import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
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
  RemediationChannel,
  CHANNEL_SPECS,
  PackageSource,
  detectInstallScope,
  resolveDisplaySoftwareName,
  isOsFinding,
  isWin32Source,
  type PreflightInput,
  type InstallScope,
  type RemediationAction,
  type Win32Source,
} from "@patchpilot/shared";
import { config } from "../config.js";
import { buildWingetMatcher, buildChocolateyMatcher, resolveAltSources, resolveAltSource } from "../catalog/matching.js";
import { audit, assertWritesAllowed, checkLiveResponseDeviceQuota } from "@patchpilot/graph";
import {
  createJob,
  listJobs,
  getJob,
  archiveJob,
  unarchiveJob,
  deleteJob,
  type JobRecord,
} from "../jobs.js";
import { loadExcludedDeviceIndex, toPreflightDevice } from "./device-exclusions.js";
import { requirePermission } from "../auth/rbac.js";
import {
  deployOrReuseWin32App,
  Win32DeployError,
  type AssignmentInput,
  type DeployOrReuseWin32AppResult,
} from "../services/win32-app-deploy.js";
import { deployOrReuseWinGetApp } from "../services/winget-app-deploy.js";

/**
 * A job's human identity for the audit log, denormalised at write time.
 *
 * Deletes are the reason this exists: once the row is gone there is nothing
 * left to join against, so an audit entry that stored only the id would be
 * unreadable exactly where it matters most.
 */
function jobLabel(job: JobRecord): string {
  const what = job.software ?? job.cveId ?? job.kbId ?? job.channel;
  return job.deviceHostname ? `${what} on ${job.deviceHostname}` : what;
}

/**
 * Bounded list for a bulk operation's `detail`. The writer caps `detail` at
 * 2,000 chars anyway; truncating here keeps the tail readable ("+ 180 more")
 * instead of a sentence that stops mid-id.
 */
