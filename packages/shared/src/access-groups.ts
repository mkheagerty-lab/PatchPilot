/**
 * Display names for the two home-tenant role-assignable security groups
 * Deploy-PatchPilot.ps1 provisions (see docs/onboarding-design.md's
 * "Home-tenant access groups" section and packages/graph/src/access-groups.ts).
 * Kept here — not in packages/graph — so both the web console (confirm-dialog
 * copy, sync-status badges) and the script/API (which actually create and
 * assign these) render byte-identical names without the browser bundle
 * depending on @patchpilot/graph's Node-only Microsoft-Graph client.
 *
 * These are the exact `displayName` values Deploy-PatchPilot.ps1 creates the
 * groups with (its own idempotent `Get-MgGroup -Filter "displayName eq '...'"`
 * lookup uses these same literals) — changing a string here without changing
 * the script (or vice versa) breaks that lookup.
 */
export const READONLY_GROUP_NAME = "PatchPilot Read-Only Access";
export const WRITE_GROUP_NAME = "PatchPilot Write Access";

/** Entra directory roles assigned to PATCHPILOT_READONLY_GROUP_ID's members. */
export const READONLY_GROUP_ROLES = ["Global Reader", "Security Reader"] as const;

/**
 * Entra directory roles assigned to PATCHPILOT_WRITE_GROUP_ID's members.
 * Additive on top of the read-only group's roles, never a replacement — a
 * write-enabled engineer stays a member of both groups (see the plan's own
 * note: holding both Security Reader and Security Administrator at once is
 * harmless, the latter is a strict superset for that surface).
 */
export const WRITE_GROUP_ROLES = [
  "Security Administrator",
  "Intune Administrator",
  "Windows Update Deployment Administrator",
] as const;

/**
 * What each home-tenant access-group role actually unlocks, for the
 * Architecture page's role/permission table. Deliberately prose, not a
 * literal role -> Graph-scope join — an Entra directory role gates which
 * delegated Graph/Defender calls the acting engineer's own token can
 * exercise, it isn't a 1:1 mapping to an OAuth scope string the way
 * GRAPH_SCOPES/DEFENDER_SCOPES (see scopes.ts) are.
 */
export const HOME_TENANT_ROLE_PURPOSE: Record<
  (typeof READONLY_GROUP_ROLES)[number] | (typeof WRITE_GROUP_ROLES)[number],
  string
> = {
  "Global Reader": "Reads users, groups, and licensing in the home tenant.",
  "Security Reader": "Reads security/vulnerability signal in the home tenant.",
  "Security Administrator": "Backs Defender for Endpoint's delegated write calls.",
  "Intune Administrator":
    "Backs Intune device/app/update-profile writes — Live Response dispatch, app deployment, quality- and feature-update profiles.",
  "Windows Update Deployment Administrator": "Backs Windows Update for Business deployment writes.",
};
