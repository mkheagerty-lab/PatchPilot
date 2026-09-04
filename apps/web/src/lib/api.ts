// Thin fetch client. The browser NEVER sees a Graph token — it only ever talks
// to the PatchPilot API on the same origin, carrying the session cookie.

import type {
  AuditActorType,
  AuditCategory,
  AuditOutcome,
  DeviceExclusionJustification,
  InstallScope,
  RemediationAction,
  Role,
  UserStatus,
} from "@patchpilot/shared";

// Re-exported so page code can pull the exclusion vocabulary from the same
// module as the rest of the API types. Unlike ExceptionJustification — which is
// hand-copied here and can silently drift — this is the real shared union that
// the API validates against and the DB enum mirrors.
export type { DeviceExclusionJustification };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    // Parsed JSON error body, when the response had one (e.g. a 422's
    // `{ error, report }` from the preflight gate) — lets callers show the
    // specific failing check instead of just the generic top-level message.
    public data?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Double-submit CSRF token, handed to us by GET /auth/me (see auth.tsx's
// AuthGate) and echoed back on every mutating call below. Module-level
// rather than React state: this file has no React dependency of its own and
// request() is the one choke point every api.* call already funnels through.
let csrfToken: string | undefined;

export function setCsrfToken(token: string | undefined): void {
  csrfToken = token;
}

const CSRF_EXEMPT_METHODS = new Set(["GET", "HEAD", "OPTIONS", undefined]);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: {
      ...(init?.body != null ? { "Content-Type": "application/json" } : {}),
      ...(!CSRF_EXEMPT_METHODS.has(init?.method) && csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!res.ok) {
    let message = res.statusText;
    let data: unknown;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
      data = body;
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new ApiError(res.status, message, data);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// ---- Domain response shapes (mirror the API / DB rows) ----

export type Severity = "critical" | "high" | "medium" | "low";

/** Whether PatchPilot can actually call Graph for a tenant (mirrors the DB enum). */
export type Reachability = "reachable" | "consent-needed" | "throttled" | "unreachable" | "unknown";

export interface Tenant {
  id: string;
  tenantId: string; // Entra tenant GUID
  displayName: string;
  consentStatus: "consented" | "pending" | "expired";
  // Distinct from consentStatus: a "consented" GDAP relationship can still be
  // unreachable (cross-tenant OBO can't redeem there). Set by the licensing probe.
  reachability: Reachability;
  readOnly: boolean;
  // Friendly label (e.g. "24H2") an engineer pinned via the Feature Updates
  // settings page. Null = use the default (latest known build).
  featureUpdateTargetVersion: string | null;
  licenses: string[];
  isMspTenant: boolean;
  // This tenant's own slice of PatchPilot's instance-wide Live Response
  // device pool (see EntitlementView.deviceLicensePool) — set by the MSP's
  // own admin under Settings > Tenants, not by the vendor. 0 until
  // explicitly allocated.
  liveResponseDeviceLimit: number;
  // When this tenant's devices + CVEs were last pulled in by a data sync.
  // Null until the first sync — the Tenants table shows "Never" for these.
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface Device {
  id: string;
  tenantId: string;
  managedDeviceId: string;
  defenderMachineId: string | null;
  hostname: string;
  os: string;
  osBuild: number | null;
  lastSeen: string | null;
  compliance: "compliant" | "noncompliant" | "unknown";
  vulnerabilityCount: number;
  owner: string | null;
  // Intune hardware inventory (managedDevice.model/manufacturer/serialNumber).
  // Defender exposes none reliably; null for Defender-only / unrecognised devices.
  model: string | null;
  manufacturer: string | null;
  serialNumber: string | null;
  // Whether an active, non-expired device exclusion covers this machine.
  // Excluded devices are hidden from /api/devices by default — pass
  // includeExcluded=true to get them back, annotated with these two fields.
  // Optional only for response shapes that predate the field.
  excluded?: boolean;
  // "Out of scope — decommissioned in June": the justification label plus the
  // engineer's note. Null when the device isn't excluded.
  exclusionReason?: string | null;
}

/** Computed SLA status returned alongside each vulnerability. */
export interface Sla {
  daysRemaining: number;
  overdue: boolean;
  dueDate: string;
  severity: Severity;
  chip: string;
}

export interface Vulnerability {
  id: string;
  tenantId: string;
  cveId: string;
  title: string;
  severity: Severity;
  cvss: number | null;
  affectedDeviceCount: number;
  software: string;
  // Marketing-friendly display name (e.g. "Google Chrome" instead of the raw
  // "chromedriver"/"chromium" Defender catalog strings). Falls back to
  // `software` when there's nothing to rename; prefer this for any UI label.
  displayName?: string | null;
  // Software vendor/publisher; null for findings Defender reported no vendor for.
  publisher: string | null;
  // Short CVE description shown in the detail panel; null when unavailable.
  description: string | null;
  // CVSS v3 vector string (e.g. "CVSS:3.1/AV:N/..."); null when unavailable.
  cvssVector: string | null;
  // EPSS exploitation probability (0..1); null when unavailable.
  epss: number | null;
  // CVE publish / last-update timestamps from Defender's catalog; null if absent.
  publishedOn: string | null;
  updatedOn: string | null;
  // Whether Defender flags a known public exploit / exploit kit for this CVE.
  exploitAvailable: boolean;
  // Stricter subset of exploitAvailable: Defender has confirmed active
  // exploitation specifically. Tightens the Compliance SLA — see Sla.tsx.
  exploitVerified: boolean;
  detectedAt: string;
  wingetRemediable: boolean;
  wingetPackageId: string | null;
  // Alternate repos (Chocolatey live-catalog match, curated fallback) this
  // finding can still be driven through when winget can't; empty when winget
  // covers it. Optional only for response shapes that predate this field.
  altSources?: AltSource[];
  status: "open" | "in-progress" | "remediated" | "dismissed";
  sla: Sla;
  // The raw Defender recommendation id (a member of some consolidated
  // recommendation's `recommendationIds[]`) matched to this CVE's software by
  // product name; null when no recommendation covers it. Drives the "Go to
  // related Security Recommendation" deep-link button.
  relatedRecommendationId: string | null;
  // Whether an active, non-expired local exception covers this finding —
  // hidden by default; included when the caller passes includeExceptions=true.
  exception?: boolean;
  // Detection evidence: the installed product version and the disk/registry
  // path(s) where Defender found it. On the device drill-down
  // (/api/devices/:id/vulnerabilities) this is exact to that one device; on the
  // fleet-wide list it's aggregated (union of paths, comma-joined distinct
  // versions) across every device in the tenant. Null when the tenant-agnostic
  // all-tenants view is requested, or where Defender's lighter fallback surface
  // carried no evidence.
  installedVersion?: string | null;
  diskPaths?: string[] | null;
  registryPaths?: string[] | null;
  // A remediation this device already applied — proven by the upgrade line in the
  // job's own transcript — that Defender hasn't published yet. Defender's software
  // inventory refreshes every 3-4 hours and Microsoft exposes no way to force it,
  // so a patched device keeps reporting the finding for hours. Present only on the
  // device drill-down, and only while the finding is genuinely awaiting a refresh.
  fixedOnDevice?: {
    packageId: string;
    versionBefore: string | null;
    versionAfter: string | null;
    verifiedAt: string;
  } | null;
}

/**
 * The two tables Defender's Recommendations page splits its feed across:
 * software/OS updates ("vulnerability") and security-control, account and
 * network findings ("misconfiguration"). The portal's *device* page merges both
 * under one "Security recommendations" tab, and so does ours.
 */
export type RecommendationKind = "vulnerability" | "misconfiguration";

/**
 * One Defender TVM security recommendation, 1:1 with a row on the portal's
 * Recommendations page — `recommendationName` is Defender's verbatim title
 * ("Update Google Chrome to version 151.0.7922.71") and is the row identity.
 * Severity is derived from Defender's numeric `severityScore` since
 * recommendations carry no discrete severity label.
 */
export interface Recommendation {
  id: string;
  tenantId: string;
  recommendationId: string;
  recommendationName: string;
  productName: string;
  vendor: string | null;
  recommendedVersion: string | null;
  severity: Severity;
  // Defender's 0..10 exposure/severity score the severity label is derived from.
  severityScore: number | null;
  // How many distinct CVEs (weaknesses) this one recommendation rolls up.
  weaknessCount: number;
  exposedMachinesCount: number;
  totalMachineCount: number;
  // Whether any rolled-up weakness has a known public exploit.
  publicExploit: boolean;
  remediationType: string | null;
  category: string | null;
  recommendationStatus: string | null;
  detectedAt: string;
  status: "open" | "in-progress" | "remediated" | "dismissed";
  // Which of Defender's two Recommendations tables this row belongs in.
  kind: RecommendationKind;
  // Null for misconfigurations — there's no patch to ship, so no SLA clock.
  sla: Sla | null;
  // ---- Defender portal parity fields ----
  osPlatform: string | null;
  subCategory: string | null;
  relatedComponent: string | null;
  // Exposure-score delta if remediated (the portal's "Impact" column).
  exposureImpact: number | null;
  // Secure-score delta if remediated (the portal's "Devices Score impact").
  configScoreImpact: number | null;
  activeAlert: boolean;
  associatedThreats: string[];
  // The Defender recommendation id, as a single-element array. Kept as an array
  // because the exposed-devices drill-down takes a list.
  recommendationIds: string[];
  // Aggregated per-user vs machine-wide install evidence across every device
  // this recommendation's software matched to — drives the Context chip.
  installScope: InstallScope;
  // Raw evidence backing installScope above — the union of disk/registry
  // paths Defender reported across every device this recommendation's
  // software matched to. Feeds the "How it was detected" panel.
  diskPaths: string[];
  registryPaths: string[];
  // Whether an active, non-expired local exception covers this recommendation —
  // hidden by default; included when the caller passes includeExceptions=true.
  exception?: boolean;
}

/** One device exposed to a recommendation — rows for the exposed-devices popout. */
export interface ExposedDevice {
  defenderMachineId: string | null;
  deviceName: string;
  owner: string | null;
  lastSeen: string | null;
  // Defender exposes no pending-reboot signal for recommendations — always null.
  pendingReboot: boolean | null;
  // This device's detection evidence for the specific CVE/recommendation the
  // popout was opened for — not the device's whole inventory. Null when this
  // device has no matching device_vulnerabilities row (e.g. no evidence
  // reported, or an Intune-only device with no Defender machine id).
  installedVersion: string | null;
  diskPaths: string[];
  registryPaths: string[];
}

/** A Defender device group (rbacGroupId/rbacGroupName), synced onto devices.deviceGroupId/Name. */
export interface DeviceGroup {
  id: string;
  name: string;
}

export type ExceptionScope = "global" | "device-group";

// Mirrors EXCEPTION_JUSTIFICATIONS in apps/api/src/routes/recommendations.ts.
// "cve-no-patch" and "false-positive" only make sense for a CVE-scoped exception.
export type ExceptionJustification =
  | "third-party-control"
  | "alternate-mitigation"
  | "risk-accepted"
  | "planned-remediation"
  | "cve-no-patch"
  | "false-positive";

/**
 * A local-only record of an engineer's intent to except a recommendation or
 * CVE from PatchPilot's own views — Defender has no public write API for
 * exceptions, so this never reaches Defender; the engineer still has to
 * create the matching exception by hand in the Defender portal.
 */
export interface RecommendationException {
  id: string;
  tenantId: string;
  recommendationId: string | null;
  cveId: string | null;
  scope: ExceptionScope;
  deviceGroupIds: string[];
  justification: ExceptionJustification;
  notes: string | null;
  expiresAt: string;
  status: "active" | "cancelled";
  createdBy: string;
  createdAt: string;
  cancelledAt: string | null;
  // "expired" isn't stored — derived server-side at read time from expiresAt.
  derivedStatus: "active" | "cancelled" | "expired";
}

/**
 * A local-only record that a device is out of scope — PatchPilot's mirror of
 * the Defender portal's Assets > Devices > Exclude. Defender exposes no write
 * API for exclusion (`PATCH /api/machines/{id}` updates only `machineTags` and
 * `deviceValue`), so this never reaches Defender; the engineer still applies
 * the matching exclusion by hand in the portal.
 *
 * Where a `RecommendationException` hides a *finding*, this hides a *device* —
 * and unlike Defender's, ours also blocks remediation (see the
 * `device-excluded` preflight check).
 */
export interface DeviceExclusion {
  id: string;
  tenantId: string;
  // Not a devices.id uuid: syncDevices hard-deletes any device Intune stops
  // returning, which is exactly the "device doesn't exist" case, so the
  // durable identity is (tenantId, managedDeviceId).
  managedDeviceId: string;
  // Snapshot taken at exclusion time, so the row still reads sensibly once the
  // device row is gone.
  deviceHostname: string;
  justification: DeviceExclusionJustification;
  notes: string | null;
  // Null means never expires — the Defender default. Diverges from
  // RecommendationException, whose expiry is mandatory.
  expiresAt: string | null;
  status: "active" | "cancelled";
  createdBy: string;
  createdAt: string;
  cancelledAt: string | null;
  // "expired" isn't stored — derived server-side at read time from expiresAt.
  derivedStatus: "active" | "cancelled" | "expired";
}

/**
 * A PatchPilot-native device group — an engineer-curated grouping used to
 * scope recurring schedule fan-out to a subset of a tenant's devices.
 *
 * Distinct from Defender's own `deviceGroupId`/`deviceGroupName` on `Device`,
 * which is a read-only RBAC machine group synced in from `/machines` and
 * can't be created or edited here.
 */
export interface LocalDeviceGroup {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
}

export interface LocalDeviceGroupMember {
  id: string;
  tenantId: string;
  deviceGroupId: string;
  managedDeviceId: string;
  deviceHostname: string;
  addedBy: string;
  addedAt: string;
}

export interface Connection {
  name: string;
  status: "connected" | "mocked" | "unknown" | "error";
  detail: string;
}

export interface WingetCatalogEntry {
  id: string;
  packageId: string;
  name: string;
  publisher: string;
  latestVersion: string | null;
  softwareTitle: string | null;
}

export interface WingetMatch {
  packageId: string;
  name: string;
  confidence: number;
  method: "manual" | "exact" | "contains" | "token-overlap";
}

/** An engineer-authored title -> package pin (winget_catalog_override row). */
export interface WingetCatalogOverride {
  id: string;
  tenantId: string | null;
  softwareTitle: string;
  packageId: string;
  createdBy: string;
  createdAt: string;
}

/** Coverage status for one software group's winget remediation path. */
export type CoverageStatus = "covered" | "not-supported" | "os";

/** Alternate repos a not-supported app can still be remediated through. */
export type PackageSource = "chocolatey" | "microsoft-store";

/** A not-supported app's resolution in an alternate repo (honest-preview). */
export interface AltSource {
  source: PackageSource;
  /** Source-native id — a Chocolatey package id or a Microsoft Store product id. */
  packageId: string;
  name: string;
}

/**
 * One software product's coverage — many per-CVE findings for the same product
 * collapsed into a single row (the way Defender's Recommendations view does),
 * with winget coverage derived live rather than from the stored sync flag.
 */
export interface CoverageRow {
  tenantId: string;
  software: string;
  /** Human-friendly product name (e.g. "pje-office" -> "Microsoft Office"); falls back to `software`. */
  displayName: string;
  publisher: string | null;
  severity: Severity;
  /** Whether this is an app finding (winget-applicable) or an OS finding. */
  patchType: "app" | "os";
  /** True when patchType === "app" — i.e. in winget's scope at all. */
  applicable: boolean;
  /**
   * covered = winget package matched; not-supported = app with no winget package
   * (candidate for another repo); os = patched via Windows Update, not winget.
   */
  status: CoverageStatus;
  match: WingetMatch | null;
  /** The matched package's latest catalog version, or null when uncovered. */
  latestVersion: string | null;
  /**
   * For not-supported apps, the alternate repos PatchPilot can drive the fix
   * through (Chocolatey / Microsoft Store). Empty for covered or OS rows.
   * Honest-preview: curated, preview-availability mappings.
   */
  altSources: AltSource[];
  /** How many distinct CVE findings this product's row rolls up. */
  cveCount: number;
  cveIds: string[];
  /** Devices exposed to this product's most-exposed CVE. */
  affectedDeviceCount: number;
  /** Highest-severity finding's id — what a "Run now" action seeds from. */
  vulnId: string;
}

export interface CatalogCoverage {
  tenantId: string | null;
  /** Distinct CVE findings considered (pre-grouping). */
  findingCount: number;
  /** Software groups (rows). */
  total: number;
  /** App-finding groups (winget-applicable). */
  applicable: number;
  /** App groups with a winget package match. */
  covered: number;
  /** App groups with no winget package (not supported by winget). */
  uncovered: number;
  /** OS-finding groups (patched via Windows Update). */
  os: number;
  rows: CoverageRow[];
}

/** Catalog freshness summary from GET /api/catalog/status. */
export interface CatalogStatus {
  demo: boolean;
  total: number;
  /** Packages sourced from the live winget mirror. */
  mirror: number;
  /** Hand-curated / fixture packages (total - mirror). */
  curated: number;
  /** When the mirror was last pulled; null in demo or before the first refresh. */
  lastRefreshedAt: string | null;
  refreshing: boolean;
}

/** Response from POST /api/catalog/refresh. */
export interface CatalogRefreshResult {
  packages: number;
  refreshedAt: string;
  durationMs: number;
}

// ---- Chocolatey catalog (user-context counterpart to the winget types above) ----

export interface ChocolateyCatalogEntry {
  id: string;
  packageId: string;
  name: string;
  publisher: string;
  latestVersion: string | null;
  softwareTitle: string | null;
}

export interface ChocolateyMatch {
  packageId: string;
  name: string;
  confidence: number;
  method: "manual" | "exact" | "contains" | "token-overlap";
}

/** A resolved catalog auto-match, minus the confidence/method — just enough to lock in a picker. */
export interface CatalogPackageLock {
  packageId: string;
  name: string;
  latestVersion: string | null;
}

/** GET /api/catalog/match — Winget + Chocolatey auto-match for the Run Now pickers. */
export interface CatalogMatchResult {
  winget: CatalogPackageLock | null;
  chocolatey: CatalogPackageLock | null;
}

/** An engineer-authored title -> package pin (chocolatey_catalog_override row). */
export interface ChocolateyCatalogOverride {
  id: string;
  tenantId: string | null;
  softwareTitle: string;
  packageId: string;
  createdBy: string;
  createdAt: string;
}

// ---- Microsoft Store app search (GET /api/store-apps/search) — backs the
// "Microsoft Store app (new)" channel's picker. Live, query-driven lookup
// against Microsoft's manifestSearch endpoint — no mirrored catalog table. ----

export interface StoreAppResult {
  packageIdentifier: string;
  name: string;
  publisher: string;
  version: string;
}

// ---- Intune app deployment ("Deploy App" — WinGet apps (Phase 1, deprecated
// for real-world use) and Win32 apps (Phase 2, now dispatched inline from Run
// Now / Fix All via Win32DeployOptionsPanel rather than a standalone modal)) ----

export type IntuneAssignmentMode = "none" | "all-devices" | "all-users" | "group";

/** Sent as the `assignment` field of POST /api/intune-apps/winget and PATCH /api/intune-apps/:id. */
export interface IntuneAssignmentInput {
  mode: IntuneAssignmentMode;
  /** Required for mode "group" — an id resolved client-side via the EntraGroupPicker. */
  groupId?: string;
  groupName?: string;
  /** Independent of `mode` — settable alongside any include target, ignored when mode is "none". */
  excludeGroupId?: string;
  excludeGroupName?: string;
  filterId?: string;
}

/** A single Entra group search result — backs EntraGroupPicker (GET /api/groups/search). */
export interface EntraGroupResult {
  id: string;
  displayName: string;
}

export interface IntuneMobileAppAssignment {
  intent?: string;
  target?: { "@odata.type": string; groupId?: string };
}

/** Live Graph mobileApp shape (winGetApp/win32LobApp) — never cached, always fetched fresh. */
export interface IntuneMobileApp {
  id: string;
  "@odata.type"?: string;
  displayName?: string;
  description?: string;
  publisher?: string;
  installExperience?: { runAsAccount?: string };
  assignments?: IntuneMobileAppAssignment[];
}

/** Response from POST /api/intune-apps/winget or POST /api/intune-apps/win32. */
export interface DeployIntuneAppResult {
  appId: string;
  /** True when this package already had an app deployed in this tenant — the existing app was reused, not duplicated. */
  reused: boolean;
  /** Only present when reused — the live current state, used to prefill the edit form. */
  app?: IntuneMobileApp;
  /** Set on the Win32 path when the app was created but Intune is still building it server-side. */
  warning?: string;
}

/** Response from PATCH /api/intune-apps/:appId. */
export interface UpdateIntuneAppResult {
  appId: string;
  updated: true;
}

/** Mirrors CoverageRow, scored against the Chocolatey catalog instead of winget. */
export interface ChocolateyCoverageRow {
  tenantId: string;
  software: string;
  displayName: string;
  publisher: string | null;
  severity: Severity;
  patchType: "app" | "os";
  applicable: boolean;
  status: CoverageStatus;
  match: ChocolateyMatch | null;
  latestVersion: string | null;
  cveCount: number;
  cveIds: string[];
  affectedDeviceCount: number;
  vulnId: string;
}

export interface ChocolateyCoverage {
  tenantId: string | null;
  findingCount: number;
  total: number;
  applicable: number;
  covered: number;
  uncovered: number;
  os: number;
  rows: ChocolateyCoverageRow[];
}

/** Catalog freshness summary from GET /api/chocolatey-catalog/status. */
export interface ChocolateyCatalogStatus {
  demo: boolean;
  total: number;
  /** Packages sourced from the live Chocolatey community feed. */
  mirror: number;
  curated: number;
  lastRefreshedAt: string | null;
  refreshing: boolean;
}

/** Response from POST /api/chocolatey-catalog/refresh. */
export interface ChocolateyCatalogRefreshResult {
  packages: number;
  refreshedAt: string;
  durationMs: number;
  /** True if the Chocolatey repository's paging cap was hit before exhausting the catalog. */
  truncated: boolean;
  truncationReason: string | null;
}

export type CheckStatus = "pass" | "warn" | "fail" | "pending";

export interface ReadinessCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface ReadinessReport {
  tenantId: string;
  displayName: string;
  ready: boolean;
  canRemediate: boolean;
  enabledChannels: string[];
  checks: ReadinessCheck[];
}

export type PreflightStatus = "pass" | "warn" | "fail";

export interface PreflightCheck {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
}

export interface PreflightReport {
  channel: string;
  canProceed: boolean;
  checks: PreflightCheck[];
  // The exact deployable script this remediation would run, returned by
  // /api/preflight so the engineer can review the code before dispatching.
  // Same generator the run route uses, so preview and payload never diverge.
  script: string;
  // Diagnostic/routing signal only — see PreflightInput.installScope in
  // packages/shared. Present on the /api/preflight response, absent from the
  // nested `report` on RemediationResult/FixAllResult.
  installScope?: InstallScope;
  autoRoutedSource?: PackageSource | null;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  tenantId: string;
  deviceId: string | null;
  cveId: string | null;
  /**
   * Additional CVE ids this one job also remediates, beyond the primary
   * `cveId` — set when a recurring schedule's fan-out consolidated several
   * open CVEs against the same (device, software) fix into a single dispatch
   * instead of one job per CVE. Null for the ordinary 1:1 case.
   */
  coveredCveIds: string[] | null;
  /**
   * Device hostname / resolved software display name snapshotted at dispatch
   * time, so the row keeps an accurate historical record even after the
   * device is renamed/removed or a later sync changes the vulnerability's
   * stored software. Null on legacy rows created before these columns
   * existed — the UI falls back to a live join for those.
   */
  deviceHostname: string | null;
  software: string | null;
  channel: string;
  status: JobStatus;
  engineer: string;
  exitCode: number | null;
  output: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  archivedAt: string | null;
  /** Present on jobs created after retry support shipped; null on legacy rows. */
  script: string | null;
  packageId: string | null;
  installScope: InstallScope | null;
  action: RemediationAction | null;
  source: PackageSource | null;
  altPackageId: string | null;
  /**
   * Shared by every job created from one multi-device dispatch (a schedule
   * fire, a Fix All, or a multi-device Run Now) so the Jobs page can group
   * them under one row. Null for single-device dispatches.
   */
  batchId: string | null;
  /** Set only when the job came from a recurring schedule's fan-out. */
  scheduleId: string | null;
}

/** Response from POST /api/remediations. */
export interface RemediationResult {
  job: Job;
  script: string;
  report: PreflightReport;
}

/** One requested software group skipped by Fix All, with the reason it couldn't run. */
export interface FixAllSkip {
  software: string;
  reason: string;
}

/** Response from POST /api/devices/:id/fix-all. */
export interface FixAllResult {
  jobsCreated: number;
  jobs: Job[];
  skipped: FixAllSkip[];
}

/** Response from POST /api/jobs/bulk-archive. */
export interface BulkArchiveResult {
  updated: string[];
  notFound: string[];
}

/** Response from POST /api/jobs/bulk-delete. */
export interface BulkDeleteResult {
  deleted: string[];
  notFound: string[];
}

export interface Schedule {
  id: string;
  tenantId: string;
  name: string;
  cron: string;
  channel: string;
  target: Record<string, unknown>;
  enabled: boolean;
  /** UPN the recurring run is attributed to; null for pre-attribution rows. */
  engineer: string | null;
  createdAt: string;
}

/** Per-tenant admin-consent target from GET /api/onboarding. */
export interface ConsentTarget {
  tenantId: string;
  displayName: string;
  consentStatus: "consented" | "pending" | "expired";
  /** Honest "can PatchPilot reach this tenant's Graph" signal (Phase A). */
  reachability: Reachability;
  licenses: string[];
  isMspTenant: boolean;
  consentUrl: string;
}

/** App-registration identity + consent URLs from GET /api/onboarding. */
export interface OnboardingReport {
  demoMode: boolean;
  clientId: string;
  tenantId: string;
  redirectUri: string;
  /** Every redirect URI this instance's own allowlist currently accepts —
   * PUBLIC_URL plus every active custom domain. Not a live read of the real
   * Entra app registration; the two match once a sync has actually run. */
  redirectUris: string[];
  /** One-click admin-consent URL for the MSP's own (home) tenant — the Global
   * Administrator opens this to make the first "Discover tenants" succeed. */
  homeConsentUrl: string;
  /** True once the MSP's own home tenant has completed admin consent (a
   * `tenants` row for it exists server-side) — see routes/onboarding.ts. */
  homeTenantConsented: boolean;
  /** True when the live app registration's requested scopes are known to
   * have drifted from what this build of PatchPilot currently requests —
   * see routes/onboarding.ts. False (not a live check) when no baseline has
   * ever been recorded, e.g. a self-hosted install that hand-wrote .env. */
  scopesSyncNeeded: boolean;
  scopes: {
    graph: string[];
    defender: string[];
    partnerCenter: string[];
  };
  consentTargets: ConsentTarget[];
}

/** "<label>.patchpilot365.com" (PatchPilot Support creates the DNS record) vs. a fully custom hostname. */
export type DomainType = "subdomain" | "custom";
/** "pending" until a Verify click finds a matching CNAME; "active" once it does. */
export type DomainStatus = "pending" | "active";

/** Server-computed, per-domain setup instructions from GET /api/domains. */
export type DomainInstructions =
  | { kind: "email-support"; summary: string; supportMailto: string }
  | { kind: "dns-cname"; summary: string; cnameRecord: { name: string; target: string } };

/** One row from GET /api/domains — mirrors packages/db's custom_domains table. */
export interface CustomDomain {
  id: string;
  hostname: string;
  type: DomainType;
  status: DomainStatus;
  cnameTarget: string;
  createdBy: string;
  createdAt: string;
  activatedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  instructions: DomainInstructions;
}

/** GET /api/domains — the App Registration page's Custom Domains card. */
export interface DomainsReport {
  primaryOrigin: string;
  platformBaseDomain: string;
  /** The host new domains are told to CNAME at — see CUSTOM_DOMAIN_CNAME_TARGET. */
  cnameTarget: string;
  /** False when cnameTarget isn't a real DNS name (e.g. a local-dev "localhost:5173"). */
  cnameTargetUsable: boolean;
  domains: CustomDomain[];
}

/** Whether a tenant's licensing could actually be read, independent of reachability. */
export type LicenseStatus = "detected" | "unavailable";

/** Detected licensing for a tenant from GET /api/licensing. */
export interface LicensingReport {
  tenantId: string;
  displayName: string;
  source: "demo-fixture" | "graph";
  reachability: Reachability;
  licenseStatus: LicenseStatus | "demo";
  licenseDetail?: string;
  licenses: string[];
  enabledChannels: string[];
}

/** One tenant's reachability + licensing probe outcome from POST /api/sync/tenants. */
export interface TenantProbe {
  tenantId: string;
  reachability: Reachability;
  licenses: string[];
  licenseStatus: LicenseStatus;
  httpStatus?: number;
  detail?: string;
  licenseDetail?: string;
}

/** Response from POST /api/sync/tenants — tenant discovery + classified probe. */
export interface SyncTenantsResult {
  tenants: number;
  probed: number;
  summary: {
    reachable: number;
    consentNeeded: number;
    throttled: number;
    unreachable: number;
    /** Reachable tenants whose licensing we couldn't read (needs Organization.Read.All). */
    licensingUnavailable: number;
  };
  probes: TenantProbe[];
}

/** Response from POST /api/sync/:tenantId/data — per-tenant ingestion counts. */
export interface SyncDataResult {
  tenantId: string;
  devices: number;
  vulnerabilities: number;
  /** Consolidated Defender recommendations ingested (0 if the tenant lacks the scope). */
  recommendations: number;
  /** When the ingestion finished — drives the Tenants "Last synced" column. */
  lastSyncedAt: string;
}

/** One row from GET /api/software-inventory — Defender's full per-tenant software inventory. */
export interface SoftwareInventoryRow {
  id: string;
  tenantId: string;
  softwareId: string;
  name: string;
  vendor: string | null;
  weaknessCount: number;
  exposedMachinesCount: number;
  installedMachinesCount: number;
  publicExploit: boolean;
  /** "user" | "machine" | "mixed" | "unknown" — summarised across deviceSoftware at sync time. */
  context: string | null;
  matchedPackageId: string | null;
  matchedPackageSource: "winget" | "chocolatey" | null;
  matchedLatestVersion: string | null;
  detectedAt: string;
  lastSeenAt: string | null;
}

/** One device in GET /api/software-inventory/:softwareId/devices — installScope is recomputed live. */
export interface SoftwareInventoryDevice {
  deviceId: string | null;
  hostname: string;
  defenderMachineId: string;
  detectedVersion: string | null;
  installScope: InstallScope;
  latestVersion: string | null;
  /** True when detectedVersion already meets or exceeds latestVersion — nothing to fix. */
  upToDate: boolean;
  wingetPackageId: string | null;
  chocolateyPackageId: string | null;
  fixable: boolean;
  // Raw detection evidence for this device — the disk/registry path(s)
  // Defender found this software at. Feeds the "How it was detected" panel.
  diskPaths: string[];
  registryPaths: string[];
}

/** Response from GET /api/software-inventory/:softwareId/devices. */
export interface SoftwareInventoryDevicesResult {
  softwareId: string;
  name: string;
  devices: SoftwareInventoryDevice[];
}

/** One row from GET /api/devices/:id/software-inventory — this device's full
 *  software inventory (not just findings with an open CVE), joined against the
 *  tenant-wide software-inventory summary for weakness/exploit context. */
export interface DeviceSoftwareInventoryRow {
  softwareId: string;
  name: string;
  vendor: string | null;
  version: string | null;
  installScope: InstallScope;
  weaknessCount: number;
  exposedMachinesCount: number;
  publicExploit: boolean;
  latestVersion: string | null;
  /** True when version already meets or exceeds latestVersion — nothing to fix. */
  upToDate: boolean;
  packageSource: "winget" | "chocolatey" | null;
  wingetPackageId: string | null;
  chocolateyPackageId: string | null;
  // Raw detection evidence for this software on this device. Feeds the
  // "How it was detected" panel.
  diskPaths: string[];
  registryPaths: string[];
}

/** Response from POST /api/software-inventory/fix. */
export interface SoftwareInventoryFixResult {
  job: Job;
  script: string;
  report: PreflightReport;
  installScope: InstallScope;
  /** Set when Fix Now silently routed to an alt source because installScope was "user". */
  autoRoutedSource: PackageSource | null;
}

/** One skipped item from a software-inventory Fix All run — the hostname when
 *  fixing one software across devices, or the software name when fixing one
 *  device's full inventory (whichever axis isn't fixed by the request). */
export interface InventoryFixAllSkip {
  label: string;
  reason: string;
}

/** Response from POST /api/software-inventory/fix-all. */
export interface InventoryFixAllResult {
  jobsCreated: number;
  jobs: Job[];
  skipped: InventoryFixAllSkip[];
}

/** One device's exposure within a grouped missing KB — carries the specific
 *  `missing_kbs` row id Fix Now needs (each device has its own row). */
export interface MissingKbGroupDevice {
  deviceId: string;
  hostname: string;
  missingKbId: string;
}

/** A missing Windows Update (KB) rolled up across devices, from GET /api/missing-kbs. */
export interface MissingKbGroup {
  tenantId: string;
  kbId: string;
  title: string;
  products: string[];
  cveCount: number;
  cveIds: string[];
  url: string | null;
  deviceCount: number;
  devices: MissingKbGroupDevice[];
  latestSyncedAt: string;
}

/** One device's missing-KB row, from GET /api/devices/:id/missing-kbs. */
export interface MissingKbRow {
  id: string;
  tenantId: string;
  deviceId: string;
  kbId: string;
  title: string;
  products: string[];
  cveCount: number;
  cveIds: string[];
  url: string | null;
  syncedAt: string;
}

/** Response from POST /api/missing-kbs/fix. */
export interface MissingKbFixResult {
  job: Job;
  script: string;
  report: PreflightReport;
}

/** One skipped device from a missing-KB Fix All run, with the reason it
 *  couldn't be dispatched. */
export interface MissingKbFixAllSkip {
  label: string;
  reason: string;
}

/** Response from POST /api/missing-kbs/fix-all. */
export interface MissingKbFixAllResult {
  jobsCreated: number;
  jobs: Job[];
  skipped: MissingKbFixAllSkip[];
}

/** One item from GET /api/missing-kbs/:id/quality-update-releases — a tenant's
 *  Intune quality-update catalog entry, annotated for the release picker. */
export interface QualityUpdateRelease {
  id: string;
  displayName: string;
  isExpeditable: boolean;
  cadence: "B" | "OOB" | "unknown";
  /** Whether this release is the one this specific missing KB resolved to. */
  matchesKbId: boolean;
}

/** One item from GET /api/quality-updates/catalog — the standalone expedite
 *  release picker (no specific KB driving the match, unlike QualityUpdateRelease). */
export interface QualityUpdateCatalogRelease {
  id: string;
  displayName: string;
  isExpeditable: boolean;
  cadence: "B" | "OOB" | "unknown";
}

export type IntuneAssignmentKind = "include" | "exclude" | "all-devices" | "all-users";
export interface IntuneAssignmentSummary {
  kind: IntuneAssignmentKind;
  groupId?: string;
  groupName?: string;
}
/** @deprecated use IntuneAssignmentKind — kept as an alias so existing importers don't need a simultaneous rename. */
export type FeatureUpdateAssignmentKind = IntuneAssignmentKind;
/** @deprecated use IntuneAssignmentSummary — kept as an alias so existing importers don't need a simultaneous rename. */
export type FeatureUpdateAssignmentSummary = IntuneAssignmentSummary;

/**
 * A Windows Quality Update policy for the Windows Updates hub's Quality
 * Updates tab, from GET/POST /api/quality-updates/campaigns — a live-synced
 * list holding both `policyType`s. Only `"expedite"` rows have a PatchPilot
 * write path (create/delete); `"quality-update"` rows are read-only mirrors
 * of `windowsQualityUpdatePolicies` and their expedite-only/patchpilot-only
 * fields are always null.
 */
export interface QualityUpdateCampaign {
  id: string;
  tenantId: string;
  policyType: "expedite" | "quality-update";
  source: "patchpilot" | "intune";
  displayName: string;
  releaseLabel: string | null;
  daysUntilForcedReboot: number | null;
  assignments: IntuneAssignmentSummary[];
  intuneProfileId: string;
  createdBy: string | null;
  createdAt: string;
}

/** A group-targeted, scheduled feature-update rollout, from
 *  GET/POST /api/feature-updates/campaigns — a live-synced list (see
 *  `POST /campaigns/sync`), covering both PatchPilot's own campaigns and any
 *  windowsFeatureUpdateProfile created directly in the Intune admin center.
 *  `targetBuild`/`offer*`/`createdBy` are null for a profile PatchPilot didn't
 *  create or that has no paced rollout schedule. */
export interface FeatureUpdateCampaign {
  id: string;
  tenantId: string;
  displayName: string;
  targetVersion: string;
  targetBuild: number | null;
  assignments: IntuneAssignmentSummary[];
  source: "patchpilot" | "intune";
  intuneProfileId: string;
  offerStartDateTimeInUTC: string | null;
  offerEndDateTimeInUTC: string | null;
  offerIntervalInDays: number | null;
  installFeatureUpdatesOptional: boolean;
  createdBy: string | null;
  createdAt: string;
}

/** Update Rings tab — read-only live-sync mirror of
 *  windowsUpdateForBusinessConfigurations, from GET /api/update-rings. No
 *  PatchPilot write path exists for this resource. */
export interface UpdateRingProfile {
  id: string;
  tenantId: string;
  displayName: string;
  assignments: IntuneAssignmentSummary[];
  qualityUpdatesDeferralPeriodInDays: number | null;
  featureUpdatesDeferralPeriodInDays: number | null;
  allowWindows11Upgrade: boolean | null;
  automaticUpdateMode: string | null;
  businessReadyUpdatesOnly: string | null;
  intuneProfileId: string;
  createdAt: string;
}

/** Driver Updates tab — read-only live-sync mirror of
 *  windowsDriverUpdateProfiles, from GET /api/driver-updates. No PatchPilot
 *  write path exists for this resource. */
export interface DriverUpdateProfile {
  id: string;
  tenantId: string;
  displayName: string;
  assignments: IntuneAssignmentSummary[];
  approvalType: string | null;
  deploymentDeferralInDays: number | null;
  intuneProfileId: string;
  createdAt: string;
}

/**
 * One audit_log row, from GET /api/audit.
 *
 * The unions come from @patchpilot/shared rather than being re-declared here so
 * the page's filters can never drift from what the writer actually emits.
 * `action`/`outcome` stay loose strings: rows written before the taxonomy
 * existed carry neither, and legacy `action` values must still render.
 */
export interface AuditRecord {
  id: string;
  engineer: string;
  actorType: AuditActorType;
  tenantId: string | null;
  category: AuditCategory;
  action: string | null;
  endpoint: string;
  method: string;
  resourceType: string | null;
  resourceId: string | null;
  resourceLabel: string | null;
  summary: string | null;
  outcome: AuditOutcome | null;
  detail: string | null;
  /** SHA-256 of the request payload. The payload itself is never stored. */
  payloadHash: string | null;
  responseStatus: number | null;
  latencyMs: number | null;
  at: string;
}

/**
 * One keyset page. There is deliberately no total — COUNT(*) over an unbounded
 * table with an ILIKE predicate is a seq scan on every page load.
 */
export interface AuditListResponse {
  rows: AuditRecord[];
  nextCursor: string | null;
}

/** Client-side filter state; serialised to the query string by AuditLog.tsx. */
export interface AuditQuery {
  category: AuditCategory | "all";
  action: string;
  actor: string;
  outcome: AuditOutcome | "all";
  q: string;
  /** `datetime-local` values (local time, no zone) — converted to ISO on send. */
  from: string;
  to: string;
  /** Deep-link only (e.g. from the Dashboard activity feed) — no dropdown for this one. */
  resourceId: string;
}

/** A row in the Script Catalog — an engineer-uploaded script (preview, Intune-only dispatch). */
/**
 * Organisational only: Intune's deviceHealthScripts accepts PowerShell alone,
 * so cmd/bash entries are catalogued but not dispatchable (RunNowModal's picker
 * disables them rather than hiding them).
 */
export type ScriptType = "powershell" | "cmd" | "bash";

export interface ScriptCatalogEntry {
  id: string;
  tenantId: string | null;
  name: string;
  description: string | null;
  scriptType: ScriptType;
  scriptContent: string;
  createdBy: string;
  createdAt: string;
  /** Non-null once archived — soft-hidden, same contract as a Job's archivedAt. */
  archivedAt: string | null;
}

// ---- Dashboard summary (GET /api/dashboard/summary) ----
// Mirrors apps/api/src/routes/dashboard.ts field-for-field. Kept here rather
// than re-derived from the response so every dashboard widget gets typed
// props without each one re-declaring the shape it's handed.

export type DeviceCompliance = "compliant" | "noncompliant" | "unknown";

export interface DashboardScope {
  tenants: number;
  reachable: number;
  stale: number;
  neverSynced: number;
  readOnly: number;
  oldestSyncAt: string | null;
  newestSyncAt: string | null;
}

export interface DashboardTiles {
  critical: number;
  high: number;
  breached: number;
  dueSoon: number;
  openFindings: number;
  devices: number;
  noncompliantDevices: number;
  compliantDevices: number;
  unmonitoredDevices: number;
  misconfigurations: number;
  activeExceptions: number;
  excludedDevices: number;
  // Open findings where Defender has confirmed active exploitation — subject
  // to the tightened Compliance SLA override (default 3 days).
  verifiedExploitOpen: number;
  // Windows client devices strictly behind the tenant's resolved
  // feature-update target build (or the shared default when unset).
  devicesBehindFeatureUpdate: number;
}

export interface DashboardSeverityCount {
  severity: Severity;
  count: number;
}

export type SlaBucketName = "breached" | "0-3d" | "4-7d" | "8-14d" | "15-30d" | "30d+";

export interface DashboardSlaBucket {
  bucket: SlaBucketName;
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}

export interface DashboardTopSoftware {
  software: string;
  displayName: string;
  severity: Severity;
  affectedDeviceCount: number;
  cveCount: number;
}

export interface DashboardComplianceCount {
  compliance: DeviceCompliance;
  count: number;
}

export interface DashboardOsBreakdown {
  os: string;
  total: number;
  compliant: number;
  noncompliant: number;
  unknown: number;
}

export interface DashboardFleet {
  compliance: DashboardComplianceCount[];
  os: DashboardOsBreakdown[];
}

export interface DashboardRemediationDay {
  day: string;
  succeeded: number;
  failed: number;
}

export interface DashboardRemediation {
  days: DashboardRemediationDay[];
  succeeded: number;
  failed: number;
  /** null when zero runs — never divide by zero to render a rate. */
  successRate: number | null;
  failedLast24h: number;
}

export interface TimeToRemediateSeverityBucket {
  count: number;
  avgHours: number | null;
  p90Hours: number | null;
}

/** Average/p90 detected->remediated interval over the dashboard's selected
 * window. Only reflects prunes recorded since remediation-event tracking
 * shipped — see the caveat surfaced in TimeToRemediateCard. */
export interface DashboardTimeToRemediate {
  windowDays: number;
  count: number;
  avgHours: number | null;
  p90Hours: number | null;
  bySeverity: Record<Severity, TimeToRemediateSeverityBucket>;
}

/** One day's CVE detected/remediated counts — "detected" counts a CVE either
 * because it's still open with that `detectedAt`, or because it was later
 * remediated but first detected that day; "remediated" counts prune-recorded
 * fixes. Independent of the dashboard's windowDays control — always the last
 * 30 days, to keep the bar chart readable. */
export interface DashboardCveTrendDay {
  day: string;
  detected: number;
  remediated: number;
}

/** One posture_snapshots day — a single point on the trend chart. */
export interface DashboardTrendPoint {
  day: string;
  devices: number;
  devicesCompliant: number;
  devicesNoncompliant: number;
  devicesUnknown: number;
  openFindings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  slaBreached: number;
  slaDueSoon: number;
  slaOk: number;
}

export interface DashboardTrendCoverage {
  requestedDays: number;
  /** Distinct days actually captured — may be less than requestedDays. */
  capturedDays: number;
  firstDay: string | null;
  /** capturedDays >= requestedDays — false is the "collecting history" state. */
  complete: boolean;
}

export interface DashboardPerTenant {
  tenantId: string;
  displayName: string;
  reachability: Reachability;
  readOnly: boolean;
  lastSyncedAt: string | null;
  devices: number;
  critical: number;
  slaBreached: number;
  noncompliantDevices: number;
}

/** One "Most urgent vulnerabilities" table row — enough to render the row and
 * to locate the matching full `Vulnerability` (by `id`) once the drawer
 * lazily fetches the full list on first open. */
export interface DashboardUrgentVuln {
  id: string;
  tenantId: string;
  cveId: string;
  title: string;
  software: string;
  displayName: string;
  severity: Severity;
  affectedDeviceCount: number;
  exploitVerified: boolean;
  sla: Sla;
}

/** One "Devices needing attention" table row — same idea, for `Device`. */
export interface DashboardAttentionDevice {
  id: string;
  tenantId: string;
  managedDeviceId: string;
  hostname: string;
  os: string;
  compliance: DeviceCompliance;
  vulnerabilityCount: number;
}

/** Response from GET /api/dashboard/summary[?tenantId=&windowDays=]. */
export interface DashboardSummary {
  tenantId: string | null;
  generatedAt: string;
  demo: boolean;
  scope: DashboardScope;
  tiles: DashboardTiles;
  severity: DashboardSeverityCount[];
  slaBuckets: DashboardSlaBucket[];
  topSoftware: DashboardTopSoftware[];
  fleet: DashboardFleet;
  remediation: DashboardRemediation;
  timeToRemediate: DashboardTimeToRemediate;
  cveTrend: DashboardCveTrendDay[];
  trend: DashboardTrendPoint[];
  trendCoverage: DashboardTrendCoverage;
  /** Populated only in all-tenants mode (tenantId omitted from the request). */
  perTenant?: DashboardPerTenant[];
  urgentVulns: DashboardUrgentVuln[];
  attentionDevices: DashboardAttentionDevice[];
  /** Tenant ids with an active recommendation exception covering an
   *  OpenSSL-library finding — see apps/api/src/routes/dashboard.ts. */
  opensslExceptionTenantIds: string[];
}

// ---- Remediation History (GET /api/remediation-history) ----
// Mirrors apps/api/src/history/remediation-history.ts field-for-field — the
// attributed ledger of every closed finding. Reads the same remediation_events
// rows the Dashboard's time-to-remediate card and CVE trend chart read, so the
// page and the card can never disagree (same reasoning as DashboardTimeToRemediate).

export type RemediationEventKind = "vulnerability" | "recommendation";
/** How a closed finding was matched back to the work that (probably) closed
 * it — see the enum's own doc comment in schema.ts for the full reasoning. */
export type RemediationAttributionKind = "job" | "manual" | "unattributed";
/** "reclassified" marks the winget-matcher-correction false positive: nothing
 * was actually fixed, so these rows are excluded from time-to-remediate. */
export type RemediationClosure = "cleared" | "reclassified";

export interface RemediationHistoryRecord {
  id: string;
  tenantId: string;
  kind: RemediationEventKind;
  cveId: string | null;
  recommendationId: string | null;
  software: string | null;
  severity: Severity;
  /** Exposure clock: Defender's first detection. */
  detectedAt: string;
  /** Exposure clock: Defender confirmed the finding gone. */
  remediatedAt: string;
  deviceId: string | null;
  deviceHostname: string | null;
  engineer: string | null;
  jobId: string | null;
  channel: string | null;
  attribution: RemediationAttributionKind;
  /** Work clock: null together when attribution is "unattributed". */
  fixStartedAt: string | null;
  fixFinishedAt: string | null;
  contributingJobs: number;
  closure: RemediationClosure;
}

/** One keyset page — same no-COUNT(*) reasoning as AuditListResponse. */
export interface RemediationHistoryListResponse {
  rows: RemediationHistoryRecord[];
  nextCursor: string | null;
}

/** Client-side filter state; serialised to the query string by RemediationHistory.tsx. */
export interface RemediationHistoryQuery {
  cveId: string;
  software: string;
  deviceId: string;
  engineer: string;
  severity: Severity | "all";
  kind: RemediationEventKind | "all";
  attribution: RemediationAttributionKind | "all";
  /** Defaults to "cleared" server-side — "all" also surfaces reclassified rows, tagged. */
  closure: RemediationClosure | "all";
  q: string;
  /** `datetime-local` values (local time, no zone) — converted to ISO on send. */
  from: string;
  to: string;
}

/** Response from GET /api/remediation-history/stats — same filters as the list, unpaged. */
export interface RemediationHistoryStats {
  matchedRows: number;
  truncated: boolean;
  /** detectedAt -> remediatedAt: how long the tenant was exposed. */
  exposure: DashboardTimeToRemediate;
  /** fixStartedAt -> fixFinishedAt, attributed rows only: how long the fix itself took. */
  work: DashboardTimeToRemediate;
  byAttribution: Record<RemediationAttributionKind, number>;
}

/** Settings > Users — mirrors UserRecord from apps/api/src/routes/users.ts. Global,
 *  not tenant-scoped: a PatchPilot role applies everywhere (see @patchpilot/shared's rbac.ts). */
export interface User {
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
}

/** Settings > Notifications — mirrors the public shape from
 *  apps/api/src/routes/notification-settings.ts. Never carries the real
 *  password: `hasPassword` tells the UI whether one is already saved. */
export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  hasPassword: boolean;
  secure: boolean;
  from: string;
}

/** Per-tenant Live Response device quota usage, from GET /api/settings/entitlement. */
export interface EntitlementTenantUsage {
  tenantId: string;
  displayName: string;
  used: number;
  limit: number;
}

/** Settings > License — mirrors the decoded (never-raw-token) view from
 *  apps/api/src/routes/entitlement-settings.ts. Three tiers: free (default
 *  fallback, read-only above tenantLimit tenants unless a trial is active),
 *  pro (same shape as an active trial, populated by a license key), and
 *  unlimited (tenantLimit/deviceLicensePool both null — no numeric cap). */
export interface EntitlementView {
  hasEntitlement: boolean;
  instanceId: string | null;
  /** Always a real value — "free" is the default/fallback tier, not the absence of one. */
  tier: string;
  /** `null` only when `unlimited` is true — never enforced as a numeric cap there. */
  tenantLimit: number | null;
  // Total instance-wide Live Response device pool the vendor issued (or the
  // trial's 30-device pool while active). How it's split across tenants is
  // deviceLicenseAllocated / perTenantDeviceUsage below, set by the MSP's own
  // admin under Settings > Tenants. `null` only when `unlimited` is true.
  deviceLicensePool: number | null;
  // Sum of every tenant's own liveResponseDeviceLimit allocation — always
  // <= deviceLicensePool (enforced when an allocation is set).
  deviceLicenseAllocated: number;
  unlimited: boolean;
  writeEnabled: boolean;
  issuedAt: string | null;
  expiresAt: string | null;
  /** True only for a verified, currently-valid pro/unlimited token. */
  valid: boolean;
  invalidReason: string | null;
  /** Tenants with `reachability === "reachable"` only — a merely-discovered GDAP relationship never counts against the tenant limit; only a tenant PatchPilot's own app can actually reach does. */
  consentedTenantCount: number;
  perTenantDeviceUsage: EntitlementTenantUsage[];
  trialStartedAt: string | null;
  trialExpiresAt: string | null;
  trialActive: boolean;
  /** True when the free tier's one-time self-serve trial has never been started. */
  trialAvailable: boolean;
}
