import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import {
  preflight,
  remediationScript,
  matchesScheduleTarget,
  isDeviceInScheduleScope,
  isExclusionLive,
  isOsFinding,
  resolveDisplaySoftwareName,
  compareWingetVersions,
  altSourceFor,
  DEVICE_EXCLUSION_JUSTIFICATION_LABELS,
  SCHEDULE_QUEUE,
  SYSTEM_ACTORS,
  SEVERITY_RANK,
  type AuditOutcome,
  type PackageSource,
  type PreflightInput,
  type RemediationChannel,
  type ScheduleTarget,
} from "@patchpilot/shared";
import { sendAlertEmail } from "@patchpilot/shared/alerting";
import { assertWritesAllowed, auditSafe, env, hasCachedSession } from "@patchpilot/graph";
import { connection, remediationQueue } from "./queue.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "scheduler" });

/**
 * Recurring-schedule firing (Phase 5, Workstream C).
 *
 * A recurring schedule needs something to fire it on a cron, and that "something"
 * must outlive any browser session — the whole point of a schedule is that it
 * runs at 2am with nobody logged in. The api can't own this (it is request-driven
 * and may run multiple replicas, which would multiply the fire), so the worker
 * does: it is a single long-lived process and already owns delegated-token
 * resolution at execution time (Option C). This module gives it two halves:
 *
 *  1. **Reconciler** — periodically reads the enabled schedules from Postgres and
 *     materialises each one as a BullMQ *job scheduler* (cron) on SCHEDULE_QUEUE,
 *     keyed by the schedule id. Disabling or deleting a schedule in the api
 *     removes its scheduler on the next reconcile. This is how api-side CRUD
 *     (which performs no Redis work) reaches the cron clock.
 *
 *  2. **Fan-out worker** — when a scheduler fires, it enqueues a "fire" job; this
 *     worker loads the schedule, re-checks it is still enabled and that the tenant
 *     is still opted in to writes (read-only-first, re-checked at fire time), then
 *     filters the tenant's open vulnerabilities by the schedule's `target` and
 *     fans out one remediation job per matching (device, vuln) — each pre-flighted
 *     and attributed to the schedule's `engineer`, so the recurring run carries
 *     that engineer's delegated GDAP/OBO identity and audit trail.
 *
 * A schedule with no `engineer` (a row created before attribution existed) is
 * skipped rather than fired under an ambiguous identity.
 *
 * In DEMO_MODE the worker does no cron work at all — scheduling, like every other
 * Microsoft-touching path, is inert without real infrastructure.
 */

/** How often the reconciler re-syncs DB schedules to BullMQ job-schedulers. */
const RECONCILE_INTERVAL_MS = 30_000;

const scheduleQueue = new Queue(SCHEDULE_QUEUE, { connection });
// Same rationale as apps/worker/src/queue.ts: an unlistened "error" on a
// BullMQ Queue/Worker crashes the whole process, taking the job worker and
// its sweeps down with it even though this schedule queue is unrelated.
scheduleQueue.on("error", (err) => {
  log.error({ err }, "schedule queue error");
  void sendAlertEmail("worker", {
    key: "schedule-queue-error",
    subject: "Schedule queue error",
    body: `The recurring-schedule queue reported an error:\n\n${err.message}\n\nScheduled remediation fires may not be running.`,
  });
});

/**
 * Reconcile DB schedules -> BullMQ job-schedulers. Idempotent: upserting a
 * scheduler with the same id+pattern is a no-op, and any scheduler whose schedule
 * is no longer enabled (disabled, deleted, or cron made invalid) is removed.
 */
