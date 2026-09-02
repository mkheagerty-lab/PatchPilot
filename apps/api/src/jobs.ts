import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, tables, demoJobs, type JobRow } from "@patchpilot/db";
import type {
  InstallScope,
  PackageSource,
  RemediationAction,
  RemediationChannel,
} from "@patchpilot/shared";
import { config } from "./config.js";
import { remediationQueue } from "./queue.js";

/**
 * The remediation job engine (Phase 3 / Phase 5).
 *
 * Mirrors audit.ts: DEMO_MODE keeps a bounded, newest-first in-memory ring
 * buffer and *simulates* execution (queued -> running -> succeeded) on a timer,
 * so the full remediation flow is clickable with zero dependencies — no Redis,
 * no Postgres, and crucially no Microsoft write.
 *
 * Production persists the job row and enqueues it on the BullMQ remediation
 * queue; the worker (apps/worker) resolves a delegated token and dispatches to
 * the real channel at execution time. The worker is the authoritative
 * read-only-first gate: it re-checks `tenants.readOnly` when the job actually
 * runs (which, for a scheduled job, may be long after this enqueue), so a write
 * is only ever issued for a tenant that is still opted in.
 */
export interface JobRecord {
  id: string;
  tenantId: string;
  deviceId: string | null;
  cveId: string | null;
  /**
   * Additional CVE ids this one job also remediates, beyond the primary
   * `cveId` — set when a recurring schedule's fan-out consolidated several
   * open CVEs against the same (device, software) fix into a single dispatch
   * instead of one job per CVE. Null for the ordinary 1:1 case.
   */
  coveredCveIds: string[] | null;
  /** Set instead of `cveId` for a Missing-KB Fix Now dispatch. */
  kbId: string | null;
  /** Set instead of `cveId`/`kbId` for an `expedited-feature-update` dispatch — the friendly target label (e.g. "24H2"). */
  featureUpdateVersion: string | null;
  /**
   * Snapshots of the dispatch-time device hostname and resolved software
   * display name. Captured once at creation so the row keeps an accurate
   * historical record even after the device is renamed/removed or a later
   * sync changes the vulnerability's stored `software` — the Jobs UI used to
   * reconstruct both live from the current /api/devices and
   * /api/vulnerabilities lists, so either would silently rewrite history.
   * Null on legacy rows created before this column existed.
   */
  deviceHostname: string | null;
  software: string | null;
  channel: RemediationChannel;
  status: "queued" | "running" | "succeeded" | "failed";
  engineer: string;
  exitCode: number | null;
  output: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  archivedAt: string | null;
  /**
   * Deployable script + the params it was built from, persisted so a failed
   * job can be resubmitted as-is via Retry. Null on legacy jobs predating
   * these columns.
   */
  script: string | null;
  packageId: string | null;
  installScope: InstallScope | null;
  action: RemediationAction | null;
  /** `"script"` tags a win32-app Script Catalog deploy — see RemediationJob.source in queue.ts. */
  source: PackageSource | "script" | null;
  altPackageId: string | null;
  /**
   * Shared by every job created from one multi-device dispatch (a schedule
   * fire, a Fix All, or a multi-device Run Now) so the Jobs page can group
   * them under one row. Null for single-device dispatches.
   */
  batchId: string | null;
  /** Set only when the job came from a recurring schedule's fan-out. */
  scheduleId: string | null;
}

export interface NewJob {
  tenantId: string;
  deviceId: string | null;
  cveId: string | null;
  /** Set instead of `cveId` for a Missing-KB Fix Now dispatch. */
  kbId?: string | null;
  /** Set instead of `cveId`/`kbId` for an `expedited-feature-update` dispatch — the friendly target label (e.g. "24H2"). */
  featureUpdateVersion?: string | null;
  channel: RemediationChannel;
  engineer: string;
  /** Reviewed PowerShell that would be delivered to the device. */
  script: string;
  /**
   * Optional ISO timestamp to defer execution to. When set and in the future
   * the job is enqueued but only dispatched at that time; the worker resolves
   * the delegated token and re-checks read-only posture when it actually runs
   * (which is why a token is never carried on the payload). Past/absent = now.
   */
  scheduleAt?: string;
  /**
   * Engineer-selected winget package id override from the Run Now dialog; the
   * worker prefers it over the CVE's stored winget mapping at execution time.
   */
  packageId?: string | null;
  /**
   * Install-scope evidence at dispatch time (queue-payload-only, same as
   * `packageId` — no `jobs` column). For channel "live-response" the worker
   * passes it through to the library script's second `Args` token so a
   * "user"-scoped app routes through the scheduled-task-as-logged-in-user path.
   */
  installScope?: InstallScope | null;
  /**
   * "uninstall" (queue-payload-only, same as `installScope` — no `jobs` column):
   * the worker's live-response path uses this to pick the uninstall library
   * script/args instead of the upgrade one. Absent/"upgrade" = existing behaviour.
   */
  action?: RemediationAction | null;
  /**
   * Alternate repo a not-supported app is routed through (queue-payload-only,
   * same as `packageId` — no `jobs` column). When set alongside
   * `altPackageId`, the worker's live-response dispatch drives this source
   * instead of winget — see `RemediationJob.source` in queue.ts.
   */
  source?: PackageSource | "script" | null;
  /** Source-native package id (Chocolatey id / Store product id) / script_catalog.id for `source`. */
  altPackageId?: string | null;
  /** Device hostname at dispatch time, snapshotted for historical record. */
  deviceHostname?: string | null;
  /**
   * Resolved software display name at dispatch time (e.g. disk-path-resolved
   * "Google Chrome" vs "Microsoft Edge (Chromium-based)" for shared-engine
   * CVEs), snapshotted for historical record.
   */
  software?: string | null;
  /**
   * Caller-supplied batch id, minted once by the dispatch site and reused
   * across every job in the same multi-device dispatch. Omit for a
   * single-device dispatch so the job renders as a standalone row.
   */
  batchId?: string | null;
  /**
   * Engineer-chosen options for an `expedited-quality-update` dispatch
   * (queue-payload-only, same as `packageId` — no `jobs` column; see
   * `RemediationJob` in queue.ts for the full rationale).
   */
  qualityUpdateDisplayName?: string | null;
  qualityUpdateCatalogItemId?: string | null;
  qualityUpdateDaysUntilForcedReboot?: 0 | 1 | 2 | null;
}

