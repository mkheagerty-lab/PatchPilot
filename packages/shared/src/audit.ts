/**
 * The audit log's vocabulary — actions, resource types, actors, outcomes.
 *
 * Lives in `shared` rather than beside the writer in `packages/graph` because
 * three consumers need the same words: the API (writing entries), the worker
 * (writing entries for background work) and the web page (rendering filters and
 * labels). Keep this module free of any Node/Postgres import — `apps/web`
 * depends on `@patchpilot/shared`, so everything here ships to the browser.
 *
 * The writer itself is `audit()` in `@patchpilot/graph`.
 */

// ---- category ----
// Two tiers of event, because they have wildly different volume and audience.
// `api_call` is the raw outbound Microsoft traffic auto-recorded by graphGet/
// graphWrite/graphUpload — a single tenant sync emits hundreds. `action` is a
// thing somebody (or something) decided to do. The page defaults to `action`
// and offers `api_call` as an opt-in, otherwise one sync buries a day of work.
export const AUDIT_CATEGORIES = ["action", "api_call"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

// ---- actor type ----
// `audit_log.engineer` stays NOT NULL and holds either a real UPN or one of the
// reserved SYSTEM_ACTORS sentinels below; this column says how to read it.
//
// `schedule` is the interesting one: a scheduled fan-out records the *owning
// engineer's* UPN (the person who armed the schedule and whose delegated
// authority the jobs run under) with actorType "schedule", so automated work
// keeps human accountability instead of vanishing into "system".
export const AUDIT_ACTOR_TYPES = ["user", "system", "schedule", "worker"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

// ---- outcome ----
// `partial` covers batch operations where some members failed; `skipped` covers
// work that was deliberately suppressed (a schedule that declined to fire
// because its tenant is read-only). Recording the suppressions matters — a
// silent no-op is exactly the thing an audit log exists to make visible.
export const AUDIT_OUTCOMES = ["success", "failure", "partial", "skipped"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * Reserved non-human actor identifiers written into `audit_log.engineer`.
 *
 * The `system:` prefix can never collide with a UPN, which is why this works
 * without making the column nullable (that would be a breaking schema change
 * for every existing reader and row).
 */
export const SYSTEM_ACTORS = {
  autoSync: "system:auto-sync",
  catalogRefresh: "system:catalog-refresh",
  chocolateyRefresh: "system:chocolatey-refresh",
  postureSnapshot: "system:posture-snapshot",
  scheduler: "system:scheduler",
  worker: "system:worker",
  startup: "system:startup",
  // The one route with no engineer session at all: the pairing script POSTs
  // its Entra credentials authenticated solely by a single-use token, so this
  // is the only actor a successful pairing row can carry.
  onboardingPairing: "system:onboarding-pairing",
} as const;

export type SystemActor = (typeof SYSTEM_ACTORS)[keyof typeof SYSTEM_ACTORS];

/** True for the reserved sentinels above — i.e. "this row has no human behind it". */
export function isSystemActor(engineer: string): boolean {
  return engineer.startsWith("system:");
}

/**
 * "system:auto-sync" -> "Auto sync". Used for the Actor column, which shows a
 * System chip plus the component rather than a raw sentinel.
 */
export function systemActorLabel(engineer: string): string {
  if (!isSystemActor(engineer)) return engineer;
  const component = engineer.slice("system:".length).replace(/-/g, " ");
  return component.charAt(0).toUpperCase() + component.slice(1);
}

// ---- resource types ----
export const AUDIT_RESOURCE_TYPES = [
  "tenant",
  "device",
  "vulnerability",
  "recommendation",
  "job",
  "schedule",
  "catalog",
  "catalog-override",
  "script",
  "setting",
  "exception",
  "manual-remediation",
  "missing-kb",
  "software",
  "session",
  "connection",
  "user",
  "background-access",
  "ai-conversation",
  // A row in the `reports` table. Superseded "ai-report" below when reports
  // stopped being an AI feature and became a `reports.id` you can re-download.
  "report",
  // Retained for historical rows only: the old AI-report path identified its
  // resource by a BullMQ job id. Nothing writes this any more, but dropping it
  // would leave those rows unlabelled and unfilterable on the Audit Log page.
  "ai-report",
  "device-group",
  "intune-app",
  // An Entra app registration — currently only written by the "Sync
  // permissions" action (Setup → App Registration), which refreshes an
  // existing registration's requested scopes/admin consent.
  "application",
  // A row in `feature_update_campaigns` — a standing, group-targeted Windows
  // feature-update rollout. The single-device "Update to <version>" action
  // reuses "device" instead, mirroring how expedited quality updates do.
  "feature-update-campaign",
  // A row in `quality_update_campaigns` — a standing, group-targeted
  // Expedited Quality Update rollout. Mirrors feature-update-campaign; the
  // single-device Fix Now/Fix All path reuses "missing-kb" instead.
  "quality-update-campaign",
  // The Windows Updates hub's combined "Sync now" — refreshes all four tabs
  // (feature updates, both quality-update policyTypes, update rings, driver
  // updates) in one request. No single-row resource id: this is a
  // page/tenant-level action, not a create/update/delete of one campaign.
  "windows-updates",
] as const;
export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

// ---- actions ----
// `noun:verb`, extending the convention the codebase already used informally via
// pseudo-endpoints ("manual-remediation:record", "recommendation-exception:create").
export const AUDIT_ACTIONS = [
  // remediation
  "remediation:dispatch",
  "remediation:fix-all",
  "remediation:retry",
  "remediation:manual-record",
  "remediation:verified",
  // jobs
  "job:archive",
  "job:unarchive",
  "job:delete",
  "job:bulk-archive",
  "job:bulk-delete",
  "job:timeout",
  "job:orphan-swept",
  "job:stale-swept",
  // schedules
  "schedule:create",
  "schedule:update",
  "schedule:delete",
  "schedule:fire",
  // tenants
  "tenant:set-write-posture",
  // Distinct from set-write-posture: the two PATCH /api/tenants/:tenantId
  // fields are unrelated settings (readOnly vs. the feature-update target
  // label), audited separately so an Audit Log filter on one never implies
  // the other changed too.
  "tenant:set-feature-update-target",
  // This tenant's own slice of PatchPilot's instance-wide Live Response
  // device pool — an MSP-admin-set allocation, distinct from both fields
  // above and from the vendor's own "entitlement:update" (which sets the
  // pool's total size, not how it's divided).
  "tenant:set-live-response-device-limit",
  "tenant:discover",
  "tenant:sync",
  "tenant:auto-sync",
  "tenant:resync",
  // The daily posture capture that gives the Dashboard trend charts their
  // history. Scheduled cycles only — post-sync captures are not audited.
  "posture:snapshot",
  // catalog
  "catalog:refresh",
  "catalog:override-create",
  "catalog:override-delete",
  "chocolatey-catalog:refresh",
  "chocolatey-catalog:override-create",
  "chocolatey-catalog:override-delete",
  "script:upload",
  "script:delete",
  "script:archive",
  "script:restore",
  "script:bulk-archive",
  "script:bulk-restore",
  "script:bulk-delete",
  // access
  "auth:login-start",
  "auth:login-success",
  "auth:login-failed",
  // A completed sign-in whose UPN has no active row in `engineers` — distinct
  // from login-failed, which covers a bad/expired authorization code. This one
  // means Entra vouched for the person but PatchPilot hasn't provisioned them.
  "auth:login-denied",
  "auth:logout",
  "auth:consent-granted",
  "auth:consent-denied",
  "connection:test",
  // settings
  "setting:update",
  // PatchPilot's vendor entitlement token upload (Settings > License). A
  // dedicated action rather than the generic setting:update above, since this
  // is the one settings change that gates whether the instance can write at
  // all — worth being filterable on its own in the Audit Log.
  "entitlement:update",
  // Self-serve free-tier trial activation (Settings > License) — distinct
  // from entitlement:update since no token is involved, just a timestamp.
  "entitlement:trial-start",
  "exception:create",
  "exception:cancel",
  "device:exclude",
  "device:stop-exclusion",
  // device groups — PatchPilot-native groups used to scope schedule fan-out,
  // distinct from Defender's own read-only RBAC device groups.
  "device-group:create",
  "device-group:update",
  "device-group:delete",
  "device-group:add-members",
  "device-group:remove-member",
  // Intune app deployment (Deploy App — WinGet/Win32 apps created in a
  // customer's Intune tenant, replicating CIPP's Deploy App flow).
  "intune-app:create",
  "intune-app:assign",
  "intune-app:update",
  // App registration sync — the in-app "Sync permissions" action (Setup →
  // App Registration) that refreshes an already-existing app registration's
  // requested Graph/Defender/Partner Center scopes and admin consent,
  // replacing a manual Deploy-PatchPilot.ps1 re-run. Distinct from
  // auth:consent-granted/denied, which cover the routine per-customer-tenant
  // consent flow rather than this one-time elevated step-up grant.
  "app-registration:sync-start",
  "app-registration:sync-success",
  "app-registration:sync-failed",
  // Custom domain management (Setup → App Registration, "Custom domain"
  // section — apps/api/src/routes/domains.ts). "domain-sync-*" is the redirect-URI
  // counterpart of the "app-registration:sync-*" scope-sync actions above: same
  // one-time elevated step-up grant, but patches Web.RedirectUris instead.
  "custom-domain:created",
  "custom-domain:activated",
  "custom-domain:verify-failed",
  "custom-domain:deleted",
  "app-registration:domain-sync-start",
  "app-registration:domain-sync-success",
  "app-registration:domain-sync-failed",
  // Read-only counterpart of "app-registration:sync-*" above — the "Test
  // Connection" action (Setup → App Registration, Requested API permissions
  // section) reports each requested scope's live status without writing
  // anything back to Entra.
  "app-registration:test-connection-start",
  "app-registration:test-connection-success",
  "app-registration:test-connection-failed",
  // Onboarding pairing — the "phone home" flow that replaces writing Entra
  // credentials to a local .env (see apps/api/src/routes/onboarding-pairing.ts).
  // "issued" is written by the authenticated admin who generated the
  // personalized installer; "paired" is written by the unauthenticated pair
  // endpoint itself, under SYSTEM_ACTORS.onboardingPairing.
  "onboarding:pairing-token-issued",
  "onboarding:paired",
  // feature updates — the group-campaign flow only. The single-device
  // "Update to <version>" action is a job dispatch and reuses
  // "remediation:dispatch", same as every other channel.
  "feature-update-campaign:create",
  // Page-local "Sync now" — refreshes feature_update_campaigns from live
  // windowsFeatureUpdateProfiles (both PatchPilot's own and any created
  // directly in the Intune admin center). Distinct from tenant:sync, which
  // bundles this in as one of several sub-syncs.
  "feature-update-campaign:sync",
  // Removes the windowsFeatureUpdateProfile from Intune itself, not just this
  // row — whether PatchPilot created it or it was synced in from the admin
  // center.
  "feature-update-campaign:delete",
  // Windows Updates hub's multi-select "Delete" bar — one row per batch, not
  // per campaign, same convention as script:bulk-delete.
  "feature-update-campaign:bulk-delete",
  "quality-update-campaign:create",
  // Removes the windowsQualityUpdateProfile from Intune itself, not just this
  // row. Only ever fired for policyType "expedite" — the read-only
  // "quality-update" policyType has no PatchPilot delete path.
  "quality-update-campaign:delete",
  "quality-update-campaign:bulk-delete",
  // Windows Updates hub's page-level "Sync now" — refreshes all four tabs
  // (feature updates, both quality-update policyTypes, update rings, driver
  // updates) in one request. Distinct from feature-update-campaign:sync,
  // which only ever refreshed the one pipeline.
  "windows-updates:sync",
  // users
  "user:create",
  "user:update",
  "user:update-role",
  "user:disable",
  "user:enable",
  "user:delete",
  // background access — the persisted, self-renewing MSAL refresh-token
  // credential (packages/graph/src/msal.ts) that auto-sync and engineer-bound
  // schedules use to reach tenants with no live session. Distinct from the
  // user:* actions above: these fire on the credential's own lifecycle, which
  // no longer tracks routine sign-in/sign-out.
  "background-access:unavailable",
  "background-access:restored",
  "user:revoke-background-access",
  // ai
  // One row per user turn, not per model round-trip — a turn that calls three
  // tools before answering is still one accountability entry, with the tool
  // calls themselves in `detail`, not three separate rows.
  "ai:chat-message",
  // A tool call the model attempted that the RBAC/tenant-reachability check
  // inside registry.ts refused. The most security-relevant row this feature
  // produces — worth its own action rather than folding into chat-message so
  // it's filterable on its own.
  "ai:tool-call-denied",
  // One row per page summary generated (POST /api/ai/summarize).
  "ai:summarize",
  // Retained for historical rows only — superseded by "report:generate" below
  // when reports stopped being an AI-only feature. Removing it would break the
  // exhaustive label record AND orphan every row the old path already wrote.
  "ai:report-generate",
  // reports
  // One row per report the worker finishes, not per enqueue — an engineer
  // polling a still-running report shouldn't produce more rows. `outcome`
  // carries the distinction between a fully narrated run and one that fell back
  // to captions because Ollama was unreachable.
  "report:generate",
  "report:download",
  // Written by the engineer deleting their own report AND by the worker's
  // retention sweep, which writes one row for the whole batch — and nothing at
  // all when the sweep found nothing, same as the stale-job sweep.
  "report:delete",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

/** Narrows an arbitrary string (a query param, a legacy row) to a known action. */
export function isAuditAction(value: string): value is AuditAction {
  return ACTION_SET.has(value);
}

/** Human labels for the Action column and the filter dropdown. */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  "remediation:dispatch": "Remediation dispatched",
  "remediation:fix-all": "Fix-all dispatched",
  "remediation:retry": "Remediation retried",
  "remediation:manual-record": "Manual remediation recorded",
  "remediation:verified": "Remediation verified on device",

  "job:archive": "Job archived",
  "job:unarchive": "Job unarchived",
  "job:delete": "Job deleted",
  "job:bulk-archive": "Jobs bulk-archived",
  "job:bulk-delete": "Jobs bulk-deleted",
  "job:timeout": "Job timed out",
  "job:orphan-swept": "Orphaned jobs swept",
  "job:stale-swept": "Stale jobs swept",

  "schedule:create": "Schedule created",
  "schedule:update": "Schedule updated",
  "schedule:delete": "Schedule deleted",
  "schedule:fire": "Schedule fired",

  "tenant:set-write-posture": "Tenant write posture changed",
  "tenant:set-feature-update-target": "Feature update target changed",
  "tenant:set-live-response-device-limit": "Tenant Live Response device allocation changed",
  "tenant:discover": "Tenants discovered",
  "tenant:sync": "Tenant synced",
  "tenant:auto-sync": "Tenant auto-synced",
  "tenant:resync": "Post-remediation resync",
  "posture:snapshot": "Posture snapshot captured",

  "catalog:refresh": "Winget catalog refreshed",
  "catalog:override-create": "Winget override created",
  "catalog:override-delete": "Winget override deleted",
  "chocolatey-catalog:refresh": "Chocolatey catalog refreshed",
  "chocolatey-catalog:override-create": "Chocolatey override created",
  "chocolatey-catalog:override-delete": "Chocolatey override deleted",
  "script:upload": "Script uploaded",
  "script:delete": "Script deleted",
  "script:archive": "Script archived",
  "script:restore": "Script restored",
  "script:bulk-archive": "Scripts bulk-archived",
  "script:bulk-restore": "Scripts bulk-restored",
  "script:bulk-delete": "Scripts bulk-deleted",

  "auth:login-start": "Sign-in started",
  "auth:login-success": "Signed in",
  "auth:login-failed": "Sign-in failed",
  "auth:login-denied": "Sign-in denied — not provisioned",
  "auth:logout": "Signed out",
  "auth:consent-granted": "Admin consent granted",
  "auth:consent-denied": "Admin consent denied",
  "connection:test": "Connection tested",

  "setting:update": "Setting updated",
  "entitlement:update": "License key updated",
  "entitlement:trial-start": "Free trial started",
  "exception:create": "Exception created",
  "exception:cancel": "Exception cancelled",
  "device:exclude": "Device excluded",
  "device:stop-exclusion": "Device exclusion stopped",

  "device-group:create": "Device group created",
  "device-group:update": "Device group updated",
  "device-group:delete": "Device group deleted",
  "device-group:add-members": "Devices added to group",
  "device-group:remove-member": "Device removed from group",

  "intune-app:create": "Intune app deployed",
  "intune-app:assign": "Intune app assignment changed",
  "intune-app:update": "Intune app updated",

  "app-registration:sync-start": "Permission sync started",
  "app-registration:sync-success": "Permissions synced",
  "app-registration:sync-failed": "Permission sync failed",

  "custom-domain:created": "Custom domain added",
  "custom-domain:activated": "Custom domain activated",
  "custom-domain:verify-failed": "Custom domain verification failed",
  "custom-domain:deleted": "Custom domain removed",
  "app-registration:domain-sync-start": "Redirect URI sync started",
  "app-registration:domain-sync-success": "Redirect URIs synced",
  "app-registration:domain-sync-failed": "Redirect URI sync failed",

  "app-registration:test-connection-start": "Connection test started",
  "app-registration:test-connection-success": "Connection test completed",
  "app-registration:test-connection-failed": "Connection test failed",

  "onboarding:pairing-token-issued": "Pairing script downloaded",
  "onboarding:paired": "Instance paired with Entra app registration",

  "feature-update-campaign:create": "Feature update campaign created",
  "feature-update-campaign:sync": "Feature update campaigns synced",
  "feature-update-campaign:delete": "Feature update campaign deleted",
  "feature-update-campaign:bulk-delete": "Feature update campaigns bulk-deleted",
  "quality-update-campaign:create": "Quality update campaign created",
  "quality-update-campaign:delete": "Quality update campaign deleted",
  "quality-update-campaign:bulk-delete": "Quality update campaigns bulk-deleted",
  "windows-updates:sync": "Windows Updates synced",

  "user:create": "User added",
  "user:update": "User updated",
  "user:update-role": "User role changed",
  "user:disable": "User disabled",
  "user:enable": "User enabled",
  "user:delete": "User removed",

  "background-access:unavailable": "Background access unavailable",
  "background-access:restored": "Background access restored",
  "user:revoke-background-access": "Background access revoked",

  "ai:chat-message": "AI chat message sent",
  "ai:tool-call-denied": "AI tool call denied",
  "ai:summarize": "AI page summary generated",
  "ai:report-generate": "AI report generated",

  "report:generate": "Report generated",
  "report:download": "Report downloaded",
  "report:delete": "Report deleted",
};

/**
 * Grouping for the page's Action dropdown — a flat forty-odd-item `<select>` is
 * unusable, so it renders as `<optgroup>`s in this order.
 */
export const AUDIT_ACTION_GROUPS: ReadonlyArray<{
  label: string;
  actions: readonly AuditAction[];
}> = [
  {
    label: "Remediation",
    actions: [
      "remediation:dispatch",
      "remediation:fix-all",
      "remediation:retry",
      "remediation:manual-record",
      "remediation:verified",
    ],
  },
  {
    label: "Jobs",
    actions: [
      "job:archive",
      "job:unarchive",
      "job:delete",
      "job:bulk-archive",
      "job:bulk-delete",
      "job:timeout",
      "job:orphan-swept",
      "job:stale-swept",
    ],
  },
  {
    label: "Schedules",
    actions: ["schedule:create", "schedule:update", "schedule:delete", "schedule:fire"],
  },
  {
    label: "Tenants",
    actions: [
      "tenant:set-write-posture",
      "tenant:set-feature-update-target",
      "tenant:set-live-response-device-limit",
      "tenant:discover",
      "tenant:sync",
      "tenant:auto-sync",
      "tenant:resync",
      "posture:snapshot",
    ],
  },
  {
    label: "Catalog",
    actions: [
      "catalog:refresh",
      "catalog:override-create",
      "catalog:override-delete",
      "chocolatey-catalog:refresh",
      "chocolatey-catalog:override-create",
      "chocolatey-catalog:override-delete",
      "script:upload",
      "script:delete",
      "script:archive",
      "script:restore",
      "script:bulk-archive",
      "script:bulk-restore",
      "script:bulk-delete",
    ],
  },
  {
    label: "Access",
    actions: [
      "auth:login-start",
      "auth:login-success",
      "auth:login-failed",
      "auth:login-denied",
      "auth:logout",
      "auth:consent-granted",
      "auth:consent-denied",
      "connection:test",
    ],
  },
  {
    label: "Settings",
    actions: ["setting:update", "entitlement:update", "entitlement:trial-start", "exception:create", "exception:cancel"],
  },
  {
    label: "Devices",
    actions: ["device:exclude", "device:stop-exclusion"],
  },
  {
    label: "Device Groups",
    actions: [
      "device-group:create",
      "device-group:update",
      "device-group:delete",
      "device-group:add-members",
      "device-group:remove-member",
    ],
  },
  {
    label: "Intune apps",
    actions: ["intune-app:create", "intune-app:assign", "intune-app:update"],
  },
  {
    label: "App registration",
    actions: [
      "app-registration:sync-start",
      "app-registration:sync-success",
      "app-registration:sync-failed",
      "custom-domain:created",
      "custom-domain:activated",
      "custom-domain:verify-failed",
      "custom-domain:deleted",
      "app-registration:domain-sync-start",
      "app-registration:domain-sync-success",
      "app-registration:domain-sync-failed",
      "app-registration:test-connection-start",
      "app-registration:test-connection-success",
      "app-registration:test-connection-failed",
    ],
  },
  {
    label: "Onboarding",
    actions: ["onboarding:pairing-token-issued", "onboarding:paired"],
  },
  {
    label: "Feature updates",
    actions: [
      "feature-update-campaign:create",
      "feature-update-campaign:sync",
      "feature-update-campaign:delete",
      "feature-update-campaign:bulk-delete",
    ],
  },
  {
    label: "Quality updates",
    actions: [
      "quality-update-campaign:create",
      "quality-update-campaign:delete",
      "quality-update-campaign:bulk-delete",
    ],
  },
  {
    label: "Windows updates",
    actions: ["windows-updates:sync"],
  },
  {
    label: "Users",
    actions: [
      "user:create",
      "user:update",
      "user:update-role",
      "user:disable",
      "user:enable",
      "user:delete",
    ],
  },
  {
    label: "Background access",
    actions: [
      "background-access:unavailable",
      "background-access:restored",
      "user:revoke-background-access",
    ],
  },
  {
    label: "Reports",
    // "ai:report-generate" sits here rather than under AI: it's the same
    // activity under an older name, and an auditor filtering for report
    // generation wants both sides of the rename in one place.
    actions: ["report:generate", "report:download", "report:delete", "ai:report-generate"],
  },
  {
    label: "AI",
    actions: ["ai:chat-message", "ai:tool-call-denied", "ai:summarize"],
  },
];

/**
 * Fills in `outcome` for rows that never set it explicitly — chiefly the
 * `api_call` tier, where the HTTP status is the only signal there is, and every
 * row written before this column existed.
 *
 * Derived at read time rather than backfilled into the writer, mirroring how
 * recommendation exceptions compute `derivedStatus` server-side.
 */
export function deriveAuditOutcome(
  stored: AuditOutcome | null,
  responseStatus: number | null,
): AuditOutcome | null {
  if (stored) return stored;
  if (responseStatus === null) return null;
  return responseStatus >= 400 ? "failure" : "success";
}

/**
 * Escapes one CSV cell.
 *
 * Two separate concerns, and the order matters:
 *
 * 1. Formula injection. Excel treats a leading `=`, `+`, `-`, `@`, TAB or CR as
 *    the start of a formula, and an audit export is precisely the file someone
 *    opens in Excel. `summary`/`detail`/`resourceLabel` carry Graph-sourced
 *    device hostnames and software titles, so the content is not fully ours.
 *    Prefixing with an apostrophe is the standard neutralisation.
 *
 *    Numbers are exempt, deliberately. A JS number can never be a formula, but
 *    a negative one stringifies to a leading `-` and would be neutralised into
 *    `'-88` — which Excel then imports as text, so the whole column stops
 *    sorting and summing. `sla-compliance.csv`'s "Days remaining" is negative
 *    on every breached row, so this is the common case, not an edge one.
 *    Injection payloads arrive as strings; only strings need the guard.
 * 2. RFC-4180 quoting for commas, quotes and newlines (`detail` can hold a
 *    multi-line failure reason).
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value !== "number" && FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.split('"').join('""')}"`;
  return text;
}

/** Joins pre-escaped cells into a CSV row. CRLF per RFC 4180. */
export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(",") + "\r\n";
}
