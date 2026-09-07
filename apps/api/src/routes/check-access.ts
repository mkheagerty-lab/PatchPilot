import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import {
  can,
  buildPatchPilotCategory,
  ENTRA_ROLE_TEMPLATE_IDS,
  CHECK_ACCESS_ENTRA_ROLES,
  REQUIRED_GDAP_ROLES,
  type CheckAccessSummary,
  type Role,
} from "@patchpilot/shared";
import { getCca, CHECK_ACCESS_SCOPES, redis, resolveEngineerObjectId, getUserMemberships, getGdapAccessAssignments } from "@patchpilot/graph";
import { config } from "../config.js";
import { resolveWebOrigin } from "../auth/origin.js";
import { collectPaged, type DelegatedAdminRelationship, type Engineer } from "../graph/sync.js";

/**
 * Check Access (Setup Health tab) — lets an engineer see where they stand
 * across PatchPilot's three access layers, and lets a `users:manage` admin
 * check the same for someone else. See docs/onboarding-design.md and the
 * plan this implements for the full design.
 *
 * Deliberately NOT a blanket `requirePermission` preHandler like
 * access-groups.ts: a self-check must stay open to every role. Authorization
 * is per-request via `assertCanCheck` instead.
 */
function assertCanCheck(actor: { id: string; role: Role }, targetUserId: string): boolean {
  return targetUserId === actor.id || can(actor.role, "users:manage");
}

/** One-shot Redis stash for the interactive-fallback callback (see auth/routes.ts's CHECK_ACCESS_STATE_PREFIX branch) — mirrors the step-up token's own one-shot spirit. */
const RESULT_TTL_SECONDS = 300;
function resultKey(resultId: string): string {
  return `pp:checkaccess:result:${resultId}`;
}

export async function stashCheckAccessResult(resultId: string, summary: CheckAccessSummary): Promise<void> {
  await redis.set(resultKey(resultId), JSON.stringify(summary), "EX", RESULT_TTL_SECONDS);
}

type EngineerRow = typeof tables.engineers.$inferSelect;
type TenantRow = typeof tables.tenants.$inferSelect;

/**
 * Category 1 (PatchPilot role/permissions) plus applicability-flagged,
 * empty-role placeholders for categories 2/3 — needs no Graph call, so both
 * `GET /api/check-access/summary` (served immediately) and
 * `assembleCheckAccessSummary` (as its starting point, before filling in
 * whichever category applies) build from this.
 */
function buildBaseSummary(target: EngineerRow, tenant: TenantRow): CheckAccessSummary {
  return {
    targetUpn: target.upn,
    targetDisplayName: target.displayName,
    tenantId: tenant.tenantId,
    tenantDisplayName: tenant.displayName,
    patchPilot: buildPatchPilotCategory(target.role, tenant.readOnly),
    entraDirect: { applicable: tenant.isMspTenant, roles: [] },
    gdapRoles: { applicable: !tenant.isMspTenant, relationshipFound: false, roles: [] },
    checkedAt: new Date().toISOString(),
    demoMode: config.DEMO_MODE,
  };
}

/**
 * Assembles all three categories once a Check Access step-up token has been
 * redeemed. Shared by both the silent and interactive callback branches in
 * auth/routes.ts, so the two flows can never drift apart.
 *
 * Category 2 (Entra Roles Direct) and Category 3 (GDAP Roles) are mutually
 * exclusive by tenant type, matching the user's own spec: Category 2 is
 * meaningful only in the home tenant (customers have no direct role
 * assignments and are never guest users there), Category 3 only in a
 * customer tenant.
 */
export async function assembleCheckAccessSummary(
  stepUpAccessToken: string,
  engineer: Engineer,
  target: EngineerRow,
  tenant: TenantRow,
): Promise<CheckAccessSummary> {
  const summary = buildBaseSummary(target, tenant);

  // Resolve the target's Entra object id once, same lazy-cache pattern as
  // applyAccessGroupAction in auth/routes.ts — it's the same column, so a
  // prior access-group action may have already populated it.
  let entraObjectId = target.entraObjectId;
  if (!entraObjectId) {
    entraObjectId = await resolveEngineerObjectId(stepUpAccessToken, config.ENTRA_TENANT_ID, target.upn);
    await db.update(tables.engineers).set({ entraObjectId }).where(eq(tables.engineers.id, target.id));
  }

  if (tenant.isMspTenant) {
    // Category 2 — Entra Roles (Direct), home tenant only.
    const memberships = await getUserMemberships(stepUpAccessToken, entraObjectId);
    const heldTemplateIds = new Set(memberships.map((m) => m.roleTemplateId).filter((id): id is string => !!id));
    summary.entraDirect.roles = CHECK_ACCESS_ENTRA_ROLES.map((role) => ({
      role,
      held: heldTemplateIds.has(ENTRA_ROLE_TEMPLATE_IDS[role as keyof typeof ENTRA_ROLE_TEMPLATE_IDS]),
    }));
  } else {
    // Category 3 — GDAP Roles (Partner Centre), customer tenant only. GDAP
    // relationships and their access-assignment security groups live in the
    // HOME tenant (Admin Relationships is a partner-tenant concept, not a
    // customer-tenant one), so the relationship lookup reuses the requesting
    // engineer's standing home-tenant token (collectPaged, same as
    // syncTenants) rather than the step-up token — DelegatedAdminRelationship
    // .Read.All is already a standing-consented scope. Only the
    // accessAssignments + membership reads below need the step-up token's
    // RoleManagement.Read.Directory / GroupMember.Read.All scopes.
    const { rows: relationships } = await collectPaged<DelegatedAdminRelationship>(
      engineer,
      engineer.homeTenantId,
      "graph",
      "/tenantRelationships/delegatedAdminRelationships?$select=id,displayName,status,customer",
    );
    const relationship = relationships.find((r) => r.customer?.tenantId === tenant.tenantId);

    if (relationship) {
      summary.gdapRoles.relationshipFound = true;
      const [assignments, memberships] = await Promise.all([
        getGdapAccessAssignments(stepUpAccessToken, relationship.id),
        getUserMemberships(stepUpAccessToken, entraObjectId),
      ]);
      const memberGroupIds = new Set(memberships.map((m) => m.id));

      // groupId -> set of role-definition ids that group carries in this
      // relationship, so a role only counts as "held" when the target is
      // actually a member of a group carrying it — not merely that the
      // relationship carries the role in the abstract (per the user's spec:
      // "match and confirm user membership").
      const roleIdsByGroup = new Map<string, Set<string>>();
      for (const a of assignments) {
        const groupId = a.accessContainer.accessContainerId;
        const set = roleIdsByGroup.get(groupId) ?? new Set<string>();
        for (const r of a.accessDetails.unifiedRoles) set.add(r.roleDefinitionId);
        roleIdsByGroup.set(groupId, set);
      }

      summary.gdapRoles.roles = REQUIRED_GDAP_ROLES.map((role) => {
        const templateId = ENTRA_ROLE_TEMPLATE_IDS[role as keyof typeof ENTRA_ROLE_TEMPLATE_IDS];
        let matchingGroupId: string | null = null;
        for (const [groupId, roleIds] of roleIdsByGroup) {
          if (templateId && roleIds.has(templateId) && memberGroupIds.has(groupId)) {
            matchingGroupId = groupId;
            break;
          }
        }
        return { role, groupId: matchingGroupId, held: matchingGroupId !== null };
      });
    }
  }

  return summary;
}

