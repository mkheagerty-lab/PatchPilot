import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db, tables, type EngineerRow } from "@patchpilot/db";
import { audit, clearMsalCache, clearTokens } from "@patchpilot/graph";
import {
  ROLE_LABELS,
  ROLES,
  USER_STATUSES,
  READONLY_GROUP_NAME,
  WRITE_GROUP_NAME,
  WRITE_GROUP_ROLES,
  type Role,
  type UserStatus,
} from "@patchpilot/shared";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import { demoEngineers, findDemoEngineerByUpn, type DemoEngineer } from "../auth/demo-engineers.js";

/**
 * Settings -> Users: the provisioned-user list and their PatchPilot role.
 *
 * Global, not tenant-scoped — a role applies everywhere (see rbac.ts). Gated
 * entirely by `users:read` (plugin level) / `users:manage` (route level),
 * which only the admin role holds — see rbac.test.ts's "keeps user
 * management admin-only" assertion.
 *
 * DEMO_MODE never touches Postgres — see auth/demo-engineers.ts for why a
 * mutable in-memory store exists there, mirroring @patchpilot/graph's
 * demoAudits.
 */

export interface UserRecord {
  id: string;
  upn: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  email: string | null;
  invitedBy: string | null;
  invitedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  receiveJobAlerts: boolean;
  /**
   * Home-tenant access groups (see packages/graph/src/access-groups.ts and
   * docs/onboarding-design.md). `readOnlyGroupSyncedAt`/`writeGroupSyncedAt`
   * null means "not confirmed member" — covers both "never attempted" and
   * "attempted and failed", which is exactly the "show a retry action"
   * condition the Users page needs; it can't and doesn't need to tell the two
   * apart. `writeAccessEnabled` is the toggle's own source of truth
   * independent of sync status, so a failed revoke still shows as "on" with
   * a retry action rather than silently reporting the wrong state.
   */
  readOnlyGroupSyncedAt: string | null;
  writeAccessEnabled: boolean;
  writeGroupSyncedAt: string | null;
}

function dbRowToRecord(row: EngineerRow): UserRecord {
  return {
    id: row.id,
    upn: row.upn,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    email: row.email,
    invitedBy: row.invitedBy,
    invitedAt: row.invitedAt ? row.invitedAt.toISOString() : null,
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    receiveJobAlerts: row.receiveJobAlerts,
    readOnlyGroupSyncedAt: row.readOnlyGroupSyncedAt ? row.readOnlyGroupSyncedAt.toISOString() : null,
    writeAccessEnabled: row.writeAccessEnabled,
    writeGroupSyncedAt: row.writeGroupSyncedAt ? row.writeGroupSyncedAt.toISOString() : null,
  };
}

