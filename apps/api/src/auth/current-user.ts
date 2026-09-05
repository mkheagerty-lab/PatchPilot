import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { config } from "../config.js";
import { findDemoEngineerByUpn } from "./demo-engineers.js";

/**
 * Resolves `req.session.engineer` (identity) into `req.currentUser`
 * (identity + PatchPilot role), fresh on every request.
 *
 * Registered globally in server.ts, after the DEMO_MODE session-injection
 * hook and before every route plugin. Two things fall out of doing this
 * per-request rather than embedding role in the session cookie:
 *
 *  - a role change or a disable takes effect on the very next request,
 *    rather than waiting out the 8h session TTL (relevant because
 *    @fastify/session still uses the default in-memory store).
 *  - a user removed or disabled mid-session is logged out immediately, not
 *    just blocked from new actions.
 *
 * No session at all -> do nothing. That's not this preHandler's problem; each
 * route plugin's own `if (!req.session.engineer) return reply.code(401)...`
 * hook still handles the fully-unauthenticated case exactly as before.
 */
export async function resolveCurrentUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const engineer = req.session.engineer;
  if (!engineer) return;

  const upn = engineer.upn.toLowerCase();

  if (config.DEMO_MODE) {
    const row = findDemoEngineerByUpn(upn);
    if (!row || row.status !== "active") {
      await req.session.destroy();
      return reply.code(403).send({ error: "not_provisioned" });
    }
    req.currentUser = { id: row.id, upn: row.upn, displayName: row.displayName, role: row.role, theme: row.theme };
    return;
  }

  const [row] = await db.select().from(tables.engineers).where(eq(tables.engineers.upn, upn)).limit(1);
  if (!row || row.status !== "active") {
    // A person removed or disabled after their session started must not keep
    // acting on it — kill the session rather than merely blocking this request.
    await req.session.destroy();
    return reply.code(403).send({ error: "not_provisioned" });
  }
  req.currentUser = { id: row.id, upn: row.upn, displayName: row.displayName, role: row.role, theme: row.theme };
}