export async function checkAccessRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer || !req.currentUser) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });

  // Category 1 (PatchPilot role/permissions) needs no Graph call, so it's
  // served immediately — the panel renders this right away while categories
  // 2/3 fill in once the step-up round trip (below) completes.
  app.get<{ Querystring: { userId?: string; tenantId?: string } }>(
    "/api/check-access/summary",
    async (req, reply) => {
      const actor = req.currentUser!;
      const targetUserId = req.query.userId || actor.id;
      if (!assertCanCheck(actor, targetUserId)) {
        return reply.code(403).send({ error: "forbidden" });
      }
      if (!req.query.tenantId) {
        return reply.code(400).send({ error: "tenantId is required" });
      }

      const [target] = await db.select().from(tables.engineers).where(eq(tables.engineers.id, targetUserId)).limit(1);
      if (!target) {
        return reply.code(404).send({ error: "user not found" });
      }
      const [tenant] = await db.select().from(tables.tenants).where(eq(tables.tenants.tenantId, req.query.tenantId)).limit(1);
      if (!tenant) {
        return reply.code(404).send({ error: "tenant not found" });
      }

      return buildBaseSummary(target, tenant);
    },
  );

  app.get<{ Querystring: { userId?: string; tenantId?: string; silent?: string } }>(
    "/api/check-access/start",
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(400).send({ error: "not_available_in_demo_mode" });
      }

      const actor = req.currentUser!;
      const targetUserId = req.query.userId || actor.id;
      const tenantId = req.query.tenantId;
      if (!tenantId) {
        return reply.code(400).send({ error: "tenantId is required" });
      }
      if (!assertCanCheck(actor, targetUserId)) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const [target] = await db.select().from(tables.engineers).where(eq(tables.engineers.id, targetUserId)).limit(1);
      if (!target) {
        return reply.code(404).send({ error: "user not found" });
      }

      const silent = req.query.silent === "1";
      const origin = resolveWebOrigin(req);
      const statePrefix = silent ? "patchpilot-checkaccess-silent:" : "patchpilot-checkaccess:";
      const state = `${statePrefix}${req.session.sessionId}:${targetUserId}:${tenantId}`;

      // Same select_account-forced / prompt=none branching as
      // access-groups.ts's /start, and for the same reason: with no `prompt`
      // at all Microsoft's authorize endpoint silently reuses whatever SSO
      // session is already in the browser, which is fine for a self-check
      // but wrong when an admin is checking someone else and needs to sign
      // in as an account that actually holds CHECK_ACCESS_SCOPES's consent
      // (any signed-in account does, since it's tenant-wide — but forcing
      // the picker keeps this consistent with every other step-up flow in
      // the app rather than special-casing "read-only" flows).
      const url = await getCca().getAuthCodeUrl({
        scopes: CHECK_ACCESS_SCOPES,
        redirectUri: `${origin}/auth/callback`,
        state,
        ...(silent
          ? { prompt: "none" as const, loginHint: req.session.engineer!.upn }
          : { prompt: "select_account" as const }),
      });

      return reply.redirect(url);
    },
  );

  // One-shot read for the interactive-fallback path (see auth/routes.ts's
  // CHECK_ACCESS_STATE_PREFIX branch) — deleted immediately so a stale
  // resultId in a bookmarked/shared URL never replays a permission snapshot.
  app.get<{ Params: { resultId: string } }>("/api/check-access/result/:resultId", async (req, reply) => {
    const key = resultKey(req.params.resultId);
    const raw = await redis.get(key);
    if (!raw) {
      return reply.code(404).send({ error: "result not found or expired" });
    }
    await redis.del(key);
    return JSON.parse(raw);
  });
}