/** DemoEngineer's shape already matches UserRecord field-for-field. */
function demoRowToRecord(row: DemoEngineer): UserRecord {
  return { ...row };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for users.test.ts, no DB/network involved.
// ---------------------------------------------------------------------------

/**
 * Lower-case, trim, and require a bare `name@domain` shape — the one check
 * this app makes on a UPN before writing it. Entra UPNs are case-insensitive;
 * storing anything but the lower-cased form risks a duplicate row that looks
 * different but logs in as the same person, or worse, a login that silently
 * fails to match an existing row.
 */
export function normalizeUpn(raw: string): { ok: true; upn: string } | { ok: false; error: string } {
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (!trimmed || at <= 0 || at === trimmed.length - 1 || trimmed.indexOf("@", at + 1) !== -1) {
    return { ok: false, error: "must be a valid user principal name (e.g. name@tenant.com)" };
  }
  return { ok: true, upn: trimmed };
}

export interface LastAdminCheck {
  targetRole: Role;
  targetStatus: UserStatus;
  /** Omit for a delete. */
  nextRole?: Role;
  nextStatus?: UserStatus;
  deleting?: boolean;
  /** Count of OTHER active admin rows — the target itself is excluded. */
  otherActiveAdmins: number;
}

/**
 * True when a mutation would leave PatchPilot with zero active admins.
 *
 * Only the target's own admin-ness matters going in: a mutation that doesn't
 * change a non-admin (or already-disabled admin) row can never orphan
 * anything, regardless of `otherActiveAdmins` — checked first so callers
 * don't need to pre-filter.
 */
export function wouldOrphanAdmins(check: LastAdminCheck): boolean {
  const wasLoadBearing = check.targetRole === "admin" && check.targetStatus === "active";
  if (!wasLoadBearing) return false;

  if (check.deleting) return check.otherActiveAdmins === 0;

  const staysLoadBearing =
    (check.nextRole ?? check.targetRole) === "admin" && (check.nextStatus ?? check.targetStatus) === "active";
  if (staysLoadBearing) return false;

  return check.otherActiveAdmins === 0;
}

/**
 * Drops an engineer's persisted MSAL cache and short-lived tokens — the real
 * revocation of the background-access credential auto-sync and their
 * schedules depend on. Never called from DEMO_MODE branches (no Redis in
 * that mode, matching every other DEMO_MODE code path in this file).
 */
async function revokeEngineerBackgroundAccess(upn: string): Promise<void> {
  await clearMsalCache(upn);
  await clearTokens(upn);
}

function revokeAuditEntry(actorUpn: string, targetId: string, targetUpn: string, detail: string) {
  return {
    engineer: actorUpn,
    endpoint: "/api/users/:id/revoke-background-access",
    method: "POST",
    action: "user:revoke-background-access" as const,
    resourceType: "user" as const,
    resourceId: targetId,
    resourceLabel: targetUpn,
    summary: `Revoked ${targetUpn}'s background-access session — auto-sync and their schedules will fail until they sign in again`,
    detail,
    outcome: "success" as const,
    responseStatus: 200,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "23505";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const createBodySchema = z.object({
  upn: z.string().trim().min(1, "upn is required"),
  displayName: z.string().trim().min(1, "displayName is required").max(200),
  role: z.enum(ROLES),
  // Optional: defaults to true for an admin, false otherwise (see the POST
  // handler) so the form doesn't need to pre-decide this before the role is
  // even chosen. An explicit value always wins over that default.
  receiveJobAlerts: z.boolean().optional(),
});

const patchBodySchema = z
  .object({
    role: z.enum(ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    receiveJobAlerts: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.role !== undefined ||
      b.status !== undefined ||
      b.displayName !== undefined ||
      b.receiveJobAlerts !== undefined,
    { message: "at least one of role, status, displayName, receiveJobAlerts is required" },
  );

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  // Read and manage sit on the same permission today (only admin holds
  // either — see rbac.ts), but gating the whole plugin on the read
  // permission and manage on individual routes matches the shape every
  // other route plugin uses, and stays correct if a future role is ever
  // given users:read without users:manage.
  app.addHook("preHandler", requirePermission("users:read"));

  app.get("/api/users", async () => {
    if (config.DEMO_MODE) {
      return demoEngineers.map(demoRowToRecord);
    }
    const rows = await db.select().from(tables.engineers).orderBy(desc(tables.engineers.createdAt));
    return rows.map(dbRowToRecord);
  });

  app.post(
    "/api/users",
    { preHandler: requirePermission("users:manage") },
    async (req, reply) => {
      const parsed = createBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      const normalized = normalizeUpn(parsed.data.upn);
      if (!normalized.ok) {
        return reply.code(400).send({ error: normalized.error });
      }
      const displayName = parsed.data.displayName.trim();
      const role = parsed.data.role;
      // Admins get every alert by default — a role that's expected to act on
      // failures shouldn't have to opt in. Every other role defaults to off.
      // An explicit value in the request always wins over that default.
      const receiveJobAlerts = parsed.data.receiveJobAlerts ?? role === "admin";
      const actor = req.currentUser!;

      if (config.DEMO_MODE) {
        if (findDemoEngineerByUpn(normalized.upn)) {
          return reply.code(409).send({ error: "a user with that UPN already exists" });
        }
        const now = new Date().toISOString();
        const row: DemoEngineer = {
          id: randomUUID(),
          upn: normalized.upn,
          displayName,
          role,
          status: "active",
          email: null,
          invitedBy: actor.upn,
          invitedAt: now,
          lastLoginAt: null,
          createdAt: now,
          updatedAt: now,
          receiveJobAlerts,
          theme: "light",
          readOnlyGroupSyncedAt: null,
          writeAccessEnabled: false,
          writeGroupSyncedAt: null,
        };
        demoEngineers.push(row);
        await audit({
          engineer: actor.upn,
          endpoint: "/api/users",
          method: "POST",
          action: "user:create",
          resourceType: "user",
          resourceId: row.id,
          resourceLabel: row.upn,
          summary: `Added ${row.upn} as ${ROLE_LABELS[role]}`,
          outcome: "success",
          payload: { upn: row.upn, role },
          responseStatus: 201,
        });
        return reply.code(201).send(demoRowToRecord(row));
      }

      const [existing] = await db
        .select({ id: tables.engineers.id })
        .from(tables.engineers)
        .where(eq(tables.engineers.upn, normalized.upn))
        .limit(1);
      if (existing) {
        return reply.code(409).send({ error: "a user with that UPN already exists" });
      }

      let row: EngineerRow;
      try {
        [row] = (await db
          .insert(tables.engineers)
          .values({
            upn: normalized.upn,
            displayName,
            role,
            status: "active",
            invitedBy: actor.upn,
            invitedAt: new Date(),
            receiveJobAlerts,
          })
          .returning()) as [EngineerRow];
      } catch (err) {
        // Defense in depth against the race between the check above and this
        // insert — two admins adding the same UPN at once.
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: "a user with that UPN already exists" });
        }
        throw err;
      }

      await audit({
        engineer: actor.upn,
        endpoint: "/api/users",
        method: "POST",
        action: "user:create",
        resourceType: "user",
        resourceId: row.id,
        resourceLabel: row.upn,
        summary: `Added ${row.upn} as ${ROLE_LABELS[role]}`,
        outcome: "success",
        payload: { upn: row.upn, role },
        responseStatus: 201,
      });

      return reply.code(201).send(dbRowToRecord(row));
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/users/:id",
    { preHandler: requirePermission("users:manage") },
    async (req, reply) => {
      const parsed = patchBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      const {
        role: nextRole,
        status: nextStatus,
        displayName: nextDisplayNameRaw,
        receiveJobAlerts: nextReceiveJobAlerts,
      } = parsed.data;
      const nextDisplayName = nextDisplayNameRaw?.trim();
      const actor = req.currentUser!;
      const targetId = req.params.id;

      // Self-protection: changing your own role or status could lock you out
      // by accident. Renaming yourself is harmless and stays allowed.
      if ((nextRole !== undefined || nextStatus !== undefined) && actor.id === targetId) {
        return reply.code(409).send({ error: "self_modification" });
      }

      if (config.DEMO_MODE) {
        const existing = demoEngineers.find((e) => e.id === targetId);
        if (!existing) return reply.code(404).send({ error: "user not found" });

        const otherActiveAdmins = demoEngineers.filter(
          (e) => e.id !== targetId && e.role === "admin" && e.status === "active",
        ).length;
        if (
          wouldOrphanAdmins({
            targetRole: existing.role,
            targetStatus: existing.status,
            nextRole,
            nextStatus,
            otherActiveAdmins,
          })
        ) {
          return reply.code(409).send({ error: "last_admin" });
        }

        if (nextRole !== undefined) existing.role = nextRole;
        if (nextStatus !== undefined) existing.status = nextStatus;
        if (nextDisplayName !== undefined) existing.displayName = nextDisplayName;
        if (nextReceiveJobAlerts !== undefined) existing.receiveJobAlerts = nextReceiveJobAlerts;
        existing.updatedAt = new Date().toISOString();

        await audit(
          patchAuditEntry(actor.upn, existing.id, existing.upn, {
            nextRole,
            nextStatus,
            nextDisplayName,
            nextReceiveJobAlerts,
          }),
        );
        if (nextStatus === "disabled") {
          // No Redis in DEMO_MODE — audit only, for UI/demo fidelity.
          await audit(revokeAuditEntry(actor.upn, existing.id, existing.upn, "revoked automatically — account was disabled"));
        }
        return demoRowToRecord(existing);
      }

      const result = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(tables.engineers).where(eq(tables.engineers.id, targetId)).limit(1);
        if (!existing) return { kind: "not_found" as const };

        const [countRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(tables.engineers)
          .where(and(ne(tables.engineers.id, targetId), eq(tables.engineers.role, "admin"), eq(tables.engineers.status, "active")));
        const count = countRow?.count ?? 0;

        if (
          wouldOrphanAdmins({
            targetRole: existing.role,
            targetStatus: existing.status,
            nextRole,
            nextStatus,
            otherActiveAdmins: count,
          })
        ) {
          return { kind: "last_admin" as const };
        }

        const updates: {
          role?: Role;
          status?: UserStatus;
          displayName?: string;
          receiveJobAlerts?: boolean;
          updatedAt: Date;
        } = {
          updatedAt: new Date(),
        };
        if (nextRole !== undefined) updates.role = nextRole;
        if (nextStatus !== undefined) updates.status = nextStatus;
        if (nextDisplayName !== undefined) updates.displayName = nextDisplayName;
        if (nextReceiveJobAlerts !== undefined) updates.receiveJobAlerts = nextReceiveJobAlerts;

        const [row] = await tx.update(tables.engineers).set(updates).where(eq(tables.engineers.id, targetId)).returning();
        return { kind: "ok" as const, row: row! };
      });

      if (result.kind === "not_found") return reply.code(404).send({ error: "user not found" });
      if (result.kind === "last_admin") return reply.code(409).send({ error: "last_admin" });

      await audit(
        patchAuditEntry(actor.upn, result.row.id, result.row.upn, {
          nextRole,
          nextStatus,
          nextDisplayName,
          nextReceiveJobAlerts,
        }),
      );
      if (nextStatus === "disabled") {
        await revokeEngineerBackgroundAccess(result.row.upn);
        await audit(
          revokeAuditEntry(actor.upn, result.row.id, result.row.upn, "revoked automatically — account was disabled"),
        );
      }
      return dbRowToRecord(result.row);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/users/:id",
    { preHandler: requirePermission("users:manage") },
    async (req, reply) => {
      const actor = req.currentUser!;
      const targetId = req.params.id;

      if (actor.id === targetId) {
        return reply.code(409).send({ error: "self_modification" });
      }

      if (config.DEMO_MODE) {
        const idx = demoEngineers.findIndex((e) => e.id === targetId);
        if (idx === -1) return reply.code(404).send({ error: "user not found" });
        const existing = demoEngineers[idx]!;

        const otherActiveAdmins = demoEngineers.filter(
          (e) => e.id !== targetId && e.role === "admin" && e.status === "active",
        ).length;
        if (wouldOrphanAdmins({ targetRole: existing.role, targetStatus: existing.status, deleting: true, otherActiveAdmins })) {
          return reply.code(409).send({ error: "last_admin" });
        }

        demoEngineers.splice(idx, 1);
        await audit({
          engineer: actor.upn,
          endpoint: "/api/users",
          method: "DELETE",
          action: "user:delete",
          resourceType: "user",
          resourceId: existing.id,
          resourceLabel: existing.upn,
          summary: `Removed ${existing.upn}`,
          outcome: "success",
          responseStatus: 200,
        });
        await audit(revokeAuditEntry(actor.upn, existing.id, existing.upn, "revoked automatically — account was removed"));
        return { deleted: true };
      }

      const result = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(tables.engineers).where(eq(tables.engineers.id, targetId)).limit(1);
        if (!existing) return { kind: "not_found" as const };

        const [countRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(tables.engineers)
          .where(and(ne(tables.engineers.id, targetId), eq(tables.engineers.role, "admin"), eq(tables.engineers.status, "active")));
        const count = countRow?.count ?? 0;

        if (wouldOrphanAdmins({ targetRole: existing.role, targetStatus: existing.status, deleting: true, otherActiveAdmins: count })) {
          return { kind: "last_admin" as const };
        }

        await tx.delete(tables.engineers).where(eq(tables.engineers.id, targetId));
        return { kind: "ok" as const, row: existing };
      });

      if (result.kind === "not_found") return reply.code(404).send({ error: "user not found" });
      if (result.kind === "last_admin") return reply.code(409).send({ error: "last_admin" });

      await audit({
        engineer: actor.upn,
        endpoint: "/api/users",
        method: "DELETE",
        action: "user:delete",
        resourceType: "user",
        resourceId: result.row.id,
        resourceLabel: result.row.upn,
        summary: `Removed ${result.row.upn}`,
        outcome: "success",
        responseStatus: 200,
      });
      await revokeEngineerBackgroundAccess(result.row.upn);
      await audit(
        revokeAuditEntry(actor.upn, result.row.id, result.row.upn, "revoked automatically — account was removed"),
      );
      return { deleted: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/users/:id/revoke-background-access",
    { preHandler: requirePermission("users:manage") },
    async (req, reply) => {
      const actor = req.currentUser!;
      const targetId = req.params.id;

      // Matches the PATCH/DELETE self-modification guard: revoking your own
      // background access from inside the session you're using right now
      // isn't a meaningful control, so keep the rule consistent.
      if (actor.id === targetId) {
        return reply.code(409).send({ error: "self_modification" });
      }

      if (config.DEMO_MODE) {
        const existing = demoEngineers.find((e) => e.id === targetId);
        if (!existing) return reply.code(404).send({ error: "user not found" });
        await audit(revokeAuditEntry(actor.upn, existing.id, existing.upn, "revoked by an admin"));
        return { revoked: true };
      }

      const [existing] = await db.select().from(tables.engineers).where(eq(tables.engineers.id, targetId)).limit(1);
      if (!existing) return reply.code(404).send({ error: "user not found" });

      await revokeEngineerBackgroundAccess(existing.upn);
      await audit(revokeAuditEntry(actor.upn, existing.id, existing.upn, "revoked by an admin"));
      return { revoked: true };
    },
  );

  /**
   * Write-access toggle preflight (see docs/onboarding-design.md's home-tenant
   * access groups section). This route never touches Graph itself — it only
   * validates that the toggle is actionable and hands back the relative URL
   * for routes/access-groups.ts's step-up start route, which the frontend
   * then does a real top-level navigation to (GET /api/users/access-group/start
   * builds the actual Microsoft auth-code URL and re-validates independently;
   * duplicating that here would just be two places that can drift). Splitting
   * it this way lets Users.tsx show "not provisioned"/"user not found" inline
   * in the confirm dialog instead of only after the user is bounced to
   * Microsoft and back.
   *
   * Write-group membership changes are always the full interactive consent
   * screen, never silent — see access-groups.ts's own doc comment for why.
   */
  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    "/api/users/:id/write-access",
    { preHandler: requirePermission("users:manage") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(400).send({ error: "not_available_in_demo_mode" });
      }

      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") {
        return reply.code(400).send({ error: "enabled (boolean) is required" });
      }

      const targetId = req.params.id;
      const [existing] = await db.select().from(tables.engineers).where(eq(tables.engineers.id, targetId)).limit(1);
      if (!existing) return reply.code(404).send({ error: "user not found" });

      if (!config.PATCHPILOT_WRITE_GROUP_ID) {
        return reply.code(400).send({ error: "access_group_not_provisioned", groupName: WRITE_GROUP_NAME });
      }

      const action = enabled ? "grant-write" : "revoke-write";
      return {
        redirectUrl: `/api/users/access-group/start?action=${action}&targetUserId=${encodeURIComponent(targetId)}`,
        roles: WRITE_GROUP_ROLES,
        targetUpn: existing.upn,
      };
    },
  );

  /**
   * Read-only group "retry" preflight — same shape as the write-access
   * preflight above, for the same reason (an inline "not provisioned" error
   * instead of only finding out after a bounce to Microsoft). Unlike the
   * automatic post-creation attempt (which is always silent, see
   * access-groups.ts), an explicit retry click is a real user gesture, so it
   * goes through the full interactive redirect — a second silent attempt
   * would just fail the same way the first one did if the reason was
   * `interaction_required`.
   */
  app.post<{ Params: { id: string } }>(
    "/api/users/:id/sync-readonly-group",
    { preHandler: requirePermission("users:manage") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(400).send({ error: "not_available_in_demo_mode" });
      }

      const targetId = req.params.id;
      const [existing] = await db.select().from(tables.engineers).where(eq(tables.engineers.id, targetId)).limit(1);
      if (!existing) return reply.code(404).send({ error: "user not found" });

      if (!config.PATCHPILOT_READONLY_GROUP_ID) {
        return reply.code(400).send({ error: "access_group_not_provisioned", groupName: READONLY_GROUP_NAME });
      }

      return {
        redirectUrl: `/api/users/access-group/start?action=add-readonly&targetUserId=${encodeURIComponent(targetId)}`,
        targetUpn: existing.upn,
      };
    },
  );
}