async function reconcileSchedules(): Promise<void> {
  const rows = await db
    .select()
    .from(tables.schedules)
    .where(eq(tables.schedules.enabled, true));

  // Only schedules with a cron AND an owning engineer are eligible to fire.
  const desired = new Map(
    rows
      .filter((r) => r.cron && r.engineer)
      .map((r) => [r.id, r] as const),
  );

  const existing = await scheduleQueue.getJobSchedulers(0, -1, true);
  const existingKeys = new Set(existing.map((s) => s.key));

  // Remove schedulers whose schedule is gone or no longer eligible.
  for (const key of existingKeys) {
    if (!desired.has(key)) {
      await scheduleQueue.removeJobScheduler(key);
      log.info({ scheduleId: key }, "removed job-scheduler (disabled/deleted)");
    }
  }

  // Upsert a scheduler per eligible schedule, keyed by the schedule id.
  for (const [id, schedule] of desired) {
    try {
      await scheduleQueue.upsertJobScheduler(
        id,
        { pattern: schedule.cron },
        { name: "fire", data: { scheduleId: id } },
      );
      if (!existingKeys.has(id)) {
        log.info(
          { scheduleId: id, scheduleName: schedule.name, cron: schedule.cron, tenantId: schedule.tenantId },
          "registered job-scheduler",
        );
      }
    } catch (err) {
      // A bad cron expression should not take down the reconcile loop.
      log.error({ err, scheduleId: id, cron: schedule.cron }, "failed to register schedule");
    }
  }
}

/**
 * Fan a fired schedule out into remediation jobs. Loads the schedule fresh (it
 * may have changed between fire and processing), re-checks posture, filters the
 * tenant's vulnerabilities by `target`, resolves affected devices via the
 * device⇄CVE join, pre-flights each (device, vuln) pair, and enqueues the ones
 * that pass onto the remediation queue under the schedule's engineer.
 */
