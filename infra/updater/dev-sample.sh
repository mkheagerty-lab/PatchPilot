#!/bin/sh
# Local dev-only container_stats sampler (Settings > Server Health > Processes).
#
# The real sampler (run.sh's sample_container_stats) only runs inside the
# `updater` compose service, which local dev never runs at all — apps/api,
# apps/worker and apps/web run on the host via `pnpm dev`, and only
# Postgres/Redis/Ollama run as real Docker containers (see
# infra/docker-compose.dev.yml). Without this script the Processes tab has
# no writer in local dev at all, so every card sits on "No live data yet"
# forever, healthcheck included, even though postgres/redis/ollama really
# are healthy local containers.
#
# Same sampling logic as run.sh, adapted for the `patchpilot-dev-<service>-1`
# names docker-compose.dev.yml uses (vs. production's `patchpilot-<service>-1`),
# and routed through `docker exec ... psql` against the postgres container
# itself rather than a host `psql` binary, since a dev machine doesn't
# necessarily have the Postgres client installed.
#
#   sh infra/updater/dev-sample.sh
#
set -eu

INTERVAL="${POLL_INTERVAL_SECONDS:-15}"
PG_CONTAINER="patchpilot-dev-postgres-1"
# Only the containers docker-compose.dev.yml actually runs — api/web/worker/
# caddy/backup have no local Docker container to sample at all.
DEV_SERVICES="postgres redis ollama"

sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

psql_exec() {
  docker exec "$PG_CONTAINER" psql -U patchpilot -d patchpilot -q -c "$1" >/dev/null 2>&1 || true
}

echo "[dev-sample] starting — polling every ${INTERVAL}s (postgres/redis/ollama)"

while true; do
  RUNNING=$(docker ps --format '{{.Names}}' 2>/dev/null || true)
  TARGETS=""
  for svc in $DEV_SERVICES; do
    CNAME="patchpilot-dev-${svc}-1"
    case "$RUNNING" in
      *"$CNAME"*) TARGETS="$TARGETS $CNAME" ;;
    esac
  done

  if [ -n "$TARGETS" ]; then
    PS_INFO=$(docker ps -s --format '{{.Names}}|{{.Image}}|{{.Size}}' 2>/dev/null || true)
    INSPECT_INFO=$(docker inspect --format '{{.Name}}|{{.RestartCount}}|{{.State.StartedAt}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $TARGETS 2>/dev/null || true)

    docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}' $TARGETS 2>/dev/null |
      while IFS='|' read -r NAME CPU MEM NET BLOCK; do
        SVC="${NAME#patchpilot-dev-}"
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

        psql_exec "
          INSERT INTO container_stats (container, cpu_percent, mem_usage, net_io, block_io, sampled_at, image, disk_size, health, started_at, restart_count)
          VALUES ('$(sql_escape "$SVC")', '$(sql_escape "$CPU_NUM")', '$(sql_escape "$MEM")', '$(sql_escape "$NET")', '$(sql_escape "$BLOCK")', now(), '$(sql_escape "$IMAGE")', '$(sql_escape "$DISK_SIZE")', '$(sql_escape "$HEALTH")', $STARTED_AT_SQL, '$(sql_escape "$RESTART_COUNT")')
          ON CONFLICT (container) DO UPDATE SET
            cpu_percent = EXCLUDED.cpu_percent, mem_usage = EXCLUDED.mem_usage,
            net_io = EXCLUDED.net_io, block_io = EXCLUDED.block_io, sampled_at = EXCLUDED.sampled_at,
            image = EXCLUDED.image, disk_size = EXCLUDED.disk_size, health = EXCLUDED.health,
            started_at = EXCLUDED.started_at, restart_count = EXCLUDED.restart_count;
        "
      done
  fi

  sleep "$INTERVAL"
done
