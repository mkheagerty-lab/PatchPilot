#!/bin/sh
# PatchPilot self-update sidecar poll loop (Settings > Updates).
#
# Claims one queued-and-due row from `update_runs` at a time via
# `FOR UPDATE SKIP LOCKED` (safe even if this container is ever scaled to more
# than one replica, though it never is in this deployment model), then does
# the actual git-pull + rebuild + restart, and writes the outcome back.
#
# Deliberately plain POSIX shell talking straight to Postgres via `psql`, not
# Node/BullMQ/Redis: this container changes almost never, needs no
# retry/eviction semantics beyond "claim one row", and must keep working
# across the very rebuild cycle it triggers (which briefly restarts redis).
set -eu

# Must equal the checkout's real path on the HOST, not just inside this
# container — see the long comment on the `updater` service in
# infra/docker-compose.yml for why a mismatch here breaks bind-mounted
# services (caddy, backup) the next time this script recreates them.
REPO_DIR="${REPO_DIR:-/opt/patchpilot}"
INTERVAL="${POLL_INTERVAL_SECONDS:-15}"
# Every compose service EXCEPT this one (`updater`) — restarting itself
# mid-command here would kill this very process before it can write the run's
# outcome back to the DB. `updater` is rebuilt/restarted separately, as the
# LAST step below, once that write-back is already durable — see the comment
# there for why skipping it stranded a real restart-container request at
# 'queued' forever on 2026-09-12 (the running process pre-dated the
# server_control_requests loop entirely, and self-update had no way to ever
# refresh it).
SERVICES="caddy web migrate api worker backup ollama postgres redis"
# Same list minus `migrate`: used by the Settings > Server Health >
# Containers "Restart entire stack" action below. A plain `docker compose
# restart` (unlike the `up -d --build` above) re-runs an already-exited
# container's entrypoint instead of leaving a one-shot job alone, which
# would silently re-run database migrations if `migrate` were included here.
STACK_SERVICES="caddy web api worker backup ollama postgres redis"

echo "[updater] starting — polling every ${INTERVAL}s"

# Doubles every single quote in $1, so it's safe to splice straight into a
# SQL '...' string literal below. Used instead of psql's -v/:'var'
# interpolation, which turned out not to substitute reliably on this image —
# it silently sent the literal ":'status'" etc. to the server and errored
# with "syntax error at or near ':'", which (combined with `set -eu` and no
# `|| true`) killed this script and put the container in a restart crash
# loop, permanently stranding the run row at status='running'.
sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

# Strips anything outside printable ASCII (+ tab/LF/CR) from captured
# build/git output before it ever reaches sql_escape/psql. Needed because
# `tail -c` below cuts on a raw byte count, not a character boundary — if
# that cut lands inside a multi-byte UTF-8 sequence (very plausible across a
# whole rebuild's worth of Docker/BuildKit/npm output), it leaves an
# orphaned continuation byte that Postgres rejects with "invalid byte
# sequence for encoding UTF8". That happened for real on 2026-09-05: the
# update itself succeeded but this write-back failed, stranding the row at
# status='running' forever — the exact "stuck on in-progress" symptom this
# sidecar exists to avoid. The `output` column is a diagnostic log, not
# meant to render, so losing the odd non-ASCII character is a fine trade for
# guaranteeing every write-back is valid UTF-8.
sanitize_output() {
  tr -cd '\11\12\15\40-\176'
}

# Same 8 containers as STACK_SERVICES above — used by the container_stats
# sampler below (Settings > Server Health > Processes).
CONTAINER_STATS_SERVICES="caddy web api worker backup ollama postgres redis"

