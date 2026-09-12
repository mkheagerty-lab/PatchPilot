import { existsSync } from "node:fs";
import os from "node:os";
import { db, tables } from "@patchpilot/db";
import { env } from "@patchpilot/graph";
import { logger } from "./logger.js";

const log = logger.child({ module: "self-process-stats" });

/**
 * Local-dev-only stand-in for the `updater` sidecar's `docker stats` sampler
 * (Settings > Server Health > Processes) for the "worker" row. In production
 * this process runs inside the `worker` Docker container, which the sidecar
 * already samples from outside via `docker stats` — this module detects that
 * case (via `/.dockerenv`, the standard container marker) and no-ops, so it
 * never races the sidecar's writes or duplicates its data.
 *
 * In local dev, `worker` runs on the host via `pnpm dev` — no container
 * exists for the sidecar (which also isn't running locally) to sample — so
 * without this, the Processes tab's "worker" card just sits empty forever.
 * This self-samples the process's own CPU/memory instead: real numbers, but
 * for the Node process, not a container, so `image`/`health`/`diskSize`/
 * `restartCount` are left null (there is no container to report them from).
 * See apps/api/src/self-process-stats.ts for the api-side counterpart.
 */

const SAMPLE_INTERVAL_MS = 15_000;

function formatMemUsage(usedBytes: number, totalBytes: number): string {
  const usedMiB = (usedBytes / 1024 / 1024).toFixed(1);
  const totalGiB = (totalBytes / 1024 / 1024 / 1024).toFixed(1);
  return `${usedMiB}MiB / ${totalGiB}GiB`;
}

async function sampleAndUpsert(
  container: string,
  lastCpuUsage: { current: NodeJS.CpuUsage },
  lastSampleTime: { current: number },
): Promise<void> {
  const now = Date.now();
  const usage = process.cpuUsage(lastCpuUsage.current);
  const elapsedMs = now - lastSampleTime.current;
  lastCpuUsage.current = process.cpuUsage();
  lastSampleTime.current = now;
  if (elapsedMs <= 0) return;

  const cpuPercent = Math.max(0, ((usage.user + usage.system) / 1000 / elapsedMs) * 100);
  const memUsage = formatMemUsage(process.memoryUsage().rss, os.totalmem());

  await db
    .insert(tables.containerStats)
    .values({
      container,
      cpuPercent,
      memUsage,
      netIo: "—",
      blockIo: "—",
      sampledAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tables.containerStats.container,
      set: { cpuPercent, memUsage, sampledAt: new Date() },
    });
}

/** Start self-sampling. Returns a stop function. No-op in DEMO_MODE or when
 *  actually running inside Docker (production) — see module doc above. */
export function startSelfProcessStats(container: string): () => void {
  if (env.DEMO_MODE || existsSync("/.dockerenv")) {
    return () => {};
  }

  const lastCpuUsage = { current: process.cpuUsage() };
  const lastSampleTime = { current: Date.now() };

  const timer = setInterval(() => {
    sampleAndUpsert(container, lastCpuUsage, lastSampleTime).catch((err) =>
      log.error({ err }, `sample failed for ${container}`),
    );
  }, SAMPLE_INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
