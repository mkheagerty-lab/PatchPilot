import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { audit, GraphError } from "@patchpilot/graph";
import {
  assignMobileApp,
  getMobileApp,
  updateMobileAppMetadata,
  waitForAppPublished,
  WINGET_APP_ODATA_TYPE,
} from "@patchpilot/graph";
import { isWin32Source, type Win32Source } from "@patchpilot/shared";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import {
  deployOrReuseWin32App,
  resolveAssignmentTargets,
  isAssignmentMode,
  Win32DeployError,
  type AssignmentInput,
} from "../services/win32-app-deploy.js";
import { deployOrReuseWinGetApp } from "../services/winget-app-deploy.js";

/**
 * Deploy App routes: create a real `winGetApp` (Phase 1) or `win32LobApp`
 * (Phase 2) object in a customer's Intune tenant and edit it — Name/
 * Description/Install Behaviour/Assignment — after the fact, replicating
 * CIPP's Deploy App UX.
 *
 * Entirely live-Graph-backed (there is no meaningful DEMO_MODE simulation of
 * "an app object exists in a customer's Intune tenant"), so every route here
 * 409s outright in demo mode, before touching the DB or Graph — the same
 * guard catalog.ts's /api/catalog/refresh and /overrides writes use.
 *
 * `intune_app_deployments` is a thin idempotency index only (see schema.ts's
 * doc comment) — Name/Description/Assignment are always read live from Graph,
 * never cached here.
 */

