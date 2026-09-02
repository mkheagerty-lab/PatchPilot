/**
 * PatchPilot's own role-based access control — the vocabulary and the matrix.
 *
 * Lives in `shared` for the same reason the audit vocabulary does: three
 * consumers need the same words. The API enforces permissions, the web app
 * hides and disables controls it knows will be refused, and both must agree on
 * what a role means. Keep this module free of any Node/Postgres import —
 * `apps/web` depends on `@patchpilot/shared`, so everything here ships to the
 * browser.
 *
 * ---
 *
 * This is deliberately NOT the same thing as GDAP. Two independent gates apply
 * to every write:
 *
 *   - **Entra/GDAP** decides which *customer tenants* a person can reach at all.
 *     A delegated token minted for a customer inherits that engineer's GDAP
 *     roles; without the role, Microsoft returns 403 and PatchPilot surfaces the
 *     tenant as `consent-needed`. PatchPilot cannot widen this.
 *   - **The role here** decides what a person may do *inside PatchPilot*, across
 *     every tenant they can already reach. PatchPilot cannot widen GDAP, and
 *     GDAP does not grant anything here.
 *
 * A third, orthogonal gate is per-tenant: `tenants.readOnly` (the write opt-in
 * in Settings > Tenants). A write needs all three to say yes.
 *
 * ---
 *
 * Checks are written against *permissions*, never role names. That is what lets
 * a fourth role — or eventually custom roles — be added by editing
 * ROLE_PERMISSIONS alone, instead of hunting down every `role === "admin"` in
 * the codebase.
 */

// ---- roles ----
// Ordered most- to least-privileged; the Users page renders the select in this
// order and `ROLES[0]` is the role the bootstrap admin is granted.
export const ROLES = ["admin", "technician", "reader"] as const;
export type Role = (typeof ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(ROLES);

/** Narrows an arbitrary string (a query param, a legacy row) to a known role. */
export function isRole(value: string): value is Role {
  return ROLE_SET.has(value);
}

// ---- account status ----
// "pending" is reserved for the email-invite flow (invited, not yet accepted)
// and is deliberately absent until that flow exists — an unused status that
// nothing sets but everything must handle is a bug waiting to happen. Adding it
// later is additive.
export const USER_STATUSES = ["active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

// ---- permissions ----
// `noun:verb`, matching the audit vocabulary's convention. Every `:write`
// implies the matching `:read` in practice, but the matrix below states both
// explicitly rather than deriving one from the other — an implicit grant is
// exactly the kind of thing that goes unnoticed when a role is added.
export const PERMISSIONS = [
  // Dashboard, Vulnerabilities, Security Recommendations, Devices, Jobs,
  // Inventories, Missing KBs, Remediation History.
  "operations:read",
  // Dispatch / Fix All / Fix Now / retry, manual remediation records,
  // recommendation exceptions, device exclusions, schedules, job archive+delete.
  "operations:write",
  // The winget, Chocolatey and script catalogs.
  "catalog:read",
  // Catalog refresh, title->package overrides, script upload/archive/delete.
  "catalog:write",
  // Branding, Compliance SLA, the tenant list, Setup/readiness/pre-flight.
  "settings:read",
  // Branding + SLA edits, tenant write-posture toggle, tenant discover/sync,
  // app-registration permission sync (Setup -> App Registration).
  "settings:write",
  "audit:read",
  "users:read",
  // Add, change role, disable/enable, remove.
  "users:manage",
  // AI summaries, reports and the chatbot. Separate from operations:read
  // because it gates local-LLM inference cost/load, not data visibility — the
  // AI tools re-check operations:read/catalog:read themselves per call, so
  // this only decides who may invoke the feature at all.
  "ai:use",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * The matrix. Typed as an exhaustive `Record<Role, ...>` so adding a role is a
 * compile error until its permissions are decided — the alternative (a partial
 * map with a fallback) fails open, which is the wrong direction for a
 * permission table.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: [...PERMISSIONS],

  // "Operations read/write." Catalog *read* is included because a remediation
  // cannot be dispatched without resolving a software title to a package — the
  // catalog is an input to the operations work, not a separate privilege.
  // Catalog *write* is not: uploading a script or pinning an override changes
  // what actually executes on a customer's endpoints.
  technician: [
    "operations:read",
    "operations:write",
    "catalog:read",
    "settings:read",
    "audit:read",
    "ai:use",
  ],

  // Read-only everywhere. Deliberately includes `audit:read` — reading the
  // record of what happened is the least privileged thing in the product, and
  // withholding it from the role whose whole purpose is oversight would be
  // backwards. Excludes `ai:use`: reader already gets the same underlying
  // data via every existing page, and AI generation spends real inference
  // compute — opt-in for the roles that act on findings, for now. One line
  // to change if that turns out to be too conservative.
  reader: ["operations:read", "catalog:read", "settings:read", "audit:read"],
};

const PERMISSION_SETS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set(ROLE_PERMISSIONS.admin),
  technician: new Set(ROLE_PERMISSIONS.technician),
  reader: new Set(ROLE_PERMISSIONS.reader),
};

/** The single authority. Every gate in the API and the web app goes through this. */
export function can(role: Role, permission: Permission): boolean {
  return PERMISSION_SETS[role].has(permission);
}

/** The full grant for a role, for `/auth/me` to hand the SPA in one round trip. */
export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

// ---- display ----

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  technician: "Technician",
  reader: "Reader",
};

