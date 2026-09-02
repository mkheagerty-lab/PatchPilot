import type { FastifyInstance } from "fastify";
import { db, tables, demoTenants, type TenantRow } from "@patchpilot/db";
import {
  evaluateReadiness,
  type ReadinessTenant,
} from "@patchpilot/shared";
import { assertWritesAllowed } from "@patchpilot/graph";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";

/**
 * Per-tenant readiness route (Phase 2).
 *
 * `GET /api/readiness?tenantId=` reports whether a tenant is wired up enough for
 * PatchPilot to operate: admin consent, licensing (graceful degradation,
 * non-negotiable #4), write posture (read-only-first, non-negotiable #6), and
 * GDAP (deferred to Phase 4). Pure evaluation over the tenant record — no
 * Microsoft calls. DEMO_MODE reads fixtures; production reads Postgres.
 */
export async function readinessRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("settings:read"));

  async function loadTenant(tenantId: string): Promise<TenantRow | null> {
    if (config.DEMO_MODE) {
      return demoTenants.find((t) => t.tenantId === tenantId) ?? null;
    }
    const rows = await db.select().from(tables.tenants);
    return rows.find((t) => t.tenantId === tenantId) ?? null;
  }

  app.get<{ Querystring: { tenantId?: string } }>(
    "/api/readiness",
    async (req, reply) => {
      const { tenantId } = req.query;
      if (!tenantId) {
        return reply.code(400).send({ error: "tenantId is required" });
      }

      const tenant = await loadTenant(tenantId);
      if (!tenant) {
        return reply.code(404).send({ error: "tenant not found" });
      }

      const input: ReadinessTenant = {
        tenantId: tenant.tenantId,
        displayName: tenant.displayName,
        consentStatus: tenant.consentStatus,
        readOnly: tenant.readOnly,
        licenses: tenant.licenses,
        isMspTenant: tenant.isMspTenant,
      };

      const writeGate = await assertWritesAllowed(tenant);
      return evaluateReadiness(input, writeGate.allowed);
    },
  );
}
