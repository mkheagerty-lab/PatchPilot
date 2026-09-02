import { sql } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { auditSafe } from "@patchpilot/graph";
import { SYSTEM_ACTORS } from "@patchpilot/shared";
import { config } from "../config.js";
import { refreshWingetCatalogFromMirror } from "./winget-mirror.js";

/**
 * Background winget catalog refresh (Phase 5, Workstream A1).
 *
 * Mirrors the auto-sync scheduler pattern: a timer-driven loop that pulls the
 * public winget source and upserts `winget_catalog`. Unlike tenant sync this
 * touches NO Microsoft tenant — it is a read from a public CDN — so it runs
 * regardless of engineer sessions or GDAP. It still never runs in DEMO_MODE
 * (the demo serves curated fixtures) and is disabled when the interval is 0.
 *
 * The first cycle is staleness-aware: on boot it refreshes only if the catalog
 * has never been pulled or is older than the configured interval, so restarts
 * don't re-download a catalog that's already fresh.
 */

/** Delay the first cycle so boot (server listen, migrations) settles first. */
const FIRST_CYCLE_DELAY_MS = 45_000;

/** Most recent mirror refresh time, or null if the catalog has never been pulled. */
async function lastRefreshedAt(): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<string | null>`max(${tables.wingetCatalog.lastRefreshedAt})` })
    .from(tables.wingetCatalog);
  return row?.at ? new Date(row.at) : null;
}

async function refreshOnce(reason: string): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await refreshWingetCatalogFromMirror();
    console.log(
      `[catalog-refresh] ${reason}: ${result.packages} packages in ${result.durationMs}ms`,
    );
    // The catalog decides which package a fix maps to, so a silent refresh —
    // or a silent failure leaving it stale — changes what remediation does.
    await auditSafe({
      engineer: SYSTEM_ACTORS.catalogRefresh,
      actorType: "system",
      endpoint: "winget-mirror:source.msix",
      method: "INGEST",
      action: "catalog:refresh",
      resourceType: "catalog",
      resourceLabel: "winget",
      summary: `Auto-refreshed the winget catalog (${reason}) — ${result.packages} packages`,
      outcome: "success",
      responseStatus: 200,
      latencyMs: result.durationMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[catalog-refresh] ${reason} failed — ${message}`);
    await auditSafe({
      engineer: SYSTEM_ACTORS.catalogRefresh,
      actorType: "system",
      endpoint: "winget-mirror:source.msix",
      method: "INGEST",
      action: "catalog:refresh",
      resourceType: "catalog",
      resourceLabel: "winget",
      summary: `Auto-refresh of the winget catalog failed (${reason})`,
      outcome: "failure",
      detail: message,
      responseStatus: 502,
      latencyMs: Date.now() - startedAt,
    });
  }
}

/**
 * Start the background catalog refresh. Returns a stop function for graceful
 * shutdown. No-op in DEMO_MODE or when the interval is ≤ 0.
 */
export function startCatalogRefresh(): () => void {
  if (config.DEMO_MODE) {
    console.log("[catalog-refresh] disabled (DEMO_MODE)");
    return () => {};
  }
  const intervalHours = config.WINGET_REFRESH_INTERVAL_HOURS;
  if (intervalHours <= 0) {
    console.log("[catalog-refresh] disabled (WINGET_REFRESH_INTERVAL_HOURS=0)");
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
          `[catalog-refresh] skipping boot refresh — last pulled ${last.toISOString()}`,
        );
      }
      interval = setInterval(() => void refreshOnce("scheduled"), intervalMs);
    })();
  }, FIRST_CYCLE_DELAY_MS);

  console.log(
    `[catalog-refresh] enabled — every ${intervalHours}h (first check in 45s)`,
  );

  return () => {
    clearTimeout(firstCycle);
    if (interval) clearInterval(interval);
  };
}
