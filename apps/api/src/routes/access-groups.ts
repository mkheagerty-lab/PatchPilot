import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { getCca, ACCESS_GROUP_SCOPES } from "@patchpilot/graph";
import { READONLY_GROUP_NAME, WRITE_GROUP_NAME } from "@patchpilot/shared";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import { resolveWebOrigin } from "../auth/origin.js";

/**
 * Starts the home-tenant access-group step-up consent redirect — see
 * docs/onboarding-design.md's "Home-tenant access groups" section and
 * packages/graph/src/access-groups.ts for what happens once the callback in
 * apps/api/src/auth/routes.ts redeems the code.
 *
 * Three actions share this one start route (they all request the same
 * ACCESS_GROUP_SCOPES pair):
 *   - "add-readonly": new-user auto-membership, kicked off by the web
 *     console right after POST /api/users succeeds (Users.tsx), always
 *     `silent=1` — a hidden-iframe `prompt=none` attempt, same UX as
 *     "Test Connection"'s silent path. Never blocks user creation: a failed
 *     silent attempt just leaves readOnlyGroupSyncedAt null and the Users
 *     page shows a retry action.
 *   - "grant-write" / "revoke-write": the Write access toggle. Always the
 *     full visible interactive redirect — silent is rejected below — because
 *     this is a deliberate privilege change, not a routine background sync.
 */
export async function accessGroupsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  // Only an admin who can already manage Users may kick off a group-membership
  // change for another engineer's Entra account.
  app.addHook("preHandler", requirePermission("users:manage"));

  app.get<{ Querystring: { action?: string; targetUserId?: string; silent?: string } }>(
    "/api/users/access-group/start",
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(400).send({ error: "not_available_in_demo_mode" });
      }

      const action = req.query.action;
      const targetUserId = req.query.targetUserId;
      if (action !== "add-readonly" && action !== "grant-write" && action !== "revoke-write") {
        return reply.code(400).send({ error: "invalid or missing action" });
      }
      if (!targetUserId) {
        return reply.code(400).send({ error: "targetUserId is required" });
      }

      const [target] = await db.select().from(tables.engineers).where(eq(tables.engineers.id, targetUserId)).limit(1);
      if (!target) {
        return reply.code(404).send({ error: "user not found" });
      }

      const groupProvisioned = action === "add-readonly" ? config.PATCHPILOT_READONLY_GROUP_ID : config.PATCHPILOT_WRITE_GROUP_ID;
      if (!groupProvisioned) {
        // Graceful failure per the plan — no group id means Deploy-PatchPilot.ps1
        // either hasn't been re-run since this feature shipped, or the admin
        // running it lacked Global Administrator/Privileged Role Administrator
        // when it tried to provision the groups.
        return reply.code(400).send({
          error: "access_group_not_provisioned",
          groupName: action === "add-readonly" ? READONLY_GROUP_NAME : WRITE_GROUP_NAME,
        });
      }

      // Silent (hidden-iframe, prompt=none) only ever applies to the automatic
      // read-only add — see this function's own doc comment above.
      const silent = req.query.silent === "1" && action === "add-readonly";

      const origin = resolveWebOrigin(req);
      const statePrefix = silent ? "patchpilot-accessgroup-silent:" : "patchpilot-accessgroup:";
      const state = `${statePrefix}${req.session.sessionId}:${action}:${targetUserId}`;
      // Interactive (non-silent) runs must NOT assume the acting engineer's
      // own signed-in Microsoft session is the right one to complete this
      // with: modifying a role-assignable group needs Global Administrator/
      // Privileged Role Administrator, which the engineer being granted
      // access frequently is not. With no `prompt` at all, Microsoft's
      // authorize endpoint silently reuses whatever SSO session is already
      // in the browser (i.e. the signed-in engineer) and never offers a
      // chooser - so the step-up token ends up belonging to an account with
      // no chance of actually holding the required Entra role, and the
      // Graph call 403s every time. `select_account` forces the picker so
      // the admin running this can choose "Use another account" and sign in
      // as whichever Microsoft account is actually Global Administrator.
      const url = await getCca().getAuthCodeUrl({
        scopes: ACCESS_GROUP_SCOPES,
        redirectUri: `${origin}/auth/callback`,
        state,
        ...(silent
          ? { prompt: "none" as const, loginHint: req.session.engineer!.upn }
          : { prompt: "select_account" as const }),
      });

      return reply.redirect(url);
    },
  );
}