# Samples `docker stats` for whichever of the 8 managed containers are
# currently running and upserts one row per container into container_stats.
# Not a claim-and-run job like the two loops above — just periodic sampling,
# so no locking/status columns, just a plain upsert per cycle.
sample_container_stats() {
  RUNNING=$(docker ps --format '{{.Names}}' 2>/dev/null || true)
  TARGETS=""
  for svc in $CONTAINER_STATS_SERVICES; do
    CNAME="patchpilot-${svc}-1"
    case "$RUNNING" in
      *"$CNAME"*) TARGETS="$TARGETS $CNAME" ;;
    esac
  done
  # Nothing up right now (e.g. mid restart-stack) — `docker stats` with no
  # args samples EVERY container on the host, not what we want here.
  [ -z "$TARGETS" ] && return 0

  # No jq in this image — plain pipe-delimited parsing via --format, same
  # style as the rest of this script.

  # `docker ps -s` adds writable-layer + virtual image size to the normal ps
  # output. Queried once for every running container (not filtered to
  # $TARGETS — `--filter name=X` would mean one call per container), then
  # matched by name below.
  PS_INFO=$(docker ps -s --format '{{.Names}}|{{.Image}}|{{.Size}}' 2>/dev/null || true)

  # `docker inspect` takes multiple names as positional args and prints one
  # formatted line per container. Its {{.Name}} output has a leading "/"
  # (e.g. "/patchpilot-redis-1") — matched against below with that prefix.
  # The {{if .State.Health}} guard covers containers with no HEALTHCHECK
  # defined (everything except postgres/redis/ollama, see docker-compose.yml).
  INSPECT_INFO=$(docker inspect --format '{{.Name}}|{{.RestartCount}}|{{.State.StartedAt}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $TARGETS 2>/dev/null || true)

  docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}' $TARGETS 2>/dev/null |
    while IFS='|' read -r NAME CPU MEM NET BLOCK; do
      SVC="${NAME#patchpilot-}"
      SVC="${SVC%-*}"
      CPU_NUM=$(printf '%s' "$CPU" | tr -d '%')

      PS_LINE=$(printf '%s\n' "$PS_INFO" | grep "^${NAME}|" || true)
      IMAGE=$(printf '%s' "$PS_LINE" | cut -d'|' -f2)
      DISK_SIZE=$(printf '%s' "$PS_LINE" | cut -d'|' -f3)

      INSPECT_LINE=$(printf '%s\n' "$INSPECT_INFO" | grep "^/${NAME}|" || true)
      RESTART_COUNT=$(printf '%s' "$INSPECT_LINE" | cut -d'|' -f2)
      STARTED_AT=$(printf '%s' "$INSPECT_LINE" | cut -d'|' -f3)
      HEALTH=$(printf '%s' "$INSPECT_LINE" | cut -d'|' -f4)

      [ -z "$IMAGE" ] && IMAGE="unknown"
      [ -z "$DISK_SIZE" ] && DISK_SIZE="—"
      [ -z "$HEALTH" ] && HEALTH="none"
      [ -z "$RESTART_COUNT" ] && RESTART_COUNT="0"

      if [ -n "$STARTED_AT" ]; then
        STARTED_AT_SQL="'$(sql_escape "$STARTED_AT")'"
      else
        STARTED_AT_SQL="NULL"
      fi

      psql "$DATABASE_URL" -q -c "
        INSERT INTO container_stats (container, cpu_percent, mem_usage, net_io, block_io, sampled_at, image, disk_size, health, started_at, restart_count)
        VALUES ('$(sql_escape "$SVC")', '$(sql_escape "$CPU_NUM")', '$(sql_escape "$MEM")', '$(sql_escape "$NET")', '$(sql_escape "$BLOCK")', now(), '$(sql_escape "$IMAGE")', '$(sql_escape "$DISK_SIZE")', '$(sql_escape "$HEALTH")', $STARTED_AT_SQL, '$(sql_escape "$RESTART_COUNT")')
        ON CONFLICT (container) DO UPDATE SET
          cpu_percent = EXCLUDED.cpu_percent, mem_usage = EXCLUDED.mem_usage,
          net_io = EXCLUDED.net_io, block_io = EXCLUDED.block_io, sampled_at = EXCLUDED.sampled_at,
          image = EXCLUDED.image, disk_size = EXCLUDED.disk_size, health = EXCLUDED.health,
          started_at = EXCLUDED.started_at, restart_count = EXCLUDED.restart_count;
      " >/dev/null 2>&1 || true
    done
}

