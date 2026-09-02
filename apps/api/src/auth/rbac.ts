import type { FastifyReply, FastifyRequest } from "fastify";
import { can, type Permission } from "@patchpilot/shared";

/**
 * Route-layer enforcement of the shared permission matrix (@patchpilot/shared's
 * rbac.ts). Checks permissions, never role names — see that module for why.
 *
 * Depends on `req.currentUser` having already been set by
 * `auth/current-user.ts`'s `resolveCurrentUser` preHandler, which runs before
 * every route plugin. If it's missing, either the request has no session at
 * all (the plugin's own 401 hook should have already caught that) or
 * `resolveCurrentUser` itself rejected it — either way, treat it as
 * unauthenticated rather than assume a permission it doesn't have.
 *
 * Response shape matches every other guard in this app: `{ error: string }`,
 * which apps/web/src/lib/api.ts already unwraps into ApiError.message.
 */
export function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.currentUser) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    if (!can(req.currentUser.role, permission)) {
      return reply.code(403).send({ error: "forbidden", required: permission });
    }
  };
}
