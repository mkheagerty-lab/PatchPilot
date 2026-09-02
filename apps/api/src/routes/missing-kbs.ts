import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  tables,
  demoTenants,
  demoDevices,
  demoMissingKbs,
  type TenantRow,
  type DeviceRow,
  type MissingKbRow,
  type IntuneAssignmentSummary,
} from "@patchpilot/db";
import {
  preflight,
  remediationScript,
  RemediationChannel,
  CHANNEL_SPECS,
  type PreflightInput,
} from "@patchpilot/shared";
import { config } from "../config.js";
import {
  audit,
  assertWritesAllowed,
  checkLiveResponseDeviceQuota,
  GraphError,
  listQualityUpdateCatalogItems,
  parseReleaseCadence,
  parseReleaseDate,
  catalogItemMatchesKb,
  createAndAssignQualityUpdateProfile,
} from "@patchpilot/graph";
import { createJob } from "../jobs.js";
import { validateScheduleAt } from "./jobs.js";
import { loadExcludedDeviceIndex, toPreflightDevice } from "./device-exclusions.js";
import { requirePermission } from "../auth/rbac.js";
import { resolveAssignmentTargets } from "../services/win32-app-deploy.js";

/**
 * Missing-KBs routes ("By OS" — Ask 4). Defender's per-device `getmissingkbs`
 * data, synced by `syncMissingKbs`, gives real KB-level detail distinct from
 * the single per-tenant "Microsoft Windows 11" recommendation row. Fix Now
 * here is the first caller in the codebase to pass a real `kbId` into
 * `remediationScript()`, replacing the always-losing "0000000" fallback.
 */

interface FixNowBody {
  tenantId?: string;
  id?: string;
  channel?: string;
  /** Optional ISO-8601 timestamp to defer this job to (one-shot scheduling). */
  scheduleAt?: string;
  /** Engineer-chosen options for an `expedited-quality-update` dispatch — see queue.ts's RemediationJob. */
  qualityUpdateDisplayName?: string;
  qualityUpdateCatalogItemId?: string;
  qualityUpdateDaysUntilForcedReboot?: number;
}

interface FixAllMissingKbBody {
  tenantId?: string;
  kbId?: string;
  channel?: string;
  /** Optional subset of device ids to fix; omitted means every device
   *  currently missing this KB. */
  deviceIds?: string[];
  /** Optional ISO-8601 timestamp to defer every created job to (one-shot scheduling). */
  scheduleAt?: string;
  /** Engineer-chosen options for an `expedited-quality-update` dispatch — see queue.ts's RemediationJob. */
  qualityUpdateDisplayName?: string;
  qualityUpdateCatalogItemId?: string;
  qualityUpdateDaysUntilForcedReboot?: number;
}

/** Validates the optional 0/1/2-day reboot-enforcement value; null if absent/valid. */
function validateDaysUntilForcedReboot(value: number | undefined): string | null {
  if (value === undefined) return null;
  return value === 0 || value === 1 || value === 2
    ? null
    : "qualityUpdateDaysUntilForcedReboot must be 0, 1, or 2";
}

/** One skipped device from a missing-KB Fix All run, with the reason it
 *  couldn't be dispatched. */
interface MissingKbFixAllSkip {
  label: string;
  reason: string;
}

interface QualityUpdateCampaignBody {
  tenantId?: string;
  displayName?: string;
  kbId?: string;
  catalogItemId?: string;
  /** The chosen release's displayName, frozen at creation time — same "don't
   *  reinterpret later" rationale as featureUpdateCampaigns.targetVersion. */
  releaseLabel?: string;
  daysUntilForcedReboot?: number;
  groupId?: string;
  groupName?: string;
  excludeGroupId?: string;
  excludeGroupName?: string;
}

/** One device's exposure to a grouped KB — carries the specific `missing_kbs`
 *  row id Fix Now needs (each device has its own row for the same kbId). */
interface KbGroupDevice {
  deviceId: string;
  hostname: string;
  missingKbId: string;
}

interface KbGroup {
  tenantId: string;
  kbId: string;
  title: string;
  products: string[];
  cveCount: number;
  cveIds: string[];
  url: string | null;
  deviceCount: number;
  devices: KbGroupDevice[];
  latestSyncedAt: string;
}

