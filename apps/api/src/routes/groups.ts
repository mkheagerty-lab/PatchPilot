import type { FastifyInstance } from "fastify";
import { GraphError, searchGroups } from "@patchpilot/graph";
import { requirePermission } from "../auth/rbac.js";

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

      const engineer = req.session.engineer!.upn;
      const homeTenantId = req.session.engineer!.homeTenantId;

      try {
        const groups = await searchGroups({ engineer, homeTenantId, tenantId, query: q.trim() });
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
