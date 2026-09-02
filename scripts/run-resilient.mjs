#!/usr/bin/env node
// Crash-restart supervisor for long-lived localhost runs of the api/worker.
//
// Only needed outside `infra/docker-compose.yml` — that stack already restarts
// a crashed container via `restart: unless-stopped`. Localhost usage (see
// README.md's "Localhost" deployment row) runs the app directly on the host
// instead, and `tsx watch` does not fill this gap: it restarts its child on a
// file save, but if the child dies on its own (an unhandled exception/rejection
// escaping to the process top level — see the BullMQ "error" event comment in
// apps/worker/src/queue.ts for a real incident), `tsx watch` just sits idle
// with a dead child until the next file change. This wraps a plain (non-watch)
// process and respawns it whenever it exits unexpectedly, with backoff so a
// fast crash loop doesn't spin the CPU or hammer Postgres/Redis.
//
// Usage: node scripts/run-resilient.mjs <command> [args...]

import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: run-resilient.mjs <command> [args...]");
  process.exit(1);
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// A run that survives at least this long is treated as healthy, resetting
// backoff to the minimum — only a *fast* crash loop should slow restarts down.
const HEALTHY_RUN_MS = MAX_BACKOFF_MS;

const label = `[resilient] ${command} ${args.join(" ")}`.trim();
let backoff = MIN_BACKOFF_MS;
let stopping = false;
let currentChild;

// On Windows, `pnpm`/`node` may resolve to a .cmd shim that only a shell can
// run. Fold everything into one command string rather than passing `args`
// alongside `shell: true` — Node deprecates (DEP0190) the array form because
// shell:true doesn't escape array args, only concatenates them; folding
// ourselves here is the same concatenation but without the warning, and the
// command is always our own package.json script, never external input.
const useShell = process.platform === "win32";

function start() {
  console.log(`${label} — starting`);
  const startedAt = Date.now();
  currentChild = useShell
    ? spawn([command, ...args].join(" "), { stdio: "inherit", shell: true })
    : spawn(command, args, { stdio: "inherit" });

  currentChild.on("exit", (code, signal) => {
    if (stopping) return;

    const ranMs = Date.now() - startedAt;
    if (ranMs > HEALTHY_RUN_MS) backoff = MIN_BACKOFF_MS;

    console.error(
      `${label} — exited (code=${code}, signal=${signal}) after ${Math.round(ranMs / 1000)}s, ` +
        `restarting in ${backoff}ms`,
    );
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  });
}

function stop(signal) {
  stopping = true;
  currentChild?.kill(signal);
  process.exit(0);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

start();
