import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  db,
  tables,
  demoTenants,
  demoDevices,
  demoVulnerabilities,
  demoDeviceVulnerabilities,
  type TenantRow,
  type DeviceRow,
  type VulnerabilityRow,
} from "@patchpilot/db";
import {
  preflight,
  remediationScript,
  winGetAppDeployPreview,
  RemediationChannel,
  PackageSource,
  detectInstallScope,
  type PreflightInput,
  type InstallScope,
  type RemediationAction,
} from "@patchpilot/shared";
import { assertWritesAllowed, checkLiveResponseDeviceQuota } from "@patchpilot/graph";
import type { WinGetAppDeployBody } from "./jobs.js";
import { config } from "../config.js";
import { buildWingetMatcher, buildChocolateyMatcher, resolveAltSources, resolveAltSource } from "../catalog/matching.js";
import { loadExcludedDeviceIndex, toPreflightDevice } from "./device-exclusions.js";
import { requirePermission } from "../auth/rbac.js";

/** Validated request-body actions — mirrors RemediationAction, "upgrade" is the default. */
const REMEDIATION_ACTIONS = new Set<RemediationAction>(["upgrade", "uninstall"]);

/**
 * Per-action pre-flight route (Phase 2).
 *
 * `POST /api/preflight` takes a tenant + vuln + device + chosen channel and
 * reports whether that exact remediation can run, enforcing licensing
 * degradation (#4) and read-only-first (#6) at the point of action. It is the
 * last gate before a Phase-3 write action is offered — pure evaluation, no
 * Microsoft calls. DEMO_MODE reads fixtures; production reads Postgres.
 */
interface PreflightBody {
  tenantId?: string;
  vulnId?: string;
  deviceId?: string;
  channel?: string;
  /** Optional alternate repo for a not-supported app: "chocolatey" | "microsoft-store". */
  source?: string;
  /**
   * Optional engineer-selected package id (Run Now dialog). No source -> it
   * overrides the CVE's winget mapping; with a source -> the curated alt id.
   */
  packageId?: string;
  /**
   * True when the engineer actually saw and used the "4. Catalog" picker
   * (Run Now dialog) — including when that choice is Winget, which serializes
   * `source` as null just like "no choice made". Suppresses the per-user-install
   * auto-route-to-Chocolatey heuristic below so an explicit Winget pick is
   * never silently overridden.
   */
  sourceExplicit?: boolean;
  /** "upgrade" (default) or "uninstall" — see RemediateBody.action in routes/jobs.ts. */
  action?: string;
  /** See RemediateBody.manualScript in routes/jobs.ts. */
  manualScript?: string;
  /**
   * winget-app channel only — the same block the dispatch route consumes
   * (RemediateBody.storeAppDeploy in routes/jobs.ts). Only `packageId` (and,
   * for the preview text, `displayName`/`publisher`/`runAsAccount`) are read
   * here; there is no server-side fallback the way winget/chocolatey have —
   * this channel has no per-CVE Store match to fall back to.
   */
  storeAppDeploy?: WinGetAppDeployBody;
}

