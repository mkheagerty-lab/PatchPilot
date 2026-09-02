import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { auditSafe } from "@patchpilot/graph";
import { SYSTEM_ACTORS } from "@patchpilot/shared";
import type { RemediationJob } from "./queue.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "post-remediation" });

/**
 * How long after a successful remediation to ask the API to re-sync the tenant.
 *
 * Defender's vulnerability-management software inventory refreshes on its own
 * 3-4 hour cadence and Microsoft documents no way to force it, so a device can
 * be patched hours before Defender stops reporting the finding. PatchPilot's
 * hourly auto-sync would eventually notice but adds up to another hour on top.
 * These offsets straddle Defender's window so the clearing is picked up close to
 * when it actually happens; the 30-minute one is deliberately early because
 * inventory sometimes refreshes well inside the documented range.
 */
const RESYNC_OFFSETS_MS = [30 * 60_000, 2 * 3_600_000, 4 * 3_600_000, 6 * 3_600_000];

/**
 * The remediation script's own success line, e.g.
 *   PatchPilot: Google.Chrome upgraded '150.0.7871.184' -> '150.0.7871.187'.
 * (emitted by `Complete-PatchPilotRun -Code 0` in packages/shared/src/scripts.ts).
 * This is first-hand evidence from the device, available immediately — hours
 * ahead of anything Defender will say.
 */
