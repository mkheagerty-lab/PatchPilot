import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  tables,
  demoTenants,
  demoDevices,
  demoSoftwareInventory,
  demoDeviceSoftware,
  type TenantRow,
  type DeviceRow,
  type SoftwareInventoryRow,
  type DeviceSoftwareRow,
} from "@patchpilot/db";
import {
  preflight,
  remediationScript,
  winGetAppDeployPreview,
  RemediationChannel,
  CHANNEL_SPECS,
  PackageSource,
  detectInstallScope,
  resolveDisplaySoftwareName,
  isOsFinding,
  alignVersionDisplay,
  compareWingetVersions,
  type PreflightInput,
  type InstallScope,
  type RemediationAction,
} from "@patchpilot/shared";
import { config } from "../config.js";
import {
  buildWingetMatcher,
  buildChocolateyMatcher,
  loadWingetCatalog,
  loadChocolateyCatalog,
  resolveAltSources,
  resolveAltSource,
} from "../catalog/matching.js";
import { audit, assertWritesAllowed, checkLiveResponseDeviceQuota } from "@patchpilot/graph";
import { createJob } from "../jobs.js";
import {
  validateScheduleAt,
  runWin32Deploy,
  runWinGetAppDeploy,
  type Win32DeployBody,
  type Win32DeployOptions,
  type WinGetAppDeployBody,
} from "./jobs.js";
import {
  loadExcludedDeviceIndex,
  toPreflightDevice,
  type ExcludedDeviceIndex,
} from "./device-exclusions.js";
import { requirePermission } from "../auth/rbac.js";
import { deployOrReuseWin32App, Win32DeployError } from "../services/win32-app-deploy.js";
import type { Win32Source } from "@patchpilot/shared";

/**
 * Software Inventory routes (Phase 5, Ask 3) — Defender's full per-tenant
 * software inventory (not just software with an open CVE finding), with a
 * per-software device drill-down and a Fix Now action that mirrors
 * `POST /api/remediations`'s preflight/dispatch pipeline against a synthetic
 * finding built from the inventory row instead of a real CVE.
 */