async function fanOutSchedule(scheduleId: string): Promise<void> {
  const startedAt = Date.now();
  const [schedule] = await db
    .select()
    .from(tables.schedules)
    .where(eq(tables.schedules.id, scheduleId))
    .limit(1);

  /**
   * One row per fire, never one per enqueued job — a single schedule can fan out
   * into hundreds. Attribution follows the plan's rule: `actorType: "schedule"`
   * but the actor is the schedule's own engineer, so automated work still carries
   * the identity whose delegated token executes it.
   *
   * The `skipped` outcomes matter as much as the successful ones: a schedule that
   * silently does nothing because its tenant went read-only is precisely the
   * thing an audit log exists to make visible.
   */
  const auditFire = (
    outcome: AuditOutcome,
    summary: string,
    detail?: string | null,
  ): Promise<void> =>
    auditSafe({
      engineer: schedule?.engineer ?? SYSTEM_ACTORS.scheduler,
      actorType: "schedule",
      tenantId: schedule?.tenantId ?? null,
      endpoint: `schedule:fire:${scheduleId}`,
      method: "FIRE",
      action: "schedule:fire",
      resourceType: "schedule",
      resourceId: scheduleId,
      resourceLabel: schedule?.name ?? null,
      summary,
      outcome,
      detail: detail ?? null,
      responseStatus: outcome === "failure" ? 500 : 200,
      latencyMs: Date.now() - startedAt,
    });

  if (!schedule) {
    await auditFire("skipped", "Fire ignored — the schedule no longer exists");
    return;
  }
  if (!schedule.enabled) {
    // Disabled between the cron firing and this processor picking it up.
    await auditFire("skipped", `"${schedule.name}" fired but is disabled — no jobs enqueued`);
    return;
  }
  const fireLog = log.child({ scheduleId, scheduleName: schedule.name, tenantId: schedule.tenantId });

  if (!schedule.engineer) {
    fireLog.warn("schedule has no engineer — skipping fire");
    await auditFire(
      "skipped",
      `"${schedule.name}" fired but has no owning engineer — no jobs enqueued`,
      "a schedule created before engineer attribution existed cannot resolve a delegated token",
    );
    return;
  }
  // Cheap up-front check so the common failure mode (the owning engineer's
  // background-access credential is gone — see packages/graph/src/msal.ts) is
  // one clear audit row instead of every fanned-out job failing individually
  // deep in executor.ts with a buried "No cached session..." message.
  if (!(await hasCachedSession(schedule.engineer))) {
    fireLog.warn(
      { engineer: schedule.engineer },
      "fired — engineer has no cached background-access session",
    );
    await auditFire(
      "failure",
      `"${schedule.name}" fired but ${schedule.engineer} has no cached background-access session — no jobs enqueued`,
      "the schedule's owning engineer must sign in to PatchPilot to establish/renew a background-access session, or an admin should reassign the schedule to an engineer who has one",
    );
    return;
  }

  const [tenant] = await db
    .select()
    .from(tables.tenants)
    .where(eq(tables.tenants.tenantId, schedule.tenantId))
    .limit(1);
  if (!tenant) {
    fireLog.warn("fired — tenant not found");
    await auditFire(
      "skipped",
      `"${schedule.name}" fired but tenant ${schedule.tenantId} is not known — no jobs enqueued`,
    );
    return;
  }
  // Write-gate-first (readOnly + vendor entitlement), re-checked at fire
  // time. The executor re-checks again before any write, but skipping here
  // avoids enqueueing a sweep of jobs that would all be refused. Computed once
  // and reused below for every PreflightInput this fire builds — one tenant
  // per fire, so the answer can't change mid-fire.
  const writeGate = await assertWritesAllowed(tenant);
  if (!writeGate.allowed) {
    fireLog.info(
      { tenantDisplayName: tenant.displayName, reason: writeGate.reason },
      "skipped — write gate closed",
    );
    await auditFire(
      "skipped",
      `"${schedule.name}" fired but ${tenant.displayName}'s write gate is closed (${writeGate.reason}) — no jobs enqueued`,
    );
    return;
  }

  const target = (schedule.target ?? {}) as ScheduleTarget;
  const channel = schedule.channel as RemediationChannel;
  const engineer = schedule.engineer;

  // Device-group scoping: a group deleted out from under a schedule must not
  // silently widen the fire back out to every device — skip and audit instead.
  let groupMemberIds: Set<string> | null = null;
  if (target.deviceGroupId) {
    const [group] = await db
      .select()
      .from(tables.deviceGroups)
      .where(
        and(
          eq(tables.deviceGroups.id, target.deviceGroupId),
          eq(tables.deviceGroups.tenantId, schedule.tenantId),
        ),
      )
      .limit(1);
    if (!group) {
      fireLog.warn({ deviceGroupId: target.deviceGroupId }, "targets missing device group");
      await auditFire(
        "failure",
        `"${schedule.name}" fired but its target device group no longer exists — no jobs enqueued`,
        "the group was likely deleted after the schedule was scoped to it; edit the schedule's targeting to fix",
      );
      return;
    }
    const members = await db
      .select()
      .from(tables.deviceGroupMembers)
      .where(
        and(
          eq(tables.deviceGroupMembers.tenantId, schedule.tenantId),
          eq(tables.deviceGroupMembers.deviceGroupId, target.deviceGroupId),
        ),
      );
    groupMemberIds = new Set(members.map((m) => m.managedDeviceId));
  }

  // Catalog override: the same "4. Catalog" pick RunNowModal's own Automated
  // tab offers, carried onto the schedule so every fire dispatches that exact
  // package/script instead of re-resolving the tenant's live auto-match at
  // fire time. Only consulted when the schedule is scoped to one software
  // title (see ScheduleTarget's doc comment) and resolved once per fire, not
  // per device, since it applies identically to every (device, vuln) pair
  // this fire dispatches to.
  let overrideScript: string | null = null;
  let overrideSource: PackageSource | null = null;
  let overrideAltPackageId: string | null = null;
  let overrideWingetPackageId: string | null = null;
  if (target.software && target.scriptCatalogId) {
    const [row] = await db
      .select()
      .from(tables.scriptCatalog)
      .where(eq(tables.scriptCatalog.id, target.scriptCatalogId))
      .limit(1);
    // Missing, archived, or non-PowerShell (Intune Remediation is
    // PowerShell-only — see isDispatchableScript) all mean the pinned script
    // can no longer be dispatched as-is. Falling back to the tenant's live
    // auto-match would violate "only target what I selected," so the whole
    // fire is skipped instead, same as a deleted device group.
    if (!row || row.archivedAt || row.scriptType !== "powershell") {
      fireLog.warn(
        { scriptCatalogId: target.scriptCatalogId },
        "targets missing/unusable script catalog entry",
      );
      await auditFire(
        "failure",
        `"${schedule.name}" fired but its Script Catalog pick is no longer usable — no jobs enqueued`,
        "the script was deleted, archived, or is not PowerShell (the only type Intune Remediation can dispatch); edit the schedule's targeting to fix",
      );
      return;
    }
    overrideScript = row.scriptContent;
  } else if (target.software && target.source) {
    overrideSource = target.source;
    overrideAltPackageId =
      target.packageId?.trim() || altSourceFor(target.software, target.source)?.packageId || null;
  } else if (target.software && target.packageId) {
    overrideWingetPackageId = target.packageId;
  }
  const hasCatalogOverride = Boolean(overrideScript || overrideSource || overrideWingetPackageId);

  // "None" also sweeps software Defender never ran CVE matching against — see
  // the non-CVE sweep below. A schedule scoped to one specific software (see
  // ScheduleTarget.software) sweeps it the same way regardless of the
  // severity floor, since the point of "only target what I selected" is to
  // keep that one title patched whether or not Defender ever ran CVE matching
  // against it. OS patching has no non-CVE analogue (Missing KBs is its own
  // surface), so this only applies to app targets.
  const sweepNonCve = (target.severity === "none" || Boolean(target.software)) && target.patchType !== "os";

  // Filter the tenant's open vulnerabilities by the schedule's target.
  let vulns = await db
    .select()
    .from(tables.vulnerabilities)
    .where(
      and(
        eq(tables.vulnerabilities.tenantId, schedule.tenantId),
        eq(tables.vulnerabilities.status, "open"),
      ),
    );

  vulns = vulns.filter((v) => matchesScheduleTarget(v, target));

  if (vulns.length === 0 && !sweepNonCve) {
    fireLog.info("fired — no matching vulnerabilities");
    await auditFire(
      "skipped",
      `"${schedule.name}" fired — no open vulnerabilities matched its target`,
    );
    return;
  }

  // Resolve which devices each matching CVE affects, via the device⇄CVE join.
  // Device exclusions come along in the same round trip: an unattended 2am
  // fan-out is exactly the case where a device the engineer has written off
  // must not quietly get patched anyway. The api loads these through
  // loadExcludedDeviceIndex; the worker queries directly rather than importing
  // an api route module, but `isExclusionLive` is the same shared predicate, so
  // the two cannot drift on what "still excluded" means.
  const [links, devices, exclusions, wingetCatalog] = await Promise.all([
    db
      .select()
      .from(tables.deviceVulnerabilities)
      .where(eq(tables.deviceVulnerabilities.tenantId, schedule.tenantId)),
    db.select().from(tables.devices).where(eq(tables.devices.tenantId, schedule.tenantId)),
    db
      .select()
      .from(tables.deviceExclusions)
      .where(eq(tables.deviceExclusions.tenantId, schedule.tenantId)),
    db.select().from(tables.wingetCatalog),
  ]);

  const vulnByCve = new Map(vulns.map((v) => [v.cveId, v]));
  const deviceByMachine = new Map(
    devices.filter((d) => d.defenderMachineId).map((d) => [d.defenderMachineId!, d]),
  );
  const exclusionByManagedDeviceId = new Map(
    exclusions.filter((e) => isExclusionLive(e)).map((e) => [e.managedDeviceId, e]),
  );
  const wingetLatestById = new Map(wingetCatalog.map((c) => [c.packageId, c.latestVersion]));

  // Devices the CVE loop below already dispatched a job to this fire — only
  // consulted when the schedule is scoped to one software (target.software),
  // where the non-CVE freshness sweep intentionally ignores weaknessCount and
  // would otherwise double-dispatch a device the CVE loop already covered for
  // that exact same software.
  const dispatchedDeviceIds = new Set<string>();

  // One batchId per fire, shared by every job this fan-out enqueues, so the
  // Jobs page can group them under a single expandable row — minted here
  // rather than per-job, and left unused if the fire ends up enqueueing zero
  // jobs (nothing ever references an empty batch).
  const batchId = randomUUID();

  let enqueued = 0;
  let skipped = 0;
  let alreadyUpToDate = 0;
  let cvesCovered = 0;

  // Multiple open CVEs against the same software on one device resolve to an
  // identical dispatch — remediationScript()'s output never varies by CVE, so
  // patching the software once (e.g. one Live Response run) closes every CVE
  // riding on it. Group candidates by (device, resolved fix) before
  // dispatching so each device gets at most one job per distinct fix this
  // fire, instead of one job per CVE. Under a catalog override every
  // candidate this fire already resolves to the exact same pinned
  // package/script (see above — only reachable when target.software is set,
  // so every matching vuln already shares one software title), so the group
  // key collapses to just the device; otherwise it's the vuln's own winget
  // mapping (falling back to software title for an unmapped app, which still
  // produces one identical script per remediationScript()).
  type Candidate = {
    link: (typeof links)[number];
    vuln: (typeof vulns)[number];
    device: (typeof devices)[number];
  };
  const groups = new Map<string, Candidate[]>();
  for (const link of links) {
    const vuln = vulnByCve.get(link.cveId);
    const device = deviceByMachine.get(link.defenderMachineId);
    if (!vuln || !device) continue;
    if (!isDeviceInScheduleScope(device.managedDeviceId, target, groupMemberIds)) continue;

    // Smart targeting: local-DB-only freshness check, same signal as the
    // Software Inventory upToDate comparison (compareWingetVersions against
    // the winget catalog's latest version) — just fed from
    // `deviceVulnerabilities.softwareVersion`, the installed version already
    // captured for this exact (device, CVE) pair at last sync, and
    // `vuln.wingetPackageId`, already resolved at vulnerability-sync time. No
    // live Defender/Graph call, and no job row is created — a device that
    // patched itself between syncs (e.g. Chrome's own background updater)
    // shouldn't be redundantly re-dispatched by a weekly schedule.
    const latestVersion = vuln.wingetPackageId ? wingetLatestById.get(vuln.wingetPackageId) : null;
    if (
      link.softwareVersion &&
      latestVersion &&
      compareWingetVersions(link.softwareVersion, latestVersion) >= 0
    ) {
      alreadyUpToDate++;
      continue;
    }

    const fixKey = hasCatalogOverride
      ? "override"
      : (overrideWingetPackageId ?? vuln.wingetPackageId ?? `sw:${vuln.software}`);
    const groupKey = `${device.id}\x1f${fixKey}`;
    const bucket = groups.get(groupKey);
    if (bucket) bucket.push({ link, vuln, device });
    else groups.set(groupKey, [{ link, vuln, device }]);
  }

  for (const candidates of groups.values()) {
    // Most-severe CVE leads (and its title carries into remediationScript),
    // ties broken by cveId for determinism — no functional effect since every
    // candidate in a group already resolves to the same fix, just which CVE
    // is reported as the job's primary one.
    candidates.sort((a, b) => {
      const rankDiff = (SEVERITY_RANK[b.vuln.severity as keyof typeof SEVERITY_RANK] ?? 0) -
        (SEVERITY_RANK[a.vuln.severity as keyof typeof SEVERITY_RANK] ?? 0);
      return rankDiff !== 0 ? rankDiff : a.vuln.cveId.localeCompare(b.vuln.cveId);
    });
    const { vuln, device } = candidates[0]!;
    // The primary's own id is stored separately as `cveId` — this column is
    // only the *additional* CVEs riding along on the same dispatch.
    const coveredCveIds =
      candidates.length > 1 ? candidates.slice(1).map((c) => c.vuln.cveId) : null;

    const exclusion = exclusionByManagedDeviceId.get(device.managedDeviceId);

    const input: PreflightInput = {
      channel,
      source: overrideSource,
      altPackageId: overrideAltPackageId,
      manualScript: Boolean(overrideScript),
      writeGate,
      tenant: {
        tenantId: tenant.tenantId,
        displayName: tenant.displayName,
        consentStatus: tenant.consentStatus,
        readOnly: tenant.readOnly,
        licenses: tenant.licenses,
      },
      vuln: {
        id: vuln.id,
        title: vuln.title,
        software: vuln.software,
        severity: vuln.severity,
        wingetRemediable: vuln.wingetRemediable,
        wingetPackageId: overrideWingetPackageId ?? vuln.wingetPackageId,
      },
      device: {
        id: device.id,
        hostname: device.hostname,
        managedDeviceId: device.managedDeviceId,
        defenderMachineId: device.defenderMachineId,
        compliance: device.compliance,
        lastSeen: device.lastSeen ? (device.lastSeen as Date).toISOString() : null,
        excluded: Boolean(exclusion),
        exclusionReason: exclusion
          ? exclusion.notes
            ? `${DEVICE_EXCLUSION_JUSTIFICATION_LABELS[exclusion.justification]} — ${exclusion.notes}`
            : DEVICE_EXCLUSION_JUSTIFICATION_LABELS[exclusion.justification]
          : null,
      },
    };

    // Same authoritative gate the api route runs at request time.
    if (!preflight(input).canProceed) {
      skipped += candidates.length;
      continue;
    }

    const script =
      overrideScript ??
      remediationScript({
        channel,
        wingetPackageId: overrideWingetPackageId ?? vuln.wingetPackageId,
        software: vuln.software,
        source: overrideSource,
        altPackageId: overrideAltPackageId,
      });

    const jobId = randomUUID();
    await db.insert(tables.jobs).values({
      id: jobId,
      tenantId: schedule.tenantId,
      deviceId: device.id,
      cveId: vuln.cveId,
      coveredCveIds,
      channel,
      status: "queued",
      engineer,
      batchId,
      scheduleId: schedule.id,
      packageId: overrideWingetPackageId,
      source: overrideSource,
      altPackageId: overrideAltPackageId,
    });

    await remediationQueue.add("remediate", {
      jobId,
      tenantId: schedule.tenantId,
      deviceId: device.id,
      cveId: vuln.cveId,
      channel,
      engineer,
      script,
    });
    dispatchedDeviceIds.add(device.id);
    enqueued++;
    cvesCovered += candidates.length;
  }

  // Non-CVE sweep: software Defender detected but never ran CVE/weakness
  // matching against, so it can never appear in `tables.vulnerabilities` — the
  // loop above structurally cannot reach it regardless of severity floor.
  // "None" opts a schedule into also catching this, using PatchPilot's own
  // pre-resolved winget match (softwareInventory.matchedPackageId), the same
  // signal Software Inventory's manual Fix button uses. `weaknessCount === 0`
  // is Defender's own signal for "no CVE matching ran," which keeps this sweep
  // from double-dispatching software the CVE-based loop above already covered.
  let nonCveEnqueued = 0;
  let nonCveSkipped = 0;
  let nonCveUpToDate = 0;
  if (sweepNonCve) {
    const [softwareRows, deviceSoftwareRows] = await Promise.all([
      db
        .select()
        .from(tables.softwareInventory)
        .where(eq(tables.softwareInventory.tenantId, schedule.tenantId)),
      db
        .select()
        .from(tables.deviceSoftware)
        .where(eq(tables.deviceSoftware.tenantId, schedule.tenantId)),
    ]);

    const softwareById = new Map(softwareRows.map((s) => [s.softwareId, s]));
    // Unscoped ("None") sweeps: only software Defender never ran CVE matching
    // against — weaknessCount === 0 keeps this mutually exclusive with the
    // CVE loop above, since a software row is either one or the other, never
    // both. Software-scoped (target.software set): match by exact title
    // instead, regardless of weaknessCount — the point is to catch this one
    // title whether or not it happens to carry an open CVE right now. That
    // reintroduces overlap with the CVE loop, handled below via
    // dispatchedDeviceIds.
    const qualifyingSoftwareIds = new Set(
      softwareRows
        .filter((s) => {
          if (target.software) {
            if (s.name !== target.software) return false;
            // A catalog override (Chocolatey/Microsoft Store/Script Catalog)
            // lets this schedule dispatch to a title winget never
            // auto-matched — the same "not supported" case RunNowModal's own
            // "4. Catalog" picker exists to cover for a one-off run. Only the
            // un-overridden default still needs a winget auto-match to know
            // what to install.
            if (hasCatalogOverride) return true;
            return (
              Boolean(s.matchedPackageId) &&
              s.matchedPackageSource === "winget" &&
              Boolean(s.matchedLatestVersion)
            );
          }
          if (!s.matchedPackageId || s.matchedPackageSource !== "winget" || !s.matchedLatestVersion) {
            return false;
          }
          return s.weaknessCount === 0;
        })
        .map((s) => s.softwareId),
    );

    for (const ds of deviceSoftwareRows) {
      if (!qualifyingSoftwareIds.has(ds.softwareId)) continue;
      const inv = softwareById.get(ds.softwareId);
      if (!inv) continue;
      if (!hasCatalogOverride && (!inv.matchedPackageId || !inv.matchedLatestVersion)) continue;
      if (isOsFinding(ds.name)) continue;

      const device = deviceByMachine.get(ds.defenderMachineId);
      if (!device) continue;
      if (target.software && dispatchedDeviceIds.has(device.id)) continue;
      if (!isDeviceInScheduleScope(device.managedDeviceId, target, groupMemberIds)) continue;

      if (
        inv.matchedLatestVersion &&
        ds.version &&
        compareWingetVersions(ds.version, inv.matchedLatestVersion) >= 0
      ) {
        nonCveUpToDate++;
        continue;
      }

      const exclusion = exclusionByManagedDeviceId.get(device.managedDeviceId);
      const displayName = resolveDisplaySoftwareName(ds.name, ds.diskPaths);

      const input: PreflightInput = {
        channel,
        source: overrideSource,
        altPackageId: overrideAltPackageId,
        manualScript: Boolean(overrideScript),
        writeGate,
        tenant: {
          tenantId: tenant.tenantId,
          displayName: tenant.displayName,
          consentStatus: tenant.consentStatus,
          readOnly: tenant.readOnly,
          licenses: tenant.licenses,
        },
        vuln: {
          id: inv.id,
          title: displayName,
          software: displayName,
          severity: "low",
          wingetRemediable: true,
          wingetPackageId: overrideWingetPackageId ?? inv.matchedPackageId,
        },
        device: {
          id: device.id,
          hostname: device.hostname,
          managedDeviceId: device.managedDeviceId,
          defenderMachineId: device.defenderMachineId,
          compliance: device.compliance,
          lastSeen: device.lastSeen ? (device.lastSeen as Date).toISOString() : null,
          excluded: Boolean(exclusion),
          exclusionReason: exclusion
            ? exclusion.notes
              ? `${DEVICE_EXCLUSION_JUSTIFICATION_LABELS[exclusion.justification]} — ${exclusion.notes}`
              : DEVICE_EXCLUSION_JUSTIFICATION_LABELS[exclusion.justification]
            : null,
        },
      };

      if (!preflight(input).canProceed) {
        nonCveSkipped++;
        continue;
      }

      const script =
        overrideScript ??
        remediationScript({
          channel,
          wingetPackageId: overrideWingetPackageId ?? inv.matchedPackageId,
          software: displayName,
          source: overrideSource,
          altPackageId: overrideAltPackageId,
        });

      const jobId = randomUUID();
      await db.insert(tables.jobs).values({
        id: jobId,
        tenantId: schedule.tenantId,
        deviceId: device.id,
        cveId: null,
        channel,
        status: "queued",
        engineer,
        batchId,
        scheduleId: schedule.id,
        software: displayName,
        deviceHostname: device.hostname,
        packageId: overrideWingetPackageId ?? inv.matchedPackageId,
        source: overrideSource,
        altPackageId: overrideAltPackageId,
      });

      await remediationQueue.add("remediate", {
        jobId,
        tenantId: schedule.tenantId,
        deviceId: device.id,
        cveId: null,
        channel,
        engineer,
        script,
      });
      nonCveEnqueued++;
    }
  }

  const totalEnqueued = enqueued + nonCveEnqueued;
  const totalSkipped = skipped + nonCveSkipped;
  const totalUpToDate = alreadyUpToDate + nonCveUpToDate;

  fireLog.info(
    { totalEnqueued, nonCveEnqueued, totalSkipped, totalUpToDate },
    "fire complete",
  );

  const detailParts = [
    cvesCovered > enqueued
      ? `${cvesCovered} open CVE(s) consolidated into ${enqueued} job(s) (same fix, one dispatch per device)`
      : null,
    skipped > 0 ? `${skipped} (device, CVE) pair(s) refused by preflight` : null,
    alreadyUpToDate > 0 ? `${alreadyUpToDate} (device, CVE) pair(s) already up to date` : null,
    nonCveEnqueued > 0 ? `${nonCveEnqueued} non-CVE software job(s) enqueued` : null,
    nonCveSkipped > 0 ? `${nonCveSkipped} non-CVE (device, software) pair(s) refused by preflight` : null,
    nonCveUpToDate > 0 ? `${nonCveUpToDate} non-CVE (device, software) pair(s) already up to date` : null,
  ].filter((p): p is string => p !== null);

  await auditFire(
    // A fire that preflight refused in part still enqueued what it could; one
    // that enqueued nothing at all did no work despite having candidates.
    // Devices already up to date are the schedule working correctly, not a
    // reason to mark the fire partial or skipped on their own — a fire that
    // enqueued nothing solely because every candidate was already patched is
    // a successful no-op, not a blocked one.
    totalEnqueued === 0
      ? totalUpToDate > 0 && totalSkipped === 0
        ? "success"
        : "skipped"
      : totalSkipped > 0
        ? "partial"
        : "success",
    `"${schedule.name}" fired — enqueued ${totalEnqueued} ${channel} job(s) across ${tenant.displayName}`,
    detailParts.length > 0 ? detailParts.join("; ") : null,
  );
}

