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

while true; do
  ROW=$(psql "$DATABASE_URL" -Atc "
    UPDATE update_runs SET status='running', started_at=now()
    WHERE id = (
      SELECT id FROM update_runs
      WHERE status='queued' AND scheduled_at <= now()
      ORDER BY scheduled_at ASC LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id || '|' || target_version;" 2>/dev/null || true)

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
    psql "$DATABASE_URL" -v id="$RUN_ID" -v status="$STATUS" -v out="$OUT" \
      -c "UPDATE update_runs SET status=:'status', finished_at=now(), output=:'out' WHERE id=:'id';"
  fi

  sleep "$INTERVAL"
done