export async function missingKbRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("operations:read"));

  async function loadTenants(): Promise<TenantRow[]> {
    return config.DEMO_MODE ? demoTenants : db.select().from(tables.tenants);
  }
  async function loadDevices(): Promise<DeviceRow[]> {
    return config.DEMO_MODE ? demoDevices : db.select().from(tables.devices);
  }
  async function loadMissingKbs(tenantId?: string): Promise<MissingKbRow[]> {
    if (config.DEMO_MODE) {
      return tenantId ? demoMissingKbs.filter((k) => k.tenantId === tenantId) : demoMissingKbs;
    }
    const rows = await db.select().from(tables.missingKbs);
    return tenantId ? rows.filter((k) => k.tenantId === tenantId) : rows;
  }
  async function loadMissingKbById(tenantId: string, id: string): Promise<MissingKbRow | null> {
    if (config.DEMO_MODE) {
      return demoMissingKbs.find((k) => k.tenantId === tenantId && k.id === id) ?? null;
    }
    const [row] = await db
      .select()
      .from(tables.missingKbs)
      .where(and(eq(tables.missingKbs.tenantId, tenantId), eq(tables.missingKbs.id, id)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Tenant-wide rollup, grouped by `kbId` across devices — mirrors the
   * recommendations roll-up's "one row per finding, expand to see devices"
   * shape, but for real Windows Update KBs instead of Defender's single
   * per-tenant OS recommendation.
   */
  app.get<{ Querystring: { tenantId?: string } }>("/api/missing-kbs", async (req) => {
    const { tenantId } = req.query;

    const [allRows, devices, excluded] = await Promise.all([
      loadMissingKbs(tenantId),
      loadDevices(),
      loadExcludedDeviceIndex(tenantId),
    ]);
    const hostnameById = new Map(devices.map((d) => [d.id, d.hostname]));

    // `missing_kbs` is already one row per (device, KB), so dropping the excluded
    // devices' rows recomputes deviceCount exactly and removes any KB group that
    // was only missing on excluded devices — no count arithmetic needed.
    const rows = excluded.isEmpty
      ? allRows
      : allRows.filter((r) => !excluded.byDeviceId.has(r.deviceId));

    const groups = new Map<string, KbGroup>();
    // Different devices can report the same KB with slightly different
    // cveAddressed arrays (Defender's per-device snapshot); union them so
    // the group shows every CVE addressed by the KB anywhere in the fleet.
    const cveIdSets = new Map<string, Set<string>>();
    for (const row of rows) {
      const hostname = hostnameById.get(row.deviceId) ?? row.deviceId;
      const syncedAtIso = row.syncedAt.toISOString();
      const key = `${row.tenantId}:${row.kbId}`;
      // Defensive: older rows synced before cveIds normalization could have a
      // non-array value persisted; never let that crash the rollup.
      const rowCveIds = Array.isArray(row.cveIds) ? row.cveIds : [];
      const g = groups.get(key);
      if (!g) {
        groups.set(key, {
          tenantId: row.tenantId,
          kbId: row.kbId,
          title: row.title,
          products: row.products,
          cveCount: row.cveCount,
          cveIds: [],
          url: row.url,
          deviceCount: 1,
          devices: [{ deviceId: row.deviceId, hostname, missingKbId: row.id }],
          latestSyncedAt: syncedAtIso,
        });
        cveIdSets.set(key, new Set(rowCveIds));
        continue;
      }
      g.deviceCount += 1;
      g.devices.push({ deviceId: row.deviceId, hostname, missingKbId: row.id });
      if (syncedAtIso > g.latestSyncedAt) g.latestSyncedAt = syncedAtIso;
      for (const cve of rowCveIds) cveIdSets.get(key)!.add(cve);
    }
    for (const [key, g] of groups) {
      const cveSet = cveIdSets.get(key)!;
      g.cveIds = [...cveSet].sort();
      g.cveCount = cveSet.size || g.cveCount;
    }

    const result = [...groups.values()].sort(
      (a, b) => b.deviceCount - a.deviceCount || b.cveCount - a.cveCount,
    );
    return { missingKbs: result };
  });

  /** Per-device missing-KB list — the detail behind a device's "By OS" tab. */
  app.get<{ Params: { id: string } }>("/api/devices/:id/missing-kbs", async (req) => {
    const { id } = req.params;
    // An excluded device shows no missing KBs, matching Defender's device page.
    // All-tenants load: this route has no tenantId to scope by, and the uuid key
    // is the device itself.
    if ((await loadExcludedDeviceIndex()).byDeviceId.has(id)) return { missingKbs: [] };
    const rows = config.DEMO_MODE
      ? demoMissingKbs.filter((k) => k.deviceId === id)
      : await db.select().from(tables.missingKbs).where(eq(tables.missingKbs.deviceId, id));
    return { missingKbs: rows };
  });

  /**
   * Fix Now for a missing KB: builds a synthetic `PreflightVuln` from the
   * device's OS label (so `preflight`'s live `isOsFinding` classifier routes
   * it as an OS patch) and runs the same preflight/dispatch pipeline as
   * `/api/software-inventory/fix` and `POST /api/remediations` — but this is
   * the one place that finally threads a real `kbId` through
   * `remediationScript()`.
   */
  app.post<{ Body: FixNowBody }>(
    "/api/missing-kbs/fix",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
    const {
      tenantId,
      id,
      channel,
      scheduleAt,
      qualityUpdateDisplayName,
      qualityUpdateCatalogItemId,
      qualityUpdateDaysUntilForcedReboot,
    } = req.body ?? {};

    if (!tenantId || !id || !channel) {
      return reply.code(400).send({ error: "tenantId, id and channel are required" });
    }

    const parsedChannel = RemediationChannel.safeParse(channel);
    if (!parsedChannel.success) {
      return reply.code(400).send({ error: `unknown channel: ${channel}` });
    }

    const scheduleAtError = validateScheduleAt(scheduleAt);
    if (scheduleAtError) {
      return reply.code(400).send({ error: scheduleAtError });
    }

    const rebootError = validateDaysUntilForcedReboot(qualityUpdateDaysUntilForcedReboot);
    if (rebootError) {
      return reply.code(400).send({ error: rebootError });
    }

    const [tenants, devices, kbRow] = await Promise.all([
      loadTenants(),
      loadDevices(),
      loadMissingKbById(tenantId, id),
    ]);

    const tenant = tenants.find((t) => t.tenantId === tenantId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    if (!kbRow) return reply.code(404).send({ error: "missing KB not found" });

    const device = devices.find((d) => d.id === kbRow.deviceId);
    if (!device) return reply.code(404).send({ error: "device not found" });
    if (!device.defenderMachineId) {
      return reply.code(404).send({ error: "device has no Defender machine id" });
    }

    const input: PreflightInput = {
      channel: parsedChannel.data,
      tenant: {
        tenantId: tenant.tenantId,
        displayName: tenant.displayName,
        consentStatus: tenant.consentStatus,
        readOnly: tenant.readOnly,
        licenses: tenant.licenses,
      },
      vuln: {
        id: kbRow.id,
        title: kbRow.title,
        software: device.os ?? "Windows",
        severity: kbRow.cveCount > 0 ? "high" : "medium",
        wingetRemediable: false,
        wingetPackageId: null,
      },
      device: toPreflightDevice(device, await loadExcludedDeviceIndex(tenantId)),
      writeGate: await assertWritesAllowed(tenant),
      liveResponseQuota:
        parsedChannel.data === "live-response"
          ? await checkLiveResponseDeviceQuota(tenant.tenantId, device.id)
          : undefined,
    };

    const report = preflight(input);
    if (!report.canProceed) {
      return reply.code(422).send({ error: "preflight failed", report });
    }

    const script = remediationScript({
      channel: parsedChannel.data,
      wingetPackageId: null,
      kbId: kbRow.kbId,
      software: kbRow.title,
    });

    const engineer = req.session.engineer!.upn;
    const job = await createJob({
      tenantId: tenant.tenantId,
      deviceId: device.id,
      cveId: null,
      kbId: kbRow.kbId,
      channel: parsedChannel.data,
      engineer,
      script,
      scheduleAt,
      deviceHostname: device.hostname,
      software: kbRow.title,
      qualityUpdateDisplayName,
      qualityUpdateCatalogItemId,
      qualityUpdateDaysUntilForcedReboot: qualityUpdateDaysUntilForcedReboot as 0 | 1 | 2 | undefined,
    });

    await audit({
      engineer,
      tenantId: tenant.tenantId,
      endpoint: CHANNEL_SPECS[parsedChannel.data].endpointTemplate,
      method: "POST",
      action: "remediation:dispatch",
      resourceType: "missing-kb",
      resourceId: job.id,
      resourceLabel: `${kbRow.kbId} on ${device.hostname}`,
      summary: `Dispatched ${kbRow.kbId} (${kbRow.title}) to ${device.hostname} via ${parsedChannel.data}${scheduleAt ? ` scheduled for ${scheduleAt}` : ""}`,
      outcome: "success",
      payload: script,
      responseStatus: 202,
    });

    return reply.code(202).send({ job, script, report });
    },
  );

  /**
   * Bulk Fix Now for one KB group — dispatches the same preflight/dispatch
   * pipeline as `/api/missing-kbs/fix` across every device (or an explicit
   * subset) currently missing `kbId`, sharing one `batchId` so the Jobs page
   * groups them under a single expandable row. Mirrors
   * `/api/software-inventory/fix-all`'s shape, simplified: missing-KB targets
   * are already fully known rows, no winget/chocolatey package matching.
   */
  app.post<{ Body: FixAllMissingKbBody }>(
    "/api/missing-kbs/fix-all",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      const {
        tenantId,
        kbId,
        channel,
        deviceIds,
        scheduleAt,
        qualityUpdateDisplayName,
        qualityUpdateCatalogItemId,
        qualityUpdateDaysUntilForcedReboot,
      } = req.body ?? {};

      if (!tenantId || !kbId || !channel) {
        return reply.code(400).send({ error: "tenantId, kbId and channel are required" });
      }

      const parsedChannel = RemediationChannel.safeParse(channel);
      if (!parsedChannel.success) {
        return reply.code(400).send({ error: `unknown channel: ${channel}` });
      }
      if (!CHANNEL_SPECS[parsedChannel.data].supports.os) {
        return reply
          .code(400)
          .send({ error: `channel ${parsedChannel.data} does not support OS remediation` });
      }

      const scheduleAtError = validateScheduleAt(scheduleAt);
      if (scheduleAtError) {
        return reply.code(400).send({ error: scheduleAtError });
      }

      const rebootError = validateDaysUntilForcedReboot(qualityUpdateDaysUntilForcedReboot);
      if (rebootError) {
        return reply.code(400).send({ error: rebootError });
      }

      const [tenants, devices, excludedIndex, allKbRows] = await Promise.all([
        loadTenants(),
        loadDevices(),
        loadExcludedDeviceIndex(tenantId),
        loadMissingKbs(tenantId),
      ]);
      const tenant = tenants.find((t) => t.tenantId === tenantId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });

      const deviceIdSet = deviceIds && deviceIds.length > 0 ? new Set(deviceIds) : null;
      const kbRows = allKbRows.filter(
        (r) =>
          r.kbId === kbId &&
          !excludedIndex.byDeviceId.has(r.deviceId) &&
          (!deviceIdSet || deviceIdSet.has(r.deviceId)),
      );
      if (kbRows.length === 0) return reply.code(404).send({ error: "missing KB not found" });

      const devicesById = new Map(devices.map((d) => [d.id, d]));
      const engineer = req.session.engineer!.upn;
      const created: Awaited<ReturnType<typeof createJob>>[] = [];
      const skipped: MissingKbFixAllSkip[] = [];
      // One batchId per Fix All request, shared by every job it creates, so
      // the Jobs page can group them under a single expandable row.
      const batchId = randomUUID();
      // One tenant per Fix All request, so the write gate (readOnly + Black
      // Iron entitlement) doesn't change between items — hoisted for the same
      // reason as excludedIndex above.
      const writeGate = await assertWritesAllowed(tenant);

      for (const kbRow of kbRows) {
        const device = devicesById.get(kbRow.deviceId);
        if (!device) {
          skipped.push({ label: kbRow.deviceId, reason: "Device not found." });
          continue;
        }
        if (!device.defenderMachineId) {
          skipped.push({ label: device.hostname, reason: "Device has no Defender machine id." });
          continue;
        }

        const input: PreflightInput = {
          channel: parsedChannel.data,
          tenant: {
            tenantId: tenant.tenantId,
            displayName: tenant.displayName,
            consentStatus: tenant.consentStatus,
            readOnly: tenant.readOnly,
            licenses: tenant.licenses,
          },
          vuln: {
            id: kbRow.id,
            title: kbRow.title,
            software: device.os ?? "Windows",
            severity: kbRow.cveCount > 0 ? "high" : "medium",
            wingetRemediable: false,
            wingetPackageId: null,
          },
          device: toPreflightDevice(device, excludedIndex),
          writeGate,
          // Unlike writeGate above, this varies per item — each kbRow here is
          // a different device, so the quota answer isn't shared across the
          // batch the way jobs.ts's single-device Fix All can hoist it.
          liveResponseQuota:
            parsedChannel.data === "live-response"
              ? await checkLiveResponseDeviceQuota(tenant.tenantId, device.id)
              : undefined,
        };

        const report = preflight(input);
        if (!report.canProceed) {
          const failed = report.checks.find((c) => c.status === "fail");
          skipped.push({ label: device.hostname, reason: failed?.detail ?? "Preflight failed." });
          continue;
        }

        const script = remediationScript({
          channel: parsedChannel.data,
          wingetPackageId: null,
          kbId: kbRow.kbId,
          software: kbRow.title,
        });

        const job = await createJob({
          tenantId: tenant.tenantId,
          deviceId: device.id,
          cveId: null,
          kbId: kbRow.kbId,
          channel: parsedChannel.data,
          engineer,
          script,
          scheduleAt,
          deviceHostname: device.hostname,
          software: kbRow.title,
          batchId,
          qualityUpdateDisplayName,
          qualityUpdateCatalogItemId,
          qualityUpdateDaysUntilForcedReboot: qualityUpdateDaysUntilForcedReboot as 0 | 1 | 2 | undefined,
        });

        await audit({
          engineer,
          tenantId: tenant.tenantId,
          endpoint: CHANNEL_SPECS[parsedChannel.data].endpointTemplate,
          method: "POST",
          action: "remediation:fix-all",
          resourceType: "missing-kb",
          resourceId: job.id,
          resourceLabel: `${kbRow.kbId} on ${device.hostname}`,
          summary: `Dispatched ${kbRow.kbId} (${kbRow.title}) to ${device.hostname} via ${parsedChannel.data}${scheduleAt ? ` scheduled for ${scheduleAt}` : ""} (missing KBs fix all)`,
          outcome: "success",
          payload: script,
          responseStatus: 202,
        });

        created.push(job);
      }

      return reply.code(202).send({
        jobsCreated: created.length,
        jobs: created,
        skipped,
      });
    },
  );

  /**
   * Release picker for the Expedited Quality Update options panel. Intune's
   * own "Expedite Windows quality updates" wizard only ever offers the single
   * latest monthly (B) release and the single latest out-of-band (OOB)
   * release — not the tenant's entire historical catalog — so this reduces
   * the same way: filter to currently-expeditable B/OOB items, then keep only
   * the newest `displayName`-dated item per cadence (parsed via
   * `parseReleaseDate`, the only date signal that exists — see its docstring).
   * "unknown"-cadence items (e.g. "D"/Preview releases) are dropped entirely,
   * matching what Intune's wizard shows.
   */
  app.get<{ Params: { id: string }; Querystring: { tenantId?: string } }>(
    "/api/missing-kbs/:id/quality-update-releases",
    async (req, reply) => {
      const { id } = req.params;
      const { tenantId } = req.query ?? {};
      if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });

      const kbRow = await loadMissingKbById(tenantId, id);
      if (!kbRow) return reply.code(404).send({ error: "missing KB not found" });

      if (config.DEMO_MODE) return { releases: [] };

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;
      let items;
      try {
        items = await listQualityUpdateCatalogItems({ engineer, homeTenantId, tenantId });
      } catch (err) {
        // A failed catalog fetch (expired token, 429, transient 5xx) must never
        // come back as an empty release list — that reads in the UI as "this
        // tenant's catalog genuinely has no expeditable releases", which is a
        // materially different (and misleading) claim than "the fetch failed,
        // try again."
        const status = err instanceof GraphError ? err.status : 502;
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(status).send({ error: message });
      }

      const latestByCadence = new Map<"B" | "OOB", { item: (typeof items)[number]; date: Date | null }>();
      for (const item of items) {
        if (item.isExpeditable === false) continue;
        const cadence = parseReleaseCadence(item);
        if (cadence !== "B" && cadence !== "OOB") continue;
        const date = parseReleaseDate(item);
        const current = latestByCadence.get(cadence);
        // Undated items never win a tie against a dated one, and only replace
        // another undated item on first sight — never treat "unparseable" as
        // "newest".
        if (!current || (date && (!current.date || date > current.date))) {
          latestByCadence.set(cadence, { item, date });
        }
      }

      const releases = [...latestByCadence.values()].map(({ item }) => ({
        id: item.id,
        displayName: item.displayName ?? item.id,
        isExpeditable: item.isExpeditable !== false,
        cadence: parseReleaseCadence(item),
        matchesKbId: catalogItemMatchesKb(item, kbRow.kbId),
      }));
      return { releases };
    },
  );

  /**
   * Group-targeted Expedited Quality Update campaign — a direct synchronous
   * Graph write, not a job dispatch, mirroring
   * `POST /api/feature-updates/campaigns`'s shape exactly: tenant
   * existence/read-only checked directly, no `preflight()` (that function
   * models a per-device dispatch; a group campaign isn't one).
   */
  app.post<{ Body: QualityUpdateCampaignBody }>(
    "/api/missing-kbs/quality-update-campaigns",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "Quality update campaigns are unavailable in demo mode" });
      }
      const {
        tenantId,
        displayName,
        kbId,
        catalogItemId,
        releaseLabel,
        daysUntilForcedReboot,
        groupId,
        groupName,
        excludeGroupId,
        excludeGroupName,
      } = req.body ?? {};

      if (
        !tenantId ||
        !displayName?.trim() ||
        !kbId?.trim() ||
        !catalogItemId?.trim() ||
        !releaseLabel?.trim() ||
        !groupId?.trim() ||
        !groupName?.trim() ||
        daysUntilForcedReboot === undefined
      ) {
        return reply.code(400).send({
          error:
            "tenantId, displayName, kbId, catalogItemId, releaseLabel, daysUntilForcedReboot, groupId and groupName are required",
        });
      }
      if (![0, 1, 2].includes(daysUntilForcedReboot)) {
        return reply.code(400).send({ error: "daysUntilForcedReboot must be 0, 1 or 2" });
      }

      const [tenant] = await db.select().from(tables.tenants).where(eq(tables.tenants.tenantId, tenantId)).limit(1);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      if (tenant.readOnly) {
        return reply
          .code(403)
          .send({ error: "Tenant is read-only — opt in to write actions before creating a campaign." });
      }

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;

      let targets;
      try {
        targets = await resolveAssignmentTargets({
          mode: "group",
          groupId: groupId.trim(),
          excludeGroupId: excludeGroupId?.trim() || undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }

      let profileId: string;
      try {
        profileId = await createAndAssignQualityUpdateProfile({
          engineer,
          homeTenantId,
          tenantId,
          catalogItemId: catalogItemId.trim(),
          kbId: kbId.trim(),
          displayName: displayName.trim(),
          daysUntilForcedReboot: daysUntilForcedReboot as 0 | 1 | 2,
          targets,
        });
      } catch (err) {
        const status = err instanceof GraphError ? err.status : 502;
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(status).send({ error: message });
      }

      const assignments: IntuneAssignmentSummary[] = [
        { kind: "include", groupId: groupId.trim(), groupName: groupName.trim() },
      ];
      if (excludeGroupId?.trim()) {
        assignments.push({
          kind: "exclude",
          groupId: excludeGroupId.trim(),
          groupName: excludeGroupName?.trim() || undefined,
        });
      }

      const [campaign] = await db
        .insert(tables.qualityUpdateCampaigns)
        .values({
          tenantId,
          policyType: "expedite",
          source: "patchpilot",
          displayName: displayName.trim(),
          kbId: kbId.trim(),
          catalogItemId: catalogItemId.trim(),
          releaseLabel: releaseLabel.trim(),
          daysUntilForcedReboot,
          assignments,
          intuneProfileId: profileId,
          createdBy: engineer,
        })
        .returning();

      await audit({
        engineer,
        tenantId,
        endpoint: CHANNEL_SPECS["expedited-quality-update"].endpointTemplate,
        method: "POST",
        action: "quality-update-campaign:create",
        resourceType: "quality-update-campaign",
        resourceId: campaign!.id,
        resourceLabel: `${displayName} (KB${kbId} → ${groupName})`,
        summary: `Created quality update campaign "${displayName}" targeting KB${kbId} (${releaseLabel}) for group "${groupName}"`,
        outcome: "success",
        responseStatus: 201,
      });

      return reply.code(201).send({ campaign });
    },
  );
}
