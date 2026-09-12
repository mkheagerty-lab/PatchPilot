import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import type { Plugin, ViteDevServer } from "vite";

/**
 * Settings > Server Health > Services & Containers: self-samples this Vite
 * dev server's own CPU/memory into `container_stats` under the "web" row,
 * the same local-dev stand-in api/worker already do when running on the
 * host (see apps/api/src/self-process-stats.ts) — nothing else samples
 * "web" locally, since it isn't a Docker container here and the `updater`
 * sidecar (which samples it via `docker stats` in production) doesn't run
 * locally either.
 *
 * Dev-server-only (`apply: "serve"`): a production build runs no Node
 * process at all — `vite build` emits static assets served by the `web`
 * Docker container — so this plugin's `configureServer` hook, which only
 * fires under `vite dev`, never executes there.
 *
 * Talks to Postgres directly via the `postgres` package rather than
 * importing @patchpilot/db: that package's source uses NodeNext-style
 * `./foo.js` specifiers pointing at `./foo.ts` files, which only resolve
 * under tsx's loader hook (as apps/api and apps/worker run under). A
 * dynamic `import()` from inside vite.config.ts executes under Vite's own
 * config Node process, which has no such hook, so that import fails with
 * ERR_MODULE_NOT_FOUND — confirmed the hard way before landing on this.
 *
 * Loads the repo-root `.env` itself (same walk-up-to-pnpm-workspace.yaml
 * logic as packages/db/src/load-env.ts) since vite.config.ts's Node process
 * gets no injected environment under `pnpm dev` — without it, DATABASE_URL
 * and DEMO_MODE are never seen here.
 */

function loadRootEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      const envPath = join(dir, ".env");
      if (existsSync(envPath)) {
        (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(envPath);
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

const SAMPLE_INTERVAL_MS = 15_000;

function formatMemUsage(usedBytes: number, totalBytes: number): string {
  const usedMiB = (usedBytes / 1024 / 1024).toFixed(1);
  const totalGiB = (totalBytes / 1024 / 1024 / 1024).toFixed(1);
  return `${usedMiB}MiB / ${totalGiB}GiB`;
}

export function selfProcessStatsPlugin(): Plugin {
  return {
    name: "patchpilot-self-process-stats",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      loadRootEnv();
      // Mirrors apps/api/src/load-env.ts's own DEMO_MODE guard convention:
      // skip unless an operator has explicitly opted out of demo mode.
      if ((process.env.DEMO_MODE ?? "true") !== "false") return;

      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) return;

      let sql: import("postgres").Sql | undefined;
      let lastCpuUsage = process.cpuUsage();
      let lastSampleTime = Date.now();

      const sample = async () => {
        sql ??= (await import("postgres")).default(databaseUrl, { max: 1 });

        const now = Date.now();
        const usage = process.cpuUsage(lastCpuUsage);
        const elapsedMs = now - lastSampleTime;
        lastCpuUsage = process.cpuUsage();
        lastSampleTime = now;
        if (elapsedMs <= 0) return;

        const cpuPercent = Math.max(0, ((usage.user + usage.system) / 1000 / elapsedMs) * 100);
        const memUsage = formatMemUsage(process.memoryUsage().rss, os.totalmem());

        await sql`
          INSERT INTO container_stats (container, cpu_percent, mem_usage, net_io, block_io, sampled_at)
          VALUES ('web', ${cpuPercent}, ${memUsage}, '—', '—', now())
          ON CONFLICT (container) DO UPDATE SET
            cpu_percent = EXCLUDED.cpu_percent, mem_usage = EXCLUDED.mem_usage, sampled_at = EXCLUDED.sampled_at
        `;
      };

      const timer = setInterval(() => {
        sample().catch((err) => console.error("[self-process-stats] sample failed for web:", err));
      }, SAMPLE_INTERVAL_MS);
      timer.unref();

      server.httpServer?.once("close", () => {
        clearInterval(timer);
        void sql?.end();
      });
    },
  };
}
