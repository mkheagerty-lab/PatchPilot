import type { FastifyInstance } from "fastify";
import { GraphError, searchGroups } from "@patchpilot/graph";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";

/**
 * Canned Entra groups for the picker in DEMO_MODE — real `searchGroups` calls
 * `acquireTokenForCustomerTenant`, which hard-throws under DEMO_MODE (see
 * packages/graph/src/msal.ts) rather than silently returning empty, so this
 * route must fork before ever calling it. Ids/names match the groups already
 * referenced by the Feature/Quality Update campaign fixtures in demo-data.ts,
 * so a newly-created demo campaign lines up with the ones already seeded.
 */
const demoGroups: Array<{ tenantId: string; id: string; displayName: string }> = [
  { tenantId: "msp-root", id: "grp-meridian-all-devices", displayName: "All Devices – Meridian MSP" },
  { tenantId: "contoso", id: "grp-contoso-pilot-ring", displayName: "Pilot Ring – Contoso Legal" },
  { tenantId: "contoso", id: "grp-contoso-vip", displayName: "VIP Devices – Contoso Legal" },
  { tenantId: "northwind", id: "grp-northwind-all-devices", displayName: "All Devices – Northwind Sales" },
];

/**
 * Entra group search — backs the searchable Include/Excluded Group pickers
 * used by Win32/Store app assignment and Feature/Quality Update campaigns.
 * Gated on `operations:write` since it only serves those write-gated forms.
 */
export async function groupsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });

  app.get<{ Querystring: { tenantId?: string; q?: string } }>(
    "/api/groups/search",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      const { tenantId, q } = req.query ?? {};
      if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });
      if (!q || q.trim().length < 2) return { groups: [] };
      const query = q.trim();

      if (config.DEMO_MODE) {
        const needle = query.toLowerCase();
        const groups = demoGroups
          .filter((g) => g.tenantId === tenantId && g.displayName.toLowerCase().startsWith(needle))
          .map(({ id, displayName }) => ({ id, displayName }));
        return { groups };
      }

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;

      try {
        const groups = await searchGroups({ engineer, homeTenantId, tenantId, query });
        return { groups };
      } catch (err) {
        const status = err instanceof GraphError ? err.status : 502;
        const message = err instanceof Error ? err.message : String(err);
        if (status === 403) {
          return reply.code(409).send({
            error: "Group search failed (HTTP 403) — this tenant likely needs re-consent for the Group.Read.All scope.",
            code: "needs-reconsent",
          });
        }
        return reply.code(status).send({ error: message });
      }
    },
  );
}
