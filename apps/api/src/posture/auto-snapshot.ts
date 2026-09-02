import { auditSafe } from "@patchpilot/graph";
import { SYSTEM_ACTORS } from "@patchpilot/shared";
import { config } from "../config.js";
import { captureAllSnapshots } from "./snapshot.js";

/**
 * Background posture snapshotter (the Dashboard's only source of history).
 *
 * Same shape as the auto-sync and catalog-refresh schedulers: a timer-driven
 * loop, off in DEMO_MODE, off when the interval is 0, returning a stop function.
 * Unlike catalog refresh this is NOT staleness-aware on boot — it captures every
 * time the API starts. The write is an upsert keyed on (tenant, day), so a
 * restart rewrites today's row rather than adding one, and capturing eagerly is
 * what guarantees a brand-new deployment has a data point within the minute
 * instead of up to a day later.
 */

/** Delay the first cycle so boot settles — after auto-sync (30s) and catalog (45s). */
const FIRST_CYCLE_DELAY_MS = 60_000;

async function captureOnce(reason: string): Promise<void> {
  const startedAt = Date.now();
  const result = await captureAllSnapshots("scheduled");
  console.log(
    `[posture-snapshot] ${reason}: ${result.captured} captured, ${result.failed} failed`,
  );
  // Audited on the scheduled cycle only. Post-sync captures are deliberately
  // silent — auditing them would triple every sync's audit volume to record
  // that a derived table was rewritten, which carries no decision content.
  await auditSafe({
    engineer: SYSTEM_ACTORS.postureSnapshot,
    actorType: "system",
    endpoint: "posture:snapshot",
    method: "INGEST",
    action: "posture:snapshot",
    resourceType: "tenant",
    resourceLabel: "all tenants",
    summary: `Captured daily posture snapshots (${reason}) — ${result.captured} tenants`,
    outcome: result.failed > 0 ? "failure" : "success",
    detail: result.failed > 0 ? `${result.failed} tenant(s) failed to capture` : undefined,
    responseStatus: result.failed > 0 ? 207 : 200,
    latencyMs: Date.now() - startedAt,
  });
}

/**
 * Start the background snapshotter. Returns a stop function for graceful
 * shutdown. No-op in DEMO_MODE or when the interval is ≤ 0.
 */
export function startPostureSnapshots(): () => void {
  if (config.DEMO_MODE) {
    console.log("[posture-snapshot] disabled (DEMO_MODE)");
    return () => {};
  }
  const intervalHours = config.POSTURE_SNAPSHOT_INTERVAL_HOURS;
  if (intervalHours <= 0) {
    console.log("[posture-snapshot] disabled (POSTURE_SNAPSHOT_INTERVAL_HOURS=0)");
    return () => {};
  }

  const intervalMs = intervalHours * 60 * 60_000;
  let interval: NodeJS.Timeout | undefined;

  const firstCycle = setTimeout(() => {
    void (async () => {
      // captureAllSnapshots already isolates per-tenant failures; this catch is
      // for the load-tenants step, which would otherwise reject unhandled and
      // leave the interval below unset.
      await captureOnce("on boot").catch((err: unknown) => {
        console.error("[posture-snapshot] boot capture failed —", err);
      });
      interval = setInterval(() => {
        void captureOnce("scheduled").catch((err: unknown) => {
          console.error("[posture-snapshot] scheduled capture failed —", err);
        });
      }, intervalMs);
    })();
  }, FIRST_CYCLE_DELAY_MS);

  console.log(
    `[posture-snapshot] enabled — every ${intervalHours}h (first capture in 60s)`,
  );

  return () => {
    clearTimeout(firstCycle);
    if (interval) clearInterval(interval);
  };
}