const MAX_DEMO_JOBS = 200;

function rowToRecord(row: JobRow): JobRecord {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: row.id,
    tenantId: row.tenantId,
    deviceId: row.deviceId,
    cveId: row.cveId,
    coveredCveIds: row.coveredCveIds,
    kbId: row.kbId,
    featureUpdateVersion: row.featureUpdateVersion,
    deviceHostname: row.deviceHostname,
    software: row.software,
    channel: row.channel as RemediationChannel,
    status: row.status,
    engineer: row.engineer,
    exitCode: row.exitCode,
    output: row.output,
    queuedAt: (row.queuedAt as Date).toISOString(),
    startedAt: iso(row.startedAt as Date | null),
    finishedAt: iso(row.finishedAt as Date | null),
    archivedAt: iso(row.archivedAt as Date | null),
    script: row.script,
    packageId: row.packageId,
    installScope: row.installScope as InstallScope | null,
    action: row.action as RemediationAction | null,
    source: row.source as PackageSource | "script" | null,
    altPackageId: row.altPackageId,
    batchId: row.batchId,
    scheduleId: row.scheduleId,
  };
}

/** Newest-first in-memory job log used only in DEMO_MODE, seeded from fixtures. */
const demoJobLog: JobRecord[] = demoJobs
  .map(rowToRecord)
  .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));

/** Demo timing for the simulated lifecycle (kept snappy for the UI). */
const RUN_AFTER_MS = 800;
const FINISH_AFTER_MS = 3000;

function simulateExecution(id: string, script: string, delayMs = 0): void {
  // A deferred job stays visibly "queued" until its scheduled time, then runs
  // through the same simulated lifecycle — mirroring the real worker, which only
  // dispatches once BullMQ releases the delayed job.
  setTimeout(() => {
    const job = demoJobLog.find((j) => j.id === id);
    if (!job || job.status !== "queued") return;
    job.status = "running";
    job.startedAt = new Date().toISOString();
  }, delayMs + RUN_AFTER_MS).unref();

  setTimeout(() => {
    const job = demoJobLog.find((j) => j.id === id);
    if (!job || job.status === "succeeded" || job.status === "failed") return;
    job.status = "succeeded";
    job.exitCode = 0;
    job.finishedAt = new Date().toISOString();
    job.output = `[demo] Simulated execution — no Microsoft API was called.\n# This is the exact script that would run on the device:\n\n${script}`;
  }, delayMs + FINISH_AFTER_MS).unref();
}

/** Milliseconds until `scheduleAt`, floored at 0 (past/absent = run now). */
function deferralMs(scheduleAt?: string): number {
  if (!scheduleAt) return 0;
  const when = Date.parse(scheduleAt);
  if (Number.isNaN(when)) return 0;
  return Math.max(0, when - Date.now());
}