/**
 * Shown beside each option in the role picker. Written for the person choosing,
 * so they describe consequences rather than listing permission strings.
 */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: "Full access, including managing users, catalogs and tenant settings.",
  technician: "Read everything and run remediation. Cannot manage users, scripts or settings.",
  reader: "Read-only across the whole console. Cannot run or change anything.",
};

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  active: "Active",
  disabled: "Disabled",
};

/**
 * The permission matrix regrouped by product area rather than role, for the
 * Roles tab on Settings > Users — a person choosing a role wants "what can
 * they touch", not the raw `noun:verb` list. Not every area has a `write`
 * permission (audit is read-only by design; users' write permission is named
 * `users:manage`, not `users:write`), so `write` is nullable rather than
 * assuming the `:read`/`:write` naming convention holds everywhere.
 */
export interface PermissionArea {
  key: string;
  label: string;
  description: string;
  read: Permission;
  write: Permission | null;
}

export const PERMISSION_AREAS: readonly PermissionArea[] = [
  {
    key: "operations",
    label: "Operations",
    description:
      "Dashboard, Vulnerabilities, Recommendations, Devices, Jobs, Inventories, Missing KBs, Remediation History.",
    read: "operations:read",
    write: "operations:write",
  },
  {
    key: "catalog",
    label: "Catalogs",
    description: "The Winget, Chocolatey and Script catalogs.",
    read: "catalog:read",
    write: "catalog:write",
  },
  {
    key: "settings",
    label: "Settings",
    description:
      "Branding, Compliance SLA, Notifications (SMTP relay), the tenant list, Setup/readiness, and syncing app registration permissions.",
    read: "settings:read",
    write: "settings:write",
  },
  {
    key: "audit",
    label: "Audit log",
    description: "The record of every action taken in PatchPilot. Read-only for every role.",
    read: "audit:read",
    write: null,
  },
  {
    key: "users",
    label: "Users & roles",
    description: "Who can sign in to PatchPilot and what role they hold.",
    read: "users:read",
    write: "users:manage",
  },
  {
    key: "ai",
    label: "AI features",
    description:
      "AI-generated page summaries, reports and the chatbot. A single on/off permission, not a read/write split — shown as \"Read only\" when granted for the same reason audit is.",
    read: "ai:use",
    write: null,
  },
] as const;

/** Read+write / read-only / no-access summary for one (role, area) cell. */
export type AreaAccess = "readwrite" | "readonly" | "none";

export function accessFor(role: Role, area: PermissionArea): AreaAccess {
  if (!can(role, area.read)) return "none";
  if (area.write && can(role, area.write)) return "readwrite";
  return "readonly";
}

export const AREA_ACCESS_LABELS: Record<AreaAccess, string> = {
  readwrite: "Read & write",
  readonly: "Read only",
  none: "No access",
};