function idList(items: readonly string[], max = 10): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} + ${items.length - max} more`;
}

/**
 * Shared deploy-config fields for the inline Win32 app deploy-or-reuse.
 * `displayName` left unset resolves from the matching catalog row per item —
 * the only reason Fix All can send this once for many software rows.
 */
export interface Win32DeployOptions {
  displayName?: string;
  description?: string;
  publisher?: string;
  runAsAccount?: "system" | "user";
  installChoco?: boolean;
  customRepo?: string;
  customArguments?: string;
  assignment?: AssignmentInput;
}

/**
 * `POST /api/remediations` request-body shape for the inline deploy: a
 * single device/software pair, so `source`/`packageId` travel alongside the
 * shared options. They're explicit rather than derived from the CVE-
 * alternate-source fields on `RemediateBody` (`source`/`packageId` there)
 * because `PackageSource` ("chocolatey" | "microsoft-store") can't express
 * "script" — the engineer's Catalog-step pick (Winget/Chocolatey/Script) is
 * a separate axis from the CVE alt-source fallback those fields drive.
 */
export interface Win32DeployBody extends Win32DeployOptions {
  source?: string;
  /** winget package id / Chocolatey package id / script_catalog.id, matching `source`. */
  packageId?: string;
}

/**
 * Runs deploy-or-reuse for the "Intune (Win32 app)" channel before a job is
 * created, so a failed deploy never leaves an orphaned job pointing at an
 * app that doesn't exist. Returns null when no deploy applies (channel isn't
 * win32-app, or the request carries no win32Deploy block — e.g. a plain
 * device sync of an already-deployed app). Throws Win32DeployError on
 * failure; callers map it to the same {error, code, appId} shape
 * POST /api/intune-apps/win32 already returns.
 *
 * `win32Deploy.source`/`packageId` are an explicit engineer override (a
 * catalog search pick, or a Script Catalog entry id) — when the engineer
 * left the "4. Catalog" picker at its default ("No selection — the CVE's
 * stored winget match is used"), the client sends no source/packageId at
 * all, so `fallback` (the same effectiveSource/effectiveWingetId/altPackageId
 * the preflight + generated script above already resolved from the CVE's
 * own stored match) is what actually gets deployed. Mirrors how Fix All's
 * per-item loop resolves deploySource/deployPackageId — this is the same
 * data, just computed once here instead of per-row.
 */
export async function runWin32Deploy(
  channel: string,
  win32Deploy: Win32DeployBody | undefined,
  ctx: { engineer: string; homeTenantId: string; tenantId: string },
  fallback: { source: Win32Source; packageId: string | null },
): Promise<{ source: Win32Source; packageId: string; reused: boolean } | null> {
  if (channel !== "win32-app" || !win32Deploy) return null;
  const source = win32Deploy.source ? win32Deploy.source : fallback.source;
  if (!isWin32Source(source)) {
    throw new Win32DeployError(`win32Deploy.source must be "winget", "chocolatey" or "script"`, {
      status: 400,
    });
  }
  const packageId = win32Deploy.packageId?.trim() || fallback.packageId?.trim();
  if (!packageId) {
    throw new Win32DeployError(
      "no package id could be resolved for this Win32 app deploy — the CVE has no stored winget match and none was picked in the Catalog step",
      { status: 400 },
    );
  }
  const result: DeployOrReuseWin32AppResult = await deployOrReuseWin32App({
    ...ctx,
    source,
    packageId,
    displayName: win32Deploy.displayName,
    description: win32Deploy.description,
    publisher: win32Deploy.publisher,
    runAsAccount: win32Deploy.runAsAccount,
    installChoco: win32Deploy.installChoco,
    customRepo: win32Deploy.customRepo,
    customArguments: win32Deploy.customArguments,
    assignment: win32Deploy.assignment,
  });
  return { source, packageId, reused: result.reused };
}

/**
 * Required-fields-only deploy config for the "Microsoft Store app (new)"
 * channel — unlike Win32DeployBody there's no `source` axis (always a
 * Store-resolved id) and no CVE-driven fallback (there's no per-CVE Store
 * match table for a fallback to come from), so `packageId` is always an
 * explicit engineer pick from `MicrosoftStorePicker`.
 */
export interface WinGetAppDeployBody {
  packageId?: string;
  displayName?: string;
  description?: string;
  publisher?: string;
  runAsAccount?: "system" | "user";
  assignment?: AssignmentInput;
}

/**
 * Runs deploy-or-reuse for the "Microsoft Store app (new)" channel before a
 * job is created — same never-orphan-a-job reasoning as `runWin32Deploy`.
 * Returns null when the channel isn't winget-app or the request carries no
 * storeAppDeploy block. Throws Win32DeployError (shared, generic despite the
 * name) on failure.
 */
export async function runWinGetAppDeploy(
  channel: string,
  storeAppDeploy: WinGetAppDeployBody | undefined,
  ctx: { engineer: string; homeTenantId: string; tenantId: string },
): Promise<{ packageId: string; reused: boolean; warning?: string } | null> {
  if (channel !== "winget-app" || !storeAppDeploy) return null;
  const packageId = storeAppDeploy.packageId?.trim();
  if (!packageId) {
    throw new Win32DeployError(
      "storeAppDeploy.packageId is required — pick a package in the Catalog step",
      { status: 400 },
    );
  }
  const displayName = storeAppDeploy.displayName?.trim();
  const publisher = storeAppDeploy.publisher?.trim();
  if (!displayName || !publisher) {
    throw new Win32DeployError("storeAppDeploy.displayName and publisher are required", { status: 400 });
  }
  const result = await deployOrReuseWinGetApp({
    ...ctx,
    source: "microsoft-store",
    packageId,
    displayName,
    description: storeAppDeploy.description,
    publisher,
    runAsAccount: storeAppDeploy.runAsAccount,
    assignment: storeAppDeploy.assignment,
  });
  return { packageId, reused: result.reused, warning: result.warning };
}

/** Validated request-body actions — mirrors RemediationAction, "upgrade" is the default. */
const REMEDIATION_ACTIONS = new Set<RemediationAction>(["upgrade", "uninstall"]);

/**
 * Validates an optional one-shot `scheduleAt`: must parse and be in the
 * future. A past or malformed value is rejected rather than silently
 * coerced to "now", so the engineer can't think a fix was deferred when it
 * actually ran immediately. Returns an error message, or null if valid/absent.
 */
export function validateScheduleAt(scheduleAt?: string): string | null {
  if (scheduleAt === undefined) return null;
  const when = Date.parse(scheduleAt);
  if (Number.isNaN(when)) return "scheduleAt must be an ISO-8601 timestamp";
  if (when <= Date.now()) return "scheduleAt must be in the future";
  return null;
}

/**
 * Remediation + jobs routes (Phase 3) — the first write-action surface.
 *
 * `POST /api/remediations` is the single entry point for running a fix. It
 * re-runs the exact same pre-flight gate as `POST /api/preflight` server-side
 * (never trust the client's "canProceed") and refuses with 422 if the action
 * cannot proceed — enforcing licensing degradation (#4) and read-only-first
 * (#6) at the point of write. Only then does it build the deployable script,
 * enqueue the job, and audit the action (#3).
 *
 * In DEMO_MODE the job engine simulates execution end-to-end; no Microsoft API
 * is ever called. Real channel dispatch over a GDAP/OBO token lands in Phase 4.
 */
interface RemediateBody {
  tenantId?: string;
  vulnId?: string;
  deviceId?: string;
  channel?: string;
  /** Optional ISO-8601 timestamp to defer execution to (one-shot scheduling). */
  scheduleAt?: string;
  /**
   * Optional alternate repo for a not-supported app (winget has no package):
   * "chocolatey" | "microsoft-store". When set, the fix is driven through that
   * source instead of winget.
   */
  source?: string;
  /**
   * True when the engineer actually saw and used the "4. Catalog" picker
   * (Run Now dialog) — including when that choice is Winget, which serializes
   * `source` as null just like "no choice made". Suppresses the per-user-install
   * auto-route-to-Chocolatey heuristic so an explicit Winget pick is never
   * silently overridden.
   */
  sourceExplicit?: boolean;
  /**
   * Optional engineer-selected package id from the Run Now dialog. With no
   * source it overrides the CVE's stored winget mapping; with a source it
   * overrides the curated alternate-source package id.
   */
  packageId?: string;
  /**
   * "upgrade" (default) or "uninstall" the resolved winget package — the Run
   * Now dialog's 3rd "Remediation to run" option. Ignored for an alternate
   * `source` or an OS finding, which have no uninstall path yet.
   */
  action?: string;
  /**
   * Manual remediation option, "dispatch" sub-mode: an engineer-supplied
   * script to run through the chosen channel instead of a generated one. When
   * present, `source`/`packageId`/`action` are ignored — there's no catalog
   * package to resolve.
   */
  manualScript?: string;
  /**
   * Caller-supplied batch id (UUID) shared across a set of `/api/remediations`
   * calls dispatched together (a multi-device Run Now), so the Jobs page can
   * group them under one row. Omit for a standalone single-device dispatch.
   */
  batchId?: string;
  /**
   * Present only when `channel === "win32-app"` and the engineer configured
   * deploy options inline in the Run Now dialog. Runs deploy-or-reuse
   * synchronously before the job is created; a device sync of an
   * already-deployed app can omit this entirely.
   */
  win32Deploy?: Win32DeployBody;
  /**
   * Present only when `channel === "winget-app"` and the engineer picked a
   * Microsoft Store package in the Run Now dialog's Catalog step. Runs
   * deploy-or-reuse synchronously before the job is created, same as
   * `win32Deploy`.
   */
  storeAppDeploy?: WinGetAppDeployBody;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function jobsRoutes(app: FastifyInstance): Promise<void> {
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
  async function loadVulns(): Promise<VulnerabilityRow[]> {
    return config.DEMO_MODE
      ? demoVulnerabilities
      : db.select().from(tables.vulnerabilities);
  }

  app.post<{ Body: RemediateBody }>(
    "/api/remediations",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
    const {
      tenantId,
      vulnId,
      deviceId,
      channel,
      scheduleAt,
      source,
      sourceExplicit,
      packageId,
      action,
      manualScript,
      batchId,
      win32Deploy,
      storeAppDeploy,
    } = req.body ?? {};

    if (!tenantId || !vulnId || !deviceId || !channel) {
      return reply
        .code(400)
        .send({ error: "tenantId, vulnId, deviceId and channel are required" });
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
    const remediationAction: RemediationAction =
      (action as RemediationAction | undefined) ?? "upgrade";

    // Optional alternate source for a not-supported app. Validate the enum here;
    // the package id is resolved from the curated map once the vuln is known.
    let parsedSource: PackageSource | null = null;
    if (source !== undefined && source !== null && source !== "") {
      const s = PackageSource.safeParse(source);
      if (!s.success) {
        return reply.code(400).send({ error: `unknown source: ${source}` });
      }
      parsedSource = s.data;
    }

    const scheduleAtError = validateScheduleAt(scheduleAt);
    if (scheduleAtError) {
      return reply.code(400).send({ error: scheduleAtError });
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

    // Software Evidence (disk + registry paths) is fetched up front so the
    // per-user/machine-wide scope signal can inform auto-routing below, before
    // the script is built. Defender Live Response has no user-context mode —
    // a SYSTEM-context winget can't see per-user-scoped installs, so a known
    // per-user app is routed to a curated alternate source instead.
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

    // Resolve package ids, honouring an engineer override from the Run Now
    // dialog. No source -> the override replaces the CVE's stored winget
    // mapping; with a source -> it replaces the alternate-source id
    // (Chocolatey id / Store product id) — live-matched against the mirrored
    // Chocolatey catalog first, curated map as fallback. When the engineer
    // didn't pick a source and the evidence shows a per-user install,
    // auto-route to the first resolved alternate source (SYSTEM-context
    // winget can't see/manage a per-user-scoped install). `sourceExplicit`
    // marks a real engineer choice from the "4. Catalog" picker even when that
    // choice is Winget (which otherwise serializes identically to "no choice
    // made") — an explicit choice is never overridden.
    const autoAlt =
      !parsedSource && !sourceExplicit && installScope === "user"
        ? (resolveAltSources(chocolateyMatcher, vuln.tenantId, vuln.software)[0] ?? null)
        : null;
    const effectiveSource: PackageSource | null = parsedSource ?? autoAlt?.source ?? null;
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
      // winget-app only: the engineer's manifestSearch pick, carried in
      // storeAppDeploy — see the matching branch in preflight.ts's step 8.
      // Without this the gate always fails "No Microsoft Store package
      // selected" even when one genuinely was.
      storePackageId: storeAppDeploy?.packageId?.trim() || null,
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

    // Authoritative server-side gate — never trust a client "canProceed".
    const report = preflight(input);
    if (!report.canProceed) {
      return reply
        .code(422)
        .send({ error: "preflight failed", report });
    }

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

    // Resolve the same disk-path-evidence-aware display name the CVE
    // drill-down UI shows (e.g. "Google Chrome" vs "Microsoft Edge
    // (Chromium-based)" for the ambiguous "chromium" DB literal), snapshotted
    // onto the job so the Jobs page's historical record matches what was
    // actually true of this device at dispatch time, not a live re-join that
    // a later sync or shared-engine CVE duplicate row could rewrite.
    const resolvedSoftware = resolveDisplaySoftwareName(vuln.software, diskPaths);

    const engineer = req.session.engineer!.upn;

    // Deploy-or-reuse the Intune Win32 app before the job exists — a failed
    // deploy must never leave a job pointing at an app that was never
    // created. `deployOrReuseWin32App` itself audits the intune-app:create/
    // assign outcome; win32DeployResult below only adds a summary of that to
    // this dispatch's own audit row.
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
      cveId: vuln.cveId,
      channel: parsedChannel.data,
      engineer,
      script,
      scheduleAt,
      packageId: !effectiveSource && override ? override : null,
      installScope,
      action: remediationAction,
      // A script-sourced win32-app deploy tags the job with `source: "script"`
      // + the script-catalog entry id, and a winget-app deploy tags it with
      // `source: "microsoft-store"` + the Store package id, so the executor's
      // win32-app/winget-app cases can find their `intune_app_deployments`
      // reuse row — see RemediationJob.source in queue.ts. Every other
      // channel/catalog combination keeps the existing alternate-repo meaning
      // of these fields.
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

    // Audit the write action (#3). The endpoint recorded is the channel's real
    // Microsoft target so the log reflects what *would* be called; the payload
    // (the script) is hashed, never stored raw.
    await audit({
      engineer,
      tenantId: tenant.tenantId,
      endpoint: CHANNEL_SPECS[parsedChannel.data].endpointTemplate,
      method: "POST",
      action: "remediation:dispatch",
      resourceType: "job",
      resourceId: job.id,
      resourceLabel: jobLabel(job),
      summary: `Dispatched ${resolvedSoftware}${vuln.cveId ? ` (${vuln.cveId})` : ""} to ${device.hostname} via ${parsedChannel.data}${scheduleAt ? ` scheduled for ${scheduleAt}` : ""}${win32DeployResult ? ` (Win32 app ${win32DeployResult.reused ? "reused" : "deployed"}: ${win32DeployResult.source}:${win32DeployResult.packageId})` : ""}${winGetAppDeployResult ? ` (Store app ${winGetAppDeployResult.reused ? "reused" : "deployed"}: ${winGetAppDeployResult.packageId})` : ""}`,
      outcome: "success",
      payload:
        win32DeployResult || winGetAppDeployResult
          ? { script, win32Deploy: win32DeployResult, storeAppDeploy: winGetAppDeployResult }
          : script,
      responseStatus: 202,
    });

    // installScope/autoAlt are diagnostic/routing signal only (never a hard
    // gate — see detectInstallScope's JSDoc) and are response-only: they are
    // not persisted on the job row, just surfaced so the engineer can see why
    // a fix was routed to an alternate source instead of winget.
    return reply.code(202).send({
      job,
      script,
      report,
      installScope,
      autoRoutedSource: autoAlt?.source ?? null,
    });
    },
  );

  interface FixAllItem {
    software?: string;
    /** Engineer-confirmed/edited winget package id for this software group. */
    packageId?: string;
  }
  interface FixAllBody {
    /** Engineer-confirmed trigger method from the Fix All dialog. */
    channel?: string;
    /** The software groups the engineer selected in the Fix All dialog. */
    items?: FixAllItem[];
    /** Optional ISO-8601 timestamp to defer every created job to (one-shot scheduling). */
    scheduleAt?: string;
    /**
     * Present only when `channel === "win32-app"`. Shared deploy config
     * applied to every item below — source/packageId aren't here because
     * each item resolves its own from the existing winget/Chocolatey
     * matching logic, same as the non-deploy path already does.
     */
    win32Deploy?: Win32DeployOptions;
  }

  const FIX_ALL_SEVERITY_RANK: Record<string, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };

  /**
   * "Fix All" — orchestrates one job per engineer-confirmed software group on
   * a device (not one per CVE finding): a product with five open CVEs still
   * only needs one `winget upgrade`. The channel and the exact software/
   * package list come from the client-side confirmation dialog, mirroring
   * Run Now's urgency-tier/trigger-method flow — but every item is still
   * re-validated and re-preflighted here, never trusting the client. Findings
   * with no winget package, OS findings, or anything that fails preflight are
   * skipped with a reason rather than attempted, so the summary tells the
   * engineer exactly what still needs a human.
   */
  app.post<{ Params: { id: string }; Body: FixAllBody }>(
    "/api/devices/:id/fix-all",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      const deviceId = req.params.id;
      const { channel, items, scheduleAt, win32Deploy } = req.body ?? {};

      if (!channel || !Array.isArray(items) || items.length === 0) {
        return reply
          .code(400)
          .send({ error: "channel and a non-empty items array are required" });
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

      const requestedItems = items
        .filter((it): it is FixAllItem & { software: string } => !!it?.software)
        .map((it) => ({ software: it.software, packageId: it.packageId?.trim() || null }));
      if (requestedItems.length === 0) {
        return reply.code(400).send({ error: "no valid items provided" });
      }

      const [tenants, devices, vulns, matcher, chocolateyMatcher] = await Promise.all([
        loadTenants(),
        loadDevices(),
        loadVulns(),
        buildWingetMatcher(),
        buildChocolateyMatcher(),
      ]);

      const device = devices.find((d) => d.id === deviceId);
      if (!device) return reply.code(404).send({ error: "device not found" });
      const tenant = tenants.find((t) => t.tenantId === device.tenantId);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });

      if (!device.defenderMachineId) {
        return reply.code(202).send({ jobsCreated: 0, jobs: [], skipped: [] });
      }

      type Link = {
        cveId: string;
        software: string;
        diskPaths: string[] | null;
        registryPaths: string[] | null;
      };
      const deviceLinks: Link[] = config.DEMO_MODE
        ? demoDeviceVulnerabilities.filter(
            (dv) =>
              dv.tenantId === device.tenantId &&
              dv.defenderMachineId === device.defenderMachineId,
          )
        : await db
            .select({
              cveId: tables.deviceVulnerabilities.cveId,
              software: tables.deviceVulnerabilities.software,
              diskPaths: tables.deviceVulnerabilities.diskPaths,
              registryPaths: tables.deviceVulnerabilities.registryPaths,
            })
            .from(tables.deviceVulnerabilities)
            .where(
              and(
                eq(tables.deviceVulnerabilities.tenantId, device.tenantId),
                eq(
                  tables.deviceVulnerabilities.defenderMachineId,
                  device.defenderMachineId,
                ),
              ),
            );

      const linkKey = (cveId: string, software: string) => `${cveId}\x1f${software}`;
      const linkKeys = new Set(deviceLinks.map((l) => linkKey(l.cveId, l.software)));
      const diskPathsByKey = new Map(
        deviceLinks.map((l) => [linkKey(l.cveId, l.software), l.diskPaths]),
      );
      const registryPathsByKey = new Map(
        deviceLinks.map((l) => [linkKey(l.cveId, l.software), l.registryPaths]),
      );

      const deviceVulns = vulns.filter(
        (v) => v.tenantId === device.tenantId && linkKeys.has(linkKey(v.cveId, v.software)),
      );

      const bySoftware = new Map<string, VulnerabilityRow[]>();
      for (const v of deviceVulns) {
        const arr = bySoftware.get(v.software);
        if (arr) arr.push(v);
        else bySoftware.set(v.software, [v]);
      }

      const channelValue = parsedChannel.data;
      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;
      // Hoisted out of the per-software loop: Fix All is a fan-out over one
      // device, so the exclusion answer is the same for every item.
      const excludedIndex = await loadExcludedDeviceIndex(device.tenantId);
      // Same reasoning — one tenant per Fix All request, so the write gate
      // (readOnly + vendor entitlement) doesn't change between items.
      const writeGate = await assertWritesAllowed(tenant);
      // Same reasoning again — one device per Fix All request, so the Live
      // Response device quota answer doesn't change between items either.
      // Only meaningful for the live-response channel; undefined otherwise.
      const liveResponseQuota =
        channelValue === "live-response"
          ? await checkLiveResponseDeviceQuota(tenant.tenantId, device.id)
          : undefined;

      const created: Awaited<ReturnType<typeof createJob>>[] = [];
      const skipped: { software: string; reason: string }[] = [];
      const routing: {
        software: string;
        installScope: InstallScope;
        autoRoutedSource: PackageSource | null;
      }[] = [];
      // One batchId per Fix All request, shared by every job it creates, so
      // the Jobs page can group them under a single expandable row.
      const batchId = randomUUID();

      for (const item of requestedItems) {
        const group = bySoftware.get(item.software);
        if (!group || group.length === 0) {
          skipped.push({
            software: item.software,
            reason: "No matching vulnerability found for this software on this device.",
          });
          continue;
        }
        if (isOsFinding(item.software)) {
          skipped.push({
            software: item.software,
            reason: "OS patch — use the Windows update channel, not Fix All.",
          });
          continue;
        }

        const representative = group.reduce((best, v) =>
          (FIX_ALL_SEVERITY_RANK[v.severity] ?? 0) > (FIX_ALL_SEVERITY_RANK[best.severity] ?? 0)
            ? v
            : best,
        );

        const groupDiskPaths = [
          ...new Set(
            group.flatMap((v) => diskPathsByKey.get(linkKey(v.cveId, v.software)) ?? []),
          ),
        ];
        const groupRegistryPaths = [
          ...new Set(
            group.flatMap((v) => registryPathsByKey.get(linkKey(v.cveId, v.software)) ?? []),
          ),
        ];
        // installScope picks an alt source for known per-user apps; when no
        // alt source covers this software, preflight's install-scope check
        // blocks the item below rather than letting a doomed winget/Live
        // Response dispatch through (never an in-script winget heuristic —
        // see detectInstallScope's JSDoc).
        const installScope: InstallScope = detectInstallScope(
          groupDiskPaths.length > 0 ? groupDiskPaths : null,
          groupRegistryPaths.length > 0 ? groupRegistryPaths : null,
        );
        const autoAlt =
          !item.packageId && installScope === "user"
            ? (resolveAltSources(chocolateyMatcher, representative.tenantId, item.software)[0] ?? null)
            : null;
        const effectiveSource: PackageSource | null = autoAlt?.source ?? null;

        // wingetPackageId on `representative` is frozen at sync time and
        // over-reports "out of winget scope" as the catalog/overrides evolve —
        // recompute live against the current catalog rather than trust it.
        const match = matcher(representative.tenantId, representative.software);
        const effectiveWingetId = !effectiveSource
          ? (item.packageId ?? match?.packageId ?? null)
          : null;
        const altPackageId = effectiveSource
          ? (item.packageId ??
            resolveAltSource(chocolateyMatcher, representative.tenantId, item.software, effectiveSource)
              ?.packageId ??
            null)
          : null;
        if (!effectiveWingetId && !altPackageId) {
          skipped.push({
            software: item.software,
            reason: "No winget package mapped for this software.",
          });
          continue;
        }

        const input: PreflightInput = {
          channel: channelValue,
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
            id: representative.id,
            title: representative.title,
            software: representative.software,
            severity: representative.severity,
            wingetRemediable: Boolean(match),
            wingetPackageId: effectiveWingetId,
          },
          device: toPreflightDevice(device, excludedIndex),
          writeGate,
          liveResponseQuota,
        };

        const report = preflight(input);
        if (!report.canProceed) {
          const failed = report.checks.find((c) => c.status === "fail");
          skipped.push({
            software: item.software,
            reason: failed?.detail ?? "Preflight failed.",
          });
          continue;
        }

        const script = remediationScript({
          channel: channelValue,
          wingetPackageId: effectiveWingetId,
          software: representative.software,
          source: effectiveSource,
          altPackageId,
          installScope,
        });

        const resolvedSoftware = resolveDisplaySoftwareName(
          item.software,
          groupDiskPaths.length > 0 ? groupDiskPaths : null,
        );

        // Deploy-or-reuse the Intune Win32 app for this software before its
        // job exists — source/packageId are derived the same way the script
        // above was (Chocolatey when auto-routed, winget otherwise); Fix All
        // has no per-item Script Catalog pick, so "script" never applies
        // here. A deploy failure skips just this item, matching every other
        // per-item failure path in this loop rather than aborting the batch.
        let win32DeployResult: { source: Win32Source; packageId: string; reused: boolean } | null =
          null;
        if (channelValue === "win32-app" && win32Deploy) {
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
            skipped.push({ software: item.software, reason: `Win32 app deploy failed: ${message}` });
            continue;
          }
        }

        const job = await createJob({
          tenantId: tenant.tenantId,
          deviceId: device.id,
          // representative is the highest-severity CVE in the group — always
          // non-null, unlike the old "null when >1 CVE" logic that starved
          // the worker's live-response gate of a CVE to key its lookup off.
          cveId: representative.cveId,
          channel: channelValue,
          engineer,
          script,
          scheduleAt,
          packageId: effectiveSource ? null : effectiveWingetId,
          installScope,
          source: effectiveSource,
          altPackageId,
          deviceHostname: device.hostname,
          software: resolvedSoftware,
          batchId,
        });

        await audit({
          engineer,
          tenantId: tenant.tenantId,
          endpoint: CHANNEL_SPECS[channelValue].endpointTemplate,
          method: "POST",
          // One row per job, not per Fix All click: each is a separate write to
          // a device and has to be individually traceable.
          action: "remediation:fix-all",
          resourceType: "job",
          resourceId: job.id,
          resourceLabel: jobLabel(job),
          summary: `Fix All dispatched ${resolvedSoftware} (${representative.cveId}) to ${device.hostname} via ${channelValue}${win32DeployResult ? ` (Win32 app ${win32DeployResult.reused ? "reused" : "deployed"}: ${win32DeployResult.source}:${win32DeployResult.packageId})` : ""}`,
          outcome: "success",
          payload: win32DeployResult ? { script, win32Deploy: win32DeployResult } : script,
          responseStatus: 202,
        });

        created.push(job);
        routing.push({
          software: item.software,
          installScope,
          autoRoutedSource: autoAlt?.source ?? null,
        });
      }

      return reply
        .code(202)
        .send({ jobsCreated: created.length, jobs: created, skipped, routing });
    },
  );

  app.get<{ Querystring: { tenantId?: string; includeArchived?: string } }>(
    "/api/jobs",
    async (req) => {
      return listJobs(req.query?.tenantId, req.query?.includeArchived === "true");
    },
  );

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req, reply) => {
    const job = await getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "job not found" });
    return job;
  });

  app.patch<{ Params: { id: string }; Body: { archived?: boolean } }>(
    "/api/jobs/:id/archive",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      const archived = req.body?.archived ?? true;
      const job = archived
        ? await archiveJob(req.params.id)
        : await unarchiveJob(req.params.id);
      if (!job) return reply.code(404).send({ error: "job not found" });

      await audit({
        engineer: req.session.engineer!.upn,
        tenantId: job.tenantId,
        endpoint: `/api/jobs/${job.id}/archive`,
        method: "PATCH",
        action: archived ? "job:archive" : "job:unarchive",
        resourceType: "job",
        resourceId: job.id,
        resourceLabel: jobLabel(job),
        summary: `${archived ? "Archived" : "Restored"} the ${jobLabel(job)} job`,
        outcome: "success",
        responseStatus: 200,
      });

      return job;
    },
  );

  /**
   * Retry — resubmits a failed job's exact original script/params as a new
   * queued job. Deliberately skips preflight: the dispatch already passed it
   * once, and the worker re-checks the tenant's read-only posture at
   * execution time regardless (the authoritative gate — see executor.ts).
   * Only available for jobs created after the `script` column existed and
   * that carry a deviceId (Fix Now/Fix All dispatches; Intune device-sync has
   * no script to replay).
   */
  app.post<{ Params: { id: string } }>(
    "/api/jobs/:id/retry",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
    const job = await getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "job not found" });
    if (job.status !== "failed") {
      return reply.code(422).send({ error: "only a failed job can be retried" });
    }
    if (!job.script || !job.deviceId) {
      return reply
        .code(422)
        .send({ error: "this job predates retry support and cannot be resubmitted" });
    }

    const engineer = req.session.engineer!.upn;
    const retried = await createJob({
      tenantId: job.tenantId,
      deviceId: job.deviceId,
      cveId: job.cveId,
      kbId: job.kbId,
      featureUpdateVersion: job.featureUpdateVersion,
      channel: job.channel,
      engineer,
      script: job.script,
      packageId: job.packageId,
      installScope: job.installScope,
      action: job.action,
      source: job.source,
      altPackageId: job.altPackageId,
      deviceHostname: job.deviceHostname,
      software: job.software,
    });

    await audit({
      engineer,
      tenantId: job.tenantId,
      endpoint: CHANNEL_SPECS[job.channel].endpointTemplate,
      method: "POST",
      action: "remediation:retry",
      resourceType: "job",
      resourceId: retried.id,
      resourceLabel: jobLabel(retried),
      summary: `Retried the ${jobLabel(job)} job (was ${job.id}) via ${job.channel}`,
      outcome: "success",
      payload: job.script,
      responseStatus: 202,
    });

    return reply.code(202).send({ job: retried });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/jobs/:id",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
    // Read first: a hard delete leaves no row to describe afterwards, and this
    // is the one job mutation the jobs table itself cannot account for.
    const job = await getJob(req.params.id);
    const ok = await deleteJob(req.params.id);
    if (!ok) return reply.code(404).send({ error: "job not found" });

    await audit({
      engineer: req.session.engineer!.upn,
      tenantId: job?.tenantId ?? null,
      endpoint: `/api/jobs/${req.params.id}`,
      method: "DELETE",
      action: "job:delete",
      resourceType: "job",
      resourceId: req.params.id,
      resourceLabel: job ? jobLabel(job) : null,
      summary: job
        ? `Permanently deleted the ${jobLabel(job)} job (${job.status})`
        : `Permanently deleted job ${req.params.id}`,
      outcome: "success",
      responseStatus: 204,
    });

    return reply.code(204).send();
    },
  );

  // Bulk variants back the Jobs page's multi-select toolbar. Each id is applied
  // independently (same archiveJob/unarchiveJob/deleteJob as the single-row
  // actions) so one missing/already-deleted id can't fail the whole batch —
  // the response reports exactly which ids succeeded.
  app.post<{ Body: { ids?: string[]; archived?: boolean } }>(
    "/api/jobs/bulk-archive",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      const { ids, archived = true } = req.body ?? {};
      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ error: "ids must be a non-empty array" });
      }
      const results = await Promise.all(
        ids.map(async (id) => ({
          id,
          ok: Boolean(archived ? await archiveJob(id) : await unarchiveJob(id)),
        })),
      );
      const updated = results.filter((r) => r.ok).map((r) => r.id);
      const notFound = results.filter((r) => !r.ok).map((r) => r.id);

      await audit({
        engineer: req.session.engineer!.upn,
        endpoint: "/api/jobs/bulk-archive",
        method: "POST",
        // One row for the batch, not one per job: a 200-job archive is a single
        // decision, and 200 rows would bury everything else on the page.
        action: archived ? "job:bulk-archive" : "job:unarchive",
        resourceType: "job",
        summary: `${archived ? "Archived" : "Restored"} ${updated.length} of ${ids.length} jobs`,
        outcome: notFound.length ? "partial" : "success",
        detail: notFound.length ? `Not found: ${idList(notFound)}` : null,
        responseStatus: 200,
      });

      return { updated, notFound };
    },
  );

  app.post<{ Body: { ids?: string[] } }>(
    "/api/jobs/bulk-delete",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.code(400).send({ error: "ids must be a non-empty array" });
    }
    // Labels have to be captured before the rows disappear (see jobLabel).
    const labels = new Map<string, string>();
    for (const id of ids) {
      const job = await getJob(id);
      if (job) labels.set(id, jobLabel(job));
    }

    const results = await Promise.all(
      ids.map(async (id) => ({ id, ok: await deleteJob(id) })),
    );
    const deleted = results.filter((r) => r.ok).map((r) => r.id);
    const notFound = results.filter((r) => !r.ok).map((r) => r.id);

    await audit({
      engineer: req.session.engineer!.upn,
      endpoint: "/api/jobs/bulk-delete",
      method: "POST",
      action: "job:bulk-delete",
      resourceType: "job",
      summary: `Permanently deleted ${deleted.length} of ${ids.length} jobs`,
      outcome: notFound.length ? "partial" : "success",
      detail: [
        deleted.length ? `Deleted: ${idList(deleted.map((id) => labels.get(id) ?? id))}` : null,
        notFound.length ? `Not found: ${idList(notFound)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      responseStatus: 200,
    });

    return { deleted, notFound };
    },
  );
}