/** Picks one audit action for a PATCH — status transitions (the
 * security-relevant case) win over a role change, which wins over a plain
 * rename, matching how the vocabulary in @patchpilot/shared's audit.ts
 * distinguishes them. */
function patchAuditEntry(
  actorUpn: string,
  targetId: string,
  targetUpn: string,
  change: {
    nextRole?: Role;
    nextStatus?: UserStatus;
    nextDisplayName?: string;
    nextReceiveJobAlerts?: boolean;
  },
) {
  const parts: string[] = [];
  if (change.nextRole) parts.push(`role -> ${ROLE_LABELS[change.nextRole]}`);
  if (change.nextStatus) parts.push(`status -> ${change.nextStatus}`);
  if (change.nextDisplayName) parts.push(`name -> ${change.nextDisplayName}`);
  if (change.nextReceiveJobAlerts !== undefined) {
    parts.push(`job alerts -> ${change.nextReceiveJobAlerts ? "on" : "off"}`);
  }

  const action =
    change.nextStatus === "disabled"
      ? ("user:disable" as const)
      : change.nextStatus === "active"
        ? ("user:enable" as const)
        : change.nextRole
          ? ("user:update-role" as const)
          : ("user:update" as const);

  return {
    engineer: actorUpn,
    endpoint: "/api/users/:id",
    method: "PATCH",
    action,
    resourceType: "user" as const,
    resourceId: targetId,
    resourceLabel: targetUpn,
    summary: `Updated ${targetUpn}: ${parts.join(", ")}`,
    outcome: "success" as const,
    payload: change,
    responseStatus: 200,
  };
}
