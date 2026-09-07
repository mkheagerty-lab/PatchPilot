import { READONLY_GROUP_ROLES, WRITE_GROUP_ROLES } from "./access-groups.js";
import { REQUIRED_GDAP_ROLES } from "./scopes.js";
import { PERMISSION_AREAS, accessFor, type Role, type AreaAccess } from "./rbac.js";

/**
 * Check Access (Setup Health tab) — lets an engineer see where they actually
 * stand across PatchPilot's three independent access layers (see rbac.ts's
 * doc comment), and lets a `users:manage` admin check the same for someone
 * else. See docs/onboarding-design.md's "Check Access" section for the full
 * design, apps/api/src/routes/check-access.ts for the API, and
 * packages/graph/src/check-access.ts for the Graph reads this assembles.
 */

/**
 * Built-in Entra directory role template IDs — fixed, Microsoft-published
 * GUIDs that are the same in every tenant (unlike a group's object id).
 * Covers every role either home-tenant access group assigns (see
 * access-groups.ts), since Category 2 (Entra Roles Direct) checks for
 * exactly those roles held *directly*, independent of group membership.
 *
 * SPIKE ITEM (see the Check Access plan's Section 0): taken from Microsoft's
 * published built-in-roles reference, not yet re-confirmed live against the
 * dev tenant's own `GET /roleManagement/directory/roleDefinitions`. Confirm
 * before relying on this for a real access decision.
 */
export const ENTRA_ROLE_TEMPLATE_IDS: Record<
  (typeof READONLY_GROUP_ROLES)[number] | (typeof WRITE_GROUP_ROLES)[number],
  string
> = {
  "Global Reader": "f2ef992c-3afb-46b9-b7cf-a126ee74c451",
  "Security Reader": "5d6b6bb7-de71-4623-b4af-96380a352509",
  "Security Administrator": "194ae4cb-b126-40b2-bd5b-6091b380977d",
  "Intune Administrator": "3a2c62db-5318-420d-8d74-23affee5d9d5",
  "Windows Update Deployment Administrator": "32696413-001a-46ae-978c-ce0f6b3620d2",
};

/**
 * Every Entra role Check Access's Category 2 (home tenant only) looks for —
 * the union of both home-tenant access groups' roles, since either one being
 * held directly (bypassing group membership entirely) is equally worth
 * surfacing.
 */
export const CHECK_ACCESS_ENTRA_ROLES: string[] = [...new Set([...READONLY_GROUP_ROLES, ...WRITE_GROUP_ROLES])];

// Category 3 (GDAP, customer tenants only) reuses REQUIRED_GDAP_ROLES
// directly — those are already exactly "the roles PatchPilot needs from a
// GDAP relationship", no separate list needed.
export { REQUIRED_GDAP_ROLES };

/** One row in Category 1's permission-area table. */
export interface CheckAccessScopeRow {
  area: string;
  label: string;
  description: string;
  access: AreaAccess;
}

/** One row in Category 2 or 3's role table. */
export interface CheckAccessRoleRow {
  role: string;
  /** Category 3 only — the GDAP role's matching security group id, if resolved. */
  groupId?: string | null;
  held: boolean;
}

export interface CheckAccessSummary {
  targetUpn: string;
  targetDisplayName: string;
  tenantId: string;
  tenantDisplayName: string;

  patchPilot: {
    role: Role;
    tenantWriteEnabled: boolean;
    scopes: CheckAccessScopeRow[];
  };

  /** Only meaningful in the home tenant — see buildPatchPilotCategory's caller. */
  entraDirect: {
    applicable: boolean;
    roles: CheckAccessRoleRow[];
  };

  /** Only meaningful in a customer tenant. */
  gdapRoles: {
    applicable: boolean;
    relationshipFound: boolean;
    roles: CheckAccessRoleRow[];
  };

  checkedAt: string;
  demoMode: boolean;
}

/**
 * Category 1 — pure DB + RBAC, no Graph call needed, so it's served
 * immediately by GET /api/check-access/summary while categories 2/3 fill in
 * once the step-up round trip completes.
 *
 * Deliberate accuracy decision: PatchPilot's actual RBAC enforcement doesn't
 * distinguish, say, Intune writes from Defender Live Response writes — both
 * sit behind the single `operations:write` permission (rbac.ts). This uses
 * the real 6-area PERMISSION_AREAS grouping rather than inventing a
 * finer-grained breakdown the system doesn't actually enforce, matching this
 * project's established norm of the UI never claiming a distinction that
 * isn't real (see the Architecture page's accuracy fixes).
 */
export function buildPatchPilotCategory(
  role: Role,
  tenantReadOnly: boolean,
): CheckAccessSummary["patchPilot"] {
  return {
    role,
    tenantWriteEnabled: !tenantReadOnly,
    scopes: PERMISSION_AREAS.map((area) => ({
      area: area.key,
      label: area.label,
      description: area.description,
      access: accessFor(role, area),
    })),
  };
}