/** Validated request-body actions — mirrors RemediationAction, "upgrade" is the default. */
const REMEDIATION_ACTIONS = new Set<RemediationAction>(["upgrade", "uninstall"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FixNowBody {
  tenantId?: string;
  softwareId?: string;
  deviceId?: string;
  channel?: string;
  source?: string;
  /**
   * True when the engineer actually saw and used the "4. Catalog" picker
   * (Run Now dialog) — including when that choice is Winget, which serializes
   * `source` as null just like "no choice made". Suppresses the per-user-install
   * auto-route-to-Chocolatey heuristic so an explicit Winget pick is never
   * silently overridden.
   */
  sourceExplicit?: boolean;
  packageId?: string;
  /** Optional ISO-8601 timestamp to defer execution to (one-shot scheduling). */
  scheduleAt?: string;
  /** "upgrade" (default) or "uninstall" — mirrors RemediateBody.action in routes/jobs.ts. */
  action?: string;
  /** Engineer-supplied script that replaces the generated one — mirrors RemediateBody.manualScript. */
  manualScript?: string;
  /** Caller-supplied batch id — mirrors RemediateBody.batchId in routes/jobs.ts. */
  batchId?: string;
  /** Mirrors RemediateBody.win32Deploy in routes/jobs.ts — see runWin32Deploy. */
  win32Deploy?: Win32DeployBody;
  /** Mirrors RemediateBody.storeAppDeploy in routes/jobs.ts — see runWinGetAppDeploy. */
  storeAppDeploy?: WinGetAppDeployBody;
}

/** Body shared by the preflight-preview route below — same shape minus `scheduleAt`. */
interface PreflightBody {
  tenantId?: string;
  softwareId?: string;
  deviceId?: string;
  channel?: string;
  source?: string;
  sourceExplicit?: boolean;
  packageId?: string;
  action?: string;
  manualScript?: string;
  /** Mirrors RemediateBody.storeAppDeploy in routes/jobs.ts — see runWinGetAppDeploy. */
  storeAppDeploy?: WinGetAppDeployBody;
}

export async function softwareInventoryRoutes(app: FastifyInstance): Promise<void> {
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
  async function loadInventory(tenantId: string): Promise<SoftwareInventoryRow[]> {
    if (config.DEMO_MODE) return demoSoftwareInventory.filter((s) => s.tenantId === tenantId);
    return db.select().from(tables.softwareInventory).where(eq(tables.softwareInventory.tenantId, tenantId));
  }
  async function loadDeviceSoftware(tenantId: string, softwareId: string): Promise<DeviceSoftwareRow[]> {
    if (config.DEMO_MODE) {
      return demoDeviceSoftware.filter((d) => d.tenantId === tenantId && d.softwareId === softwareId);
    }
    return db
      .select()
      .from(tables.deviceSoftware)
      .where(and(eq(tables.deviceSoftware.tenantId, tenantId), eq(tables.deviceSoftware.softwareId, softwareId)));
  }
  async function loadDeviceSoftwareByMachine(
    tenantId: string,
    defenderMachineId: string,
  ): Promise<DeviceSoftwareRow[]> {
    if (config.DEMO_MODE) {
      return demoDeviceSoftware.filter(
        (d) => d.tenantId === tenantId && d.defenderMachineId === defenderMachineId,
      );
    }
    return db
      .select()
      .from(tables.deviceSoftware)
      .where(
        and(
          eq(tables.deviceSoftware.tenantId, tenantId),
          eq(tables.deviceSoftware.defenderMachineId, defenderMachineId),
        ),
      );
  }

  /**
   * `deviceSoftware` rows belonging to excluded devices, counted per software id.
   *
   * Only the excluded machines are queried, so this stays cheap however large the
   * tenant's inventory is — one row per (excluded device × installed product).
   */
  async function excludedInstallCounts(
    tenantId: string,
    excluded: ExcludedDeviceIndex,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (excluded.isEmpty) return counts;
    const machineIds = [...excluded.byMachineId.keys()];
    if (machineIds.length === 0) return counts;

    const rows: { softwareId: string }[] = config.DEMO_MODE
      ? demoDeviceSoftware.filter(
          (d) => d.tenantId === tenantId && machineIds.includes(d.defenderMachineId),
        )
      : await db
          .select({ softwareId: tables.deviceSoftware.softwareId })
          .from(tables.deviceSoftware)
          .where(
            and(
              eq(tables.deviceSoftware.tenantId, tenantId),
              inArray(tables.deviceSoftware.defenderMachineId, machineIds),
            ),
          );

    for (const r of rows) counts.set(r.softwareId, (counts.get(r.softwareId) ?? 0) + 1);
    return counts;
  }

  /** List a tenant's full Defender software inventory (Ask 3's landing list). */
  app.get<{ Querystring: { tenantId?: string } }>("/api/software-inventory", async (req, reply) => {
    const { tenantId } = req.query;
    if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });
    const inventory = await loadInventory(tenantId);

    const excluded = await loadExcludedDeviceIndex(tenantId);
    if (excluded.isEmpty) return { softwareInventory: inventory };

    // Subtract, never recompute: installedMachinesCount/exposedMachinesCount are
    // Defender's own numbers and `deviceSoftware` is a sparser local view of the
    // same fleet, so replacing them would understate real inventory. Every
    // excluded machine with a row for this product is genuinely one of the
    // machines Defender counted, so subtracting yields a safe lower bound. A
    // product installed only on excluded devices drops out entirely.
    const excludedCounts = await excludedInstallCounts(tenantId, excluded);
    const adjusted = inventory.flatMap((s) => {
      const gone = excludedCounts.get(s.softwareId) ?? 0;
      if (gone === 0) return [s];
      const installedMachinesCount = Math.max(0, s.installedMachinesCount - gone);
      if (s.installedMachinesCount > 0 && installedMachinesCount === 0) return [];
      return [
        {
          ...s,
          installedMachinesCount,
          exposedMachinesCount: Math.min(
            Math.max(0, s.exposedMachinesCount - gone),
            installedMachinesCount,
          ),
        },
      ];
    });
    return { softwareInventory: adjusted };
  });

  /**
   * Per-software device drill-down: which devices have it installed, at what
   * version, in what context, and what winget/Chocolatey latest version it
   * resolves to. Context is recomputed live from disk/registry evidence per
   * device (never trusted off the frozen `softwareInventory.context` summary
   * or the sync-time `deviceSoftware` row) so the UI matches what a Fix Now
   * dispatch would actually see.
   */
  app.get<{ Params: { softwareId: string }; Querystring: { tenantId?: string } }>(
    "/api/software-inventory/:softwareId/devices",
    async (req, reply) => {
      const { tenantId } = req.query;
      const { softwareId } = req.params;
      if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });

      const [devices, allRows, wingetCatalog, chocolateyCatalog, wingetMatcher, chocolateyMatcher, excluded] =
        await Promise.all([
          loadDevices(),
          loadDeviceSoftware(tenantId, softwareId),
          loadWingetCatalog(),
          loadChocolateyCatalog(),
          buildWingetMatcher(),
          buildChocolateyMatcher(),
          loadExcludedDeviceIndex(tenantId),
        ]);
      if (allRows.length === 0) return reply.code(404).send({ error: "software not found" });
      // Filtered after the 404 so "every device with it is excluded" reads as an
      // empty drill-down rather than a product that doesn't exist.
      const rows = excluded.isEmpty
        ? allRows
        : allRows.filter((r) => !excluded.byMachineId.has(r.defenderMachineId));

      const wingetLatestById = new Map(wingetCatalog.map((c) => [c.packageId, c.latestVersion]));
      const chocolateyLatestById = new Map(chocolateyCatalog.map((c) => [c.packageId, c.latestVersion]));

      const deviceByMachineId = new Map(devices.filter((d) => d.defenderMachineId).map((d) => [d.defenderMachineId as string, d]));

      const items = rows.map((row) => {
        const device = deviceByMachineId.get(row.defenderMachineId) ?? null;
        const installScope: InstallScope = detectInstallScope(row.diskPaths, row.registryPaths);
        const wingetMatch = wingetMatcher(tenantId, row.name);
        const chocolateyMatch = chocolateyMatcher(tenantId, row.name);
        const rawLatestVersion = wingetMatch
          ? (wingetLatestById.get(wingetMatch.packageId) ?? null)
          : chocolateyMatch
            ? (chocolateyLatestById.get(chocolateyMatch.packageId) ?? null)
            : null;
        const { detected: detectedVersion, latest: latestVersion } = alignVersionDisplay(
          row.version,
          rawLatestVersion,
        );
        const upToDate = Boolean(
          detectedVersion && latestVersion && compareWingetVersions(detectedVersion, latestVersion) >= 0,
        );
        return {
          deviceId: device?.id ?? null,
          hostname: device?.hostname ?? row.defenderMachineId,
          defenderMachineId: row.defenderMachineId,
          detectedVersion,
          installScope,
          latestVersion,
          upToDate,
          wingetPackageId: wingetMatch?.packageId ?? null,
          chocolateyPackageId: chocolateyMatch?.packageId ?? null,
          fixable: Boolean(wingetMatch || chocolateyMatch),
          diskPaths: row.diskPaths ?? [],
          registryPaths: row.registryPaths ?? [],
        };
      });

      return { softwareId, name: allRows[0]!.name, devices: items };
    },
  );

  /**
   * Per-device software inventory drill-down (the inverse direction of
   * `/api/software-inventory/:softwareId/devices`): every product Defender
   * sees installed on this device, joined against the tenant-wide
   * `softwareInventory` summary for weakness/exploit context and a
   * live-recomputed winget/Chocolatey match — same technique as the
   * per-software route above, just keyed by `defenderMachineId` instead.
   */
  app.get<{ Params: { id: string } }>("/api/devices/:id/software-inventory", async (req, reply) => {
    const { id } = req.params;
    const devices = await loadDevices();
    const device = devices.find((d) => d.id === id);
    if (!device) return reply.code(404).send({ error: "device not found" });
    // Defender's device page shows no software inventory for an excluded device.
    // The tab renders its explanatory empty state from the device row's own
    // `excluded` flag, so the payload shape stays unchanged.
    if ((await loadExcludedDeviceIndex(device.tenantId)).byDeviceId.has(device.id)) {
      return { softwareInventory: [] };
    }
    if (!device.defenderMachineId) return { softwareInventory: [] };

    const [rows, inventory, wingetCatalog, chocolateyCatalog, wingetMatcher, chocolateyMatcher] =
      await Promise.all([
        loadDeviceSoftwareByMachine(device.tenantId, device.defenderMachineId),
        loadInventory(device.tenantId),
        loadWingetCatalog(),
        loadChocolateyCatalog(),
        buildWingetMatcher(),
        buildChocolateyMatcher(),
      ]);

    const inventoryBySoftwareId = new Map(inventory.map((s) => [s.softwareId, s]));
    const wingetLatestById = new Map(wingetCatalog.map((c) => [c.packageId, c.latestVersion]));
    const chocolateyLatestById = new Map(chocolateyCatalog.map((c) => [c.packageId, c.latestVersion]));

    const items = rows.map((row) => {
      const summary = inventoryBySoftwareId.get(row.softwareId) ?? null;
      const installScope: InstallScope = detectInstallScope(row.diskPaths, row.registryPaths);
      const wingetMatch = wingetMatcher(device.tenantId, row.name);
      const chocolateyMatch = chocolateyMatcher(device.tenantId, row.name);
      const rawLatestVersion = wingetMatch
        ? (wingetLatestById.get(wingetMatch.packageId) ?? null)
        : chocolateyMatch
          ? (chocolateyLatestById.get(chocolateyMatch.packageId) ?? null)
          : null;
      const { detected: version, latest: latestVersion } = alignVersionDisplay(
        row.version,
        rawLatestVersion,
      );
      const upToDate = Boolean(
        version && latestVersion && compareWingetVersions(version, latestVersion) >= 0,
      );
      const packageSource: "winget" | "chocolatey" | null = wingetMatch
        ? "winget"
        : chocolateyMatch
          ? "chocolatey"
          : null;
      return {
        softwareId: row.softwareId,
        name: row.name,
        vendor: row.vendor,
        version,
        installScope,
        weaknessCount: summary?.weaknessCount ?? 0,
        exposedMachinesCount: summary?.exposedMachinesCount ?? 0,
        publicExploit: summary?.publicExploit ?? false,
        latestVersion,
        upToDate,
        packageSource,
        wingetPackageId: wingetMatch?.packageId ?? null,
        chocolateyPackageId: chocolateyMatch?.packageId ?? null,
        diskPaths: row.diskPaths ?? [],
        registryPaths: row.registryPaths ?? [],
      };
    });

    return { softwareInventory: items };
  });

  /**
   * Fix Now for a software-inventory row: builds a synthetic `PreflightVuln`
   * (no real CVE — `cveId` is null on the created job) and runs the exact
   * same server-side preflight gate + dispatch pipeline as
   * `POST /api/remediations`, so licensing degradation (#4), read-only-first
   * (#6) and the winget/user-scope auto-routing all apply identically here.
   */
  app.post<{ Body: FixNowBody }>(
    "/api/software-inventory/fix",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
    const {
      tenantId,
      softwareId,
      deviceId,
      channel,
      source,
      sourceExplicit,
      packageId,
      scheduleAt,
      action,
      manualScript,
      batchId,
      win32Deploy,
      storeAppDeploy,
    } = req.body ?? {};

    if (!tenantId || !softwareId || !deviceId || !channel) {
      return reply
        .code(400)
        .send({ error: "tenantId, softwareId, deviceId and channel are required" });
    }

    if (batchId !== undefined && !UUID_RE.test(batchId)) {
      return reply.code(400).send({ error: "batchId must be a UUID" });
    }

    const parsedChannel = RemediationChannel.safeParse(channel);
    if (!parsedChannel.success) {
      return reply.code(400).send({ error: `unknown channel: ${channel}` });
    }

    if (action !== undefined && !REMEDIATION_ACTIONS.has(action as RemediationAction)) {
      return reply.code(400).send({ error: `unknown action: ${action}` });
    }
    const remediationAction: RemediationAction = (action as RemediationAction | undefined) ?? "upgrade";

    const scheduleAtError = validateScheduleAt(scheduleAt);
    if (scheduleAtError) {
      return reply.code(400).send({ error: scheduleAtError });
    }

    let parsedSource: PackageSource | null = null;
    if (source !== undefined && source !== null && source !== "") {
      const s = PackageSource.safeParse(source);
      if (!s.success) {
        return reply.code(400).send({ error: `unknown source: ${source}` });
      }
      parsedSource = s.data;
    }

    const [tenants, devices, matcher, chocolateyMatcher] = await Promise.all([
      loadTenants(),
      loadDevices(),
      buildWingetMatcher(),
      buildChocolateyMatcher(),
    ]);

    const tenant = tenants.find((t) => t.tenantId === tenantId);
    const device = devices.find((d) => d.id === deviceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    if (!device) return reply.code(404).send({ error: "device not found" });
    if (!device.defenderMachineId) {
      return reply.code(404).send({ error: "device has no Defender machine id" });
    }

    const [softwareRow] = config.DEMO_MODE
      ? demoDeviceSoftware.filter(
          (d) =>
            d.tenantId === tenantId &&
            d.softwareId === softwareId &&
            d.defenderMachineId === device.defenderMachineId,
        )
      : await db
          .select()
          .from(tables.deviceSoftware)
          .where(
            and(
              eq(tables.deviceSoftware.tenantId, tenantId),
              eq(tables.deviceSoftware.softwareId, softwareId),
              eq(tables.deviceSoftware.defenderMachineId, device.defenderMachineId),
            ),
          )
          .limit(1);
    if (!softwareRow) {
      return reply.code(404).send({ error: "software not found on this device" });
    }

    const [inventoryRow] = config.DEMO_MODE
      ? demoSoftwareInventory.filter((s) => s.tenantId === tenantId && s.softwareId === softwareId)
      : await db
          .select()
          .from(tables.softwareInventory)
          .where(
            and(
              eq(tables.softwareInventory.tenantId, tenantId),
              eq(tables.softwareInventory.softwareId, softwareId),
            ),
          )
          .limit(1);
    if (!inventoryRow) {
      return reply.code(404).send({ error: "software not found" });
    }

    const diskPaths = softwareRow.diskPaths ?? null;
    const registryPaths = softwareRow.registryPaths ?? null;
    const installScope: InstallScope = detectInstallScope(diskPaths, registryPaths);

    const match = matcher(tenant.tenantId, softwareRow.name);

    const autoAlt =
      !parsedSource && !sourceExplicit && installScope === "user"
        ? (resolveAltSources(chocolateyMatcher, tenant.tenantId, softwareRow.name)[0] ?? null)
        : null;
    const effectiveSource: PackageSource | null = parsedSource ?? autoAlt?.source ?? null;
    const override = packageId?.trim() || null;
    const effectiveWingetId = !effectiveSource && override ? override : (match?.packageId ?? null);
    const altPackageId = effectiveSource
      ? (override ??
        resolveAltSource(chocolateyMatcher, tenant.tenantId, softwareRow.name, effectiveSource)
          ?.packageId ??
        null)
      : null;

    const trimmedManualScript = manualScript?.trim() || null;

    const input: PreflightInput = {
      channel: parsedChannel.data,
      source: effectiveSource,
      altPackageId,
      installScope,
      manualScript: Boolean(trimmedManualScript),
      // winget-app only — see the matching comment in routes/jobs.ts.
      storePackageId: storeAppDeploy?.packageId?.trim() || null,
      tenant: {
        tenantId: tenant.tenantId,
        displayName: tenant.displayName,
        consentStatus: tenant.consentStatus,
        readOnly: tenant.readOnly,
        licenses: tenant.licenses,
      },
      vuln: {
        id: inventoryRow.id,
        title: `Update ${softwareRow.name}`,
        software: softwareRow.name,
        severity: "low",
        wingetRemediable: Boolean(match) && !isOsFinding(softwareRow.name),
        wingetPackageId: effectiveWingetId,
      },
      device: toPreflightDevice(device, await loadExcludedDeviceIndex(tenant.tenantId)),
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

    const script =
      trimmedManualScript ??
      remediationScript({
        channel: parsedChannel.data,
        wingetPackageId: effectiveWingetId,
        software: softwareRow.name,
        source: effectiveSource,
        altPackageId,
        installScope,
        action: remediationAction,
      });

    const resolvedSoftware = resolveDisplaySoftwareName(softwareRow.name, diskPaths);
    const engineer = req.session.engineer!.upn;

    // Deploy-or-reuse the Intune Win32 app before the job exists — mirrors
    // POST /api/remediations (routes/jobs.ts) so a Fix Now dispatched from
    // the Software Inventory page gets the same inline win32-app behavior as
    // a CVE-driven Run Now.
    let win32DeployResult: { source: Win32Source; packageId: string; reused: boolean } | null;
    let winGetAppDeployResult: { packageId: string; reused: boolean; warning?: string } | null;
    try {
      win32DeployResult = await runWin32Deploy(
        parsedChannel.data,
        win32Deploy,
        {
          engineer,
          homeTenantId: req.session.engineer!.homeTenantId,
          tenantId: tenant.tenantId,
        },
        {
          source: effectiveSource === "chocolatey" ? "chocolatey" : "winget",
          packageId: altPackageId ?? effectiveWingetId,
        },
      );
      winGetAppDeployResult = await runWinGetAppDeploy(parsedChannel.data, storeAppDeploy, {
        engineer,
        homeTenantId: req.session.engineer!.homeTenantId,
        tenantId: tenant.tenantId,
      });
    } catch (err) {
      if (err instanceof Win32DeployError) {
        return reply.code(err.status).send({ error: err.message, code: err.code, appId: err.appId });
      }
      throw err;
    }

    const job = await createJob({
      tenantId: tenant.tenantId,
      deviceId: device.id,
      cveId: null,
      channel: parsedChannel.data,
      engineer,
      script,
      scheduleAt,
      packageId: effectiveSource ? null : effectiveWingetId,
      installScope,
      action: remediationAction,
      // See the matching comment in routes/jobs.ts's POST /api/remediations —
      // a script-sourced win32-app deploy tags the job with `source: "script"`
      // + the script-catalog entry id, and a winget-app deploy tags it with
      // `source: "microsoft-store"` + the Store package id.
      source: winGetAppDeployResult
        ? "microsoft-store"
        : win32DeployResult?.source === "script"
          ? "script"
          : effectiveSource,
      altPackageId: winGetAppDeployResult
        ? winGetAppDeployResult.packageId
        : win32DeployResult?.source === "script"
          ? win32DeployResult.packageId
          : altPackageId,
      deviceHostname: device.hostname,
      software: resolvedSoftware,
      batchId: batchId ?? null,
    });

    await audit({
      engineer,
      tenantId: tenant.tenantId,
      endpoint: CHANNEL_SPECS[parsedChannel.data].endpointTemplate,
      method: "POST",
      action: "remediation:dispatch",
      resourceType: "software",
      resourceId: job.id,
      resourceLabel: `${resolvedSoftware} on ${device.hostname}`,
      summary: `Dispatched ${resolvedSoftware} to ${device.hostname} via ${parsedChannel.data}${scheduleAt ? ` scheduled for ${scheduleAt}` : ""} (software inventory)${win32DeployResult ? ` (Win32 app ${win32DeployResult.reused ? "reused" : "deployed"}: ${win32DeployResult.source}:${win32DeployResult.packageId})` : ""}${winGetAppDeployResult ? ` (Store app ${winGetAppDeployResult.reused ? "reused" : "deployed"}: ${winGetAppDeployResult.packageId})` : ""}`,
      outcome: "success",
      payload:
        win32DeployResult || winGetAppDeployResult
          ? { script, win32Deploy: win32DeployResult, storeAppDeploy: winGetAppDeployResult }
          : script,
      responseStatus: 202,
    });

    return reply.code(202).send({
      job,
      script,
      report,
      installScope,
      autoRoutedSource: autoAlt?.source ?? null,
    });
    },
  );

  /**
   * Evaluate-only companion to `/api/software-inventory/fix` — same
   * synthetic-vuln resolution + gate, no `createJob()`/`audit()` call. Mirrors
   * `POST /api/preflight`'s shape so `RunNowModal` can preview the gate/script
   * for a software-inventory target the same way it does for a real CVE.
   */
  app.post<{ Body: PreflightBody }>("/api/software-inventory/preflight", async (req, reply) => {
    const {
      tenantId,
      softwareId,
      deviceId,
      channel,
      source,
      sourceExplicit,
      packageId,
      action,
      manualScript,
      storeAppDeploy,
    } = req.body ?? {};

    if (!tenantId || !softwareId || !deviceId || !channel) {
      return reply
        .code(400)
        .send({ error: "tenantId, softwareId, deviceId and channel are required" });
    }

    const parsedChannel = RemediationChannel.safeParse(channel);
    if (!parsedChannel.success) {
      return reply.code(400).send({ error: `unknown channel: ${channel}` });
    }

    if (action !== undefined && !REMEDIATION_ACTIONS.has(action as RemediationAction)) {
      return reply.code(400).send({ error: `unknown action: ${action}` });
    }
    const remediationAction: RemediationAction = (action as RemediationAction | undefined) ?? "upgrade";

    let parsedSource: PackageSource | null = null;
    if (source !== undefined && source !== null && source !== "") {
      const s = PackageSource.safeParse(source);
      if (!s.success) {
        return reply.code(400).send({ error: `unknown source: ${source}` });
      }
      parsedSource = s.data;
    }

    const [tenants, devices, matcher, chocolateyMatcher] = await Promise.all([
      loadTenants(),
      loadDevices(),
      buildWingetMatcher(),
      buildChocolateyMatcher(),
    ]);

    const tenant = tenants.find((t) => t.tenantId === tenantId);
    const device = devices.find((d) => d.id === deviceId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    if (!device) return reply.code(404).send({ error: "device not found" });
    if (!device.defenderMachineId) {
      return reply.code(404).send({ error: "device has no Defender machine id" });
    }

    const [softwareRow] = config.DEMO_MODE
      ? demoDeviceSoftware.filter(
          (d) =>
            d.tenantId === tenantId &&
            d.softwareId === softwareId &&
            d.defenderMachineId === device.defenderMachineId,
        )
      : await db
          .select()
          .from(tables.deviceSoftware)
          .where(
            and(
              eq(tables.deviceSoftware.tenantId, tenantId),
              eq(tables.deviceSoftware.softwareId, softwareId),
              eq(tables.deviceSoftware.defenderMachineId, device.defenderMachineId),
            ),
          )
          .limit(1);
    if (!softwareRow) {
      return reply.code(404).send({ error: "software not found on this device" });
    }

    const [inventoryRow] = config.DEMO_MODE
      ? demoSoftwareInventory.filter((s) => s.tenantId === tenantId && s.softwareId === softwareId)
      : await db
          .select()
          .from(tables.softwareInventory)
          .where(
            and(
              eq(tables.softwareInventory.tenantId, tenantId),
              eq(tables.softwareInventory.softwareId, softwareId),
            ),
          )
          .limit(1);
    if (!inventoryRow) {
      return reply.code(404).send({ error: "software not found" });
    }

    const diskPaths = softwareRow.diskPaths ?? null;
    const registryPaths = softwareRow.registryPaths ?? null;
    const installScope: InstallScope = detectInstallScope(diskPaths, registryPaths);

    // winget-app is a completely separate path from the winget/chocolatey
    // matcher logic below — see the matching branch in routes/preflight.ts.
    if (parsedChannel.data === "winget-app") {
      const storePackageId = storeAppDeploy?.packageId?.trim() || null;
      const input: PreflightInput = {
        channel: parsedChannel.data,
        source: null,
        altPackageId: null,
        installScope,
        manualScript: false,
        storePackageId,
        tenant: {
          tenantId: tenant.tenantId,
          displayName: tenant.displayName,
          consentStatus: tenant.consentStatus,
          readOnly: tenant.readOnly,
          licenses: tenant.licenses,
        },
        vuln: {
          id: inventoryRow.id,
          title: `Update ${softwareRow.name}`,
          software: softwareRow.name,
          severity: "low",
          wingetRemediable: false,
          wingetPackageId: null,
        },
        device: toPreflightDevice(device, await loadExcludedDeviceIndex(tenant.tenantId)),
        writeGate: await assertWritesAllowed(tenant),
      };
      const script = storePackageId
        ? winGetAppDeployPreview({
            packageId: storePackageId,
            software: softwareRow.name,
            displayName: storeAppDeploy?.displayName,
            publisher: storeAppDeploy?.publisher,
            runAsAccount: storeAppDeploy?.runAsAccount,
          })
        : null;
      return {
        ...preflight(input),
        script,
        installScope,
        autoRoutedSource: null,
      };
    }

    const match = matcher(tenant.tenantId, softwareRow.name);

    const autoAlt =
      !parsedSource && !sourceExplicit && installScope === "user"
        ? (resolveAltSources(chocolateyMatcher, tenant.tenantId, softwareRow.name)[0] ?? null)
        : null;
    const effectiveSource: PackageSource | null = parsedSource ?? autoAlt?.source ?? null;
    const override = packageId?.trim() || null;
    const effectiveWingetId = !effectiveSource && override ? override : (match?.packageId ?? null);
    const altPackageId = effectiveSource
      ? (override ??
        resolveAltSource(chocolateyMatcher, tenant.tenantId, softwareRow.name, effectiveSource)
          ?.packageId ??
        null)
      : null;

    const trimmedManualScript = manualScript?.trim() || null;

    const input: PreflightInput = {
      channel: parsedChannel.data,
      source: effectiveSource,
      altPackageId,
      installScope,
      manualScript: Boolean(trimmedManualScript),
      tenant: {
        tenantId: tenant.tenantId,
        displayName: tenant.displayName,
        consentStatus: tenant.consentStatus,
        readOnly: tenant.readOnly,
        licenses: tenant.licenses,
      },
      vuln: {
        id: inventoryRow.id,
        title: `Update ${softwareRow.name}`,
        software: softwareRow.name,
        severity: "low",
        wingetRemediable: Boolean(match) && !isOsFinding(softwareRow.name),
        wingetPackageId: effectiveWingetId,
      },
      device: toPreflightDevice(device, await loadExcludedDeviceIndex(tenant.tenantId)),
      writeGate: await assertWritesAllowed(tenant),
      liveResponseQuota:
        parsedChannel.data === "live-response"
          ? await checkLiveResponseDeviceQuota(tenant.tenantId, device.id)
          : undefined,
    };

    const script =
      trimmedManualScript ??
      remediationScript({
        channel: parsedChannel.data,
        wingetPackageId: effectiveWingetId,
        software: softwareRow.name,
        source: effectiveSource,
        altPackageId,
        installScope,
        action: remediationAction,
      });

    return {
      ...preflight(input),
      script,
      installScope,
      autoRoutedSource: autoAlt?.source ?? null,
    };
  });

  /** One engineer-selected target from the Fix All checklist, with an
   *  optional winget package id override — `key` is `device.id` when fixing
   *  one software across devices, or `softwareId` when fixing one device's
   *  full inventory (whichever axis isn't fixed by the request). */
  interface FixAllInventoryItem {
    key: string;
    packageId?: string;
  }

  interface FixAllInventoryBody {
    tenantId?: string;
    channel?: string;
    /** Fix this one software across every device that has it installed. */
    softwareId?: string;
    /** Fix every fixable software title installed on this one device. */
    deviceId?: string;
    /** Optional ISO-8601 timestamp to defer every created job to (one-shot scheduling). */
    scheduleAt?: string;
    /** Optional explicit selection + per-item package overrides from the Fix
     *  All checklist. When omitted, every target is attempted with its
     *  auto-detected package (prior default-all behavior). */
    items?: FixAllInventoryItem[];
    /** Mirrors FixAllBody.win32Deploy in routes/jobs.ts — shared deploy config
     *  applied to every item below; each item resolves its own source/
     *  packageId the same way its script does. */
    win32Deploy?: Win32DeployOptions;
  }

  /** One skipped item from a software-inventory Fix All run, with the reason
   *  it couldn't be dispatched. `label` is the hostname when fixing one
   *  software across devices, or the software name when fixing one device's
   *  full inventory — whichever axis isn't fixed by the request. */
  interface InventoryFixAllSkip {
    label: string;
    reason: string;
  }

  /**
   * Bulk Fix Now for the software-inventory pages — exactly one of
   * `softwareId` (fix this title on every device that has it) or `deviceId`
   * (fix every fixable title on this one device) must be given. Reuses the
   * same synthetic-vuln preflight/dispatch pipeline as the single-device
   * `/fix` route above, one job per target, skipping anything unmatched or
   * blocked with a reason instead of attempting it.
   */
  app.post<{ Body: FixAllInventoryBody }>(
    "/api/software-inventory/fix-all",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
    const { tenantId, channel, softwareId, deviceId, scheduleAt, items, win32Deploy } =
      req.body ?? {};

    if (!tenantId || !channel) {
      return reply.code(400).send({ error: "tenantId and channel are required" });
    }
    if (!softwareId && !deviceId) {
      return reply.code(400).send({ error: "either softwareId or deviceId is required" });
    }
    if (softwareId && deviceId) {
      return reply.code(400).send({ error: "provide only one of softwareId or deviceId" });
    }

    const parsedChannel = RemediationChannel.safeParse(channel);
    if (!parsedChannel.success) {
      return reply.code(400).send({ error: `unknown channel: ${channel}` });
    }
    if (!CHANNEL_SPECS[parsedChannel.data].supports.app) {
      return reply
        .code(400)
        .send({ error: `channel ${parsedChannel.data} does not support app remediation` });
    }

    const scheduleAtError = validateScheduleAt(scheduleAt);
    if (scheduleAtError) {
      return reply.code(400).send({ error: scheduleAtError });
    }

    const [tenants, devices, matcher, chocolateyMatcher] = await Promise.all([
      loadTenants(),
      loadDevices(),
      buildWingetMatcher(),
      buildChocolateyMatcher(),
    ]);
    const tenant = tenants.find((t) => t.tenantId === tenantId);
    if (!tenant) return reply.code(404).send({ error: "tenant not found" });

    type Target = { softwareRow: DeviceSoftwareRow; device: DeviceRow; label: string; key: string };
    const targets: Target[] = [];
    const skipped: InventoryFixAllSkip[] = [];

    if (softwareId) {
      const rows = await loadDeviceSoftware(tenantId, softwareId);
      if (rows.length === 0) return reply.code(404).send({ error: "software not found" });
      const deviceByMachineId = new Map(
        devices.filter((d) => d.defenderMachineId).map((d) => [d.defenderMachineId as string, d]),
      );
      for (const row of rows) {
        const device = deviceByMachineId.get(row.defenderMachineId);
        if (!device) {
          skipped.push({ label: row.defenderMachineId, reason: "Device not found." });
          continue;
        }
        targets.push({ softwareRow: row, device, label: device.hostname, key: device.id });
      }
    } else {
      const device = devices.find((d) => d.id === deviceId);
      if (!device) return reply.code(404).send({ error: "device not found" });
      if (!device.defenderMachineId) {
        return reply.code(202).send({ jobsCreated: 0, jobs: [], skipped: [] });
      }
      const rows = await loadDeviceSoftwareByMachine(tenantId, device.defenderMachineId);
      for (const row of rows) {
        targets.push({ softwareRow: row, device, label: row.name, key: row.softwareId });
      }
    }

    // An explicit checklist selects + optionally overrides a subset of
    // targets; omitting it preserves the prior default-all behavior.
    const itemsByKey = items ? new Map(items.map((i) => [i.key, i])) : null;
    const selectedTargets = itemsByKey
      ? targets.filter((t) => itemsByKey.has(t.key))
      : targets;

    if (selectedTargets.length === 0) {
      return reply.code(202).send({ jobsCreated: 0, jobs: [], skipped });
    }

    const engineer = req.session.engineer!.upn;
    const homeTenantId = req.session.engineer!.homeTenantId;
    const created: Awaited<ReturnType<typeof createJob>>[] = [];
    // Hoisted: this fan-out spans many devices, but one index answers for all.
    const excludedIndex = await loadExcludedDeviceIndex(tenant.tenantId);
    // One batchId per Fix All request, shared by every job it creates, so
    // the Jobs page can group them under a single expandable row.
    const batchId = randomUUID();
    // One tenant per Fix All request, so the write gate (readOnly + Black
    // Iron entitlement) doesn't change between items — hoisted for the same
    // reason as excludedIndex above.
    const writeGate = await assertWritesAllowed(tenant);

    for (const { softwareRow, device, label, key } of selectedTargets) {
      const diskPaths = softwareRow.diskPaths ?? null;
      const registryPaths = softwareRow.registryPaths ?? null;
      const installScope: InstallScope = detectInstallScope(diskPaths, registryPaths);
      const match = matcher(tenant.tenantId, softwareRow.name);
      const override = itemsByKey?.get(key)?.packageId?.trim() || null;

      const autoAlt =
        installScope === "user"
          ? (resolveAltSources(chocolateyMatcher, tenant.tenantId, softwareRow.name)[0] ?? null)
          : null;
      const effectiveSource: PackageSource | null = autoAlt?.source ?? null;
      const effectiveWingetId = !effectiveSource
        ? (override ?? match?.packageId ?? null)
        : null;
      const altPackageId = effectiveSource
        ? (resolveAltSource(chocolateyMatcher, tenant.tenantId, softwareRow.name, effectiveSource)
            ?.packageId ?? null)
        : null;

      if (!effectiveWingetId && !altPackageId) {
        skipped.push({ label, reason: "No supported package source found." });
        continue;
      }

      const input: PreflightInput = {
        channel: parsedChannel.data,
        source: effectiveSource,
        altPackageId,
        installScope,
        tenant: {
          tenantId: tenant.tenantId,
          displayName: tenant.displayName,
          consentStatus: tenant.consentStatus,
          readOnly: tenant.readOnly,
          licenses: tenant.licenses,
        },
        vuln: {
          id: softwareRow.softwareId,
          title: `Update ${softwareRow.name}`,
          software: softwareRow.name,
          severity: "low",
          wingetRemediable: Boolean(match) && !isOsFinding(softwareRow.name),
          wingetPackageId: effectiveWingetId,
        },
        device: toPreflightDevice(device, excludedIndex),
        writeGate,
        // Unlike writeGate above, this varies per item when fixing one
        // software across many devices — device isn't constant for the
        // whole batch the way it is in jobs.ts's single-device Fix All.
        liveResponseQuota:
          parsedChannel.data === "live-response"
            ? await checkLiveResponseDeviceQuota(tenant.tenantId, device.id)
            : undefined,
      };

      const report = preflight(input);
      if (!report.canProceed) {
        const failed = report.checks.find((c) => c.status === "fail");
        skipped.push({ label, reason: failed?.detail ?? "Preflight failed." });
        continue;
      }

      const script = remediationScript({
        channel: parsedChannel.data,
        wingetPackageId: effectiveWingetId,
        software: softwareRow.name,
        source: effectiveSource,
        altPackageId,
        installScope,
      });

      const resolvedSoftware = resolveDisplaySoftwareName(softwareRow.name, diskPaths);

      // Deploy-or-reuse the Intune Win32 app for this software before its job
      // exists — source/packageId derived the same way the script above was
      // (Chocolatey when auto-routed, winget otherwise); this checklist has no
      // per-item Script Catalog pick, so "script" never applies here. Mirrors
      // the identical block in jobs.ts's /api/devices/:id/fix-all. A deploy
      // failure skips just this item rather than aborting the batch.
      let win32DeployResult: { source: Win32Source; packageId: string; reused: boolean } | null =
        null;
      if (parsedChannel.data === "win32-app" && win32Deploy) {
        const deploySource: Win32Source = effectiveSource === "chocolatey" ? "chocolatey" : "winget";
        const deployPackageId = altPackageId ?? effectiveWingetId!;
        try {
          const result = await deployOrReuseWin32App({
            engineer,
            homeTenantId,
            tenantId: tenant.tenantId,
            source: deploySource,
            packageId: deployPackageId,
            displayName: win32Deploy.displayName,
            description: win32Deploy.description,
            publisher: win32Deploy.publisher,
            runAsAccount: win32Deploy.runAsAccount,
            installChoco: win32Deploy.installChoco,
            customRepo: win32Deploy.customRepo,
            customArguments: win32Deploy.customArguments,
            assignment: win32Deploy.assignment,
          });
          win32DeployResult = { source: deploySource, packageId: deployPackageId, reused: result.reused };
        } catch (err) {
          const message = err instanceof Win32DeployError ? err.message : String(err);
          skipped.push({ label, reason: `Win32 app deploy failed: ${message}` });
          continue;
        }
      }

      const job = await createJob({
        tenantId: tenant.tenantId,
        deviceId: device.id,
        cveId: null,
        channel: parsedChannel.data,
        engineer,
        script,
        scheduleAt,
        packageId: effectiveSource ? null : effectiveWingetId,
        source: effectiveSource,
        altPackageId,
        deviceHostname: device.hostname,
        software: resolvedSoftware,
        batchId,
      });

      await audit({
        engineer,
        tenantId: tenant.tenantId,
        endpoint: CHANNEL_SPECS[parsedChannel.data].endpointTemplate,
        method: "POST",
        action: "remediation:fix-all",
        resourceType: "job",
        resourceId: job.id,
        resourceLabel: `${resolvedSoftware} on ${device.hostname}`,
        summary: `Dispatched ${resolvedSoftware} to ${device.hostname} via ${parsedChannel.data}${scheduleAt ? ` scheduled for ${scheduleAt}` : ""} (software inventory)${win32DeployResult ? ` (Win32 app ${win32DeployResult.reused ? "reused" : "deployed"}: ${win32DeployResult.source}:${win32DeployResult.packageId})` : ""}`,
        outcome: "success",
        payload: win32DeployResult ? { script, win32Deploy: win32DeployResult } : script,
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
}