let reconcileTimer: NodeJS.Timeout | undefined;
let scheduleWorker: Worker | undefined;

/**
 * Start the schedule reconciler + fan-out worker. No-op in DEMO_MODE. Returns a
 * stop function for graceful shutdown.
 */
export function startScheduler(): () => Promise<void> {
  if (env.DEMO_MODE) {
    log.info("DEMO_MODE — recurring schedules are inert");
    return async () => {};
  }

  scheduleWorker = new Worker(
    SCHEDULE_QUEUE,
    async (job) => {
      const scheduleId = (job.data as { scheduleId?: string }).scheduleId;
      if (!scheduleId) return;
      await fanOutSchedule(scheduleId);
    },
    { connection, concurrency: 1 },
  );
  scheduleWorker.on("failed", (job, err) => {
    log.error({ fireJobId: job?.id, err }, "fire failed");
    void sendAlertEmail("worker", {
      key: "schedule-fire-failed",
      subject: "A recurring schedule fire failed",
      body: `Schedule fire job ${job?.id ?? "(unknown)"} failed:\n\n${err.message}`,
    });
  });
  scheduleWorker.on("error", (err) => {
    log.error({ err }, "fire worker error");
    void sendAlertEmail("worker", {
      key: "schedule-fire-worker-error",
      subject: "Schedule fire worker error",
      body: `The schedule fire worker reported an error:\n\n${err.message}`,
    });
  });

  // Reconcile immediately, then on an interval to pick up api-side CRUD.
  void reconcileSchedules().catch((err) => log.error({ err }, "initial reconcile failed"));
  reconcileTimer = setInterval(() => {
    void reconcileSchedules().catch((err) => log.error({ err }, "reconcile failed"));
  }, RECONCILE_INTERVAL_MS);

  log.info("started — reconciling recurring schedules");

  return async () => {
    if (reconcileTimer) clearInterval(reconcileTimer);
    await scheduleWorker?.close();
  };
}