# ---- host patching (Settings > Server Health > Resources) ----
# Desired state lives in settings["host-patching"] (apps/api/src/routes/
# host-patching-settings.ts); these two functions push it out to the host
# every loop iteration — cheap and idempotent, same philosophy as
# sample_container_stats' unconditional upsert above. Both toggles default
# off (no row yet = every coalesce below falls back to the off/default
# value), so a fresh deploy changes nothing on the host until an admin opts
# in via Settings.

APT_DROPIN=/etc/apt/apt.conf.d/51-patchpilot-managed

# Fully owns $APT_DROPIN — never opens 50-unattended-upgrades (Ubuntu's own
# shipped file). apt.conf.d list-type options like Allowed-Origins APPEND
# across fragments rather than replace, so a separate always-rewritten file
# is sufficient; omitting a block entirely when its toggle is off is
# equivalent to (and simpler than) commenting it out.
rewrite_apt_managed_dropin() {
  HP=$(psql "$DATABASE_URL" -Aqtc "
    SELECT coalesce(value->>'autoRebootEnabled', 'false') || '|' ||
           coalesce(value->>'autoRebootTimeUtc', '03:30') || '|' ||
           coalesce(value->>'dockerAutoUpdateEnabled', 'false')
    FROM settings WHERE key = 'host-patching';" 2>/dev/null || true)

  AUTO_REBOOT="${HP%%|*}"
  REST="${HP#*|}"
  REBOOT_TIME="${REST%%|*}"
  DOCKER_AUTO_UPDATE="${REST#*|}"

  # Defensive fallback if the stored value is ever malformed — never write a
  # value unattended-upgrades might reject.
  case "$REBOOT_TIME" in
    [0-2][0-9]:[0-5][0-9]) ;;
    *) REBOOT_TIME="03:30" ;;
  esac

  {
    echo "// Managed by PatchPilot — DO NOT EDIT BY HAND."
    echo "// Rewritten every ~${INTERVAL}s by the updater sidecar from"
    echo "// Settings > Server Health > Resources. Deliberately separate"
    echo "// from Ubuntu's own 50-unattended-upgrades, which is never edited."
    if [ "$AUTO_REBOOT" = "true" ]; then
      echo "Unattended-Upgrade::Automatic-Reboot \"true\";"
      echo "Unattended-Upgrade::Automatic-Reboot-WithUsers \"true\";"
      echo "Unattended-Upgrade::Automatic-Reboot-Time \"${REBOOT_TIME}\";"
    fi
    if [ "$DOCKER_AUTO_UPDATE" = "true" ]; then
      echo ""
      echo "Unattended-Upgrade::Allowed-Origins {"
      # \$ so the shell never expands this — the literal text
      # "${distro_codename}" is an APT config variable, substituted by APT
      # itself (not by this script) when it parses the file on the host.
      echo "    \"Docker:\${distro_codename}\";"
      echo "};"
    fi
  } >"${APT_DROPIN}.tmp" 2>/dev/null && mv "${APT_DROPIN}.tmp" "$APT_DROPIN" || true
}

DAEMON_JSON=/etc/docker/daemon.json

