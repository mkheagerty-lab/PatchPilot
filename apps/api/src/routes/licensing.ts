import type { FastifyInstance } from "fastify";
import { db, tables, demoTenants, eq, type TenantRow } from "@patchpilot/db";
import { enabledChannels, type RemediationChannel } from "@patchpilot/shared";
import { config } from "../config.js";
import { probeTenant, type TenantReachability, type LicenseStatus } from "../graph/licensing.js";
import { requirePermission } from "../auth/rbac.js";

/**
 * Licensing detection route (Phase 4).
 *
 * `GET /api/licensing?tenantId=` reports the licenses PatchPilot believes a
 * tenant holds, plus the remediation channels those licenses enable — the data
 * behind graceful degradation (non-negotiable #4).
 *
 * - DEMO_MODE: returns the tenant's fixture licenses; no Microsoft call.
 * - Production: reads live Graph `/subscribedSkus` (via the GDAP OBO exchange
 *   for customer tenants), maps SKUs to capabilities, and persists the result
 *   to `tenants.licenses` so the rest of the app degrades consistently.
 */
interface LicensingReport {
  tenantId: string;
  displayName: string;
  source: "demo-fixture" | "graph";
  reachability: TenantReachability | "unknown";
  /** Whether licensing was actually read (vs. reachable-but-no-permission). */
  licenseStatus: LicenseStatus | "demo";
  /** Why licensing couldn't be read, when applicable. */
  licenseDetail?: string;
  licenses: string[];
  enabledChannels: RemediationChannel[];
}

export async function licensingRoutes(app: FastifyInstance): Promise<void> {
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
    "/api/licensing",
    async (req, reply) => {
      const engineer = req.session.engineer!;
      const { tenantId } = req.query;
      if (!tenantId) {
        return reply.code(400).send({ error: "tenantId is required" });
      }

      const tenant = await loadTenant(tenantId);
      if (!tenant) {
        return reply.code(404).send({ error: "tenant not found" });
      }

      // DEMO_MODE: serve fixture licenses — never touches Microsoft.
      if (config.DEMO_MODE) {
        const report: LicensingReport = {
          tenantId: tenant.tenantId,
          displayName: tenant.displayName,
          source: "demo-fixture",
          reachability: tenant.reachability,
          licenseStatus: "demo",
          licenses: tenant.licenses,
          enabledChannels: enabledChannels(tenant.licenses),
        };
        return report;
      }

      // Production: probe live and persist both the licenses and the reachability
      // so graceful degradation (#4) is consistent and the UI can tell "no
      // licenses" apart from "couldn't reach the tenant".
      const probe = await probeTenant(
        engineer.upn,
        engineer.homeTenantId,
        tenant.tenantId,
      );
      // Only overwrite stored licenses when we actually read them; an
      // unavailable licensing read must not wipe a prior detection (#4).
      await db
        .update(tables.tenants)
        .set(
          probe.licenseStatus === "detected"
            ? { reachability: probe.status, licenses: probe.licenses }
            : { reachability: probe.status },
        )
        .where(eq(tables.tenants.tenantId, tenant.tenantId));

      // Report the licenses we now hold (freshly detected, or the preserved prior set).
      const reportedLicenses =
        probe.licenseStatus === "detected" ? probe.licenses : tenant.licenses;
      const report: LicensingReport = {
        tenantId: tenant.tenantId,
        displayName: tenant.displayName,
        source: "graph",
        reachability: probe.status,
        licenseStatus: probe.licenseStatus,
        licenseDetail: probe.licenseDetail,
        licenses: reportedLicenses,
        enabledChannels: enabledChannels(reportedLicenses),
      };
      return report;
    },
  );
}