export async function createJob(input: NewJob): Promise<JobRecord> {
  const now = new Date().toISOString();
  const record: JobRecord = {
    id: randomUUID(),
    tenantId: input.tenantId,
    deviceId: input.deviceId,
    cveId: input.cveId,
    coveredCveIds: null,
    kbId: input.kbId ?? null,
    featureUpdateVersion: input.featureUpdateVersion ?? null,
    deviceHostname: input.deviceHostname ?? null,
    software: input.software ?? null,
    channel: input.channel,
    status: "queued",
    engineer: input.engineer,
    exitCode: null,
    output: null,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
    archivedAt: null,
    script: input.script,
    packageId: input.packageId ?? null,
    installScope: input.installScope ?? null,
    action: input.action ?? null,
    source: input.source ?? null,
    altPackageId: input.altPackageId ?? null,
    batchId: input.batchId ?? null,
    scheduleId: null,
  };

  const delayMs = deferralMs(input.scheduleAt);

  if (config.DEMO_MODE) {
    demoJobLog.unshift(record);
    if (demoJobLog.length > MAX_DEMO_JOBS) demoJobLog.length = MAX_DEMO_JOBS;
    simulateExecution(record.id, input.script, delayMs);
    return record;
  }

  // Production: persist the queued job, then enqueue it for the worker. The
  // worker resolves a delegated token and dispatches to the real channel at
  // execution time, re-checking the tenant's read-only posture before any write.
  const [row] = await db
    .insert(tables.jobs)
    .values({
      id: record.id,
      tenantId: record.tenantId,
      deviceId: record.deviceId,
      cveId: record.cveId,
      kbId: record.kbId,
      featureUpdateVersion: record.featureUpdateVersion,
      deviceHostname: record.deviceHostname,
      software: record.software,
      channel: record.channel,
      status: "queued",
      engineer: record.engineer,
      scheduleAt: input.scheduleAt ? new Date(input.scheduleAt) : null,
      script: record.script,
      packageId: record.packageId,
      installScope: record.installScope,
      action: record.action,
      source: record.source,
      altPackageId: record.altPackageId,
      batchId: record.batchId,
    })
    .returning();

  await remediationQueue.add(
    "remediate",
    {
      jobId: record.id,
      tenantId: record.tenantId,
      deviceId: record.deviceId,
      cveId: record.cveId,
      kbId: record.kbId,
      featureUpdateVersion: record.featureUpdateVersion,
      channel: record.channel,
      engineer: record.engineer,
      script: input.script,
      packageId: input.packageId ?? null,
      installScope: input.installScope ?? null,
      action: input.action ?? null,
      source: input.source ?? null,
      altPackageId: input.altPackageId ?? null,
      qualityUpdateDisplayName: input.qualityUpdateDisplayName ?? null,
      qualityUpdateCatalogItemId: input.qualityUpdateCatalogItemId ?? null,
      qualityUpdateDaysUntilForcedReboot: input.qualityUpdateDaysUntilForcedReboot ?? null,
    },
    // Defer dispatch when scheduled for later; BullMQ holds the job until the
    // delay elapses, then the worker mints a fresh token and re-checks posture.
    delayMs > 0 ? { delay: delayMs } : undefined,
  );

  return rowToRecord(row!);
}

export async function listJobs(
  tenantId?: string,
  includeArchived = false,
  /** Query-level "any of these tenants" constraint for the all-tenants case
   * (no single tenantId) — ignored when tenantId is set. */
  tenantIds?: string[],
): Promise<JobRecord[]> {
  if (config.DEMO_MODE) {
    return demoJobLog
      .filter((j) => (tenantId ? j.tenantId === tenantId : tenantIds ? tenantIds.includes(j.tenantId) : true))
      .filter((j) => (includeArchived ? true : !j.archivedAt));
  }

  const conditions = [
    tenantId ? eq(tables.jobs.tenantId, tenantId) : tenantIds ? inArray(tables.jobs.tenantId, tenantIds) : undefined,
    includeArchived ? undefined : isNull(tables.jobs.archivedAt),
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const rows = await db
    .select()
    .from(tables.jobs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(tables.jobs.queuedAt));
  return rows.map(rowToRecord);
}

export async function getJob(id: string): Promise<JobRecord | null> {
  if (config.DEMO_MODE) {
    return demoJobLog.find((j) => j.id === id) ?? null;
  }
  const [row] = await db
    .select()
    .from(tables.jobs)
    .where(eq(tables.jobs.id, id))
    .limit(1);
  return row ? rowToRecord(row) : null;
}

/** Soft-archive: hides the job from the default list view without losing history. */
export async function archiveJob(id: string): Promise<JobRecord | null> {
  const archivedAt = new Date().toISOString();
  if (config.DEMO_MODE) {
    const job = demoJobLog.find((j) => j.id === id);
    if (!job) return null;
    job.archivedAt = archivedAt;
    return job;
  }
  const [row] = await db
    .update(tables.jobs)
    .set({ archivedAt: new Date(archivedAt) })
    .where(eq(tables.jobs.id, id))
    .returning();
  return row ? rowToRecord(row) : null;
}

/** Restores a previously archived job to the default list view. */
export async function unarchiveJob(id: string): Promise<JobRecord | null> {
  if (config.DEMO_MODE) {
    const job = demoJobLog.find((j) => j.id === id);
    if (!job) return null;
    job.archivedAt = null;
    return job;
  }
  const [row] = await db
    .update(tables.jobs)
    .set({ archivedAt: null })
    .where(eq(tables.jobs.id, id))
    .returning();
  return row ? rowToRecord(row) : null;
}

/** Permanently removes a job. Returns false if no such job existed. */
export async function deleteJob(id: string): Promise<boolean> {
  if (config.DEMO_MODE) {
    const index = demoJobLog.findIndex((j) => j.id === id);
    if (index === -1) return false;
    demoJobLog.splice(index, 1);
    return true;
  }
  const rows = await db.delete(tables.jobs).where(eq(tables.jobs.id, id)).returning();
  return rows.length > 0;
}
