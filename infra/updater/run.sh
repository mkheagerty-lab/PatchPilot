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
# Every compose service EXCEPT this one (`updater`) — so the rebuild command
# can never touch its own container, regardless of whether a future release's
# compose diff happens to also change the updater block.
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
        docker compose -f infra/docker-compose.yml --env-file .env up -d --build $SERVICES
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

  sleep "$INTERVAL"
done
