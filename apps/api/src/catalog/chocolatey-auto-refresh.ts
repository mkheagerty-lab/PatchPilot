import { sql } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { auditSafe } from "@patchpilot/graph";
import { SYSTEM_ACTORS } from "@patchpilot/shared";
import { config } from "../config.js";
import { refreshChocolateyCatalogFromMirror } from "./chocolatey-mirror.js";

/**
 * Background Chocolatey catalog refresh — the user-context counterpart to
 * auto-refresh.ts's winget scheduler. Same shape: a timer-driven loop that
 * pulls a public repository and upserts `chocolatey_catalog`, touches no
 * Microsoft tenant, never runs in DEMO_MODE, and is disabled when the
 * interval is 0. Staleness-aware first cycle, same reasoning as winget's.
 */

const FIRST_CYCLE_DELAY_MS = 60_000;

async function lastRefreshedAt(): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<string | null>`max(${tables.chocolateyCatalog.lastRefreshedAt})` })
    .from(tables.chocolateyCatalog);
  return row?.at ? new Date(row.at) : null;
}

async function refreshOnce(reason: string): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await refreshChocolateyCatalogFromMirror();
    console.log(
      `[chocolatey-catalog-refresh] ${reason}: ${result.packages} packages in ${result.durationMs}ms${result.truncated ? ` (truncated: ${result.truncationReason})` : ""}`,
    );
    await auditSafe({
      engineer: SYSTEM_ACTORS.chocolateyRefresh,
      actorType: "system",
      endpoint: "chocolatey-mirror:packages",
      method: "INGEST",
      action: "chocolatey-catalog:refresh",
      resourceType: "catalog",
      resourceLabel: "chocolatey",
      summary: `Auto-refreshed the Chocolatey catalog (${reason}) — ${result.packages} packages${result.truncated ? " (truncated)" : ""}`,
      // A truncated pull succeeded but left the catalog incomplete; recording it
      // as a plain success would hide why a package later looks missing.
      outcome: result.truncated ? "partial" : "success",
      detail: result.truncationReason ?? null,
      responseStatus: 200,
      latencyMs: result.durationMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[chocolatey-catalog-refresh] ${reason} failed — ${message}`);
    await auditSafe({
      engineer: SYSTEM_ACTORS.chocolateyRefresh,
      actorType: "system",
      endpoint: "chocolatey-mirror:packages",
      method: "INGEST",
      action: "chocolatey-catalog:refresh",
      resourceType: "catalog",
      resourceLabel: "chocolatey",
      summary: `Auto-refresh of the Chocolatey catalog failed (${reason})`,
      outcome: "failure",
      detail: message,
      responseStatus: 502,
      latencyMs: Date.now() - startedAt,
    });
  }
}

/**
 * Start the background Chocolatey catalog refresh. Returns a stop function
 * for graceful shutdown. No-op in DEMO_MODE or when the interval is ≤ 0.
 */
export function startChocolateyCatalogRefresh(): () => void {
  if (config.DEMO_MODE) {
    console.log("[chocolatey-catalog-refresh] disabled (DEMO_MODE)");
    return () => {};
  }
  const intervalHours = config.CHOCOLATEY_REFRESH_INTERVAL_HOURS;
  if (intervalHours <= 0) {
    console.log("[chocolatey-catalog-refresh] disabled (CHOCOLATEY_REFRESH_INTERVAL_HOURS=0)");
    return () => {};
  }

  const intervalMs = intervalHours * 60 * 60_000;
  let interval: NodeJS.Timeout | undefined;

  const firstCycle = setTimeout(() => {
    void (async () => {
      const last = await lastRefreshedAt().catch(() => null);
      const stale = !last || Date.now() - last.getTime() >= intervalMs;
      if (stale) {
        await refreshOnce(last ? "stale on boot" : "initial population");
      } else {
        console.log(
          `[chocolatey-catalog-refresh] skipping boot refresh — last pulled ${last.toISOString()}`,
        );
      }
      interval = setInterval(() => void refreshOnce("scheduled"), intervalMs);
    })();
  }, FIRST_CYCLE_DELAY_MS);

  console.log(
    `[chocolatey-catalog-refresh] enabled — every ${intervalHours}h (first check in 60s)`,
  );

  return () => {
    clearTimeout(firstCycle);
    if (interval) clearInterval(interval);
  };
}