export async function preflightRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("settings:read"));

  async function loadTenants(): Promise<TenantRow[]> {
    return config.DEMO_MODE ? demoTenants : db.select().from(tables.tenants);
  }
  async function loadDevices(): Promise<DeviceRow[]> {
    return config.DEMO_MODE ? demoDevices : db.select().from(tables.devices);
  }
  async function loadVulns(): Promise<VulnerabilityRow[]> {
    return config.DEMO_MODE
      ? demoVulnerabilities
      : db.select().from(tables.vulnerabilities);
  }

  app.post<{ Body: PreflightBody }>("/api/preflight", async (req, reply) => {
    const {
      tenantId,
      vulnId,
      deviceId,
      channel,
      source,
      sourceExplicit,
      packageId,
      action,
      manualScript,
      storeAppDeploy,
    } = req.body ?? {};

    if (!tenantId || !vulnId || !deviceId || !channel) {
      return reply
        .code(400)
        .send({ error: "tenantId, vulnId, deviceId and channel are required" });
    }

    const parsedChannel = RemediationChannel.safeParse(channel);
    if (!parsedChannel.success) {
      return reply.code(400).send({ error: `unknown channel: ${channel}` });
    }

    if (action !== undefined && !REMEDIATION_ACTIONS.has(action as RemediationAction)) {
      return reply.code(400).send({ error: `unknown action: ${action}` });
    }
    const remediationAction: RemediationAction =
      (action as RemediationAction | undefined) ?? "upgrade";

    let parsedSource: PackageSource | null = null;
    if (source !== undefined && source !== null && source !== "") {
      const s = PackageSource.safeParse(source);
      if (!s.success) {
        return reply.code(400).send({ error: `unknown source: ${source}` });
      }
      parsedSource = s.data;
    }

    const [tenants, devices, vulns, matcher, chocolateyMatcher] = await Promise.all([
      loadTenants(),
      loadDevices(),
      loadVulns(),
      buildWingetMatcher(),
      buildChocolateyMatcher(),
    ]);

    const tenant = tenants.find((t) => t.tenantId === tenantId);
    const vuln = vulns.find((v) => v.id === vulnId);
    const device = devices.find((d) => d.id === deviceId);

    if (!tenant) return reply.code(404).send({ error: "tenant not found" });
    if (!vuln) return reply.code(404).send({ error: "vulnerability not found" });
    if (!device) return reply.code(404).send({ error: "device not found" });

    // wingetRemediable/wingetPackageId on `vuln` are frozen at sync time and
    // over-report "out of winget scope" as the catalog/overrides evolve —
    // recompute live against the current catalog rather than trust them.
    const match = matcher(vuln.tenantId, vuln.software);

    // Software Evidence (disk + registry paths) — same lookup the run route
    // does, so this preview's install-scope check and auto-routing exactly
    // predict what Fix Now will actually do. Without this, the preview could
    // show a clean gate for an app that's per-user-only, only for the real
    // dispatch to fail after the engineer clicks Fix Now.
    let diskPaths: string[] | null = null;
    let registryPaths: string[] | null = null;
    if (device.defenderMachineId) {
      if (config.DEMO_MODE) {
        const link = demoDeviceVulnerabilities.find(
          (dv) =>
            dv.tenantId === device.tenantId &&
            dv.defenderMachineId === device.defenderMachineId &&
            dv.cveId === vuln.cveId &&
            dv.software === vuln.software,
        );
        diskPaths = link?.diskPaths ?? null;
        registryPaths = link?.registryPaths ?? null;
      } else {
        const [link] = await db
          .select({
            diskPaths: tables.deviceVulnerabilities.diskPaths,
            registryPaths: tables.deviceVulnerabilities.registryPaths,
          })
          .from(tables.deviceVulnerabilities)
          .where(
            and(
              eq(tables.deviceVulnerabilities.tenantId, device.tenantId),
              eq(tables.deviceVulnerabilities.defenderMachineId, device.defenderMachineId),
              eq(tables.deviceVulnerabilities.cveId, vuln.cveId),
              eq(tables.deviceVulnerabilities.software, vuln.software),
            ),
          )
          .limit(1);
        diskPaths = link?.diskPaths ?? null;
        registryPaths = link?.registryPaths ?? null;
      }
    }
    const installScope: InstallScope = detectInstallScope(diskPaths, registryPaths);

    // winget-app ("Microsoft Store app (new)") is a completely separate path
    // from everything below: it has no relationship to the winget/chocolatey
    // catalog matchers at all — `packageId` there is always a live
    // manifestSearch pick carried in `storeAppDeploy`, not a CVE-mapped
    // winget id. Branching here (rather than threading a channel check
    // through the winget/chocolatey logic below) keeps that logic from
    // silently applying to a channel it was never built for.
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
          id: vuln.id,
          title: vuln.title,
          software: vuln.software,
          severity: vuln.severity,
          wingetRemediable: false,
          wingetPackageId: null,
        },
        device: toPreflightDevice(device, await loadExcludedDeviceIndex(tenant.tenantId)),
        writeGate: await assertWritesAllowed(tenant),
      };
      const script = storePackageId
        ? winGetAppDeployPreview({
            packageId: storePackageId,
            software: vuln.software,
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

    // When the engineer hasn't picked a source (and didn't explicitly pick
    // Winget either — `sourceExplicit` distinguishes the two) and the evidence
    // shows a per-user install, auto-route to the first resolved alternate
    // source — same rule the run route applies — so this preview's gate and
    // script reflect what Fix Now will actually dispatch, not a plain winget
    // attempt that the real dispatch would silently reroute away from. An
    // explicit catalog choice is never overridden.
    const autoAlt =
      !parsedSource && !sourceExplicit && installScope === "user"
        ? (resolveAltSources(chocolateyMatcher, vuln.tenantId, vuln.software)[0] ?? null)
        : null;
    const effectiveSource: PackageSource | null = parsedSource ?? autoAlt?.source ?? null;

    // Honour an engineer override the same way the run route does, so the gate
    // and preview evaluate the package that would actually be dispatched.
    const override = packageId?.trim() || null;
    const effectiveWingetId = !effectiveSource && override ? override : (match?.packageId ?? null);
    const altPackageId = effectiveSource
      ? (override ??
        resolveAltSource(chocolateyMatcher, vuln.tenantId, vuln.software, effectiveSource)?.packageId ??
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
        id: vuln.id,
        title: vuln.title,
        software: vuln.software,
        severity: vuln.severity,
        wingetRemediable: Boolean(match),
        wingetPackageId: effectiveWingetId,
      },
      device: toPreflightDevice(device, await loadExcludedDeviceIndex(tenant.tenantId)),
      writeGate: await assertWritesAllowed(tenant),
      liveResponseQuota:
        parsedChannel.data === "live-response"
          ? await checkLiveResponseDeviceQuota(tenant.tenantId, device.id)
          : undefined,
    };

    // Surface the exact deployable script alongside the gate result so the engineer
    // can review the code BEFORE running — same generator the run route uses to build
    // the queued job's payload, so the preview and the dispatched body never diverge.
    const script =
      trimmedManualScript ??
      remediationScript({
        channel: parsedChannel.data,
        wingetPackageId: effectiveWingetId,
        software: vuln.software,
        source: effectiveSource,
        altPackageId,
        installScope,
        action: remediationAction,
      });

    // installScope/autoRoutedSource are response-only, same as the run route's
    // 202 response — surfaced so the modal can explain why a fix is routed to
    // an alternate source (or blocked) instead of a plain winget attempt.
    return {
      ...preflight(input),
      script,
      installScope,
      autoRoutedSource: autoAlt?.source ?? null,
    };
  });
}
