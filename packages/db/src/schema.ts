import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  doublePrecision,
  date,
  pgEnum,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";

/**
 * `bytea`, which drizzle-orm 0.38 has no builtin for.
 *
 * Only `dataType()` is needed: `postgres-js` already round-trips a Node
 * `Buffer` to and from a bytea column, so no `toDriver`/`fromDriver` mapping is
 * involved. Used by `reports.pdf` — the only binary column in this schema.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// ---- enums ----
export const severityEnum = pgEnum("severity", ["critical", "high", "medium", "low"]);
export const consentStatusEnum = pgEnum("consent_status", ["consented", "pending", "expired"]);
// Whether PatchPilot can actually call Graph for a tenant, independent of the
// GDAP relationship status. A relationship can be "consented" yet still be
// unreachable (cross-tenant OBO can't redeem there) — this records reality.
export const reachabilityEnum = pgEnum("reachability", [
  "reachable",
  "consent-needed",
  "throttled",
  "unreachable",
  "unknown",
]);
export const complianceEnum = pgEnum("compliance", ["compliant", "noncompliant", "unknown"]);
export const vulnStatusEnum = pgEnum("vuln_status", ["open", "in-progress", "remediated", "dismissed"]);
export const jobStatusEnum = pgEnum("job_status", ["queued", "running", "succeeded", "failed"]);
export const channelEnum = pgEnum("channel", [
  "live-response",
  "intune-remediation",
  "win32-app",
  "expedited-quality-update",
  "winget-app",
  "expedited-feature-update",
]);
export const scriptTypeEnum = pgEnum("script_type", ["powershell", "cmd", "bash"]);
// PatchPilot's own role, independent of GDAP — decides what a signed-in person
// may do inside the console, not which customer tenants they can reach (that's
// still Entra/GDAP). See the permission matrix in packages/shared/src/rbac.ts.
export const userRoleEnum = pgEnum("user_role", ["admin", "technician", "reader"]);
// "pending" is reserved for the future email-invite flow and deliberately not a
// member yet — see the note in packages/shared/src/rbac.ts.
export const userStatusEnum = pgEnum("user_status", ["active", "disabled"]);
export const exceptionScopeEnum = pgEnum("exception_scope", ["global", "device-group"]);
export const exceptionJustificationEnum = pgEnum("exception_justification", [
  "third-party-control",
  "alternate-mitigation",
  "risk-accepted",
  "planned-remediation",
  "cve-no-patch",
  "false-positive",
]);
// "expired" is derived at read time from expiresAt, not stored.
export const exceptionStatusEnum = pgEnum("exception_status", ["active", "cancelled"]);
// Defender's own five device-exclusion justifications, verbatim from the portal
// (Assets > Devices > Exclude). Deliberately its own enum rather than reusing
// exception_justification, whose six values are finding-shaped ("CVE has no
// patch available") and make no sense against a device.
export const deviceExclusionJustificationEnum = pgEnum("device_exclusion_justification", [
  "inactive-device",
  "duplicate-device",
  "device-does-not-exist",
  "out-of-scope",
  "other",
]);
// Audit log tiers. "api_call" is the raw outbound Microsoft traffic recorded
// automatically by graphGet/graphWrite/graphUpload — hundreds of rows per sync.
// "action" is a decision somebody or something made. See the vocabulary in
// packages/shared/src/audit.ts; these three must stay in step with it.
export const auditCategoryEnum = pgEnum("audit_category", ["action", "api_call"]);
export const auditActorTypeEnum = pgEnum("audit_actor_type", [
  "user",
  "system",
  "schedule",
  "worker",
]);
export const auditOutcomeEnum = pgEnum("audit_outcome", [
  "success",
  "failure",
  "partial",
  "skipped",
]);
// "tool" is a tool-call result being fed back to the model, not something a
// person or the model authored — kept distinct from "assistant" so a
// transcript can render/skip it differently. "system" is reserved for a
// future per-conversation system-prompt override; nothing writes it yet.
export const aiMessageRoleEnum = pgEnum("ai_message_role", ["user", "assistant", "tool", "system"]);

// A report's lifecycle: inserted `pending` by the api before it enqueues, moved
// to `rendering` when the worker picks it up, then `ready` or `failed`. Only
// `ready` rows have `pdf` bytes.
export const reportStatusEnum = pgEnum("report_status", [
  "pending",
  "rendering",
  "ready",
  "failed",
]);

// ---- tenants ----
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull().unique(), // Entra tenant GUID
  displayName: text("display_name").notNull(),
  consentStatus: consentStatusEnum("consent_status").notNull().default("pending"),
  // Can PatchPilot actually reach Graph for this tenant? Set by licensing probe.
  reachability: reachabilityEnum("reachability").notNull().default("unknown"),
  readOnly: boolean("read_only").notNull().default(true),
  // Detected licensing -> which channels are enabled. e.g. ["intune","mde-p2"]
  licenses: jsonb("licenses").$type<string[]>().notNull().default([]),
  isMspTenant: boolean("is_msp_tenant").notNull().default(false),
  // When this tenant's operational data (devices + CVEs) was last pulled into
  // PatchPilot by a `/sync/:tenantId/data` run. Null until the first sync — the
  // UI surfaces it so the engineer knows how fresh the data is. Tenant discovery
  // (/sync/tenants) does NOT stamp this; only an actual data sync does.
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  // Friendly Windows feature-update label (e.g. "24H2"), not a raw build number
  // — stays meaningful if packages/shared/src/os.ts's CLIENT_BUILDS gains keys
  // later. Null = use the default (resolveTargetBuild() falls back to
  // latestClientBuild()); a customer's fleet may intentionally lag the latest
  // release, so this can't be a hardcoded constant.
  featureUpdateTargetVersion: text("feature_update_target_version"),
  // The MSP's own slice of PatchPilot's instance-wide Live Response device
  // pool (see entitlement.deviceLicensePool in packages/graph/src/
  // entitlement.ts) — how many distinct devices THIS tenant may ever have
  // dispatched over Live Response. Fail-closed default of 0: an
  // unallocated tenant gets none, the same "nothing until explicitly
  // granted" posture as a fresh instance with no entitlement at all. Set by
  // the MSP's own admin (Settings > Tenants), not by the vendor — the pool
  // total is the vendor's, how it's split across tenants is the MSP's call.
  // The write path (apps/api/src/routes/data.ts) enforces that the sum of
  // every tenant's allocation never exceeds the pool.
  liveResponseDeviceLimit: integer("live_response_device_limit").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- engineers ----
// The provisioned-user list: who may sign in and what PatchPilot role they
// hold. A person must have an active row here before Entra login is honoured
// (see the /auth/callback gate) — GDAP alone is not enough. `upn` is always
// stored lower-cased (Entra UPNs are case-insensitive; a mismatched case here
// would silently lock someone out) and is the join key everywhere else in the
// schema already uses as a bare text attribution column (jobs.engineer,
// auditLog.engineer, etc.) — none of those became FKs here; see the note below.
export const engineers = pgTable("engineers", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Always stored lower-cased by the write path (see users.ts) — Entra UPNs
  // are case-insensitive, and a case mismatch here would silently lock
  // someone out of the login gate.
  upn: text("upn").notNull().unique(),
  displayName: text("display_name").notNull(),
  role: userRoleEnum("role").notNull().default("technician"),
  status: userStatusEnum("status").notNull().default("active"),
  // Entra UPN and mail address diverge often enough (UPN suffix vs. primary
  // SMTP domain) that this can't be derived from `upn`; nullable until the
  // invite-email flow needs it.
  email: text("email"),
  // The UPN of whoever added this row, and when. Free text like every other
  // attribution column in this schema (see packages/shared/src/audit.ts) —
  // not an FK, so it survives the actor being removed later.
  invitedBy: text("invited_by"),
  invitedAt: timestamp("invited_at", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  // Opt-in to job/sync failure emails (see packages/shared/src/alerting.ts).
  // Defaults false because Postgres can't express "true only for admins" as a
  // column default — the two places that create an admin row (users.ts's POST
  // and auth/bootstrap.ts) set this explicitly true instead. Not touched when
  // an existing row is later promoted to admin, so a prior opt-out sticks.
  receiveJobAlerts: boolean("receive_job_alerts").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- devices ----
export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    managedDeviceId: text("managed_device_id").notNull(),
    defenderMachineId: text("defender_machine_id"),
    hostname: text("hostname").notNull(),
    os: text("os").notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }),
    compliance: complianceEnum("compliance").notNull().default("unknown"),
    vulnerabilityCount: integer("vulnerability_count").notNull().default(0),
    owner: text("owner"),
    // Intune hardware inventory (managedDevice.model/manufacturer/serialNumber).
    // Defender exposes none of these reliably, so they come from the Intune sync
    // and are null for Defender-only / unrecognised devices.
    model: text("model"),
    manufacturer: text("manufacturer"),
    serialNumber: text("serial_number"),
    // Defender machine group (rbacGroupId/rbacGroupName from /machines), used to
    // scope "per device group" exceptions (see recommendationExceptions below).
    // Nullable: rides along on the existing /machines fetch, so older synced rows
    // are null until the next sync.
    deviceGroupId: text("device_group_id"),
    deviceGroupName: text("device_group_name"),
    // Raw Windows build number, parsed from Intune's osVersion at sync time
    // (packages/shared/src/os.ts's parseBuild()) — kept alongside the `os`
    // display string so "is this device behind target?" is a cheap numeric
    // comparison instead of re-parsing osVersion on every read. Null for
    // non-Windows devices and rows synced before this column existed.
    osBuild: integer("os_build"),
  },
  (t) => [
    index("devices_tenant_idx").on(t.tenantId),
    // Stable identity for upserts: Intune's managedDeviceId is the durable
    // per-device id, unlike our own `id` which must stay fixed across syncs
    // for anything (jobs, verifications, open UI state) that references a
    // device by row id — see syncDevices() in apps/api/src/graph/sync.ts.
    uniqueIndex("devices_tenant_managed_device_idx").on(t.tenantId, t.managedDeviceId),
  ],
);

// ---- device ⇄ CVE exposure (join table) ----
// Defender reports which machines a CVE affects only transiently during a sync
// (the aggregated `affectedMachineIds`); nothing in the schema persisted that
// linkage, so the device detail panel could not filter CVEs to one device. This
// table materialises it: one row per (tenant, defender machine, CVE, software).
// Defender's finding grain is per-software — the same CVE can affect multiple
// products on one machine (e.g. a Chromium use-after-free hits Edge, Chrome, and
// any CEF-bundling app) — so software is part of the key. The sync
// delete-and-replaces a tenant's rows each run, joining back to `vulnerabilities`
// on (tenantId, cveId, software) at read time to hydrate the per-device CVE list.
export const deviceVulnerabilities = pgTable(
  "device_vulnerabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    // Defender machine id (matches devices.defenderMachineId) — the linkage is
    // only meaningful for Defender-onboarded devices.
    defenderMachineId: text("defender_machine_id").notNull(),
    cveId: text("cve_id").notNull(),
    // The affected software this finding is for — Defender attributes each CVE to
    // a specific product, and one CVE can appear against several. Matches the
    // stored `vulnerabilities.software` so the read-time join is exact.
    software: text("software").notNull(),
    // Per-device detection evidence from Defender's export-assessment surface
    // (SoftwareVulnerabilitiesByMachine): the installed software version and the
    // disk/registry path(s) where the vulnerable product was found — the "how it
    // was detected" the device drill-down surfaces, and the signal used to tell a
    // per-user install (C:\Users\... / HKEY_USERS\...) from a machine-wide one
    // (C:\Program Files\... / HKEY_LOCAL_MACHINE\...) — the case SYSTEM-context
    // winget can't correlate. Nullable: the lighter machinesVulnerabilities
    // fallback and rows predating these columns carry none.
    softwareVersion: text("software_version"),
    diskPaths: jsonb("disk_paths").$type<string[]>(),
    registryPaths: jsonb("registry_paths").$type<string[]>(),
  },
  (t) => [
    index("device_vulns_tenant_machine_idx").on(t.tenantId, t.defenderMachineId),
    uniqueIndex("device_vulns_unique_idx").on(
      t.tenantId,
      t.defenderMachineId,
      t.cveId,
      t.software,
    ),
  ],
);

// ---- vulnerabilities ----
export const vulnerabilities = pgTable(
  "vulnerabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    cveId: text("cve_id").notNull(),
    title: text("title").notNull(),
    severity: severityEnum("severity").notNull(),
    cvss: doublePrecision("cvss"),
    affectedDeviceCount: integer("affected_device_count").notNull().default(0),
    software: text("software").notNull(),
    // Software vendor/publisher (Defender productVendor). Nullable: not every
    // finding reports a vendor, and historical rows predate this column.
    publisher: text("publisher"),
    // Short CVE description (Defender vulnerability description). Nullable for the
    // same reasons — shown in the detail panel when present, omitted otherwise.
    description: text("description"),
    // CVSS v3 vector string (Defender `cvssVector`), e.g.
    // "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H". Nullable — detail panel only.
    cvssVector: text("cvss_vector"),
    // EPSS probability (0..1) that this CVE is exploited in the wild. Nullable.
    epss: doublePrecision("epss"),
    // When the CVE was first published / last updated in Defender's catalog.
    publishedOn: timestamp("published_on", { withTimezone: true }),
    updatedOn: timestamp("updated_on", { withTimezone: true }),
    // Whether Defender flags a known public exploit / exploit kit / verified
    // exploit for this CVE — drives the "Exploit available" threat insight.
    exploitAvailable: boolean("exploit_available").notNull().default(false),
    // Stricter subset of exploitAvailable: Defender has confirmed active
    // exploitation specifically (not just a public PoC or kit). Drives the
    // "verified exploit" Compliance SLA override — see packages/shared/src/sla.ts.
    exploitVerified: boolean("exploit_verified").notNull().default(false),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    // Stamp of the last sync that saw this finding in Defender's data. Distinct
    // from `detectedAt`, which is Defender's *first*-detected and never moves
    // forward. This is what makes a row's absence detectable: after a sync every
    // still-reported row carries that run's timestamp, so anything older is a
    // finding Defender has stopped reporting and the sync prunes it. Nullable
    // because rows written before this column existed were never stamped — they
    // read as "not seen", which is the safe default (the first full sync either
    // re-stamps them or removes them).
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    wingetRemediable: boolean("winget_remediable").notNull().default(false),
    wingetPackageId: text("winget_package_id"),
    status: vulnStatusEnum("status").notNull().default("open"),
  },
  (t) => [
    index("vulns_tenant_idx").on(t.tenantId),
    index("vulns_severity_idx").on(t.severity),
    // A (CVE, software) pair is unique within a tenant — Defender's per-software
    // finding grain, so one CVE that affects multiple products becomes multiple
    // rows. This is the conflict target the live ingestion sync upserts on so it
    // can preserve detectedAt (the SLA clock) and engineer-set status across
    // repeated syncs.
    uniqueIndex("vulns_tenant_cve_idx").on(t.tenantId, t.cveId, t.software),
  ],
);

// ---- cve catalog (shared, tenant-independent per-CVE metadata) ----
// CVE metadata (CVSS, description, EPSS, exploit flags) is global: CVE-2024-1234
// has the same score everywhere. An MSP with 150+ tenants is exposed to a heavily
// overlapping CVE universe (Chrome/Windows/Office are everywhere), so fetching
// `/vulnerabilities/{id}` once per tenant re-pays Defender's ~100-reads/min cap
// 150× for the same facts. This table caches each CVE's detail ONCE across all
// tenants; a sync only fetches CVEs it doesn't already have fresh, so steady-state
// metadata reads approach zero and large fleets stop hitting the throttle ceiling.
export const cveCatalog = pgTable("cve_catalog", {
  // The CVE id (e.g. "CVE-2024-1234"). Global key — not tenant-scoped.
  cveId: text("cve_id").primaryKey(),
  // Mirrors Defender's `/vulnerabilities/{id}` shape so a row reconstructs the
  // same metadata the per-CVE fetch returned. All nullable — best-effort catalog.
  name: text("name"),
  description: text("description"),
  // Raw Defender severity label ("Critical"/"High"/…), mapped at read time.
  severity: text("severity"),
  cvssV3: doublePrecision("cvss_v3"),
  cvssVector: text("cvss_vector"),
  publishedOn: timestamp("published_on", { withTimezone: true }),
  updatedOn: timestamp("updated_on", { withTimezone: true }),
  epss: doublePrecision("epss"),
  publicExploit: boolean("public_exploit").notNull().default(false),
  exploitVerified: boolean("exploit_verified").notNull().default(false),
  exploitInKit: boolean("exploit_in_kit").notNull().default(false),
  // When this row was last refreshed from Defender — the TTL anchor that decides
  // whether a sync re-fetches the CVE or reuses the cached metadata.
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- recommendations (Defender TVM security recommendations) ----
// One row per (tenant, recommendation) — Defender consolidates the many CVEs for
// a single product into one actionable "Update <product>" recommendation. This is
// the consolidated surface that mirrors the Defender portal's Recommendations
// view; the per-CVE `vulnerabilities` table remains the drill-down detail.
export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    // Defender recommendation id (e.g. "va-_-google-_-chrome"). Stable per product.
    recommendationId: text("recommendation_id").notNull(),
    // Human-readable action, e.g. "Update Google Chrome".
    recommendationName: text("recommendation_name").notNull(),
    // Product + vendor the recommendation targets.
    productName: text("product_name").notNull(),
    vendor: text("vendor"),
    // Version Defender recommends upgrading to; null when not applicable.
    recommendedVersion: text("recommended_version"),
    // Worst-case severity bucket Defender assigns the recommendation.
    severity: severityEnum("severity").notNull(),
    // Defender's 0..10 severity score (exposure-weighted); null when unavailable.
    severityScore: doublePrecision("severity_score"),
    // How many distinct CVEs (weaknesses) this recommendation collapses.
    weaknessCount: integer("weakness_count").notNull().default(0),
    // Machines exposed vs. total in scope — drives the affected-device count.
    exposedMachinesCount: integer("exposed_machines_count").notNull().default(0),
    totalMachineCount: integer("total_machine_count").notNull().default(0),
    // Whether any collapsed CVE has a known public exploit.
    publicExploit: boolean("public_exploit").notNull().default(false),
    // Defender remediation type (e.g. "Update", "Uninstall", "ConfigurationChange").
    remediationType: text("remediation_type"),
    // Defender recommendation category (e.g. "Software", "OS", "Security controls").
    category: text("category"),
    // Defender status — "Active", "Exception" or "Resolved". We ingest all three
    // and filter at read time, so a portal-side exception is visible here too.
    recommendationStatus: text("recommendation_status"),
    // ---- Defender portal parity columns ----
    // The portal's Recommendations page shows these on its Vulnerabilities and
    // Misconfigurations tables; PatchPilot mirrors them column-for-column.
    // "Windows10AndAbove", "Linux", … — the portal's "OS platform" column.
    osPlatform: text("os_platform"),
    // Finer-grained grouping under `category` (e.g. "Antivirus", "Firewall").
    subCategory: text("sub_category"),
    // The component the recommendation is really about — the portal's "Related
    // component" column, which for library findings differs from productName
    // (e.g. "OpenSSL" for "Update owning apps: vulnerable OpenSSL libraries").
    relatedComponent: text("related_component"),
    // Exposure-score delta if remediated — the Vulnerabilities table's "Impact".
    exposureImpact: doublePrecision("exposure_impact"),
    // Secure-score delta if remediated — the Misconfigurations table's
    // "Devices Score impact"/"Points achieved".
    configScoreImpact: doublePrecision("config_score_impact"),
    // Whether an active Defender alert references this recommendation — together
    // with associatedThreats this drives the portal's "Threats" column.
    activeAlert: boolean("active_alert").notNull().default(false),
    // Threat-analytics report ids Defender associates with the recommendation.
    associatedThreats: jsonb("associated_threats").$type<string[]>().notNull().default([]),
    // SLA clock anchor, preserved across syncs like vulnerabilities.detectedAt.
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    status: vulnStatusEnum("status").notNull().default("open"),
  },
  (t) => [
    index("recs_tenant_idx").on(t.tenantId),
    index("recs_severity_idx").on(t.severity),
    // Upsert conflict target: a recommendation is unique within a tenant, so the
    // sync can preserve detectedAt (SLA clock) and engineer-set status.
    uniqueIndex("recs_tenant_rec_idx").on(t.tenantId, t.recommendationId),
  ],
);

// ---- remediation events (detected -> remediated history) ----
// vulnerabilities/recommendations never carry a "remediated" timestamp — when
// Defender stops reporting a finding, the sync prunes (hard-deletes) the row
// rather than moving it to a resolved state (see the prune comments in
// graph/sync.ts). This table is what makes that moment durable: each prune site
// writes one row here — carrying the row's `detectedAt` (already the SLA clock
// anchor) and the prune's `remediatedAt` — right before deleting it, so
// "average time to remediate" has real detected->remediated pairs to average
// over. No FK back to vulnerabilities/recommendations: the source row is gone
// by the time this is written, same free-standing posture as
// manualRemediations below.
//
// Caveat (documented, not solved here): a prune doesn't always mean a genuine
// fix — e.g. a winget-matcher correction can insert a corrected row beside a
// stale one, and the prune of the stale row records a false "remediated" event
// here. This is pre-existing noise in the prune signal, not something this
// table introduces.
export const remediationKindEnum = pgEnum("remediation_event_kind", ["vulnerability", "recommendation"]);

// How a closed finding was matched back to the work that (probably) closed it.
// "job" — a succeeded PatchPilot job for the same tenant/CVE/software closed it.
// "manual" — an engineer's manual_remediations record was confirmed for it.
// "unattributed" — neither matched: some other actor (Autopatch, WSUS, the end
// user, a Defender re-scan) closed it, or the closing job predates attribution
// existing. Still a real remediation — the finding was genuinely open for
// detectedAt..remediatedAt — just one PatchPilot can't take credit for.
export const remediationAttributionEnum = pgEnum("remediation_attribution", [
  "job",
  "manual",
  "unattributed",
]);
// "cleared" — Defender stopped reporting the finding because it was actually
// fixed. "reclassified" — a winget-matcher correction inserted a corrected row
// beside this one (same CVE, different `software`) and this stale row was
// pruned as a side effect; nothing was fixed, so this must not count toward
// time-to-remediate. See the prune-site comments below for why this happens.
export const remediationClosureEnum = pgEnum("remediation_closure", ["cleared", "reclassified"]);

export const remediationEvents = pgTable(
  "remediation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kind: remediationKindEnum("kind").notNull(),
    // set when kind = "vulnerability"
    cveId: text("cve_id"),
    // set when kind = "recommendation"
    recommendationId: text("recommendation_id"),
    software: text("software"),
    severity: severityEnum("severity").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    // Precision(3) to match audit_log.at (see the comment there): every value
    // written here comes from a JS Date, which only carries milliseconds, but
    // Postgres timestamptz defaults to microsecond precision. A keyset cursor
    // over this column round-trips the ISO string, so a row whose microsecond
    // remainder is non-zero would silently sort on the wrong side of its own
    // page boundary and get skipped — pinning precision(3) keeps the stored
    // value and the value the cursor can express identical.
    remediatedAt: timestamp("remediated_at", { withTimezone: true, precision: 3 }).notNull(),

    // ---- attribution (who/what closed it, and how) ----
    // The device the attributed job/manual-record ran against. No FK — devices
    // are re-synced/pruned independently, and this table is a permanent record
    // that must outlive the device row.
    deviceId: uuid("device_id"),
    // Snapshot, same reasoning as jobs.deviceHostname above: survives a device
    // rename or removal so this row keeps reading correctly.
    deviceHostname: text("device_hostname"),
    // UPN of the engineer who ran the job/manual fix, or a system:<component>
    // sentinel — same contract as jobs.engineer / audit_log.engineer. Null when
    // attribution is "unattributed".
    engineer: text("engineer"),
    // The job that (most likely) closed this finding. No FK — jobs are
    // deletable and this row must survive that.
    jobId: uuid("job_id"),
    channel: channelEnum("channel"),
    attribution: remediationAttributionEnum("attribution").notNull().default("unattributed"),
    // The work clock: when the fix itself started/finished (job dispatch/finish,
    // or the manual record's markedAt for both). Distinct from detectedAt/
    // remediatedAt, which are the exposure clock (Defender's view). Null
    // together when attribution is "unattributed" — there is no fix to time.
    fixStartedAt: timestamp("fix_started_at", { withTimezone: true }),
    fixFinishedAt: timestamp("fix_finished_at", { withTimezone: true }),
    // How many succeeded jobs plausibly contributed to closing this finding —
    // a Defender finding spans every exposed machine, so more than one device's
    // job can close the same (CVE, software) pair in one tenant. `jobId`/
    // `deviceId` above record only the one attribution was anchored to.
    contributingJobs: integer("contributing_jobs").notNull().default(0),
    closure: remediationClosureEnum("closure").notNull().default("cleared"),
  },
  (t) => [
    index("remediation_events_tenant_remediated_idx").on(t.tenantId, t.remediatedAt),
    index("remediation_events_tenant_severity_idx").on(t.tenantId, t.severity),
    index("remediation_events_tenant_cve_idx").on(t.tenantId, t.cveId),
    index("remediation_events_tenant_device_idx").on(t.tenantId, t.deviceId),
    index("remediation_events_engineer_idx").on(t.engineer),
  ],
);

// ---- recommendation exceptions (local-only tracking) ----
// Defender exceptions have no public write API ("Exceptions are currently only
// supported in the Microsoft Defender portal, and not via public API." — MS
// Learn). PatchPilot therefore records the engineer's intent locally: the
// engineer still applies the matching exception by hand in the Defender portal,
// and this row is what PatchPilot's own views filter against (hidden by default,
// revealable via a status filter). Scoped to either a whole recommendation
// (recommendationId set) or a single CVE (cveId set); scope is either tenant-wide
// ("global") or a set of Defender device groups (deviceGroupIds, matched against
// devices.deviceGroupId). "expired" isn't a stored state — it's derived at read
// time by comparing expiresAt to now, since nothing needs to run to "expire" a row.
export const recommendationExceptions = pgTable(
  "recommendation_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    recommendationId: text("recommendation_id"),
    cveId: text("cve_id"),
    scope: exceptionScopeEnum("scope").notNull(),
    deviceGroupIds: jsonb("device_group_ids").$type<string[]>().notNull().default([]),
    justification: exceptionJustificationEnum("justification").notNull(),
    notes: text("notes"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: exceptionStatusEnum("status").notNull().default("active"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [index("rec_exceptions_tenant_idx").on(t.tenantId)],
);

// ---- device exclusions (local-only tracking) ----
// The device-level sibling of recommendationExceptions above, mirroring the
// Defender portal's "Exclude device" action (Assets > Devices > Exclude). Same
// constraint applies: Defender exposes no write API for exclusion — PATCH
// /api/machines/{id} can only set machineTags and deviceValue, and no machine
// action excludes — so the engineer still excludes by hand in the portal and
// this row is what PatchPilot's own views filter against.
//
// Two deliberate differences from recommendationExceptions:
//
//  1. Keyed on `managedDeviceId`, NOT devices.id. syncDevices() hard-deletes any
//     device Intune stops returning, so a uuid reference would be orphaned in
//     exactly the "device doesn't exist" / "duplicate device" cases this feature
//     exists to handle. (tenantId, managedDeviceId) is the durable identity —
//     it's already the upsert conflict target in syncDevices.
//  2. `expiresAt` is nullable: null means "never", matching Defender, where an
//     exclusion has no expiry. An optional review date is still supported, and
//     "expired" stays derived at read time rather than stored.
//
// Defender's own exclusion state (DeviceInfo.IsExcluded / ExclusionReason) is
// readable, but only through Advanced Hunting, which would need a new
// ThreatHunting.Read.All consent scope and is P2/E5-only — see the note in
// apps/api/src/routes/device-exclusions.ts. Not mirrored today.
export const deviceExclusions = pgTable(
  "device_exclusions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    managedDeviceId: text("managed_device_id").notNull(),
    // Snapshot so the exclusion list and the audit log still name the device
    // after its `devices` row is gone — same reason jobs carries deviceHostname.
    deviceHostname: text("device_hostname").notNull(),
    justification: deviceExclusionJustificationEnum("justification").notNull(),
    notes: text("notes"),
    // Null = never expires (Defender parity). A date makes it a review deadline.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: exceptionStatusEnum("status").notNull().default("active"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [
    index("device_exclusions_tenant_idx").on(t.tenantId),
    // Lookup key for "is this device excluded?". Not unique: cancelled rows are
    // kept as history, and re-excluding a device cancels the old row and writes
    // a new one (Defender: "the new justification overrides previous values").
    // "At most one *active* row per device" is enforced in the create route.
    index("device_exclusions_tenant_device_idx").on(t.tenantId, t.managedDeviceId),
  ],
);

// ---- device groups (PatchPilot-native, local-only) ----
// Unlike devices.deviceGroupId/deviceGroupName (Defender's own read-only RBAC
// machine group, synced in from /machines), this is an engineer-curated group
// created and managed entirely inside PatchPilot — used to scope recurring
// schedule fan-out to a subset of the tenant's devices. Flat membership only,
// no nested groups.
export const deviceGroups = pgTable(
  "device_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("device_groups_tenant_idx").on(t.tenantId),
    uniqueIndex("device_groups_tenant_name_idx").on(t.tenantId, t.name),
  ],
);

// Membership join table. Keyed on `managedDeviceId`, NOT devices.id, for the
// same reason as deviceExclusions above: syncDevices() hard-deletes/upserts
// device rows every sync, so a uuid FK would orphan. deviceHostname is a
// snapshot so the members list still renders a name mid-sync-gap.
export const deviceGroupMembers = pgTable(
  "device_group_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceGroupId: uuid("device_group_id").notNull(),
    managedDeviceId: text("managed_device_id").notNull(),
    deviceHostname: text("device_hostname").notNull(),
    addedBy: text("added_by").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("device_group_members_group_idx").on(t.deviceGroupId),
    uniqueIndex("device_group_members_unique_idx").on(t.deviceGroupId, t.managedDeviceId),
  ],
);

// ---- software inventory (Defender "Inventories > Software", aggregate) ----
// Defender's Software Inventory (/api/software) lists every product it sees
// installed anywhere in the fleet, independent of whether TVM runs CVE/weakness
// matching against it — the "Nvidia App has an outdated bundled OpenSSL but
// Defender can't tell you that" case. One row per (tenant, Defender software id).
// weaknessCount/exposedMachinesCount/publicExploit mirror what Defender itself
// reports (0 when Defender has no weakness data, which is the whole point of the
// page); matchedPackageId/matchedPackageSource/matchedLatestVersion are
// PatchPilot's own addition — the winget/Chocolatey catalog match resolved from
// the software's name, so the page can offer "Fix Now" even when Defender has no
// recommendation for it. context summarises the per-device evidence in
// deviceSoftware for the list view ("user"/"machine"/"mixed"/"unknown"); the
// per-device drill-down recomputes it exactly via detectInstallScope.
export const softwareInventory = pgTable(
  "software_inventory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    // Defender's software id (e.g. "nvidia-_-app"). Stable per product.
    softwareId: text("software_id").notNull(),
    name: text("name").notNull(),
    vendor: text("vendor"),
    // Defender's own weakness/exposure counts — zero for software Defender
    // detects but doesn't run CVE matching against.
    weaknessCount: integer("weakness_count").notNull().default(0),
    exposedMachinesCount: integer("exposed_machines_count").notNull().default(0),
    installedMachinesCount: integer("installed_machines_count").notNull().default(0),
    publicExploit: boolean("public_exploit").notNull().default(false),
    // Summary across this software's deviceSoftware rows: "user" | "machine" |
    // "mixed" | "unknown". Computed at sync time from detectInstallScope.
    context: text("context"),
    // PatchPilot's catalog match, resolved from `name` the same way winget
    // findings resolve from a vulnerability's software title.
    matchedPackageId: text("matched_package_id"),
    matchedPackageSource: text("matched_package_source"), // "winget" | "chocolatey"
    matchedLatestVersion: text("matched_latest_version"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    // Same prune-detection pattern as vulnerabilities.lastSeenAt.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [
    index("software_inventory_tenant_idx").on(t.tenantId),
    uniqueIndex("software_inventory_tenant_software_idx").on(t.tenantId, t.softwareId),
  ],
);

// ---- device ⇄ software (join table, per-device installed software) ----
// Defender's /api/machines/{id}/software per-device detail, materialised the
// same way deviceVulnerabilities materialises per-device CVE findings — one row
// per (tenant, Defender machine, software), carrying the installed version and
// the disk/registry paths that drive Context (User/SYSTEM) detection via the
// existing detectInstallScope, exactly like deviceVulnerabilities does.
export const deviceSoftware = pgTable(
  "device_software",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    defenderMachineId: text("defender_machine_id").notNull(),
    softwareId: text("software_id").notNull(),
    name: text("name").notNull(),
    vendor: text("vendor"),
    version: text("version"),
    diskPaths: jsonb("disk_paths").$type<string[]>(),
    registryPaths: jsonb("registry_paths").$type<string[]>(),
  },
  (t) => [
    index("device_software_tenant_machine_idx").on(t.tenantId, t.defenderMachineId),
    uniqueIndex("device_software_unique_idx").on(t.tenantId, t.defenderMachineId, t.softwareId),
  ],
);

// ---- missing KBs (Defender per-device getmissingkbs, OS quality/security updates) ----
// Defender's Missing KBs surface (api/machines/{id}/getmissingkbs) lists the specific
// Windows Update KBs a device is missing — this is what "By OS" / "Missing KBs" is
// built from, distinct from the OS-level recommendation rows in `recommendations`
// (which are per-tenant/product, not per-device/KB). One row per (tenant, device, KB);
// `kbId` is Defender's `id` field, used unmodified as the join key into Intune's
// windowsQualityUpdateCatalogItem.kbArticleId when dispatching Expedited Quality Update.
export const missingKbs = pgTable(
  "missing_kbs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    kbId: text("kb_id").notNull(),
    title: text("title").notNull(),
    products: jsonb("products").$type<string[]>().notNull().default([]),
    cveCount: integer("cve_count").notNull().default(0),
    cveIds: jsonb("cve_ids").$type<string[]>().notNull().default([]),
    url: text("url"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("missing_kbs_tenant_device_idx").on(t.tenantId, t.deviceId),
    uniqueIndex("missing_kbs_unique_idx").on(t.deviceId, t.kbId),
  ],
);

// ---- winget catalog (MDVM software title -> winget package id) ----
export const wingetCatalog = pgTable("winget_catalog", {
  id: uuid("id").primaryKey().defaultRandom(),
  packageId: text("package_id").notNull().unique(),
  name: text("name").notNull(),
  publisher: text("publisher").notNull(),
  latestVersion: text("latest_version"),
  // The MDVM software title this package maps to.
  softwareTitle: text("software_title"),
  // Provenance of the row: "winget-mirror" for entries ingested from winget's
  // pre-indexed source catalog, "curated" for hand-authored title mappings.
  // Null on rows that predate Phase 5. Preserved across mirror refreshes so a
  // curated mapping is never silently relabelled.
  source: text("source"),
  // When this row's package facts (name/publisher/latestVersion) were last
  // refreshed from the winget mirror. Null until the first refresh / for curated
  // rows. Drives the Catalog page's freshness indicator and the refresh TTL.
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
});

// ---- winget catalog overrides (engineer-authored title -> package mappings) ----
// A manual escape hatch over the fuzzy matcher: when an engineer knows a Defender
// software title should drive a specific winget package, they pin it here. The
// matcher consults overrides FIRST (method "manual", confidence 1.0) so a curated
// human decision always beats the heuristics. A null tenantId is a global override
// applied to every tenant; a tenant-scoped row overrides the global for that one
// tenant. Title matching uses the same shared normaliser as the fuzzy matcher, so
// version/architecture noise in the stored title doesn't defeat the pin.
export const wingetCatalogOverride = pgTable(
  "winget_catalog_override",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Null = global (all tenants). Otherwise the Entra tenantId this applies to.
    tenantId: text("tenant_id"),
    // The MDVM software title to pin (matched normalised, like the fuzzy matcher).
    softwareTitle: text("software_title").notNull(),
    // The winget package id this title resolves to.
    packageId: text("package_id").notNull(),
    // UPN of the engineer who authored the mapping (audit trail).
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("winget_override_tenant_idx").on(t.tenantId, t.softwareTitle)],
);

// ---- chocolatey catalog (software title -> chocolatey package id) ----
// User-context counterpart to wingetCatalog: PatchPilot maps a per-user install
// (winget can't correlate a per-user context reliably, per detectInstallScope's
// own doc comment) to a Chocolatey package instead. Same shape, same matching
// contract as winget — matchChocolatey mirrors matchWinget exactly.
export const chocolateyCatalog = pgTable("chocolatey_catalog", {
  id: uuid("id").primaryKey().defaultRandom(),
  packageId: text("package_id").notNull().unique(),
  name: text("name").notNull(),
  publisher: text("publisher").notNull(),
  latestVersion: text("latest_version"),
  // The MDVM/software-inventory title this package maps to.
  softwareTitle: text("software_title"),
  // Provenance: "chocolatey-mirror" for entries ingested from the Chocolatey
  // community feed, "curated" for hand-authored title mappings.
  source: text("source"),
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
});

// ---- chocolatey catalog overrides (engineer-authored title -> package mappings) ----
// Manual escape hatch, identical contract to wingetCatalogOverride: overrides are
// consulted first (method "manual", confidence 1.0), tenant-scoped beats global.
export const chocolateyCatalogOverride = pgTable(
  "chocolatey_catalog_override",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id"),
    softwareTitle: text("software_title").notNull(),
    packageId: text("package_id").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chocolatey_override_tenant_idx").on(t.tenantId, t.softwareTitle)],
);

// ---- jobs ----
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id"),
    cveId: text("cve_id"),
    // Missing-KB Fix Now dispatches (Expedited Quality Update / Live Response OS
    // remediation) carry the Defender KB id here instead of a cveId — the two are
    // mutually exclusive per job, mirroring how the executor branches on channel.
    kbId: text("kb_id"),
    // expedited-feature-update dispatches carry the target version label here
    // (e.g. "24H2") instead of a kbId/cveId — mutually exclusive per job, same
    // convention as kbId above.
    featureUpdateVersion: text("feature_update_version"),
    channel: channelEnum("channel").notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    engineer: text("engineer").notNull(),
    exitCode: integer("exit_code"),
    output: text("output"),
    // Snapshots taken at dispatch time so the Jobs page keeps an accurate
    // historical record even after the device is renamed/removed or the
    // vulnerability's `software` label is superseded by a later sync — both of
    // which the page previously reconstructed live from /api/devices and
    // /api/vulnerabilities, so a rename or resync silently rewrote history.
    // `software` is the disk-path-resolved display name (e.g. "Google Chrome"
    // vs "Microsoft Edge (Chromium-based)"), not the raw ambiguous DB literal.
    software: text("software"),
    deviceHostname: text("device_hostname"),
    // Deployable script + the queue-payload params it was built from, persisted
    // (previously queue-payload-only) so a failed job can be resubmitted as-is
    // via the Jobs page's Retry action without re-deriving them. Null on jobs
    // created before this column existed — those aren't retryable.
    script: text("script"),
    packageId: text("package_id"),
    installScope: text("install_scope"),
    action: text("action"),
    source: text("source"),
    altPackageId: text("alt_package_id"),
    // BullMQ job id, for correlation with the worker queue.
    queueJobId: text("queue_job_id"),
    // Shared by every job created from one multi-device dispatch (a schedule
    // fire, a Fix All, or a multi-device Run Now) so the Jobs page can group
    // them under one row. Null for single-device dispatches. No FK — same
    // soft-attribution style as `engineer`.
    batchId: uuid("batch_id"),
    // Set only when the job came from a recurring schedule's fan-out, linking
    // it back to the schedule that fired it (previously unrecoverable except
    // by heuristic). No FK, so deleting a schedule doesn't orphan-block its
    // historical jobs.
    scheduleId: uuid("schedule_id"),
    // Additional CVE ids this one job also remediates, beyond the primary
    // `cveId` — set when the scheduler's fan-out consolidates several open
    // CVEs against the same (device, software) into a single dispatch instead
    // of one job per CVE (see fanOutSchedule). Null/absent means "just the
    // primary cveId", the pre-existing 1:1 shape. Attribution matching
    // (graph/attribution.ts, post-remediation.ts backfillRemediationAttribution)
    // checks this alongside `cveId` so every consolidated CVE still closes out
    // correctly in Remediation History, not just the primary one.
    coveredCveIds: jsonb("covered_cve_ids").$type<string[]>(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    // When set, the job is deferred (BullMQ delay) until this time; the 2-hour
    // stale-job sweep measures from this instant instead of queuedAt so a job
    // scheduled days out isn't timed out before its turn ever comes.
    scheduleAt: timestamp("schedule_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_tenant_idx").on(t.tenantId),
    index("jobs_status_idx").on(t.status),
    index("jobs_batch_idx").on(t.batchId),
    index("jobs_schedule_idx").on(t.scheduleId),
  ],
);

// ---- schedules ----
export const schedules = pgTable("schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  // cron expression driving the BullMQ repeatable job.
  cron: text("cron").notNull(),
  channel: channelEnum("channel").notNull(),
  // Dynamic device group / target descriptor.
  target: jsonb("target").$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  // Engineer (UPN) the recurring run is attributed to. A scheduled fire mints a
  // delegated token under THIS engineer's GDAP/OBO identity at execution time, so
  // every job a schedule fans out carries the creating engineer's authority and
  // shows up in the audit log under them. Nullable: rows created before this
  // column have no owner, and the worker skips firing those rather than guessing.
  engineer: text("engineer"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- audit log (every Graph call, and every action taken in PatchPilot) ----
// Started life as a Microsoft-API-call log, which is why the first block of
// columns is HTTP-shaped. The second block generalises it to domain events so
// the same table answers "what did we do to this tenant, and who decided it?"
// — including for background work, which has no engineer behind it.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id"),
    // Either a real engineer UPN or one of the reserved `system:<component>`
    // sentinels (SYSTEM_ACTORS in @patchpilot/shared). Deliberately still NOT
    // NULL: the sentinel namespace can't collide with a UPN, so background
    // actors get an identity without a breaking nullability change. actorType
    // below says which kind this is.
    engineer: text("engineer").notNull(),
    endpoint: text("endpoint").notNull(),
    method: text("method").notNull(),
    // We store a hash of the payload, never the raw payload (may contain PII).
    payloadHash: text("payload_hash"),
    responseStatus: integer("response_status"),
    latencyMs: integer("latency_ms"),

    // ---- domain-event columns ----
    category: auditCategoryEnum("category").notNull().default("api_call"),
    actorType: auditActorTypeEnum("actor_type").notNull().default("user"),
    // Canonical noun:verb from AUDIT_ACTIONS. Null on api_call rows and on
    // every row written before these columns existed.
    action: text("action"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    // Denormalised display name ("Google Chrome", "Contoso Ltd") so rendering
    // the log needs no joins — and so a deleted job still reads meaningfully.
    resourceLabel: text("resource_label"),
    // Human sentence, capped in the writer.
    summary: text("summary"),
    // Nullable; derived from responseStatus at read time when absent.
    outcome: auditOutcomeEnum("outcome"),
    // Short reason / error text. Bounded in the writer — never a payload.
    detail: text("detail"),

    // Millisecond precision, deliberately. `defaultNow()` is Postgres now(),
    // which stores microseconds — but a JS Date (and so every `at` the API
    // emits) only carries milliseconds. That mismatch silently breaks the
    // keyset cursor: the cursor round-trips a truncated `at`, so a row whose
    // microsecond remainder is non-zero sorts on the wrong side of its own
    // page boundary and is skipped. Pinning precision(3) makes the stored
    // value and the value the cursor can express identical.
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_tenant_idx").on(t.tenantId),
    index("audit_at_idx").on(t.at),
    // The hot path: the page's default view is category='action' ORDER BY at DESC.
    index("audit_category_at_idx").on(t.category, t.at),
    index("audit_tenant_at_idx").on(t.tenantId, t.at),
    index("audit_action_idx").on(t.action),
    index("audit_engineer_idx").on(t.engineer),
    index("audit_resource_idx").on(t.resourceType, t.resourceId),
  ],
);

// ---- resync requests (post-remediation catch-up syncs) ----
// Defender's software inventory refreshes on its own 3-4 hour cadence and Microsoft
// exposes no way to force it, so a device can be patched long before Defender stops
// reporting the finding. The hourly auto-sync would eventually notice, but adds up
// to another hour of lag on top. After a successful remediation the worker drops a
// few rows here (+30m/+2h/+4h/+6h) and the API drains them on a fast timer, so
// PatchPilot picks up the clearing as soon as Defender publishes it.
//
// The worker can't sync directly — all auth/token/Graph wiring lives in the API
// process — so this table is the transport between the two.
export const resyncRequests = pgTable(
  "resync_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    // When the sync should run. The drain picks up anything at or before now.
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    // What asked for it, for diagnostics — e.g. "job:<uuid>".
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("resync_due_idx").on(t.dueAt)],
);

// ---- remediation verifications (fixed on device, awaiting Defender) ----
// The remediation script reports the versions it saw either side of the upgrade
// ("Google.Chrome upgraded '150.0.7871.184' -> '150.0.7871.187'"), which is direct
// evidence from the device itself — hours ahead of Defender's inventory refresh.
// Recording it lets the UI say "fixed on device, Defender refresh pending" instead
// of leaving a stale finding looking untouched. Defender stays the source of truth
// for whether a finding exists; this only annotates the gap.
export const remediationVerifications = pgTable(
  "remediation_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    // The job whose transcript this came from (audit trail). Nullable so a row
    // outlives job archival rather than being lost with it.
    jobId: uuid("job_id"),
    // Winget package id that was upgraded — the join key back to
    // vulnerabilities.winget_package_id.
    packageId: text("package_id").notNull(),
    // MDVM software title of the finding that triggered the job, when known. A
    // second join key for findings whose winget mapping is absent.
    software: text("software"),
    cveId: text("cve_id"),
    // Versions the script observed. Nullable: the upgrade may be verified without
    // a parseable "before" (fresh install) and we keep the row either way.
    versionBefore: text("version_before"),
    versionAfter: text("version_after"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("remediation_verif_device_idx").on(t.tenantId, t.deviceId),
    index("remediation_verif_at_idx").on(t.verifiedAt),
  ],
);

// ---- settings (single-row key/value: branding, SLA thresholds) ----
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- update runs (Settings -> Updates: self-update sidecar hand-off) ----
// A dedicated table, not a `settings` blob field: the updater sidecar's poll
// needs `FOR UPDATE SKIP LOCKED` row-claiming semantics a JSON blob can't
// give it, and a run history (what got triggered, when, by whom, with what
// output) is exactly what `jobs` already models as a table elsewhere in this
// schema. The "is a newer version available" side of the feature lives in
// `settings` under the "updates" key instead — that part genuinely is
// single-current-value config, same as "smtp"/"entitlement".
export const updateRuns = pgTable(
  "update_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Git tag to check out, e.g. "v0.2.0".
    targetVersion: text("target_version").notNull(),
    // What was actually running when this row was created — same
    // snapshot-at-creation-time convention as jobs.software/deviceHostname.
    // Lets the UI/audit distinguish a forward update from a rollback
    // (targetVersion < fromVersion) without re-deriving it from CURRENT_VERSION,
    // which changes across restarts. Null on rows created before this column
    // existed — those just fall back to the target-only display.
    fromVersion: text("from_version"),
    status: jobStatusEnum("status").notNull().default("queued"),
    // Engineer (UPN) who triggered this run. No FK — same soft-attribution
    // style as jobs.engineer/auditLog.engineer.
    triggeredBy: text("triggered_by").notNull(),
    // When the updater sidecar may claim this row. "Run now" sets this to the
    // insert time; "Schedule" sets it to the chosen future instant.
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // Captured git/docker compose stdout+stderr from the updater sidecar,
    // bounded there before it's written back.
    output: text("output"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("update_runs_status_idx").on(t.status),
    index("update_runs_scheduled_idx").on(t.scheduledAt),
  ],
);

// ---- custom domains (Setup -> App Registration "Custom domain" section) ----
// One row per additional hostname this instance should accept logins/OAuth
// callbacks on, on top of the deploy-time PUBLIC_URL. "subdomain" rows are a
// <label>.patchpilot365.com hostname living in PatchPilot's own DNS zone —
// PatchPilot Support creates that record manually (support@patchpilot365.com); "custom" rows are
// a hostname the customer owns, pointed at this instance via a CNAME they
// create themselves. Neither path ever calls a DNS provider's API to CREATE a
// record — activation (see routes/domains.ts's verify handler) is always
// gated on a live, read-only CNAME lookup, which is the one thing both paths
// share. Not tenant-scoped: one instance = one MSP, like `settings` above.
export const domainTypeEnum = pgEnum("domain_type", ["subdomain", "custom"]);
export const domainStatusEnum = pgEnum("domain_status", ["pending", "active"]);

export const customDomains = pgTable(
  "custom_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostname: text("hostname").notNull(),
    type: domainTypeEnum("type").notNull(),
    status: domainStatusEnum("status").notNull().default("pending"),
    // Snapshot of the CNAME target (host of config.PUBLIC_URL) at creation
    // time, so an old row's instructions stay self-consistent even if
    // PUBLIC_URL is later changed.
    cnameTarget: text("cname_target").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastCheckError: text("last_check_error"),
  },
  (t) => [uniqueIndex("custom_domains_hostname_idx").on(t.hostname)],
);

// ---- manual remediations (Remediation Options "Manual -> record" sub-flow) ----
// An engineer's free-text record that a finding was fixed by hand outside any
// PatchPilot channel — no script, no Graph call, no job row. Tracked as "waiting
// on Defender" until the next sync stops reporting the CVE on this device, at
// which point the prune step in graph/sync.ts stamps confirmedAt, mirroring the
// remediationVerifications "fixed on device, awaiting Defender" pattern above.
export const manualRemediations = pgTable(
  "manual_remediations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    cveId: text("cve_id"),
    software: text("software").notNull(),
    notes: text("notes").notNull(),
    engineer: text("engineer").notNull(),
    markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => [index("manual_remediations_tenant_device_idx").on(t.tenantId, t.deviceId)],
);

// ---- script catalog (engineer-uploaded scripts, Intune-remediation-only preview) ----
// Not a mirrored repo like winget/chocolatey — these are hand-authored by an
// engineer and dispatched only via the intune-remediation channel today. A null
// tenantId is a global script, mirroring wingetCatalogOverride's convention.
export const scriptCatalog = pgTable(
  "script_catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    description: text("description"),
    // Organisational only today: Intune deviceHealthScripts accepts PowerShell
    // alone, so cmd/bash entries are catalogued but not dispatchable. The
    // default is correct for every pre-existing row — the upload form only ever
    // offered a textarea labelled "PowerShell script".
    scriptType: scriptTypeEnum("script_type").notNull().default("powershell"),
    scriptContent: text("script_content").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Soft-hide, same contract as jobs.archivedAt: a script referenced by past
    // jobs shouldn't have to be destroyed to get it out of the way.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("script_catalog_tenant_idx").on(t.tenantId)],
);

// ---- posture snapshots (the Dashboard's trend history) ----
// The only table in this schema that retains history. Every other posture table
// is current-state — devices and vulnerabilities are upserted or pruned on each
// sync, so yesterday's numbers are simply gone. Without this, a trend chart
// would have nothing to plot but the present.
//
// Every count here is POST-filter: findings covered by an active recommendation
// exception, and devices covered by an exclusion, are already subtracted. A
// snapshot is meant to be the history of what the Dashboard actually displayed
// that day, so it goes through the same helpers the read routes use rather than
// counting raw rows.
//
// `day` is a real `date` column, which makes "one row per tenant per day" a
// unique index the upsert targets instead of an application convention.
export const postureSnapshots = pgTable(
  "posture_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    day: date("day").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    // Which path wrote this row: the daily timer, a just-finished sync, or a
    // manual/backfill capture. Kept so a suspicious point can be traced back.
    source: text("source").notNull(),

    devices: integer("devices").notNull(),
    devicesCompliant: integer("devices_compliant").notNull(),
    devicesNoncompliant: integer("devices_noncompliant").notNull(),
    devicesUnknown: integer("devices_unknown").notNull(),

    openFindings: integer("open_findings").notNull(),
    critical: integer("critical").notNull(),
    high: integer("high").notNull(),
    medium: integer("medium").notNull(),
    low: integer("low").notNull(),

    slaBreached: integer("sla_breached").notNull(),
    slaDueSoon: integer("sla_due_soon").notNull(),
    slaOk: integer("sla_ok").notNull(),
    // The thresholds in force at capture time, frozen. Without this, editing the
    // SLA in Settings would silently re-interpret every historical point.
    slaThresholds: jsonb("sla_thresholds").$type<Record<string, number>>().notNull(),

    softwareCovered: integer("software_covered").notNull(),
    softwareUncovered: integer("software_uncovered").notNull(),
    softwareOs: integer("software_os").notNull(),

    jobsSucceeded: integer("jobs_succeeded").notNull(),
    jobsFailed: integer("jobs_failed").notNull(),
  },
  (t) => [
    uniqueIndex("posture_snapshots_tenant_day_idx").on(t.tenantId, t.day),
    index("posture_snapshots_day_idx").on(t.day),
  ],
);

// ---- AI chat (conversations + messages) ----
// `engineer` is a UPN, not an `engineers.id` FK — same attribution convention
// as jobs.engineer / auditLog.engineer / manualRemediations.engineer (see the
// note on the engineers table above): free text so a conversation survives the
// owning engineer being removed later, and ownership is just an equality check
// in the route layer, not a join.
export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engineer: text("engineer").notNull(),
    // Null = cross-tenant scope ("All Tenants" in the chat widget). Not an FK
    // to tenants.id — every other tenant-scoped column in this schema stores
    // the Entra tenant GUID as free text, matched against tenants.tenant_id.
    tenantId: text("tenant_id"),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Soft-hide, same contract as jobs.archivedAt / scriptCatalog.archivedAt.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("ai_conversations_engineer_idx").on(t.engineer, t.createdAt)],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Not an FK — this schema doesn't use them (see engineers table note); the
    // route layer deletes/orphans messages explicitly if a conversation is ever
    // hard-deleted, same discipline as every other parent/child pair here.
    conversationId: uuid("conversation_id").notNull(),
    role: aiMessageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    // Which tools this message's turn invoked and with what args — the
    // per-message accountability trail. Empty for plain user/assistant text.
    toolCalls: jsonb("tool_calls").$type<{ name: string; args: unknown }[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

// ---- generated reports ----
// One row per report an engineer asked for, holding the rendered PDF itself.
// The row — not the BullMQ job — is what the client polls and what the history
// list reads: a job disappears on `removeOnComplete`, on eviction, or on a Redis
// restart, and a finished report vanishing with it is exactly the durability
// problem this table exists to fix.
//
// NEVER `db.select().from(reports)` — that pulls every `pdf` blob into the
// heap, so a 50-row history list is tens of megabytes of Buffers per request.
// `REPORT_LIST_COLUMNS` in `apps/api/src/reports/store.ts` is the projection
// every route except the download uses.
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Deliberately `text`, not a pg enum: adding a report type must be a change
    // to the registry in `packages/shared/src/reports.ts` and nothing else. An
    // enum would make every new type a migration.
    reportType: text("report_type").notNull(),
    // The registry's `factsVersion` at generation time, so an old PDF is never
    // reinterpreted against a fact shape that has since changed.
    factsVersion: integer("facts_version").notNull().default(1),
    // Entra tenant GUID; null = all tenants. Free text matched against
    // tenants.tenant_id, same as every other tenant-scoped column here.
    tenantId: text("tenant_id"),
    tenantName: text("tenant_name"),
    windowDays: integer("window_days").notNull(),
    title: text("title").notNull(),
    // UPN, same attribution convention as jobs.engineer. Also the ownership
    // check: a report is only visible to the engineer who generated it.
    engineer: text("engineer").notNull(),
    status: reportStatusEnum("status").notNull().default("pending"),
    // What actually happened, not what was asked for — a run can request AI
    // narration and still land here as false when Ollama was unreachable.
    narrated: boolean("narrated").notNull().default(false),
    narrationSkippedReason: text("narration_skipped_reason"),
    // Numerals the model stated that trace to nothing in the section's own
    // facts. Printed in the PDF appendix, not just shown in the UI.
    factCheckWarnings: jsonb("fact_check_warnings").$type<string[]>().notNull().default([]),
    pdf: bytea("pdf"),
    pdfBytes: integer("pdf_bytes"),
    pdfSha256: text("pdf_sha256"),
    // Stored, not derived at download time, so the name in the history list and
    // the name in `content-disposition` can never disagree.
    filename: text("filename").notNull(),
    error: text("error"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Stamped at INSERT from REPORT_RETENTION_DAYS and never recomputed at
    // sweep time: deriving it from the current env var would mean lowering that
    // setting retroactively deletes reports an engineer was told would be kept.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("reports_engineer_idx").on(t.engineer, t.requestedAt),
    index("reports_expires_idx").on(t.expiresAt),
    index("reports_tenant_idx").on(t.tenantId, t.requestedAt),
  ],
);

// ---- Intune app deployments (WinGet + Win32 apps) ----
// A thin idempotency/reuse index only — NOT a cache of editable fields.
// displayName/description/installExperience/assignments are always read live
// from Graph when the Deploy App form opens (getMobileApp in
// packages/graph/src/intune-apps.ts), the same "trust the live Microsoft
// source" principle already applied to exposure counts elsewhere in this
// schema. This table exists purely so the Catalog page's "Deploy" button can
// tell, before calling Graph, whether a given package already has an Intune
// app object in this tenant — and if so, open the form in edit mode against
// intuneAppId instead of creating a duplicate.
export const intuneAppTypeEnum = pgEnum("intune_app_type", ["win32-lob", "winget"]);

export const intuneAppDeployments = pgTable(
  "intune_app_deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    appType: intuneAppTypeEnum("app_type").notNull(),
    // "winget" | "chocolatey" — reuses the same values as the winget/chocolatey
    // catalog rows' packageId namespace, so a (source, packageId) pair is
    // unambiguous without a second lookup.
    source: text("source").notNull(),
    packageId: text("package_id").notNull(),
    intuneAppId: text("intune_app_id").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Keyed on appType too, not just (tenantId, source, packageId) — a single
    // package can legitimately have both a winGetApp and a win32LobApp object
    // in the same tenant (Phase 1 vs Phase 2 deployment strategy are distinct
    // Graph objects with distinct ids). Without appType in the key, a Win32
    // deploy of a package that already has a WinGet-app row would collide on
    // the same row and silently overwrite intuneAppId while leaving appType
    // stale — and the reuse-check for either route would hand back the wrong
    // app type entirely.
    uniqueIndex("intune_app_deployments_tenant_type_source_package_idx").on(
      t.tenantId,
      t.appType,
      t.source,
      t.packageId,
    ),
  ],
);

// ---- feature update campaigns ----
// A live-synced mirror of the tenant's windowsFeatureUpdateProfiles, not just a
// creation-time snapshot: `source` distinguishes rows PatchPilot itself created
// via the campaign flow from ones synced in from a profile that already existed
// in Intune (pre-dating onboarding, or created directly in the Intune admin
// center). syncFeatureUpdateProfiles (apps/api/src/graph/sync.ts) upserts on
// (tenantId, intuneProfileId) and prunes rows Graph no longer reports — a
// PatchPilot-created row's creation event still lives forever in audit_log
// regardless of whether its live row is later pruned.
// Named for feature updates originally; now shared by all 4 Windows-update
// table types (feature updates, quality updates, update rings, driver
// updates) since every one of them targets Entra groups the same way. Kept
// as `IntuneAssignmentKind`/`IntuneAssignmentSummary` with the old names
// aliased below so existing importers don't need a simultaneous rename.
export type IntuneAssignmentKind = "include" | "exclude" | "all-devices" | "all-users";
export interface IntuneAssignmentSummary {
  kind: IntuneAssignmentKind;
  groupId?: string;
  groupName?: string;
}
export type FeatureUpdateAssignmentKind = IntuneAssignmentKind;
export type FeatureUpdateAssignmentSummary = IntuneAssignmentSummary;
export const featureUpdateCampaigns = pgTable(
  "feature_update_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    displayName: text("display_name").notNull(),
    // Friendly label (e.g. "24H2", or Graph's raw featureUpdateVersion string
    // when it doesn't match a known CLIENT_BUILDS entry) and the resolved raw
    // build behind it — same split as tenants.featureUpdateTargetVersion vs.
    // devices.osBuild. targetBuild is nullable: a profile synced in from
    // Intune may target a version string PatchPilot doesn't recognize.
    targetVersion: text("target_version").notNull(),
    targetBuild: integer("target_build"),
    // Structured assignment targets — not just a single include/exclude group,
    // since a profile created directly in Intune can have multiple include
    // groups, "All devices"/"All users" targets, or none at all.
    assignments: jsonb("assignments").$type<IntuneAssignmentSummary[]>().notNull().default([]),
    // "patchpilot" only for rows PatchPilot's own campaign-creation route
    // inserted; a sync upsert never overwrites this on an existing row, so a
    // PatchPilot-created profile keeps its provenance even after later syncs
    // refresh its other fields.
    source: text("source", { enum: ["patchpilot", "intune"] }).notNull().default("intune"),
    intuneProfileId: text("intune_profile_id").notNull(),
    // rolloutSettings is optional on the Graph object — null when a synced-in
    // profile has no paced rollout schedule.
    offerStartDateTimeInUTC: timestamp("offer_start_date_time_in_utc", { withTimezone: true }),
    offerEndDateTimeInUTC: timestamp("offer_end_date_time_in_utc", { withTimezone: true }),
    offerIntervalInDays: integer("offer_interval_in_days"),
    installFeatureUpdatesOptional: boolean("install_feature_updates_optional").notNull().default(false),
    // Null for a profile synced in from Intune — no PatchPilot engineer created it.
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("feature_update_campaigns_tenant_idx").on(t.tenantId),
    uniqueIndex("feature_update_campaigns_tenant_profile_idx").on(t.tenantId, t.intuneProfileId),
  ],
);

// ---- quality update campaigns ----
// Holds BOTH Windows-update-policy kinds Intune calls "quality update"
// policies, discriminated by policyType: "expedite" (windowsQualityUpdate-
// Profiles — PatchPilot can create/delete these via
// createAndAssignQualityUpdateProfile) and "quality-update" (the newer,
// separate windowsQualityUpdatePolicies resource — read-only here, synced in
// like featureUpdateCampaigns' Intune-origin rows). One table, not two,
// because the Quality Updates tab needs one unified sort/search/select
// surface; policyType is a filter, not a join. Same live-synced-mirror
// rationale as featureUpdateCampaigns: syncQualityUpdateProfiles/
// syncQualityUpdatePolicies (apps/api/src/graph/sync.ts) each upsert on
// (tenantId, policyType, intuneProfileId) and prune only within their own
// policyType, so syncing one kind never prunes the other's rows.
export const qualityUpdatePolicyTypeEnum = pgEnum("quality_update_policy_type", [
  "expedite",
  "quality-update",
]);
export const qualityUpdateCampaigns = pgTable(
  "quality_update_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    policyType: qualityUpdatePolicyTypeEnum("policy_type").notNull().default("expedite"),
    displayName: text("display_name").notNull(),
    // Expedite-only (a "quality-update"-type row created by an admin directly
    // in Intune has no associated Missing-KB match or catalog item known to
    // PatchPilot).
    kbId: text("kb_id"),
    catalogItemId: text("catalog_item_id"),
    releaseLabel: text("release_label"),
    daysUntilForcedReboot: integer("days_until_forced_reboot"),
    // Structured assignment targets, same shape as featureUpdateCampaigns —
    // replaces the old flat groupName/groupId/excludeGroupName/excludeGroupId
    // columns so a profile synced in from Intune can carry multiple
    // include groups or an "All devices"/"All users" target.
    assignments: jsonb("assignments").$type<IntuneAssignmentSummary[]>().notNull().default([]),
    // "patchpilot" only for expedite rows PatchPilot's own creation route
    // inserted; every "quality-update"-type row is "intune" since PatchPilot
    // can't create those.
    source: text("source", { enum: ["patchpilot", "intune"] }).notNull().default("intune"),
    intuneProfileId: text("intune_profile_id").notNull(),
    // Null for a profile synced in from Intune — no PatchPilot engineer created it.
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("quality_update_campaigns_tenant_idx").on(t.tenantId),
    uniqueIndex("quality_update_campaigns_tenant_policy_profile_idx").on(
      t.tenantId,
      t.policyType,
      t.intuneProfileId,
    ),
  ],
);

// ---- update rings ----
// Read-only mirror of windowsUpdateForBusinessConfigurations — PatchPilot has
// no creation flow for these, so every row is Intune-origin and there's no
// source/createdBy split to make.
export const updateRingProfiles = pgTable(
  "update_ring_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    intuneProfileId: text("intune_profile_id").notNull(),
    displayName: text("display_name").notNull(),
    assignments: jsonb("assignments").$type<IntuneAssignmentSummary[]>().notNull().default([]),
    qualityUpdatesDeferralPeriodInDays: integer("quality_updates_deferral_period_in_days"),
    featureUpdatesDeferralPeriodInDays: integer("feature_updates_deferral_period_in_days"),
    allowWindows11Upgrade: boolean("allow_windows_11_upgrade"),
    automaticUpdateMode: text("automatic_update_mode"),
    businessReadyUpdatesOnly: text("business_ready_updates_only"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("update_ring_profiles_tenant_idx").on(t.tenantId),
    uniqueIndex("update_ring_profiles_tenant_profile_idx").on(t.tenantId, t.intuneProfileId),
  ],
);

// ---- driver updates ----
// Read-only mirror of windowsDriverUpdateProfiles — same rationale as
// updateRingProfiles above.
export const driverUpdateProfiles = pgTable(
  "driver_update_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    intuneProfileId: text("intune_profile_id").notNull(),
    displayName: text("display_name").notNull(),
    assignments: jsonb("assignments").$type<IntuneAssignmentSummary[]>().notNull().default([]),
    approvalType: text("approval_type"),
    deploymentDeferralInDays: integer("deployment_deferral_in_days"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("driver_update_profiles_tenant_idx").on(t.tenantId),
    uniqueIndex("driver_update_profiles_tenant_profile_idx").on(t.tenantId, t.intuneProfileId),
  ],
);

// ---- onboarding pairing tokens ----
// A single-use, short-TTL token minted by the "download personalized
// installer" flow (Setup > App Registration) and baked into the script the
// customer's Global Admin runs. It's the ONLY authentication on the public
// POST /api/onboarding/pair endpoint, so the raw value is never stored — only
// its hash, mirroring how secrets are never persisted anywhere in this schema.
export const onboardingPairingTokens = pgTable(
  "onboarding_pairing_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    // Snapshot of what was baked into the issued script, for audit.
    redirectUri: text("redirect_uri").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Set atomically (single conditional UPDATE) on successful pairing. Null
    // means still usable — this is the actual single-use gate, not a status
    // enum, so consumption is one indexed WHERE clause rather than a read then
    // a separate write.
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("onboarding_pairing_tokens_hash_idx").on(t.tokenHash),
    index("onboarding_pairing_tokens_expires_idx").on(t.expiresAt),
  ],
);

// ---- entitlement device usage (per-tenant Live Response quota) ----
// PatchPilot's vendor-controlled license key (see packages/graph/src/
// entitlement.ts) caps how many distinct devices, per tenant, may ever be
// dispatched a Live Response action — a separate quota from the general
// read-only/write-posture gate. A row here is both the record of "this device
// has counted against the quota" AND the actual consumption of a slot: an
// already-present device is always free to re-dispatch, so metering is a
// one-time cost per (tenant, device) pair, not per job.
export const entitlementDeviceUsage = pgTable(
  "entitlement_device_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    // devices.id at first dispatch — no FK, matching this schema's convention
    // of plain tenantId/deviceId columns elsewhere (e.g. remediationVerifications).
    deviceId: uuid("device_id").notNull(),
    // Snapshots, so this row survives the device being deleted/re-synced.
    managedDeviceId: text("managed_device_id").notNull(),
    deviceHostname: text("device_hostname").notNull(),
    firstDispatchedAt: timestamp("first_dispatched_at", { withTimezone: true }).notNull().defaultNow(),
    lastDispatchedAt: timestamp("last_dispatched_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchCount: integer("dispatch_count").notNull().default(1),
  },
  (t) => [
    uniqueIndex("entitlement_device_usage_tenant_device_idx").on(t.tenantId, t.deviceId),
    index("entitlement_device_usage_tenant_idx").on(t.tenantId),
  ],
);
