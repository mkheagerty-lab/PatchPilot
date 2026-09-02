import type { FastifyBaseLogger } from "fastify";
import { and, eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { auditSafe } from "@patchpilot/graph";
import { SYSTEM_ACTORS } from "@patchpilot/shared";
import { config } from "../config.js";

/**
 * Idempotently seeds/promotes BOOTSTRAP_ADMIN_UPN to an active admin at every
 * startup. This is both initial provisioning — the very first person has no
 * row to sign in with otherwise, since login is now gated on one existing —
 * and the lockout recovery hatch: set the var, restart, sign in.
 *
 * Never runs in DEMO_MODE: the demo engineer is already an active admin via
 * the seeded in-memory store (auth/demo-engineers.ts), and there is no real
 * `engineers` table to write to in that mode.
 */
export async function bootstrapAdmin(log: FastifyBaseLogger): Promise<void> {
  if (config.DEMO_MODE) return;

  const upn = config.BOOTSTRAP_ADMIN_UPN;

  if (upn) {
    const [existing] = await db.select().from(tables.engineers).where(eq(tables.engineers.upn, upn)).limit(1);

    if (!existing) {
      await db.insert(tables.engineers).values({
        upn,
        displayName: upn,
        role: "admin",
        status: "active",
        invitedBy: SYSTEM_ACTORS.startup,
        invitedAt: new Date(),
        receiveJobAlerts: true,
      });
      log.warn(`[bootstrap] provisioned ${upn} as admin via BOOTSTRAP_ADMIN_UPN`);
      await auditSafe({
        engineer: SYSTEM_ACTORS.startup,
        actorType: "system",
        endpoint: "startup:bootstrap-admin",
        method: "SYSTEM",
        action: "user:create",
        resourceType: "user",
        resourceLabel: upn,
        summary: `${upn} provisioned as admin via BOOTSTRAP_ADMIN_UPN`,
        outcome: "success",
      });
    } else if (existing.role !== "admin" || existing.status !== "active") {
      await db
        .update(tables.engineers)
        .set({ role: "admin", status: "active", updatedAt: new Date() })
        .where(eq(tables.engineers.id, existing.id));
      log.warn(`[bootstrap] restored ${upn} to active admin via BOOTSTRAP_ADMIN_UPN`);
      await auditSafe({
        engineer: SYSTEM_ACTORS.startup,
        actorType: "system",
        endpoint: "startup:bootstrap-admin",
        method: "SYSTEM",
        action: "user:update-role",
        resourceType: "user",
        resourceId: existing.id,
        resourceLabel: upn,
        summary: `${upn} restored to active admin via BOOTSTRAP_ADMIN_UPN`,
        outcome: "success",
      });
    }
    return;
  }

  // No bootstrap var set — only a problem if nobody can actually sign in.
  const [anyActiveAdmin] = await db
    .select({ id: tables.engineers.id })
    .from(tables.engineers)
    .where(and(eq(tables.engineers.role, "admin"), eq(tables.engineers.status, "active")))
    .limit(1);

  if (!anyActiveAdmin) {
    log.warn(
      "[bootstrap] No active admin exists and BOOTSTRAP_ADMIN_UPN is not set — nobody can sign in to PatchPilot. Set BOOTSTRAP_ADMIN_UPN in .env and restart.",
    );
  }
}
