// Settings > Server Health > Containers (Phase 2) — the allowlist of infra
// containers an admin may restart individually. Deliberately excludes
// "migrate" (a one-shot job — restarting the already-exited container would
// re-run its entrypoint and silently re-run database migrations) and
// "updater" itself (restarting the container that is executing the restart
// request would kill the request mid-flight). This is the API route's
// server-side validation for a client-supplied container name — never trust
// it straight into a shell command; infra/updater/run.sh also re-checks
// against its own hardcoded allowlist as defense in depth.
export const RESTARTABLE_CONTAINERS = [
  "caddy",
  "web",
  "api",
  "worker",
  "backup",
  "ollama",
  "postgres",
  "redis",
] as const;

export type RestartableContainer = (typeof RESTARTABLE_CONTAINERS)[number];

export function isRestartableContainer(value: string): value is RestartableContainer {
  return (RESTARTABLE_CONTAINERS as readonly string[]).includes(value);
}

/**
 * Static (not live-inspected) reference info for the Containers tab —
 * sourced from infra/docker-compose.yml and infra/Caddyfile, not queried at
 * runtime, since none of this ever changes without a code change to those
 * files. `port` is the port the container's own process listens on
 * internally (not necessarily published to the host — only caddy's 80/443
 * are); "—" for the background-only containers that don't run a server at
 * all. `path` is the URL path Caddy routes to that container, for the two
 * containers actually reachable that way; "—" for everything else (either
 * not client-facing, or — for caddy itself — the entry point, not a routed
 * path).
 */
export const CONTAINER_INFO: Record<RestartableContainer, { port: string; path: string }> = {
  caddy: { port: "80, 443", path: "—" },
  web: { port: "80", path: "/ (default)" },
  api: { port: "4000", path: "/api/*, /auth/*" },
  worker: { port: "—", path: "—" },
  backup: { port: "—", path: "—" },
  ollama: { port: "11434", path: "—" },
  postgres: { port: "5432", path: "—" },
  redis: { port: "6379", path: "—" },
};
