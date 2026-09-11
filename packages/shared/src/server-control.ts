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
