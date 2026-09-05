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

REPO_DIR="${REPO_DIR:-/repo}"
INTERVAL="${POLL_INTERVAL_SECONDS:-15}"
# Every compose service EXCEPT this one (`updater`) — so the rebuild command
# can never touch its own container, regardless of whether a future release's
# compose diff happens to also change the updater block.
SERVICES="caddy web migrate api worker backup ollama postgres redis"

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

    OUT=$(cd "$REPO_DIR" && {
      git fetch --tags --force &&
      git checkout --force "$TAG" &&
      docker compose -f infra/docker-compose.yml --env-file .env up -d --build $SERVICES
    } 2>&1) && STATUS=succeeded || STATUS=failed

    echo "[updater] run $RUN_ID finished: $STATUS"
    # Bound what gets written back — a runaway build log shouldn't blow out
    # the `output` column.
    OUT=$(printf '%s' "$OUT" | tail -c 20000)
    psql "$DATABASE_URL" -q -c "UPDATE update_runs SET status='$(sql_escape "$STATUS")', finished_at=now(), output='$(sql_escape "$OUT")' WHERE id='$(sql_escape "$RUN_ID")';" \
      || echo "[updater] WARNING: failed to write back status for run $RUN_ID — it will stay stuck at 'running' until fixed manually." >&2
  fi

  sleep "$INTERVAL"
done