export async function intuneAppsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });

  /**
   * Live-fetch an Intune app's current state — powers the Deploy App form's
   * edit mode. Read-only, so it's gated on operations:read rather than write,
   * and is never blocked by a tenant's readOnly flag (only writes are).
   */
  app.get<{ Params: { appId: string }; Querystring: { tenantId?: string } }>(
    "/api/intune-apps/:appId",
    { preHandler: requirePermission("operations:read") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "Intune app deployment is unavailable in demo mode" });
      }
      const tenantId = req.query.tenantId?.trim();
      if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;

      const mobileApp = await getMobileApp({
        engineer,
        homeTenantId,
        tenantId,
        appId: req.params.appId,
      });
      if (!mobileApp) return reply.code(404).send({ error: "app not found" });
      return mobileApp;
    },
  );

  /**
   * Create-or-reuse a WinGet app. Idempotent by (tenantId, "winget",
   * packageId): a second click (or a Catalog page that hasn't refreshed its
   * deployment-index lookup yet) reuses the existing app rather than creating
   * a duplicate object in the tenant.
   *
   * No live frontend caller today (the catalog page's old Deploy button was
   * retired — see commit b06840f) — kept working for any historical rows and
   * as a thin wrapper so it stays exercised. Logic lives in
   * `deployOrReuseWinGetApp` (`source: "winget"`, distinct from the
   * "Microsoft Store app (new)" channel's `source: "microsoft-store"` — the
   * two never collide in `intune_app_deployments`' reuse index).
   */
  app.post<{
    Body: {
      tenantId?: string;
      packageId?: string;
      displayName?: string;
      description?: string;
      publisher?: string;
      runAsAccount?: "system" | "user";
      assignment?: AssignmentInput;
    };
  }>(
    "/api/intune-apps/winget",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "Intune app deployment is unavailable in demo mode" });
      }
      const { tenantId, packageId, displayName, publisher } = req.body;

      if (!tenantId || !packageId?.trim() || !displayName?.trim() || !publisher?.trim()) {
        return reply
          .code(400)
          .send({ error: "tenantId, packageId, displayName and publisher are required" });
      }
      if (req.body.assignment?.mode && !isAssignmentMode(req.body.assignment.mode)) {
        return reply.code(400).send({ error: `unknown assignment mode: ${req.body.assignment.mode}` });
      }

      const [tenant] = await db
        .select()
        .from(tables.tenants)
        .where(eq(tables.tenants.tenantId, tenantId))
        .limit(1);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      if (tenant.readOnly) {
        return reply
          .code(403)
          .send({ error: "Tenant is read-only — opt in to write actions before deploying an app." });
      }

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;

      try {
        const result = await deployOrReuseWinGetApp({
          engineer,
          homeTenantId,
          tenantId,
          source: "winget",
          packageId,
          displayName,
          description: req.body.description,
          publisher,
          runAsAccount: req.body.runAsAccount,
          assignment: req.body.assignment,
        });
        const app = await getMobileApp({ engineer, homeTenantId, tenantId, appId: result.appId });
        return reply.code(result.reused ? 200 : 201).send({ ...result, app });
      } catch (err) {
        if (err instanceof Win32DeployError) {
          return reply.code(err.status).send({ error: err.message, code: err.code, appId: err.appId });
        }
        throw err;
      }
    },
  );

  /**
   * Create-or-reuse a Win32 app (Phase 2) from a winget-, Chocolatey-, or
   * Script-Catalog-sourced package. Idempotent by (tenantId, source,
   * packageId). Thin validate-then-call wrapper — all of the create/upload/
   * assign/reuse/audit work lives in `deployOrReuseWin32App`, shared with the
   * Run Now / Fix All dispatch routes in `jobs.ts`.
   */
  app.post<{
    Body: {
      tenantId?: string;
      source?: Win32Source;
      packageId?: string;
      displayName?: string;
      description?: string;
      publisher?: string;
      runAsAccount?: "system" | "user";
      minVersion?: string;
      installChoco?: boolean;
      customRepo?: string;
      customArguments?: string;
      assignment?: AssignmentInput;
    };
  }>(
    "/api/intune-apps/win32",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "Intune app deployment is unavailable in demo mode" });
      }
      const { tenantId, source, packageId, displayName, publisher } = req.body;

      if (!isWin32Source(source)) {
        return reply.code(400).send({ error: 'source must be "winget", "chocolatey" or "script"' });
      }
      if (!tenantId || !packageId?.trim() || !displayName?.trim() || !publisher?.trim()) {
        return reply
          .code(400)
          .send({ error: "tenantId, packageId, displayName and publisher are required" });
      }

      const [tenant] = await db
        .select()
        .from(tables.tenants)
        .where(eq(tables.tenants.tenantId, tenantId))
        .limit(1);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      if (tenant.readOnly) {
        return reply
          .code(403)
          .send({ error: "Tenant is read-only — opt in to write actions before deploying an app." });
      }

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;

      try {
        const result = await deployOrReuseWin32App({
          engineer,
          homeTenantId,
          tenantId,
          source,
          packageId,
          displayName,
          description: req.body.description,
          publisher,
          runAsAccount: req.body.runAsAccount,
          minVersion: req.body.minVersion,
          installChoco: req.body.installChoco,
          customRepo: req.body.customRepo,
          customArguments: req.body.customArguments,
          assignment: req.body.assignment,
        });
        return reply.code(result.reused ? 200 : 201).send(result);
      } catch (err) {
        if (err instanceof Win32DeployError) {
          return reply.code(err.status).send({ error: err.message, code: err.code, appId: err.appId });
        }
        throw err;
      }
    },
  );

  /**
   * Metadata edit (Name/Description) and/or reassignment — "changing on the
   * fly" without re-creating the app. Either half is optional; a request can
   * patch metadata only, assignment only, or both.
   *
   * Install Behaviour (runAsAccount) is deliberately not editable here —
   * live-verified against BLACK IRON, Graph rejects any PATCH whose body
   * includes installExperience at all, unconditionally. It's fixed at
   * creation time, same as Publisher.
   */
  app.patch<{
    Params: { appId: string };
    Body: {
      tenantId?: string;
      displayName?: string;
      description?: string;
      assignment?: AssignmentInput;
    };
  }>(
    "/api/intune-apps/:appId",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "Intune app deployment is unavailable in demo mode" });
      }
      const { appId } = req.params;
      const { tenantId, displayName, description, assignment } = req.body;
      if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });
      if (assignment && !isAssignmentMode(assignment.mode)) {
        return reply.code(400).send({ error: `unknown assignment mode: ${assignment.mode}` });
      }

      const [tenant] = await db
        .select()
        .from(tables.tenants)
        .where(eq(tables.tenants.tenantId, tenantId))
        .limit(1);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });
      if (tenant.readOnly) {
        return reply
          .code(403)
          .send({ error: "Tenant is read-only — opt in to write actions before editing this app." });
      }

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;
      const ctx = { engineer, homeTenantId, tenantId };

      const current = await getMobileApp({ ...ctx, appId });
      if (!current) return reply.code(404).send({ error: "app not found" });
      const odataType = (current["@odata.type"] as string | undefined) ?? WINGET_APP_ODATA_TYPE;

      const startedAt = Date.now();
      const changes: string[] = [];

      // Any PATCH — metadata or assignment — 400s with "PublishingState is
      // not 'Published'" while Intune is still building a freshly created
      // winGetApp server-side. Wait once, up front, if there's anything to
      // do here at all.
      if ((displayName !== undefined || description !== undefined || assignment) && current.publishingState !== "published") {
        const published = await waitForAppPublished({ ...ctx, appId });
        if (!published) {
          return reply.code(409).send({
            error:
              "This app is still being processed by Intune and can't be edited yet — try again in a minute.",
          });
        }
      }

      if (displayName !== undefined || description !== undefined) {
        try {
          await updateMobileAppMetadata({ ...ctx, appId, odataType, displayName, description });
          if (displayName !== undefined) changes.push(`name -> "${displayName}"`);
          if (description !== undefined) changes.push("description updated");
        } catch (err) {
          const status = err instanceof GraphError ? err.status : 502;
          const message = err instanceof Error ? err.message : String(err);
          await audit({
            engineer,
            tenantId,
            endpoint: `/deviceAppManagement/mobileApps/${appId}`,
            method: "PATCH",
            action: "intune-app:update",
            resourceType: "intune-app",
            resourceId: appId,
            resourceLabel: displayName ?? current.displayName ?? appId,
            summary: `Failed to update Intune app ${appId} metadata`,
            outcome: "failure",
            detail: message,
            responseStatus: status,
            latencyMs: Date.now() - startedAt,
          });
          return reply.code(status).send({ error: message });
        }
      }

      if (assignment) {
        let targets;
        try {
          targets = await resolveAssignmentTargets(assignment);
        } catch (err) {
          const status = err instanceof GraphError ? err.status : 400;
          const message = err instanceof Error ? err.message : String(err);
          if (status === 403) {
            return reply.code(409).send({
              error: `Group lookup failed (HTTP 403) — this tenant likely needs re-consent for the Group.Read.All scope.`,
              code: "needs-reconsent",
            });
          }
          return reply.code(400).send({ error: message });
        }
        try {
          await assignMobileApp({ ...ctx, appId, targets });
          changes.push(`assignment -> ${assignment.mode}`);
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
            resourceLabel: current.displayName ?? appId,
            summary: `Failed to reassign Intune app ${appId}`,
            outcome: "failure",
            detail: message,
            responseStatus: status,
            latencyMs: Date.now() - startedAt,
          });
          return reply.code(status).send({ error: message });
        }
      }

      await audit({
        engineer,
        tenantId,
        endpoint: `/deviceAppManagement/mobileApps/${appId}`,
        method: "PATCH",
        action: "intune-app:update",
        resourceType: "intune-app",
        resourceId: appId,
        resourceLabel: displayName ?? current.displayName ?? appId,
        summary:
          changes.length > 0
            ? `Updated Intune app "${current.displayName ?? appId}" — ${changes.join(", ")}`
            : `No-op update for Intune app ${appId}`,
        outcome: "success",
        payload: { displayName, description, assignment },
        responseStatus: 200,
        latencyMs: Date.now() - startedAt,
      });

      return reply.code(200).send({ appId, updated: true });
    },
  );
}
