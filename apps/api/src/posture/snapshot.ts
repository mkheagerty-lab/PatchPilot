/**
 * Writes one `posture_snapshots` row per tenant per day.
 *
 * Every other posture table in the schema is current-state — sync upserts or
 * delete-and-replaces it — so nothing in PatchPilot could answer "were we better
 * off last week?". This is the only table that retains history, and this file is
 * the only thing that writes it.
 *
 * Two design rules make the history trustworthy:
 *
 * 1. **No derivation lives here.** Counts come from `loadTenantPosture()` (the
 *    same pipeline behind /api/vulnerabilities and /api/devices) and
 *    `computeCoverage()` (the same one behind /api/catalog/coverage). A snapshot
 *    is meant to be a record of what the Dashboard actually showed that day; a
 *    second implementation would make it a record of something else.
 * 2. **The SLA thresholds in force are frozen into the row.** SLA state is a
 *    function of the thresholds, so without `slaThresholds` a later edit in
 *    Settings would retroactively change what every past day "meant".
 *
 * Upsert on (tenantId, day) rather than insert: the first capture of the day
 * writes the row, every later capture that day rewrites it. That gives "a row
 * exists as soon as the API has run once" and "the row reflects the most recent
 * sync" without duplicates, ordering assumptions, or a separate backfill path.
 */
import { db, tables, demoTenants, type TenantRow } from "@patchpilot/db";
import { config } from "../config.js";
import { loadSlaThresholds } from "../routes/recommendations.js";
import { computeCoverage } from "../catalog/coverage.js";
import { listJobs } from "../jobs.js";
import {
  complianceCounts,
  loadTenantPosture,
  severityCounts,
  slaCounts,
} from "./findings.js";

/**
 * Why the row was written. `scheduled` is the daily timer, `post-sync` a capture
 * triggered by fresh Graph data landing, `backfill` a fixture or manual write.
 * Kept on the row so a gap in the trend can be read as "the scheduler was down"
 * rather than "posture was zero".
 */
export type SnapshotSource = "scheduled" | "post-sync" | "backfill";

/** UTC calendar day as `YYYY-MM-DD` — the grain of the unique index. */
export function snapshotDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function loadTenants(): Promise<TenantRow[]> {
  if (config.DEMO_MODE) return demoTenants;
  return db.select().from(tables.tenants);
}

/**
 * Job outcomes for the tenant's current day.
 *
 * Deliberately day-scoped rather than lifetime: the snapshot answers "what
 * happened on this day", and a lifetime total would make the trend chart a
 * monotonically rising line that says nothing. Archived jobs are included —
 * archiving is a UI-tidiness action, and letting it erase history would make
 * yesterday's throughput editable.
 */
async function jobOutcomesForDay(tenantId: string, day: string): Promise<{
  succeeded: number;
  failed: number;
}> {
  const jobs = await listJobs(tenantId, true);
  let succeeded = 0;
  let failed = 0;
  for (const j of jobs) {
    // Finished-at, not queued-at: a job queued at 23:58 and failing at 00:03
    // belongs to the day it produced its outcome.
    const at = j.finishedAt;
    if (!at || at.slice(0, 10) !== day) continue;
    if (j.status === "succeeded") succeeded += 1;
    else if (j.status === "failed") failed += 1;
  }
  return { succeeded, failed };
}

/**
 * Capture (or rewrite) today's snapshot for one tenant.
 *
 * Never called in DEMO_MODE — the demo's trend comes from `demoPostureSnapshots`
 * and there is no database to write to.
 */
export async function captureTenantSnapshot(
  tenantId: string,
  source: SnapshotSource,
  now: Date = new Date(),
): Promise<void> {
  const day = snapshotDay(now);
  const thresholds = await loadSlaThresholds();
  const posture = await loadTenantPosture(tenantId, thresholds, now);
  const coverage = await computeCoverage(tenantId);
  const jobs = await jobOutcomesForDay(tenantId, day);

  const sev = severityCounts(posture.findings);
  const sla = slaCounts(posture.findings);
  const compliance = complianceCounts(posture.devices);

  const row = {
    tenantId,
    day,
    capturedAt: now,
    source,
    devices: posture.devices.length,
    devicesCompliant: compliance.compliant,
    devicesNoncompliant: compliance.noncompliant,
    devicesUnknown: compliance.unknown,
    openFindings: posture.findings.length,
    critical: sev.critical,
    high: sev.high,
    medium: sev.medium,
    low: sev.low,
    slaBreached: sla.breached,
    slaDueSoon: sla["due-soon"],
    slaOk: sla.ok,
    slaThresholds: thresholds as unknown as Record<string, number>,
    softwareCovered: coverage.covered,
    softwareUncovered: coverage.uncovered,
    softwareOs: coverage.os,
    jobsSucceeded: jobs.succeeded,
    jobsFailed: jobs.failed,
  };

  await db
    .insert(tables.postureSnapshots)
    .values(row)
    .onConflictDoUpdate({
      target: [tables.postureSnapshots.tenantId, tables.postureSnapshots.day],
      // `day` and `tenantId` are the conflict target, so everything else is
      // rewritten — including `source`, which should report what most recently
      // produced the numbers now stored.
      set: {
        capturedAt: row.capturedAt,
        source: row.source,
        devices: row.devices,
        devicesCompliant: row.devicesCompliant,
        devicesNoncompliant: row.devicesNoncompliant,
        devicesUnknown: row.devicesUnknown,
        openFindings: row.openFindings,
        critical: row.critical,
        high: row.high,
        medium: row.medium,
        low: row.low,
        slaBreached: row.slaBreached,
        slaDueSoon: row.slaDueSoon,
        slaOk: row.slaOk,
        slaThresholds: row.slaThresholds,
        softwareCovered: row.softwareCovered,
        softwareUncovered: row.softwareUncovered,
        softwareOs: row.softwareOs,
        jobsSucceeded: row.jobsSucceeded,
        jobsFailed: row.jobsFailed,
      },
    });
}

/**
 * Capture every tenant, isolating failures.
 *
 * One unreachable tenant must not cost the other nineteen their day's data
 * point — a gap in the trend is unrecoverable, since posture tables keep no
 * history to reconstruct it from.
 */
export async function captureAllSnapshots(
  source: SnapshotSource,
  now: Date = new Date(),
): Promise<{ captured: number; failed: number }> {
  const tenants = await loadTenants();
  let captured = 0;
  let failed = 0;
  for (const t of tenants) {
    try {
      await captureTenantSnapshot(t.tenantId, source, now);
      captured += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[posture-snapshot] ${t.displayName} (${t.tenantId}) failed — ${message}`);
    }
  }
  return { captured, failed };
}
