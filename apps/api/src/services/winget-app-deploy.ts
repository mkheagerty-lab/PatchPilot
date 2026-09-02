import { and, eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { audit, GraphError, createWinGetApp, getMobileApp, waitForAppPublished, assignMobileApp } from "@patchpilot/graph";
import {
  resolveAssignmentTargets,
  isAssignmentMode,
  Win32DeployError,
  type AssignmentInput,
} from "./win32-app-deploy.js";

/**
 * DB-aware `winGetApp` create-or-reuse, mirroring `deployOrReuseWin32App`'s
 * shape but simpler: a `winGetApp` needs no packaging or content upload —
 * Intune resolves and builds the package server-side from `packageIdentifier`
 * (see `packages/graph/src/winget-app.ts`'s doc comment).
 *
 * `source` distinguishes two callers that must never collide in
 * `intune_app_deployments`' reuse index: `"winget"` is the original Phase 1
 * Deploy-App-off-Catalog-page flow (now dead in the UI — no live caller — but
 * its DB rows and `POST /api/intune-apps/winget` route are preserved as-is
 * for idempotency with anything created before it was retired), keyed against
 * community winget-repo ids that Intune's server-side resolution cannot
 * actually build (root-caused in task #20). `"microsoft-store"` is the
 * "Microsoft Store app (new)" channel — ids resolved live via `manifestSearch`
 * against Microsoft's own curated Store mirror, confirmed to publish
 * successfully in the Phase A spike (see winget-app.ts's doc comment).
 *
 * Reused (not duplicated) by the Run Now dispatch route, which needs the
 * exact same deploy-or-reuse behaviour synchronously before `createJob()`.
 * Throws `Win32DeployError` (generic despite the name — shared with Win32)
 * so each caller maps status codes on its own terms.
 */

export interface DeployOrReuseWinGetAppInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  source: "winget" | "microsoft-store";
  /** winget community-repo id (source "winget") or Store packageIdentifier (source "microsoft-store"), e.g. "9NZVDKPMR9RD". */
  packageId: string;
  displayName: string;
  description?: string;
  publisher: string;
  runAsAccount?: "system" | "user";
  assignment?: AssignmentInput;
}

export interface DeployOrReuseWinGetAppResult {
  appId: string;
  reused: boolean;
  warning?: string;
}

export async function deployOrReuseWinGetApp(
  input: DeployOrReuseWinGetAppInput,
): Promise<DeployOrReuseWinGetAppResult> {
  const { engineer, homeTenantId, tenantId, source } = input;
  const ctx = { engineer, homeTenantId, tenantId };
  const trimmedPackageId = input.packageId.trim();
  if (!trimmedPackageId) throw new Win32DeployError("packageId is required", { status: 400 });

  const displayName = input.displayName.trim();
  const description = input.description?.trim() ?? "";
  const publisher = input.publisher.trim();
  if (!displayName || !publisher) {
    throw new Win32DeployError("displayName and publisher are required", { status: 400 });
  }
  const runAsAccount = input.runAsAccount === "user" ? "user" : "system";
  const assignment: AssignmentInput = input.assignment?.mode ? input.assignment : { mode: "none" };
  if (!isAssignmentMode(assignment.mode)) {
    throw new Win32DeployError(`unknown assignment mode: ${assignment.mode}`, { status: 400 });
  }

  const startedAt = Date.now();
  let targets;
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
        eq(tables.intuneAppDeployments.appType, "winget"),
        eq(tables.intuneAppDeployments.source, source),
        eq(tables.intuneAppDeployments.packageId, trimmedPackageId),
      ),
    )
    .limit(1);
  if (existing) {
    const current = await getMobileApp({ ...ctx, appId: existing.intuneAppId });
    if (current) {
      // Same reasoning as deployOrReuseWin32App: a prior deploy may have used
      // a different (or no) assignment, so reuse must still apply the target
      // the caller is asking for now — only "none" is a true no-op.
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
            summary: `Reused WinGet app "${displayName}" but assignment failed`,
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
          summary: `Reused WinGet app "${displayName}" (${source}:${trimmedPackageId}) — assignment: ${assignment.mode}`,
          outcome: "success",
          payload: { source, packageId: trimmedPackageId, runAsAccount, assignment },
          responseStatus: 200,
          latencyMs: Date.now() - startedAt,
        });
      }
      return { appId: existing.intuneAppId, reused: true };
    }
  }

  let appId: string;
  try {
    appId = await createWinGetApp({
      ...ctx,
      displayName,
      description,
      publisher,
      packageIdentifier: trimmedPackageId,
      runAsAccount,
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
      summary: `Failed to create WinGet app "${displayName}" (${source}:${trimmedPackageId})`,
      outcome: "failure",
      detail: message,
      responseStatus: status,
      latencyMs: Date.now() - startedAt,
    });
    throw new Win32DeployError(message, { status });
  }

  // Persist the reuse index as soon as the app exists in Intune, before
  // attempting assignment — a retry after a downstream failure must reuse
  // this app id, not create another orphan object.
  await db
    .insert(tables.intuneAppDeployments)
    .values({
      tenantId,
      appType: "winget",
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
      summary: `Deployed WinGet app "${displayName}" (${source}:${trimmedPackageId}) — not assigned`,
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
      summary: `Deployed WinGet app "${displayName}" (${source}:${trimmedPackageId}) — still processing in Intune, assignment skipped`,
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
      summary: `Created WinGet app "${displayName}" but assignment failed — it exists in Intune, targeting nothing`,
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
    summary: `Deployed WinGet app "${displayName}" (${source}:${trimmedPackageId}) — assignment: ${assignment.mode}`,
    outcome: "success",
    payload: { source, packageId: trimmedPackageId, runAsAccount, assignment },
    responseStatus: 201,
    latencyMs: Date.now() - startedAt,
  });

  return { appId, reused: false };
}
