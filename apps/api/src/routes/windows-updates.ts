import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { audit, GraphError } from "@patchpilot/graph";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import {
  syncFeatureUpdateProfiles,
  syncQualityUpdateProfiles,
  syncQualityUpdatePolicies,
  syncUpdateRingProfiles,
  syncDriverUpdateProfiles,
} from "../graph/sync.js";

/**
 * Windows Updates hub's page-level "Sync now" — replaces the old
 * per-pipeline sync button with one that refreshes all four tabs (Feature
 * Updates, Quality Updates' two policyTypes, Update Rings, Driver Updates) in
 * one request, one toast, one audit row. Distinct from
 * `POST /api/feature-updates/campaigns/sync`, which still exists for any
 * caller that only wants that one pipeline refreshed.
 */
export async function windowsUpdatesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });

  app.post<{ Body: { tenantId?: string } }>(
    "/api/windows-updates/sync",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "Windows Updates sync is unavailable in demo mode" });
      }
      const { tenantId } = req.body ?? {};
      if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });

      const [tenant] = await db
        .select()
        .from(tables.tenants)
        .where(eq(tables.tenants.tenantId, tenantId))
        .limit(1);
      if (!tenant) return reply.code(404).send({ error: "tenant not found" });

      const engineer = {
        upn: req.session.engineer!.upn,
        homeTenantId: req.session.engineer!.homeTenantId,
      };
      const startedAt = Date.now();
      try {
        const featureUpdates = await syncFeatureUpdateProfiles(engineer, tenantId);
        const expeditePolicies = await syncQualityUpdateProfiles(engineer, tenantId);
        const qualityUpdatePolicies = await syncQualityUpdatePolicies(engineer, tenantId);
        const updateRings = await syncUpdateRingProfiles(engineer, tenantId);
        const driverUpdates = await syncDriverUpdateProfiles(engineer, tenantId);

        const counts = {
          featureUpdates: featureUpdates.count,
          expeditePolicies: expeditePolicies.count,
          qualityUpdatePolicies: qualityUpdatePolicies.count,
          updateRings: updateRings.count,
          driverUpdates: driverUpdates.count,
        };

        await audit({
          engineer: engineer.upn,
          tenantId,
          endpoint: "/api/windows-updates/sync",
          method: "POST",
          action: "windows-updates:sync",
          resourceType: "windows-updates",
          resourceLabel: tenant.displayName,
          summary: `Synced ${counts.featureUpdates} feature updates, ${counts.expeditePolicies} expedite policies, ${counts.qualityUpdatePolicies} quality update policies, ${counts.updateRings} update rings, ${counts.driverUpdates} driver update profiles for ${tenant.displayName}`,
          outcome: "success",
          responseStatus: 200,
          latencyMs: Date.now() - startedAt,
        });

        return { counts };
      } catch (err) {
        const status = err instanceof GraphError ? err.status : 502;
        const message = err instanceof Error ? err.message : String(err);
        await audit({
          engineer: engineer.upn,
          tenantId,
          endpoint: "/api/windows-updates/sync",
          method: "POST",
          action: "windows-updates:sync",
          resourceType: "windows-updates",
          resourceLabel: tenant.displayName,
          summary: `Windows Updates sync for ${tenant.displayName} failed`,
          outcome: "failure",
          detail: message,
          responseStatus: status,
          latencyMs: Date.now() - startedAt,
        });
        return reply.code(status).send({ error: message });
      }
    },
  );
}
