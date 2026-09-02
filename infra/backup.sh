#!/bin/sh
# Nightly pg_dump with local-disk rotation. Runs as the `backup` service in
# docker-compose.yml, on the same postgres:17-alpine image as the `postgres`
# service itself (so pg_dump never crosses a major-version boundary against
# the server it's dumping). Writes .last_success / .last_failure marker files
# that apps/worker/src/backup-watchdog.ts reads to alert if a nightly run goes
# missing or fails — this script never sends email itself, it only ever
# touches files under /backups. No cloud/offsite copy by design — see the
# project's own local-disk-only backup decision.
set -eu

BACKUP_DIR=/backups
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
RUN_AT_HOUR="${BACKUP_HOUR:-2}" # 02:00 container-local time

mkdir -p "$BACKUP_DIR"

run_backup() {
  ts=$(date +%Y%m%d_%H%M%S)
  file="$BACKUP_DIR/patchpilot_${ts}.dump"
  echo "[backup] starting pg_dump -> $file"
  if pg_dump -h "${PGHOST:-postgres}" -U "${PGUSER:-patchpilot}" -d "${PGDATABASE:-patchpilot}" -F c -f "$file"; then
    date -u +%Y-%m-%dT%H:%M:%SZ >"$BACKUP_DIR/.last_success"
    echo "[backup] succeeded: $file"
    # Rotation: only ever deletes files this same script wrote, matching the
    # naming pattern above — never touches .last_success/.last_failure.
    find "$BACKUP_DIR" -name 'patchpilot_*.dump' -mtime "+${RETENTION_DAYS}" -delete
  else
    rm -f "$file"
    date -u +%Y-%m-%dT%H:%M:%SZ >"$BACKUP_DIR/.last_failure"
    echo "[backup] pg_dump failed" >&2
  fi
}

# Busybox `date -d` (this image's date) parses "YYYY-MM-DD HH:MM:SS" but not
# GNU keywords like "today"/"tomorrow" — so the next run is computed from
# today's run time plus a day of seconds, never from a relative keyword.
seconds_until_next_run() {
  now=$(date +%s)
  today_run=$(date -d "$(date +%Y-%m-%d) ${RUN_AT_HOUR}:00:00" +%s)
  if [ "$now" -ge "$today_run" ]; then
    echo $((today_run + 86400 - now))
  else
    echo $((today_run - now))
  fi
}

echo "[backup] watchdog started; retention=${RETENTION_DAYS}d, daily run at ${RUN_AT_HOUR}:00 container time"
# One immediate run so a fresh deploy proves connectivity/credentials right
# away instead of waiting up to 24h to find out pg_dump can't reach postgres.
run_backup

while true; do
  wait_s=$(seconds_until_next_run)
  echo "[backup] sleeping ${wait_s}s until next run"
  sleep "$wait_s"
  run_backup
done
