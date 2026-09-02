import { and, eq, isNull, or } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { audit, GraphError, sha256Hex } from "@patchpilot/graph";
import {
  buildAssignmentTargets,
  assignMobileApp,
  getMobileApp,
  waitForAppPublished,
  createWin32LobApp,
  uploadWin32AppContent,
  getWin32WrapperPackage,
  getWin32ScriptWrapperPackage,
  type AssignmentMode,
  type AssignmentTarget,
  type Win32WrapperFamily,
} from "@patchpilot/graph";
import {
  generateWingetDetect,
  generateChocolateyDetect,
  generateScriptDetect,
  buildWin32CommandLines,
  type Win32Source,
} from "@patchpilot/shared";

/**
 * DB-aware Win32 app create-or-reuse, shared by `POST /api/intune-apps/win32`
 * (thin wrapper) and the Run Now / Fix All dispatch routes (`jobs.ts`), which
 * need the exact same deploy-or-reuse behaviour synchronously before
 * `createJob()` — moved out of `intune-apps.ts` so neither caller duplicates
 * the create/upload/assign/audit pipeline. Throws `Win32DeployError` instead
 * of shaping a Fastify reply so each caller maps status codes on its own
 * terms (a route 400s; a dispatch route folds it into its own error body).
 */

export const ASSIGNMENT_MODES: AssignmentMode[] = ["none", "all-devices", "all-users", "group"];
export function isAssignmentMode(v: unknown): v is AssignmentMode {
  return typeof v === "string" && (ASSIGNMENT_MODES as string[]).includes(v);
}

export interface AssignmentInput {
  mode: AssignmentMode;
  /** Already-resolved by the client-side Entra group picker — no server-side name lookup. */
  groupId?: string;
  groupName?: string;
  /** Independent of `mode` — settable simultaneously with any include target. */
  excludeGroupId?: string;
  excludeGroupName?: string;
  filterId?: string;
}

/**
 * Validates the client's { mode, groupId?, excludeGroupId? } and builds the
 * Graph assignment target array (possibly both an include and an exclude
 * entry). No Graph call here — the picker already resolved both ids
 * client-side.
 */
export async function resolveAssignmentTargets(input: AssignmentInput): Promise<AssignmentTarget[]> {
  const { mode, groupId, excludeGroupId, filterId } = input;
  if (mode === "group" && !groupId) {
    throw new Error('a group is required for assignment mode "group"');
  }
  return buildAssignmentTargets({ mode, groupId, filterId, excludeGroupId });
}

export class Win32DeployError extends Error {
  status: number;
  code?: "needs-reconsent";
  /** Set once the app object exists in Intune even though this call still failed — a retry must reuse it, not create a duplicate. */
  appId?: string;

  constructor(message: string, opts: { status: number; code?: "needs-reconsent"; appId?: string }) {
    super(message);
    this.name = "Win32DeployError";
    this.status = opts.status;
    this.code = opts.code;
    this.appId = opts.appId;
  }
}

export interface DeployOrReuseWin32AppInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  source: Win32Source;
  /** winget package id / Chocolatey package id / script_catalog.id, depending on `source`. */
  packageId: string;
  /** Omitted to resolve from the matching catalog row (winget/chocolatey) or the script catalog entry's own name. */
  displayName?: string;
  description?: string;
  publisher?: string;
  runAsAccount?: "system" | "user";
  minVersion?: string;
  installChoco?: boolean;
  customRepo?: string;
  customArguments?: string;
  assignment?: AssignmentInput;
}

export interface DeployOrReuseWin32AppResult {
  appId: string;
  reused: boolean;
  warning?: string;
}

