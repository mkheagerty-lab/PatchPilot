import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";

/**
 * Update Rings tab — read-only live-sync mirror of
 * `windowsUpdateForBusinessConfigurations`. No PatchPilot write path exists
 * for this resource, so unlike feature-updates.ts/quality-updates.ts this
 * file has no create/delete/bulk-delete routes, only the list.
 */
export async function updateRingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });

  app.get<{ Querystring: { tenantId?: string } }>(
    "/api/update-rings",
    { preHandler: requirePermission("operations:read") },
    async (req) => {
      if (config.DEMO_MODE) return { profiles: [] };
      const { tenantId } = req.query ?? {};
      const rows = await db
        .select()
        .from(tables.updateRingProfiles)
        .where(tenantId ? eq(tables.updateRingProfiles.tenantId, tenantId) : undefined)
        .orderBy(desc(tables.updateRingProfiles.createdAt));
      return { profiles: rows };
    },
  );
}