const UPGRADE_LINE = /^PatchPilot:\s*(\S+)\s+upgraded\s+'([^']*)'\s*->\s*'([^']*)'\.?\s*$/gm;

/**
 * The script's other terminal-success line, e.g.
 *   PatchPilot: Zoom.Zoom is already at the newest version winget has available
 *   ('6.7.11228'); no update was applicable.
 * (emitted by `Complete-PatchPilotRun -Code 6` for winget's own
 * APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE — the device was already
 * compliant, nothing was upgraded). versionBefore is set equal to versionAfter
 * here, not left null: null means "before wasn't reported", which would read as
 * a fresh install rather than "confirmed already current" — callers distinguish
 * the two by comparing versionBefore to versionAfter.
 */
const ALREADY_CURRENT_LINE =
  /^PatchPilot:\s*(\S+)\s+is already at the newest version winget has available\s*\('([^']*)'\);\s*no update was applicable\.?\s*$/gm;

export type UpgradeEvidence = {
  packageId: string;
  versionBefore: string | null;
  versionAfter: string;
};

/**
 * Pulls the last terminal-success evidence line out of a job transcript. Last
 * rather than first: the transcript is an append-only progress log, so if a
 * run ever reports more than one, the final state is the one that's true now.
 * Checked in this order because the script only ever emits one or the other
 * (both call `exit`), so this just picks whichever is present.
 */
export function parseUpgradeEvidence(output: string): UpgradeEvidence | null {
  const upgraded = [...output.matchAll(UPGRADE_LINE)].at(-1);
  if (upgraded) {
    const [, packageId, before, after] = upgraded;
    if (packageId && after) return { packageId, versionBefore: before || null, versionAfter: after };
  }
  const alreadyCurrent = [...output.matchAll(ALREADY_CURRENT_LINE)].at(-1);
  if (alreadyCurrent) {
    const [, packageId, after] = alreadyCurrent;
    if (packageId && after) return { packageId, versionBefore: after, versionAfter: after };
  }
  return null;
}

/**
 * The MDVM software title of the finding that triggered a job — a second join
 * key for findings whose winget mapping is absent.
 *
 * A CVE is not enough on its own to identify one product: shared-engine CVEs
 * (Chromium, WebKit, OpenSSL) are reported by Defender once per affected title,
 * so "the row for this CVE" can be Edge's when the job upgraded Chrome. Storing
 * the wrong title here would make `lookupFix` annotate a *different, unpatched*
 * product on the device as fixed — so the title is only recorded when the winget
 * id ties it to what was actually upgraded, or when the CVE is unambiguous.
 * Returning null costs nothing: the winget id remains the primary join key.
 */
async function lookupSoftware(
  tenantId: string,
  cveId: string | null,
  packageId: string,
): Promise<string | null> {
  if (!cveId) return null;
  const rows = await db
    .select({
      software: tables.vulnerabilities.software,
      wingetPackageId: tables.vulnerabilities.wingetPackageId,
    })
    .from(tables.vulnerabilities)
    .where(
      and(
        eq(tables.vulnerabilities.tenantId, tenantId),
        eq(tables.vulnerabilities.cveId, cveId),
      ),
    );

  const matched = rows.find(
    (r) => r.wingetPackageId?.toLowerCase() === packageId.toLowerCase(),
  );
  if (matched) return matched.software;

  const titles = [...new Set(rows.map((r) => r.software))];
  return titles.length === 1 ? titles[0]! : null;
}

/**
 * Queue the catch-up syncs for one job, measured from when it finished.
 *
 * Offsets that have already elapsed are dropped rather than queued as due-now:
 * for a job finished within the last few minutes that's all of them, but when
 * this runs over an older job during backfill, a sync for a window that closed
 * hours ago would just duplicate work the hourly cycle has already done.
 */
async function queueResyncs(tenantId: string, jobId: string, finishedAtMs: number): Promise<void> {
  const now = Date.now();
  const due = RESYNC_OFFSETS_MS.map((offset) => finishedAtMs + offset).filter((at) => at > now);
  if (due.length === 0) return;
  await db.insert(tables.resyncRequests).values(
    due.map((at) => ({ tenantId, dueAt: new Date(at), reason: `job:${jobId}` })),
  );
}

/**
 * Records what a successful remediation proved and schedules the catch-up syncs
 * that will let Defender confirm it.
 *
 * Best-effort by design: this runs after the job has already reached its
 * terminal status, and a failure here must never change that verdict or throw
 * out of the BullMQ processor. Everything it writes is an annotation — Defender
 * remains the source of truth for whether a finding still exists.
 */
export async function recordRemediationSuccess(
  payload: RemediationJob,
  output: string,
): Promise<void> {
  const evidence = parseUpgradeEvidence(output);

  if (evidence && payload.deviceId) {
    await db.insert(tables.remediationVerifications).values({
      tenantId: payload.tenantId,
      deviceId: payload.deviceId,
      jobId: payload.jobId,
      packageId: evidence.packageId,
      software: await lookupSoftware(payload.tenantId, payload.cveId ?? null, evidence.packageId),
      cveId: payload.cveId,
      versionBefore: evidence.versionBefore,
      versionAfter: evidence.versionAfter,
      verifiedAt: new Date(),
    });

    // First-hand proof from the device, hours ahead of anything Defender will
    // say — and the only record of it other than a verification row nothing
    // else surfaces. Audited only when evidence actually existed; a transcript
    // with no upgrade line proved nothing worth recording.
    await auditSafe({
      engineer: SYSTEM_ACTORS.worker,
      actorType: "worker",
      tenantId: payload.tenantId,
      endpoint: "worker:remediation-verified",
      method: "VERIFY",
      action: "remediation:verified",
      resourceType: "job",
      resourceId: payload.jobId,
      resourceLabel: evidence.packageId,
      summary:
        evidence.versionBefore === evidence.versionAfter
          ? `${evidence.packageId} confirmed already current at ${evidence.versionAfter}`
          : `${evidence.packageId} upgraded ${evidence.versionBefore ?? "(unreported)"} → ${evidence.versionAfter}`,
      outcome: "success",
      detail: `dispatched by ${payload.engineer}`,
      responseStatus: 200,
    });
  }

  await queueResyncs(payload.tenantId, payload.jobId, Date.now());
}

/**
 * How far back to look for succeeded jobs whose evidence was never recorded.
 * Matches the window the device drill-down annotates within (FIXED_ON_DEVICE_-
 * WINDOW_MS in apps/api/src/routes/data.ts): recovering anything older would
 * write rows the UI can't render.
 */
const BACKFILL_WINDOW_MS = 24 * 3_600_000;

/**
 * Replays the evidence hook over recently succeeded jobs that have no
 * verification row — jobs that finished while this feature didn't exist yet, or
 * whose hook lost a race with a worker restart.
 *
 * Safe to run repeatedly: a job is a candidate only while nothing references it
 * in `remediation_verifications`, so a job whose transcript has no upgrade line
 * is skipped outright rather than re-queueing its syncs on every boot. The job
 * transcript is the only input, so this invents nothing that didn't already
 * happen on the device.
 */
export async function backfillMissedVerifications(): Promise<void> {
  const candidates = await db
    .select({
      id: tables.jobs.id,
      tenantId: tables.jobs.tenantId,
      deviceId: tables.jobs.deviceId,
      cveId: tables.jobs.cveId,
      output: tables.jobs.output,
      finishedAt: tables.jobs.finishedAt,
    })
    .from(tables.jobs)
    .leftJoin(
      tables.remediationVerifications,
      eq(tables.remediationVerifications.jobId, tables.jobs.id),
    )
    .where(
      and(
        eq(tables.jobs.status, "succeeded"),
        gt(tables.jobs.finishedAt, new Date(Date.now() - BACKFILL_WINDOW_MS)),
        isNull(tables.remediationVerifications.id),
      ),
    );

  let recovered = 0;
  for (const job of candidates) {
    const evidence = job.output ? parseUpgradeEvidence(job.output) : null;
    if (!evidence || !job.deviceId) continue;

    // Stamped with when the device actually reported the upgrade, not now — the
    // UI shows this time to the engineer and ages the annotation out by it.
    const verifiedAt = job.finishedAt ?? new Date();
    await db.insert(tables.remediationVerifications).values({
      tenantId: job.tenantId,
      deviceId: job.deviceId,
      jobId: job.id,
      packageId: evidence.packageId,
      software: await lookupSoftware(job.tenantId, job.cveId, evidence.packageId),
      cveId: job.cveId,
      versionBefore: evidence.versionBefore,
      versionAfter: evidence.versionAfter,
      verifiedAt,
    });
    await queueResyncs(job.tenantId, job.id, verifiedAt.getTime());
    recovered++;
  }

  if (recovered > 0) {
    log.info(`backfilled ${recovered} remediation verification(s) from job transcripts`);
    // Only when it recovered something. This runs on every worker boot and
    // normally finds nothing, so an unconditional row would be pure noise. One
    // row for the run, spanning whatever tenants the candidates belonged to.
    await auditSafe({
      engineer: SYSTEM_ACTORS.startup,
      actorType: "worker",
      tenantId: null,
      endpoint: "worker:verification-backfill",
      method: "VERIFY",
      action: "remediation:verified",
      resourceType: "job",
      summary: `Recovered ${recovered} remediation verification(s) from job transcripts on boot`,
      outcome: "success",
      detail: "jobs that succeeded while the post-run hook was unavailable",
      responseStatus: 200,
    });
  }
}

/**
 * How far back to look for unattributed remediation-history events. Wider
 * than BACKFILL_WINDOW_MS above: attribution requires the closing job to have
 * *finished*, then Defender to confirm the clear via a resync, and
 * RESYNC_OFFSETS_MS schedules those up to 6h after the job — so an event
 * whose real cause only becomes attributable well after it was first
 * recorded is still common a day later. 72h comfortably covers that lag
 * without rescanning the whole table on every boot.
 */
const ATTRIBUTION_BACKFILL_WINDOW_MS = 72 * 3_600_000;

function sameTitle(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Retroactively attributes `remediation_events` rows still tagged
 * `attribution: "unattributed"` to the job or manual record that most likely
 * closed them — a same-tenant, same-CVE-or-software match whose fix
 * timestamp falls inside the event's own [detectedAt, remediatedAt] window.
 *
 * This is a follow-up pass over `graph/attribution.ts`'s live matching at
 * prune time (apps/api), not a duplicate of it: that match runs inside the
 * pruning sync transaction and can only see what's already landed by then,
 * so a job that finishes (or a manual record that gets marked) shortly after
 * the finding is pruned is missed there and picked up here instead. The
 * worker can't import apps/api's module directly (apps never import each
 * other, only packages/*), so the matching heuristic — same CVE/software,
 * newest finishedAt wins, contributingJobs counts all matches — is mirrored
 * here rather than shared. One difference: the doomed vulnerability row is
 * already gone by backfill time, so there's no wingetPackageId left to
 * disambiguate a job match — title agreement (or a CVE-only fallback when
 * the job carries no software) is all that's available.
 *
 * Idempotent and safe to run on every boot: only rows still "unattributed"
 * are candidates, and a row with no match simply stays that way — this never
 * invents attribution the job/manual tables don't already support.
 */
export async function backfillRemediationAttribution(): Promise<void> {
  const since = new Date(Date.now() - ATTRIBUTION_BACKFILL_WINDOW_MS);

  const candidates = await db
    .select({
      id: tables.remediationEvents.id,
      tenantId: tables.remediationEvents.tenantId,
      cveId: tables.remediationEvents.cveId,
      software: tables.remediationEvents.software,
      detectedAt: tables.remediationEvents.detectedAt,
      remediatedAt: tables.remediationEvents.remediatedAt,
    })
    .from(tables.remediationEvents)
    .where(
      and(
        eq(tables.remediationEvents.attribution, "unattributed"),
        gt(tables.remediationEvents.remediatedAt, since),
      ),
    );

  if (candidates.length === 0) return;

  const tenantIds = [...new Set(candidates.map((c) => c.tenantId))];

  const manualRows = await db
    .select({
      tenantId: tables.manualRemediations.tenantId,
      deviceId: tables.manualRemediations.deviceId,
      cveId: tables.manualRemediations.cveId,
      software: tables.manualRemediations.software,
      engineer: tables.manualRemediations.engineer,
      markedAt: tables.manualRemediations.markedAt,
    })
    .from(tables.manualRemediations)
    .where(inArray(tables.manualRemediations.tenantId, tenantIds));

  const manualDeviceIds = [...new Set(manualRows.map((m) => m.deviceId))];
  const devices = manualDeviceIds.length
    ? await db
        .select({ id: tables.devices.id, hostname: tables.devices.hostname })
        .from(tables.devices)
        .where(inArray(tables.devices.id, manualDeviceIds))
    : [];
  const hostnameByDeviceId = new Map(devices.map((d) => [d.id, d.hostname]));

  const jobRows = await db
    .select({
      id: tables.jobs.id,
      tenantId: tables.jobs.tenantId,
      deviceId: tables.jobs.deviceId,
      deviceHostname: tables.jobs.deviceHostname,
      cveId: tables.jobs.cveId,
      coveredCveIds: tables.jobs.coveredCveIds,
      software: tables.jobs.software,
      channel: tables.jobs.channel,
      engineer: tables.jobs.engineer,
      queuedAt: tables.jobs.queuedAt,
      startedAt: tables.jobs.startedAt,
      finishedAt: tables.jobs.finishedAt,
    })
    .from(tables.jobs)
    .where(and(inArray(tables.jobs.tenantId, tenantIds), eq(tables.jobs.status, "succeeded")));

  let recovered = 0;
  for (const event of candidates) {
    // 1. manual — a record for this tenant + cveId + software, marked inside
    // the event's own exposure window.
    const manual = manualRows.find(
      (m) =>
        m.tenantId === event.tenantId &&
        !!event.cveId &&
        m.cveId === event.cveId &&
        sameTitle(m.software, event.software) &&
        m.markedAt >= event.detectedAt &&
        m.markedAt <= event.remediatedAt,
    );
    if (manual) {
      await db
        .update(tables.remediationEvents)
        .set({
          attribution: "manual",
          deviceId: manual.deviceId,
          deviceHostname: hostnameByDeviceId.get(manual.deviceId) ?? null,
          engineer: manual.engineer,
          fixStartedAt: manual.markedAt,
          fixFinishedAt: manual.markedAt,
        })
        .where(eq(tables.remediationEvents.id, event.id));
      recovered++;
      continue;
    }

    // 2. job — succeeded jobs for this tenant, matched on CVE + software (or
    // CVE-only when the job carries no software), finished inside the
    // event's exposure window. Newest finishedAt wins; contributingJobs
    // counts every match, since one Defender finding can span many devices.
    const jobCandidates = jobRows.filter((j) => {
      if (j.tenantId !== event.tenantId) return false;
      if (!j.finishedAt || j.finishedAt < event.detectedAt || j.finishedAt > event.remediatedAt) {
        return false;
      }
      if (event.cveId) {
        // See attribution.ts's live matcher for why coveredCveIds is checked
        // too: a schedule fan-out that consolidated several CVEs into one job
        // only stamps the primary CVE as `cveId`.
        if (j.cveId !== event.cveId && !j.coveredCveIds?.includes(event.cveId)) return false;
        return !j.software || sameTitle(j.software, event.software);
      }
      return sameTitle(j.software, event.software);
    });

    if (jobCandidates.length > 0) {
      jobCandidates.sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime());
      const best = jobCandidates[0]!;
      await db
        .update(tables.remediationEvents)
        .set({
          attribution: "job",
          deviceId: best.deviceId,
          deviceHostname: best.deviceHostname,
          engineer: best.engineer,
          jobId: best.id,
          channel: best.channel,
          fixStartedAt: best.startedAt ?? best.queuedAt,
          fixFinishedAt: best.finishedAt,
          contributingJobs: jobCandidates.length,
        })
        .where(eq(tables.remediationEvents.id, event.id));
      recovered++;
    }
  }

  if (recovered > 0) {
    log.info(`backfilled attribution for ${recovered} remediation event(s)`);
    await auditSafe({
      engineer: SYSTEM_ACTORS.startup,
      actorType: "worker",
      tenantId: null,
      endpoint: "worker:attribution-backfill",
      method: "VERIFY",
      action: "remediation:verified",
      summary: `Recovered attribution for ${recovered} remediation event(s) closed after the sync that pruned them`,
      outcome: "success",
      detail: "jobs/manual records that finished shortly after the live prune-time match ran",
      responseStatus: 200,
    });
  }
}