# Merges (never clobbers) the live-restore key into daemon.json — an admin
# may have hand-set other keys over SSH (e.g. a registry mirror). Only acts
# when the desired value actually differs from the current one, since
# restarting dockerd briefly stops every container on the host, including
# this one (restart: unless-stopped brings it back).
sync_docker_daemon_json() {
  DESIRED=$(psql "$DATABASE_URL" -Aqtc "
    SELECT coalesce(value->>'dockerLiveRestoreEnabled', 'false')
    FROM settings WHERE key = 'host-patching';" 2>/dev/null || true)
  case "$DESIRED" in
    true) DESIRED_JSON=true ;;
    *) DESIRED_JSON=false ;;
  esac

  [ -f "$DAEMON_JSON" ] || echo '{}' >"$DAEMON_JSON" 2>/dev/null || true
  CURRENT=$(jq -r '."live-restore" // false' "$DAEMON_JSON" 2>/dev/null || echo false)
  [ "$CURRENT" = "$DESIRED_JSON" ] && return 0

  echo "[updater] docker live-restore: $CURRENT -> $DESIRED_JSON"
  if jq --argjson v "$DESIRED_JSON" '. + {"live-restore": $v}' "$DAEMON_JSON" >"${DAEMON_JSON}.tmp" 2>/dev/null; then
    mv "${DAEMON_JSON}.tmp" "$DAEMON_JSON"
    (cd "$REPO_DIR" && docker compose -f infra/docker-compose.yml --env-file .env build host-exec) \
      >/dev/null 2>&1 || true
    (cd "$REPO_DIR" && docker compose -f infra/docker-compose.yml --env-file .env run --rm host-exec \
      nsenter -t 1 -m -u -n -i -- systemctl restart docker) >/dev/null 2>&1 \
      || echo "[updater] WARNING: dockerd restart for live-restore change may have failed." >&2
  else
    echo "[updater] WARNING: failed to update $DAEMON_JSON — leaving live-restore unchanged." >&2
    rm -f "${DAEMON_JSON}.tmp"
  fi
}

# Reads /host-run/reboot-required (existence only) + its .pkgs sibling, the
# newest unattended-upgrades log's mtime, and the daemon's actual
# live-restore state — then upserts the singleton host_status row. Plain
# periodic sampling like sample_container_stats above, not a claim-and-run
# job.
sample_host_status() {
  if [ -f /host-run/reboot-required ]; then
    REBOOT_REQUIRED=true
    REBOOT_PKGS=$(cat /host-run/reboot-required.pkgs 2>/dev/null | tr '\n' ' ' | sanitize_output || true)
  else
    REBOOT_REQUIRED=false
    REBOOT_PKGS=""
  fi

  LAST_LOG=$(ls -t /host-unattended-log/unattended-upgrades*.log 2>/dev/null | head -n1 || true)
  if [ -n "$LAST_LOG" ]; then
    LAST_LOG_EPOCH=$(stat -c '%Y' "$LAST_LOG" 2>/dev/null || true)
  else
    LAST_LOG_EPOCH=""
  fi

  LIVE_RESTORE=$(docker info --format '{{.LiveRestoreEnabled}}' 2>/dev/null || true)
  case "$LIVE_RESTORE" in
    true) LIVE_RESTORE_SQL=true ;;
    false) LIVE_RESTORE_SQL=false ;;
    *) LIVE_RESTORE_SQL=NULL ;;
  esac

  if [ -n "$REBOOT_PKGS" ]; then
    PKGS_SQL="'$(sql_escape "$REBOOT_PKGS")'"
  else
    PKGS_SQL="NULL"
  fi

  if [ -n "$LAST_LOG_EPOCH" ]; then
    LAST_UPGRADE_SQL="to_timestamp($LAST_LOG_EPOCH)"
  else
    LAST_UPGRADE_SQL="NULL"
  fi

  psql "$DATABASE_URL" -q -c "
    INSERT INTO host_status (id, reboot_required, reboot_required_packages, last_unattended_upgrade_at, docker_live_restore_active, sampled_at)
    VALUES ('host', $REBOOT_REQUIRED, $PKGS_SQL, $LAST_UPGRADE_SQL, $LIVE_RESTORE_SQL, now())
    ON CONFLICT (id) DO UPDATE SET
      reboot_required = EXCLUDED.reboot_required, reboot_required_packages = EXCLUDED.reboot_required_packages,
      last_unattended_upgrade_at = EXCLUDED.last_unattended_upgrade_at, docker_live_restore_active = EXCLUDED.docker_live_restore_active,
      sampled_at = EXCLUDED.sampled_at;
  " >/dev/null 2>&1 || true
}

# Reconcile any host reboot request left at 'issued' by the invocation that
# triggered an OS reboot right before the VM went down. Nothing writes
# 'confirmed' from inside that invocation — `systemctl reboot` can (and
# should) kill it first — so this process simply being alive at all, on the
# other side of the reboot, is the success signal. Must run before the loop
# claims anything new.
psql "$DATABASE_URL" -q -c "
  UPDATE host_reboot_requests SET status='confirmed', confirmed_at=now()
  WHERE status='issued';" >/dev/null 2>&1 || true

