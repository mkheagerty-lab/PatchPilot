/**
 * Report retention: two independent bounds, both documented in the reports
 * plan's "Storage + retention" section.
 *
 * 1. Time-based sweep — deletes rows whose `expiresAt` (stamped once at
 *    INSERT from `REPORT_RETENTION_DAYS`, never recomputed here — see the
 *    column comment in `packages/db/src/schema.ts`) has passed. Same shape as
 *    `sweepStaleJobs` in `apps/worker/src/index.ts`: runs at boot and on an
 *    interval, and audits only when it actually deleted something.
 * 2. Per-engineer cap — after each successful render, keep only the newest
 *    `REPORT_RETENTION_MAX_PER_ENGINEER` rows for that engineer, oldest
 *    first. Bounds the table for an engineer who generates reports all day
 *    and never revisits the history page. Deliberately silent (no audit row)
 *    — this is routine housekeeping tied to that engineer's own reports, not
 *    an event anyone needs to investigate later, unlike the time sweep which
 *    spans every engineer's rows.
 */
import { desc, eq, inArray, lt } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { auditSafe } from "@patchpilot/graph";
import { SYSTEM_ACTORS } from "@patchpilot/shared";
import { reportEnv } from "./env.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "reports-retention" });

function idList(ids: readonly string[], max = 10): string {
  if (ids.length <= max) return ids.join(", ");
  return `${ids.slice(0, max).join(", ")} + ${ids.length - max} more`;
}

export async function sweepExpiredReports(): Promise<void> {
  const deleted = await db
    .delete(tables.reports)
    .where(lt(tables.reports.expiresAt, new Date()))
    .returning({ id: tables.reports.id });

  if (deleted.length === 0) return;

  log.info({ reportIds: deleted.map((r) => r.id) }, `retention sweep: deleted ${deleted.length} expired report(s)`);
  await auditSafe({
    engineer: SYSTEM_ACTORS.worker,
    actorType: "worker",
    tenantId: null,
    endpoint: "worker:report-retention",
    method: "SWEEP",
    action: "report:delete",
    resourceType: "report",
    summary: `Deleted ${deleted.length} expired report(s)`,
    outcome: "success",
    detail: idList(deleted.map((r) => r.id)),
    responseStatus: 200,
  });
}

/** Deletes this engineer's oldest reports beyond the configured cap. Call
 * after every successful render — the row just written may have pushed the
 * count over the limit. */
export async function enforcePerEngineerCap(engineer: string): Promise<void> {
  const rows = await db
    .select({ id: tables.reports.id })
    .from(tables.reports)
    .where(eq(tables.reports.engineer, engineer))
    .orderBy(desc(tables.reports.requestedAt));

  if (rows.length <= reportEnv.REPORT_RETENTION_MAX_PER_ENGINEER) return;

  const overflowIds = rows.slice(reportEnv.REPORT_RETENTION_MAX_PER_ENGINEER).map((r) => r.id);
  await db.delete(tables.reports).where(inArray(tables.reports.id, overflowIds));
  log.info(
    { engineer, reportIds: overflowIds },
    `pruned ${overflowIds.length} report(s) over the ${reportEnv.REPORT_RETENTION_MAX_PER_ENGINEER}-row cap`,
  );
}

const SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

/** Starts the periodic time-based sweep: once at boot, then every 6h.
 * Returns a stop function for SIGTERM. */
export function startReportRetention(): () => void {
  sweepExpiredReports().catch((err) => log.error({ err }, "retention sweep failed"));
  const timer = setInterval(() => {
    sweepExpiredReports().catch((err) => log.error({ err }, "retention sweep failed"));
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