export async function deployOrReuseWin32App(
  input: DeployOrReuseWin32AppInput,
): Promise<DeployOrReuseWin32AppResult> {
  const { engineer, homeTenantId, tenantId, source } = input;
  const ctx = { engineer, homeTenantId, tenantId };
  const trimmedPackageId = input.packageId.trim();
  if (!trimmedPackageId) throw new Win32DeployError("packageId is required", { status: 400 });

  const runAsAccount = input.runAsAccount === "user" ? "user" : "system";
  const installChoco = input.installChoco === true;
  const customRepo = input.customRepo?.trim() || undefined;
  const customArguments = input.customArguments?.trim() || undefined;
  const minVersion = input.minVersion?.trim() || undefined;
  const assignment: AssignmentInput = input.assignment?.mode ? input.assignment : { mode: "none" };
  if (!isAssignmentMode(assignment.mode)) {
    throw new Win32DeployError(`unknown assignment mode: ${assignment.mode}`, { status: 400 });
  }

  let displayName = input.displayName?.trim();
  let description = input.description?.trim() ?? "";
  let publisher = input.publisher?.trim();
  let scriptContent: string | undefined;

  if (source === "winget" || source === "chocolatey") {
    if (!displayName || !publisher) {
      const catalogTable = source === "winget" ? tables.wingetCatalog : tables.chocolateyCatalog;
      const [row] = await db
        .select()
        .from(catalogTable)
        .where(eq(catalogTable.packageId, trimmedPackageId))
        .limit(1);
      if (!displayName) displayName = row?.name ?? trimmedPackageId;
      if (!publisher) publisher = row?.publisher ?? "Unknown";
    }
  } else {
    // source === "script": packageId is the script_catalog entry's id — same
    // tenant-or-global visibility rule as GET /api/script-catalog.
    const [row] = await db
      .select()
      .from(tables.scriptCatalog)
      .where(
        and(
          eq(tables.scriptCatalog.id, trimmedPackageId),
          or(eq(tables.scriptCatalog.tenantId, tenantId), isNull(tables.scriptCatalog.tenantId)),
        ),
      )
      .limit(1);
    if (!row) throw new Win32DeployError("script catalog entry not found", { status: 404 });
    // Re-validated here even though the client already gates on this (see
    // apps/web/src/lib/scripts.ts's isDispatchableScript) — the wrapper this
    // module bakes the script into is a raw PowerShell block, so a
    // cmd/bash entry must never reach it.
    if (row.scriptType !== "powershell") {
      throw new Win32DeployError(
        "only PowerShell script catalog entries can be deployed as a Win32 app",
        { status: 400 },
      );
    }
    scriptContent = row.scriptContent;
    if (!displayName) displayName = row.name;
    if (!description) description = row.description ?? "";
    if (!publisher) publisher = "PatchPilot Script Catalog";
  }

  if (!displayName || !publisher) {
    throw new Win32DeployError("displayName and publisher are required", { status: 400 });
  }

  const startedAt = Date.now();
  let targets: AssignmentTarget[];
  try {
    targets = await resolveAssignmentTargets(assignment);
  } catch (err) {
    const status = err instanceof GraphError ? err.status : 400;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 403) {
      throw new Win32DeployError(
        "Group lookup failed (HTTP 403) — this tenant likely needs re-consent for the Group.Read.All scope.",
        { status: 409, code: "needs-reconsent" },
      );
    }
    throw new Win32DeployError(message, { status: 400 });
  }

  const [existing] = await db
    .select()
    .from(tables.intuneAppDeployments)
    .where(
      and(
        eq(tables.intuneAppDeployments.tenantId, tenantId),
        eq(tables.intuneAppDeployments.appType, "win32-lob"),
        eq(tables.intuneAppDeployments.source, source),
        eq(tables.intuneAppDeployments.packageId, trimmedPackageId),
      ),
    )
    .limit(1);
  if (existing) {
    const current = await getMobileApp({ ...ctx, appId: existing.intuneAppId });
    if (current) {
      // A prior deploy of this same package may have used a different (or no)
      // assignment — e.g. first created with "Do not Assign", then redeployed
      // via the win32-app channel with a real target. Reusing the app object
      // must not silently skip applying the assignment the caller is asking
      // for now; only "none" is a true no-op.
      if (targets.length) {
        try {
          await assignMobileApp({ ...ctx, appId: existing.intuneAppId, targets });
        } catch (err) {
          const status = err instanceof GraphError ? err.status : 502;
          const message = err instanceof Error ? err.message : String(err);
          await audit({
            engineer,
            tenantId,
            endpoint: `/deviceAppManagement/mobileApps/${existing.intuneAppId}/assign`,
            method: "POST",
            action: "intune-app:assign",
            resourceType: "intune-app",
            resourceId: existing.intuneAppId,
            resourceLabel: displayName,
            summary: `Reused Win32 app "${displayName}" but assignment failed`,
            outcome: "failure",
            detail: message,
            responseStatus: status,
            latencyMs: Date.now() - startedAt,
          });
          throw new Win32DeployError(message, { status, appId: existing.intuneAppId });
        }
        await audit({
          engineer,
          tenantId,
          endpoint: `/deviceAppManagement/mobileApps/${existing.intuneAppId}/assign`,
          method: "POST",
          action: "intune-app:assign",
          resourceType: "intune-app",
          resourceId: existing.intuneAppId,
          resourceLabel: displayName,
          summary: `Reused Win32 app "${displayName}" (${source}:${trimmedPackageId}) — assignment: ${assignment.mode}`,
          outcome: "success",
          payload: { source, packageId: trimmedPackageId, runAsAccount, assignment },
          responseStatus: 200,
          latencyMs: Date.now() - startedAt,
        });
      }
      return { appId: existing.intuneAppId, reused: true };
    }
  }

  let wrapperPackage: ReturnType<typeof getWin32WrapperPackage>;
  let detectionScript: string;
  if (source === "script") {
    const contentHash = sha256Hex(scriptContent!);
    wrapperPackage = getWin32ScriptWrapperPackage({
      scriptCatalogEntryId: trimmedPackageId,
      scriptContent: scriptContent!,
      contentHash,
    });
    detectionScript = generateScriptDetect({ scriptCatalogEntryId: trimmedPackageId, contentHash });
  } else {
    const family: Win32WrapperFamily = source;
    wrapperPackage = getWin32WrapperPackage(family);
    detectionScript =
      source === "winget"
        ? generateWingetDetect({ packageId: trimmedPackageId, minVersion })
        : generateChocolateyDetect({ packageId: trimmedPackageId, minVersion });
  }
  const { installCommandLine, uninstallCommandLine } = buildWin32CommandLines({
    source,
    packageId: trimmedPackageId,
    installChoco,
    customRepo,
    customArguments,
  });
  const detectionScriptContentBase64 = Buffer.from(detectionScript, "utf-8").toString("base64");

  let appId: string;
  try {
    appId = await createWin32LobApp({
      ...ctx,
      displayName,
      description,
      publisher,
      installCommandLine,
      uninstallCommandLine,
      runAsAccount,
      setupFileName: wrapperPackage.setupFileName,
      detectionScriptContentBase64,
    });
  } catch (err) {
    const status = err instanceof GraphError ? err.status : 502;
    const message = err instanceof Error ? err.message : String(err);
    await audit({
      engineer,
      tenantId,
      endpoint: "/deviceAppManagement/mobileApps",
      method: "POST",
      action: "intune-app:create",
      resourceType: "intune-app",
      resourceLabel: displayName,
      summary: `Failed to create Win32 app "${displayName}" (${source}:${trimmedPackageId})`,
      outcome: "failure",
      detail: message,
      responseStatus: status,
      latencyMs: Date.now() - startedAt,
    });
    throw new Win32DeployError(message, { status });
  }

  // Persist the reuse index as soon as the app object exists, before content
  // upload or assignment — a retry after a downstream failure must reuse
  // this app id, not create another orphan.
  await db
    .insert(tables.intuneAppDeployments)
    .values({
      tenantId,
      appType: "win32-lob",
      source,
      packageId: trimmedPackageId,
      intuneAppId: appId,
      createdBy: engineer,
    })
    .onConflictDoUpdate({
      target: [
        tables.intuneAppDeployments.tenantId,
        tables.intuneAppDeployments.appType,
        tables.intuneAppDeployments.source,
        tables.intuneAppDeployments.packageId,
      ],
      set: { intuneAppId: appId, createdBy: engineer, createdAt: new Date() },
    });

  try {
    await uploadWin32AppContent({
      ...ctx,
      appId,
      package: wrapperPackage.package,
      encryptionInfo: wrapperPackage.encryptionInfo,
      unencryptedContentSize: wrapperPackage.unencryptedContentSize,
    });
  } catch (err) {
    const status = err instanceof GraphError ? err.status : 502;
    const message = err instanceof Error ? err.message : String(err);
    await audit({
      engineer,
      tenantId,
      endpoint: `/deviceAppManagement/mobileApps/${appId}/microsoft.graph.win32LobApp/contentVersions`,
      method: "POST",
      action: "intune-app:create",
      resourceType: "intune-app",
      resourceId: appId,
      resourceLabel: displayName,
      summary: `Created Win32 app "${displayName}" but content upload failed — it exists in Intune, not yet installable`,
      outcome: "failure",
      detail: message,
      responseStatus: status,
      latencyMs: Date.now() - startedAt,
    });
    throw new Win32DeployError(message, { status, appId });
  }

  // Nothing to assign on a fresh create with "Do not Assign" — skip the
  // wait-for-published poll entirely for the common default case.
  if (!targets.length) {
    await audit({
      engineer,
      tenantId,
      endpoint: "/deviceAppManagement/mobileApps",
      method: "POST",
      action: "intune-app:create",
      resourceType: "intune-app",
      resourceId: appId,
      resourceLabel: displayName,
      summary: `Deployed Win32 app "${displayName}" (${source}:${trimmedPackageId}) — not assigned`,
      outcome: "success",
      payload: { source, packageId: trimmedPackageId, runAsAccount, assignment },
      responseStatus: 201,
      latencyMs: Date.now() - startedAt,
    });
    return { appId, reused: false };
  }

  const published = await waitForAppPublished({ ...ctx, appId });
  if (!published) {
    await audit({
      engineer,
      tenantId,
      endpoint: "/deviceAppManagement/mobileApps",
      method: "POST",
      action: "intune-app:create",
      resourceType: "intune-app",
      resourceId: appId,
      resourceLabel: displayName,
      summary: `Deployed Win32 app "${displayName}" (${source}:${trimmedPackageId}) — still processing in Intune, assignment skipped`,
      outcome: "success",
      payload: { source, packageId: trimmedPackageId, runAsAccount, assignment },
      responseStatus: 201,
      latencyMs: Date.now() - startedAt,
    });
    return {
      appId,
      reused: false,
      warning:
        "App created but Intune is still building it server-side — assignment was skipped. Dispatch again in a minute to set assignment.",
    };
  }

  try {
    await assignMobileApp({ ...ctx, appId, targets });
  } catch (err) {
    const status = err instanceof GraphError ? err.status : 502;
    const message = err instanceof Error ? err.message : String(err);
    await audit({
      engineer,
      tenantId,
      endpoint: `/deviceAppManagement/mobileApps/${appId}/assign`,
      method: "POST",
      action: "intune-app:assign",
      resourceType: "intune-app",
      resourceId: appId,
      resourceLabel: displayName,
      summary: `Created Win32 app "${displayName}" but assignment failed — it exists in Intune, targeting nothing`,
      outcome: "failure",
      detail: message,
      responseStatus: status,
      latencyMs: Date.now() - startedAt,
    });
    throw new Win32DeployError(message, { status, appId });
  }

  await audit({
    engineer,
    tenantId,
    endpoint: "/deviceAppManagement/mobileApps",
    method: "POST",
    action: "intune-app:create",
    resourceType: "intune-app",
    resourceId: appId,
    resourceLabel: displayName,
    summary: `Deployed Win32 app "${displayName}" (${source}:${trimmedPackageId}) — assignment: ${assignment.mode}`,
    outcome: "success",
    payload: { source, packageId: trimmedPackageId, runAsAccount, assignment },
    responseStatus: 201,
    latencyMs: Date.now() - startedAt,
  });

  return { appId, reused: false };
}