while true; do
  # -q suppresses the "UPDATE n" command-completion tag. Without it, when
  # this UPDATE...RETURNING matches zero rows (the normal case: nothing
  # queued right now), psql still prints "UPDATE 0" to stdout despite -t —
  # -t only suppresses column headers/row-count footers for an actual result
  # set, not the completion tag for a query that returned none. That
  # "UPDATE 0" text used to land in $ROW as if it were real claimed-row data,
  # and since it contains no "|", both `${ROW%%|*}` and `${ROW#*|}` below
  # evaluated to the whole string — so every idle poll acted as if it had
  # just claimed a row literally named "UPDATE 0", then failed instantly
  # trying `git checkout "UPDATE 0"`.
  ROW=$(psql "$DATABASE_URL" -Aqtc "
    UPDATE update_runs SET status='running', started_at=now()
    WHERE id = (
      SELECT id FROM update_runs
      WHERE status='queued' AND scheduled_at <= now()
      ORDER BY scheduled_at ASC LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id || '|' || target_version;" 2>/dev/null || true)

  # Belt-and-braces on top of -q: only trust $ROW if it actually looks like
  # "<id>|<version>" data, so any future output-format surprise degrades to
  # "did nothing this poll" instead of a crash loop.
  case "$ROW" in
    *"|"*) ;;
    *) ROW="" ;;
  esac

  if [ -n "$ROW" ]; then
    RUN_ID="${ROW%%|*}"
    TAG="${ROW#*|}"
    echo "[updater] claimed run $RUN_ID -> $TAG"

    # Run the actual update in the background, teeing to a log file, so this
    # loop can flush partial output back to the row every few seconds — the
    # Settings > Updates page polls every 5s and shows a live log while
    # status='running', instead of nothing until the whole thing finishes
    # (a `docker compose ... --build` can easily take minutes).
    LOGFILE=$(mktemp)
    (
      cd "$REPO_DIR" && {
        echo "== Fetching tags ==" &&
        git fetch --tags --force &&
        echo "== Checking out $TAG ==" &&
        git checkout --force "$TAG" &&
        echo "== Building and restarting containers ==" &&
        docker compose -f infra/docker-compose.yml --env-file .env up -d --build $SERVICES &&
        # host-exec is deliberately excluded from $SERVICES (never started by
        # a normal deploy — see infra/docker-compose.yml), but its image
        # still needs to track this checkout since the host-reboot/
        # live-restore-restart paths below `docker compose run` it on demand.
        # Best-effort: a failed image rebuild here shouldn't fail the whole
        # update run — those paths just retry the build themselves.
        { docker compose -f infra/docker-compose.yml --env-file .env build host-exec || true; }
      }
    ) >"$LOGFILE" 2>&1 &
    BUILD_PID=$!

    while kill -0 "$BUILD_PID" 2>/dev/null; do
      sleep 3
      PARTIAL=$(tail -c 20000 "$LOGFILE" 2>/dev/null | sanitize_output || true)
      # Best-effort: a flush failing mid-run (e.g. postgres briefly restarting
      # as part of $SERVICES) just means one skipped log update, not a
      # crash — the final write below is the one that must succeed.
      psql "$DATABASE_URL" -q -c "UPDATE update_runs SET output='$(sql_escape "$PARTIAL")' WHERE id='$(sql_escape "$RUN_ID")';" \
        >/dev/null 2>&1 || true
    done

    wait "$BUILD_PID" && STATUS=succeeded || STATUS=failed
    # Bound what gets written back — a runaway build log shouldn't blow out
    # the `output` column.
    OUT=$(tail -c 20000 "$LOGFILE" 2>/dev/null | sanitize_output || true)
    rm -f "$LOGFILE"

    echo "[updater] run $RUN_ID finished: $STATUS"
    if ! psql "$DATABASE_URL" -q -c "UPDATE update_runs SET status='$(sql_escape "$STATUS")', finished_at=now(), output='$(sql_escape "$OUT")' WHERE id='$(sql_escape "$RUN_ID")';"; then
      echo "[updater] WARNING: write-back with output failed for run $RUN_ID — retrying status-only so it doesn't get stranded at 'running'." >&2
      # Belt-and-braces on top of sanitize_output: whatever broke the write
      # above (output content or otherwise), recording status/finished_at
      # alone matters far more than the diagnostic log for that one run.
      psql "$DATABASE_URL" -q -c "UPDATE update_runs SET status='$(sql_escape "$STATUS")', finished_at=now() WHERE id='$(sql_escape "$RUN_ID")';" \
        || echo "[updater] WARNING: status-only write-back also failed for run $RUN_ID — it will stay stuck at 'running' until fixed manually." >&2
    fi

    # Rebuild/restart `updater` itself last, now that the run's outcome is
    # already written back above — this container can only safely replace
    # itself once nothing left in this invocation needs to survive past it.
    # Without this, every self-update deploys new code to disk that this
    # already-running process never picks up (a `while true` shell loop
    # doesn't re-read its own source), so any change to this script — a new
    # claim-and-run block, a bug fix — silently never takes effect until
    # someone restarts the updater container by hand.
    echo "[updater] restarting updater to pick up whatever this run just deployed"
    (cd "$REPO_DIR" && docker compose -f infra/docker-compose.yml --env-file .env up -d --build updater) \
      >/dev/null 2>&1 || echo "[updater] WARNING: self-restart failed — updater is still running pre-$TAG code." >&2
  fi

  # ---- server control requests (Settings > Server Health > Containers) ----
  # Same claim-and-run shape as update_runs above, just against a different
  # table/action set — see the comment on serverControlRequests in
  # packages/db/src/schema.ts for why this is a dedicated table too.
  CROW=$(psql "$DATABASE_URL" -Aqtc "
    UPDATE server_control_requests SET status='running', started_at=now()
    WHERE id = (
      SELECT id FROM server_control_requests
      WHERE status='queued'
      ORDER BY created_at ASC LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id || '|' || action || '|' || coalesce(target, '');" 2>/dev/null || true)

  # Same "UPDATE 0" guard as $ROW above.
  case "$CROW" in
    *"|"*) ;;
    *) CROW="" ;;
  esac

  if [ -n "$CROW" ]; then
    CONTROL_ID="${CROW%%|*}"
    CREST="${CROW#*|}"
    ACTION="${CREST%%|*}"
    TARGET="${CREST#*|}"
    echo "[updater] claimed control request $CONTROL_ID -> $ACTION ${TARGET:+($TARGET)}"

    CLOGFILE=$(mktemp)
    (
      cd "$REPO_DIR" && case "$ACTION" in
        restart-stack)
          echo "== Restarting whole stack ==" &&
          docker compose -f infra/docker-compose.yml restart $STACK_SERVICES
          ;;
        restart-container)
          # Hardcoded allowlist as defense in depth on top of the api's own
          # isRestartableContainer check
          # (packages/shared/src/server-control.ts) — this script is the
          # last line of defense against an arbitrary shell argument
          # reaching `docker compose restart`.
          case "$TARGET" in
            caddy|web|api|worker|backup|ollama|postgres|redis)
              echo "== Restarting $TARGET ==" &&
              docker compose -f infra/docker-compose.yml restart "$TARGET"
              ;;
            *)
              echo "Refusing to restart unrecognized target: $TARGET" >&2
              exit 1
              ;;
          esac
          ;;
        *)
          echo "Unknown server control action: $ACTION" >&2
          exit 1
          ;;
      esac
    ) >"$CLOGFILE" 2>&1 &
    CONTROL_PID=$!

    while kill -0 "$CONTROL_PID" 2>/dev/null; do
      sleep 3
      CPARTIAL=$(tail -c 20000 "$CLOGFILE" 2>/dev/null | sanitize_output || true)
      # Best-effort, same as the update_runs flush above — a restart of
      # postgres itself as part of this very action can transiently fail
      # this write; the final write-back below is the one that must succeed.
      psql "$DATABASE_URL" -q -c "UPDATE server_control_requests SET output='$(sql_escape "$CPARTIAL")' WHERE id='$(sql_escape "$CONTROL_ID")';" \
        >/dev/null 2>&1 || true
    done

    wait "$CONTROL_PID" && CSTATUS=succeeded || CSTATUS=failed
    COUT=$(tail -c 20000 "$CLOGFILE" 2>/dev/null | sanitize_output || true)
    rm -f "$CLOGFILE"

    echo "[updater] control request $CONTROL_ID finished: $CSTATUS"
    if ! psql "$DATABASE_URL" -q -c "UPDATE server_control_requests SET status='$(sql_escape "$CSTATUS")', completed_at=now(), output='$(sql_escape "$COUT")' WHERE id='$(sql_escape "$CONTROL_ID")';"; then
      echo "[updater] WARNING: write-back with output failed for control request $CONTROL_ID — retrying status-only so it doesn't get stranded at 'running'." >&2
      psql "$DATABASE_URL" -q -c "UPDATE server_control_requests SET status='$(sql_escape "$CSTATUS")', completed_at=now() WHERE id='$(sql_escape "$CONTROL_ID")';" \
        || echo "[updater] WARNING: status-only write-back also failed for control request $CONTROL_ID — it will stay stuck at 'running' until fixed manually." >&2
    fi
  fi

  # ---- host patching config + status (Settings > Server Health > Resources) ----
  # Plain periodic push/sample, same cadence as container stats below — run
  # after both claim blocks above, before the (also plain periodic)
  # container stats sampler.
  rewrite_apt_managed_dropin
  sync_docker_daemon_json
  sample_host_status

  # ---- container stats (Settings > Server Health > Processes) ----
  # Not a claim-and-run job — nothing to claim, just periodic sampling at the
  # existing $INTERVAL cadence, run after both claim blocks above.
  sample_container_stats

  # ---- host reboot requests (Settings > Server Health > Resources) ----
  # Deliberately the LAST action every loop iteration: everything else this
  # tick has already been written back by the time this runs, since an OS
  # reboot is the most disruptive thing this script can do. See
  # packages/db/src/schema.ts's hostRebootRequests comment for why this is a
  # dedicated table/status flow rather than server_control_requests above.
  HR_ID=$(psql "$DATABASE_URL" -Aqtc "
    UPDATE host_reboot_requests SET status='issuing'
    WHERE id = (
      SELECT id FROM host_reboot_requests
      WHERE status='queued'
      ORDER BY created_at ASC LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id;" 2>/dev/null || true)

  if [ -n "$HR_ID" ]; then
    echo "[updater] claimed host reboot request $HR_ID"
    (cd "$REPO_DIR" && docker compose -f infra/docker-compose.yml --env-file .env build host-exec) \
      >/dev/null 2>&1 || echo "[updater] WARNING: host-exec build failed for reboot request $HR_ID — proceeding anyway." >&2

    # Write 'issued' BEFORE the reboot itself — this is the point of no
    # return. `systemctl reboot` can (and should) tear this container down
    # before the next line executes; the pre-loop reconciliation step above
    # is what closes this out to 'confirmed' once the host comes back.
    psql "$DATABASE_URL" -q -c "UPDATE host_reboot_requests SET status='issued', issued_at=now() WHERE id='$(sql_escape "$HR_ID")';" \
      >/dev/null 2>&1 || true

    if ! (cd "$REPO_DIR" && docker compose -f infra/docker-compose.yml --env-file .env run --rm host-exec \
        nsenter -t 1 -m -u -n -i -- systemctl reboot) >/dev/null 2>&1; then
      echo "[updater] WARNING: issuing host reboot for request $HR_ID failed." >&2
      psql "$DATABASE_URL" -q -c "UPDATE host_reboot_requests SET status='failed', output='nsenter systemctl reboot failed' WHERE id='$(sql_escape "$HR_ID")';" \
        >/dev/null 2>&1 || true
    fi
  fi

  sleep "$INTERVAL"
done
