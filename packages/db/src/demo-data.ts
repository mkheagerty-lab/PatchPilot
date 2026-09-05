/**
 * Single source of truth for demo/seed data.
 *
 * Used in two places:
 *   1. `seed.ts` inserts these rows into Postgres (real dev/prod with Docker).
 *   2. The API serves them directly from memory when DEMO_MODE=true, so the
 *      console is fully clickable with NO database and NO Microsoft wiring.
 *
 * Rows carry explicit `id`/timestamps so both paths are deterministic and the
 * frontend (which keys on `id`) is stable across restarts.
 *
 * Dates are anchored relative to ANCHOR so SLA chips show a realistic mix of
 * overdue / due-soon / on-track without needing to be re-edited over time.
 */
import type { InferSelectModel } from "drizzle-orm";
import {
  DEFAULT_SLA,
  computeSla,
  slaTone,
  isOsFinding,
  matchWinget,
  type Severity,
  type WingetCatalogEntry,
} from "@patchpilot/shared";
import {
  tenants,
  devices,
  deviceVulnerabilities,
  vulnerabilities,
  recommendations,
  wingetCatalog,
  wingetCatalogOverride,
  jobs,
  schedules,
  softwareInventory,
  deviceSoftware,
  chocolateyCatalog,
  chocolateyCatalogOverride,
  missingKbs,
  recommendationExceptions,
  deviceExclusions,
  deviceGroups,
  deviceGroupMembers,
  auditLog,
  postureSnapshots,
  remediationEvents,
  engineers,
} from "./schema.js";

export type TenantRow = InferSelectModel<typeof tenants>;
export type DeviceRow = InferSelectModel<typeof devices>;
export type DeviceVulnerabilityRow = InferSelectModel<typeof deviceVulnerabilities>;
export type VulnerabilityRow = InferSelectModel<typeof vulnerabilities>;
export type RecommendationRow = InferSelectModel<typeof recommendations>;
export type WingetCatalogRow = InferSelectModel<typeof wingetCatalog>;
export type WingetCatalogOverrideRow = InferSelectModel<typeof wingetCatalogOverride>;
export type JobRow = InferSelectModel<typeof jobs>;
export type ScheduleRow = InferSelectModel<typeof schedules>;
export type SoftwareInventoryRow = InferSelectModel<typeof softwareInventory>;
export type DeviceSoftwareRow = InferSelectModel<typeof deviceSoftware>;
export type ChocolateyCatalogRow = InferSelectModel<typeof chocolateyCatalog>;
export type ChocolateyCatalogOverrideRow = InferSelectModel<typeof chocolateyCatalogOverride>;
export type MissingKbRow = InferSelectModel<typeof missingKbs>;
export type RecommendationExceptionRow = InferSelectModel<typeof recommendationExceptions>;
export type DeviceExclusionRow = InferSelectModel<typeof deviceExclusions>;
export type DeviceGroupRow = InferSelectModel<typeof deviceGroups>;
export type DeviceGroupMemberRow = InferSelectModel<typeof deviceGroupMembers>;
export type AuditLogRow = InferSelectModel<typeof auditLog>;
export type RemediationEventRow = InferSelectModel<typeof remediationEvents>;
// No demo/seed fixture — DEMO_MODE injects a synthetic admin session directly
// (see server.ts) rather than reading this table, and seed.ts deliberately
// never touches `engineers` (it must survive a reseed). The type is exported
// purely so API/web code has something to import.
export type EngineerRow = InferSelectModel<typeof engineers>;

/** Anchor "now" for demo dates. Kept fixed so the seeded story is reproducible. */
const ANCHOR = new Date("2026-06-23T00:00:00Z");
/** Days before/after the anchor, as a Date. */
const daysFromAnchor = (n: number): Date =>
  new Date(ANCHOR.getTime() + n * 24 * 60 * 60 * 1000);

export const demoTenants: TenantRow[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    tenantId: "msp-root",
    displayName: "Black Iron (MSP)",
    consentStatus: "consented",
    reachability: "reachable",
    readOnly: false,
    licenses: ["intune", "mde-p2"],
    isMspTenant: true,
    lastSyncedAt: daysFromAnchor(-1),
    featureUpdateTargetVersion: null,
    // Demo mode never enforces the Live Response device quota (see
    // packages/graph/src/live-response-quota.ts's DEMO_MODE short-circuit),
    // so this value is unused — kept at the real fail-closed default for
    // consistency with a freshly-migrated tenant row.
    liveResponseDeviceLimit: 0,
    createdAt: daysFromAnchor(-120),
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    tenantId: "contoso",
    displayName: "Contoso Legal",
    consentStatus: "consented",
    reachability: "reachable",
    readOnly: true,
    licenses: ["intune", "mde-p2"],
    isMspTenant: false,
    lastSyncedAt: daysFromAnchor(0),
    // Demonstrates the per-tenant setting: Contoso intentionally lags the
    // latest release, so the "23H2 or later" line in demoDevices below shows
    // both sides of the badge threshold.
    featureUpdateTargetVersion: "23H2",
    liveResponseDeviceLimit: 0,
    createdAt: daysFromAnchor(-60),
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    tenantId: "northwind",
    displayName: "Northwind Sales",
    consentStatus: "pending",
    reachability: "unknown",
    readOnly: true,
    licenses: [],
    isMspTenant: false,
    // Northwind has never been synced — drives the "—" / "Never" UI state.
    lastSyncedAt: null,
    featureUpdateTargetVersion: null,
    liveResponseDeviceLimit: 0,
    createdAt: daysFromAnchor(-3),
  },
];

export const demoDevices: DeviceRow[] = [
  {
    id: "d0000001-0000-0000-0000-000000000001",
    tenantId: "contoso",
    managedDeviceId: "dev-1",
    defenderMachineId: "mde-1",
    hostname: "CON-LT-014",
    os: "Windows 11 Enterprise 23H2",
    osBuild: 22631,
    lastSeen: daysFromAnchor(-1),
    compliance: "noncompliant",
    vulnerabilityCount: 7,
    owner: "a.smith@contoso.com",
    model: "Latitude 7440",
    manufacturer: "Dell Inc.",
    serialNumber: "7KQ2X94",
    deviceGroupId: "grp-sales",
    deviceGroupName: "Sales & Marketing",
  },
  {
    id: "d0000002-0000-0000-0000-000000000002",
    tenantId: "contoso",
    managedDeviceId: "dev-2",
    defenderMachineId: "mde-2",
    hostname: "CON-DT-007",
    os: "Windows 11 Pro 24H2",
    osBuild: 26100,
    lastSeen: daysFromAnchor(0),
    compliance: "compliant",
    vulnerabilityCount: 1,
    owner: "j.doe@contoso.com",
    model: "OptiPlex 7010",
    manufacturer: "Dell Inc.",
    serialNumber: "9YH4ZL2",
    deviceGroupId: "grp-finance",
    deviceGroupName: "Finance",
  },
  {
    id: "d0000003-0000-0000-0000-000000000003",
    tenantId: "contoso",
    managedDeviceId: "dev-3",
    defenderMachineId: "mde-3",
    hostname: "CON-LT-022",
    os: "Windows 10 Pro 22H2",
    osBuild: 19045,
    lastSeen: daysFromAnchor(-9),
    compliance: "noncompliant",
    vulnerabilityCount: 4,
    owner: "r.lee@contoso.com",
    model: "ThinkPad X1 Carbon Gen 11",
    manufacturer: "LENOVO",
    serialNumber: "PF3ABC12",
    deviceGroupId: "grp-engineering",
    deviceGroupName: "Engineering",
  },
  {
    id: "d0000004-0000-0000-0000-000000000004",
    tenantId: "northwind",
    managedDeviceId: "dev-4",
    defenderMachineId: null,
    hostname: "NW-SVR-001",
    os: "Windows Server 2022",
    osBuild: 20348,
    lastSeen: null,
    compliance: "unknown",
    vulnerabilityCount: 0,
    owner: null,
    model: "PowerEdge R750",
    manufacturer: "Dell Inc.",
    serialNumber: "BTRX4Z3",
    deviceGroupId: "grp-servers",
    deviceGroupName: "Servers",
  },
];

/**
 * Device ⇄ CVE exposure rows — the persisted form of Defender's transient
 * `affectedMachineIds`, keyed by `defenderMachineId` so the device detail panel
 * can filter CVEs to one machine. Only Defender-onboarded contoso devices appear
 * (mde-1/2/3); the Northwind server has no Defender machine id, so it has no rows.
 * Counts here line up with each device's `vulnerabilityCount` above.
 */
/**
 * Detection evidence per CVE — the installed version + disk path(s) where
 * Defender found the vulnerable product, mirroring the export-assessment
 * (SoftwareVulnerabilitiesByMachine) surface that populates these columns in
 * live mode. Keyed by cveId; the OS finding (CVE-2025-50999) has none because
 * Defender reports OS-component CVEs without a file-level disk path.
 */
const demoEvidenceByCve: Record<
  string,
  { softwareVersion: string | null; diskPaths: string[] | null; registryPaths: string[] | null }
> = {
  "CVE-2025-12345": {
    softwareVersion: "23.01",
    diskPaths: ["C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files\\7-Zip\\7zFM.exe"],
    registryPaths: [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\7-Zip",
    ],
  },
  "CVE-2025-22001": {
    softwareVersion: "125.0.1",
    diskPaths: ["C:\\Program Files\\Mozilla Firefox\\firefox.exe"],
    registryPaths: [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mozilla Firefox",
    ],
  },
  "CVE-2025-33010": {
    softwareVersion: "8.6.2",
    diskPaths: ["C:\\Program Files\\Notepad++\\notepad++.exe"],
    registryPaths: [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Notepad++",
    ],
  },
  "CVE-2025-40555": {
    softwareVersion: "126.0.6478.127",
    diskPaths: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
    registryPaths: [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Google Chrome",
    ],
  },
  "CVE-2025-50999": { softwareVersion: null, diskPaths: null, registryPaths: null },
  "CVE-2025-60001": {
    softwareVersion: "1.2.10",
    diskPaths: ["C:\\Program Files\\Greenshot\\Greenshot.exe"],
    registryPaths: [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Greenshot",
    ],
  },
  "CVE-2025-60011": {
    softwareVersion: "2.2402.7.0",
    diskPaths: [
      "C:\\Users\\jdoe\\AppData\\Local\\WhatsApp\\WhatsApp.exe",
    ],
    registryPaths: [
      "HKEY_USERS\\S-1-5-21-111111111-222222222-333333333-1001\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WhatsApp",
    ],
  },
};

const evidenceFor = (cveId: string) =>
  demoEvidenceByCve[cveId] ?? { softwareVersion: null, diskPaths: null, registryPaths: null };

// Each demo CVE maps to exactly one product (real Defender data can map one CVE
// to several — the (CVE, software) grain the schema now stores). The device⇄CVE
// linkage carries this so it exactly matches the stored `vulnerabilities.software`.
const demoSoftwareByCve: Record<string, string> = {
  "CVE-2025-12345": "7-Zip",
  "CVE-2025-22001": "Mozilla Firefox",
  "CVE-2025-33010": "Notepad++",
  "CVE-2025-40555": "Google Chrome",
  "CVE-2025-50999": "Microsoft Windows",
  "CVE-2025-60001": "Greenshot",
  "CVE-2025-60011": "WhatsApp",
};
const softwareFor = (cveId: string) => demoSoftwareByCve[cveId] ?? "Unknown software";

export const demoDeviceVulnerabilities: DeviceVulnerabilityRow[] = [
  // CON-LT-014 (mde-1) — the worst box: exposed to every demo CVE, including
  // the two not-supported apps (Greenshot, WhatsApp).
  ...[
    "CVE-2025-12345",
    "CVE-2025-22001",
    "CVE-2025-33010",
    "CVE-2025-40555",
    "CVE-2025-50999",
    "CVE-2025-60001",
    "CVE-2025-60011",
  ].map((cveId, i) => ({
    id: `db000001-0000-0000-0000-00000000000${i + 1}`,
    tenantId: "contoso",
    defenderMachineId: "mde-1",
    cveId,
    software: softwareFor(cveId),
    ...evidenceFor(cveId),
  })),
  // CON-DT-007 (mde-2) — compliant, only the low-severity OS finding.
  {
    id: "db000002-0000-0000-0000-000000000001",
    tenantId: "contoso",
    defenderMachineId: "mde-2",
    cveId: "CVE-2025-50999",
    software: softwareFor("CVE-2025-50999"),
    ...evidenceFor("CVE-2025-50999"),
  },
  // CON-LT-022 (mde-3) — Notepad++, Chrome, the OS finding, and Greenshot
  // (a not-supported app routed through Chocolatey).
  ...[
    "CVE-2025-33010",
    "CVE-2025-40555",
    "CVE-2025-50999",
    "CVE-2025-60001",
  ].map((cveId, i) => ({
    id: `db000003-0000-0000-0000-00000000000${i + 1}`,
    tenantId: "contoso",
    defenderMachineId: "mde-3",
    cveId,
    software: softwareFor(cveId),
    ...evidenceFor(cveId),
  })),
];

export const demoVulnerabilities: VulnerabilityRow[] = [
  {
    id: "fa000001-0000-0000-0000-000000000001",
    tenantId: "contoso",
    cveId: "CVE-2025-12345",
    title: "7-Zip heap overflow in archive parsing",
    severity: "critical",
    cvss: 9.8,
    affectedDeviceCount: 4,
    software: "7-Zip",
    publisher: "Igor Pavlov",
    description:
      "A heap-based buffer overflow in 7-Zip's archive parser allows a crafted archive to execute arbitrary code in the context of the user opening it.",
    cvssVector: "CVSS:3.1/AV:L/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H",
    epss: 0.42,
    publishedOn: daysFromAnchor(-16),
    updatedOn: daysFromAnchor(-11),
    exploitAvailable: true,
    exploitVerified: false,
    detectedAt: daysFromAnchor(-13), // critical, 7d SLA -> overdue
    lastSeenAt: daysFromAnchor(0),
    wingetRemediable: true,
    wingetPackageId: "7zip.7zip",
    status: "open",
  },
  {
    id: "fa000002-0000-0000-0000-000000000002",
    tenantId: "contoso",
    cveId: "CVE-2025-22001",
    title: "Firefox remote code execution",
    severity: "critical",
    cvss: 9.1,
    affectedDeviceCount: 2,
    software: "Mozilla Firefox",
    publisher: "Mozilla",
    description:
      "A use-after-free in Firefox's rendering engine can be triggered by a malicious web page, leading to remote code execution.",
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H",
    epss: 0.67,
    publishedOn: daysFromAnchor(-7),
    updatedOn: daysFromAnchor(-4),
    exploitAvailable: true,
    // Verified exploit tightens the 7d critical SLA to the 3d override,
    // flipping this from "due soon" to overdue — demoes the new threshold.
    exploitVerified: true,
    detectedAt: daysFromAnchor(-5), // critical, 7d SLA -> due soon (3d verified-exploit SLA -> overdue)
    lastSeenAt: daysFromAnchor(0),
    wingetRemediable: true,
    wingetPackageId: "Mozilla.Firefox",
    status: "open",
  },
  {
    id: "fa000003-0000-0000-0000-000000000003",
    tenantId: "contoso",
    cveId: "CVE-2025-33010",
    title: "Notepad++ DLL hijacking",
    severity: "high",
    cvss: 7.8,
    affectedDeviceCount: 3,
    software: "Notepad++",
    publisher: "Notepad++ Team",
    description:
      "Notepad++ loads a dependency DLL from its working directory, allowing a planted DLL to run with the privileges of the user launching the editor.",
    cvssVector: "CVSS:3.1/AV:L/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H",
    epss: 0.08,
    publishedOn: daysFromAnchor(-24),
    updatedOn: daysFromAnchor(-18),
    exploitAvailable: false,
    exploitVerified: false,
    detectedAt: daysFromAnchor(-20), // high, 14d SLA -> overdue
    lastSeenAt: daysFromAnchor(0),
    wingetRemediable: true,
    wingetPackageId: "Notepad++.Notepad++",
    status: "in-progress",
  },
  {
    id: "fa000004-0000-0000-0000-000000000004",
    tenantId: "contoso",
    cveId: "CVE-2025-40555",
    title: "Google Chrome type confusion in V8",
    severity: "high",
    cvss: 8.3,
    affectedDeviceCount: 1,
    software: "Google Chrome",
    publisher: "Google LLC",
    description:
      "A type confusion bug in Chrome's V8 JavaScript engine allows a crafted page to corrupt memory and potentially execute arbitrary code.",
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H",
    epss: 0.31,
    publishedOn: daysFromAnchor(-8),
    updatedOn: daysFromAnchor(-5),
    // Verified exploit tightens the 14d high SLA to the 3d override,
    // flipping this from "on track" to overdue — demoes the new threshold.
    exploitAvailable: true,
    exploitVerified: true,
    detectedAt: daysFromAnchor(-6), // high, 14d SLA -> on track (3d verified-exploit SLA -> overdue)
    lastSeenAt: daysFromAnchor(0),
    wingetRemediable: true,
    wingetPackageId: "Google.Chrome",
    status: "open",
  },
  {
    id: "fa000005-0000-0000-0000-000000000005",
    tenantId: "contoso",
    cveId: "CVE-2025-50999",
    title: "Windows TCP/IP information disclosure",
    severity: "medium",
    cvss: 5.4,
    affectedDeviceCount: 5,
    software: "Microsoft Windows",
    publisher: "Microsoft",
    description:
      "A flaw in the Windows TCP/IP stack allows a remote attacker to read fragments of kernel memory by sending specially crafted packets.",
    cvssVector: "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N",
    epss: 0.02,
    publishedOn: daysFromAnchor(-14),
    updatedOn: daysFromAnchor(-9),
    exploitAvailable: false,
    exploitVerified: false,
    detectedAt: daysFromAnchor(-10), // medium, 30d SLA -> on track (OS patch)
    lastSeenAt: daysFromAnchor(0),
    wingetRemediable: false,
    wingetPackageId: null,
    status: "open",
  },
  {
    // App finding winget can't resolve — there is no winget package for
    // Greenshot, so coverage marks it `not-supported`. It is still an APP (not
    // OS), so it routes through the alternate-source (Chocolatey) path.
    id: "fa000006-0000-0000-0000-000000000006",
    tenantId: "contoso",
    cveId: "CVE-2025-60001",
    title: "Greenshot insecure plugin loading",
    severity: "high",
    cvss: 7.4,
    affectedDeviceCount: 2,
    software: "Greenshot",
    publisher: "Greenshot",
    description:
      "Greenshot loads image-export plugins from a user-writable directory without verifying their origin, allowing a planted plugin to run when a screenshot is exported.",
    cvssVector: "CVSS:3.1/AV:L/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:L",
    epss: 0.05,
    publishedOn: daysFromAnchor(-21),
    updatedOn: daysFromAnchor(-15),
    exploitAvailable: false,
    exploitVerified: false,
    detectedAt: daysFromAnchor(-19), // high, 14d SLA -> overdue
    lastSeenAt: daysFromAnchor(0),
    wingetRemediable: false,
    wingetPackageId: null,
    status: "open",
  },
  {
    // App finding winget can't resolve — WhatsApp is a Store-published app, so
    // coverage marks it `not-supported` and the alternate-source path routes it
    // through the Microsoft Store source.
    id: "fa000007-0000-0000-0000-000000000007",
    tenantId: "contoso",
    cveId: "CVE-2025-60011",
    title: "WhatsApp Desktop path traversal in file preview",
    severity: "high",
    cvss: 8.1,
    affectedDeviceCount: 1,
    software: "WhatsApp",
    publisher: "WhatsApp LLC",
    description:
      "A path-traversal flaw in WhatsApp Desktop's attachment preview lets a crafted message write files outside the intended cache directory.",
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:N",
    epss: 0.12,
    publishedOn: daysFromAnchor(-9),
    updatedOn: daysFromAnchor(-5),
    exploitAvailable: false,
    exploitVerified: false,
    detectedAt: daysFromAnchor(-6), // high, 14d SLA -> on track
    lastSeenAt: daysFromAnchor(0),
    wingetRemediable: false,
    wingetPackageId: null,
    status: "open",
  },
];

/**
 * Defender security recommendations, 1:1 with the rows on the portal's
 * Recommendations page — `recommendationName` is Defender's verbatim title and is
 * the row identity everywhere in the UI. `weaknessCount` is deliberately larger
 * than the count of demo CVEs above to tell the real story: Defender reopens
 * hundreds of historical CVEs per product, and the recommendation is the single
 * actionable roll-up.
 *
 * The portal splits these across two tables and so does PatchPilot: "Update …"
 * rows (`category` Software/OS) land under Vulnerabilities; the
 * `ConfigurationChange` rows below land under Misconfigurations, which carry a
 * `configScoreImpact` instead of CVEs and have no SLA clock. The OpenSSL and
 * Windows 11 rows exist to exercise the "listed, but Fix now is disabled" path
 * (library-level and OS findings PatchPilot can't dispatch via winget), and the
 * `recommendationStatus: "Exception"` row exercises a portal-side exception.
 */
export const demoRecommendations: RecommendationRow[] = [
  {
    id: "30000001-0000-0000-0000-000000000001",
    tenantId: "contoso",
    recommendationId: "va-_-igor-pavlov-_-7-zip",
    recommendationName: "Update 7-Zip to version 24.08",
    productName: "7-Zip",
    vendor: "Igor Pavlov",
    recommendedVersion: "24.08",
    severity: "critical",
    severityScore: 9.8,
    weaknessCount: 23,
    exposedMachinesCount: 4,
    totalMachineCount: 4,
    publicExploit: true,
    remediationType: "Update",
    category: "Software",
    recommendationStatus: "Active",
    osPlatform: "Windows10AndAbove",
    subCategory: null,
    relatedComponent: "7-Zip",
    exposureImpact: 4.2,
    configScoreImpact: null,
    activeAlert: true,
    associatedThreats: ["Ransomware delivery via archive files"],
    detectedAt: daysFromAnchor(-13),
    status: "open",
  },
  {
    id: "30000002-0000-0000-0000-000000000002",
    tenantId: "contoso",
    recommendationId: "va-_-mozilla-_-firefox",
    recommendationName: "Update Mozilla Firefox to version 127.0.1",
    productName: "Mozilla Firefox",
    vendor: "Mozilla",
    recommendedVersion: "127.0.1",
    severity: "critical",
    severityScore: 9.1,
    weaknessCount: 148,
    exposedMachinesCount: 2,
    totalMachineCount: 3,
    publicExploit: true,
    remediationType: "Update",
    category: "Software",
    recommendationStatus: "Active",
    osPlatform: "Windows10AndAbove",
    subCategory: null,
    relatedComponent: "Web browser",
    exposureImpact: 3.7,
    configScoreImpact: null,
    activeAlert: false,
    associatedThreats: [],
    detectedAt: daysFromAnchor(-5),
    status: "open",
  },
  {
    id: "30000003-0000-0000-0000-000000000003",
    tenantId: "contoso",
    recommendationId: "va-_-notepad-_-notepad",
    recommendationName: "Update Notepad++ to version 8.6.9",
    productName: "Notepad++",
    vendor: "Notepad++ Team",
    recommendedVersion: "8.6.9",
    severity: "high",
    severityScore: 7.8,
    weaknessCount: 11,
    exposedMachinesCount: 3,
    totalMachineCount: 4,
    publicExploit: false,
    remediationType: "Update",
    category: "Software",
    recommendationStatus: "Active",
    osPlatform: "Windows10AndAbove",
    subCategory: null,
    relatedComponent: "Notepad++",
    exposureImpact: 1.9,
    configScoreImpact: null,
    activeAlert: false,
    associatedThreats: [],
    detectedAt: daysFromAnchor(-20),
    status: "in-progress",
  },
  {
    id: "30000004-0000-0000-0000-000000000004",
    tenantId: "contoso",
    recommendationId: "va-_-google-_-chrome",
    recommendationName: "Update Google Chrome to version 126.0.6478.127",
    productName: "Google Chrome",
    vendor: "Google LLC",
    recommendedVersion: "126.0.6478.127",
    severity: "high",
    severityScore: 8.3,
    weaknessCount: 312,
    exposedMachinesCount: 1,
    totalMachineCount: 4,
    publicExploit: false,
    remediationType: "Update",
    category: "Software",
    recommendationStatus: "Active",
    osPlatform: "Windows10AndAbove",
    subCategory: null,
    relatedComponent: "Web browser",
    exposureImpact: 2.8,
    configScoreImpact: null,
    activeAlert: false,
    associatedThreats: [],
    detectedAt: daysFromAnchor(-6),
    status: "open",
  },
  {
    id: "30000005-0000-0000-0000-000000000005",
    tenantId: "contoso",
    recommendationId: "va-_-microsoft-_-windows-11",
    recommendationName: "Update Microsoft Windows 11 (OS and built-in applications)",
    productName: "Microsoft Windows 11",
    vendor: "Microsoft",
    recommendedVersion: null,
    severity: "medium",
    severityScore: 5.4,
    weaknessCount: 64,
    exposedMachinesCount: 5,
    totalMachineCount: 5,
    publicExploit: false,
    remediationType: "Update",
    category: "OS",
    recommendationStatus: "Active",
    osPlatform: "Windows11",
    subCategory: null,
    relatedComponent: "Operating System",
    exposureImpact: 6.5,
    configScoreImpact: null,
    activeAlert: false,
    associatedThreats: [],
    detectedAt: daysFromAnchor(-10),
    status: "open",
  },
  {
    // Library-level finding: PatchPilot can't dispatch this (no winget package
    // ships the fix — the owning app has to be updated), so it lists with
    // "Fix now" disabled. See requiresManualRemediation in @patchpilot/shared.
    id: "30000006-0000-0000-0000-000000000006",
    tenantId: "contoso",
    recommendationId: "va-_-openssl-_-openssl",
    recommendationName: "Update owning apps: vulnerable OpenSSL libraries detected",
    productName: "OpenSSL",
    vendor: "OpenSSL",
    recommendedVersion: null,
    severity: "high",
    severityScore: 7.4,
    weaknessCount: 9,
    exposedMachinesCount: 3,
    totalMachineCount: 5,
    publicExploit: true,
    remediationType: "Attention required",
    category: "Software",
    recommendationStatus: "Active",
    osPlatform: "Windows10AndAbove",
    subCategory: null,
    relatedComponent: "OpenSSL",
    exposureImpact: 3.1,
    configScoreImpact: null,
    activeAlert: true,
    associatedThreats: ["Exploitation of vulnerable TLS libraries"],
    detectedAt: daysFromAnchor(-32),
    status: "open",
  },
  {
    // Excepted in the Defender portal, not in PatchPilot — ingested so it can be
    // shown as excepted rather than silently missing, hidden from the default view.
    id: "30000007-0000-0000-0000-000000000007",
    tenantId: "contoso",
    recommendationId: "va-_-videolan-_-vlc-media-player",
    recommendationName: "Update VLC media player to version 3.0.21",
    productName: "VLC media player",
    vendor: "VideoLAN",
    recommendedVersion: "3.0.21",
    severity: "medium",
    severityScore: 5.9,
    weaknessCount: 7,
    exposedMachinesCount: 2,
    totalMachineCount: 5,
    publicExploit: false,
    remediationType: "Update",
    category: "Software",
    recommendationStatus: "Exception",
    osPlatform: "Windows10AndAbove",
    subCategory: null,
    relatedComponent: "VLC media player",
    exposureImpact: 0.9,
    configScoreImpact: null,
    activeAlert: false,
    associatedThreats: [],
    detectedAt: daysFromAnchor(-45),
    status: "open",
  },

  // ---- Misconfigurations (the portal's second Recommendations table) ----
  {
    id: "30000008-0000-0000-0000-000000000008",
    tenantId: "contoso",
    recommendationId: "scid-2000",
    recommendationName: "Turn on Microsoft Defender Antivirus real-time protection",
    productName: "Microsoft Defender Antivirus",
    vendor: "Microsoft",
    recommendedVersion: null,
    severity: "critical",
    severityScore: 9.4,
    weaknessCount: 0,
    exposedMachinesCount: 2,
    totalMachineCount: 5,
    publicExploit: false,
    remediationType: "ConfigurationChange",
    category: "Security controls",
    recommendationStatus: "Active",
    osPlatform: "Windows10AndAbove",
    subCategory: "Antivirus",
    relatedComponent: "Microsoft Defender Antivirus",
    exposureImpact: null,
    configScoreImpact: 8.5,
    activeAlert: true,
    associatedThreats: ["Malware execution on unprotected endpoints"],
    detectedAt: daysFromAnchor(-18),
    status: "open",
  },
  {
    id: "30000009-0000-0000-0000-000000000009",
    tenantId: "contoso",
    recommendationId: "scid-4001",
    recommendationName: "Disable NTLM authentication",
    productName: "Windows Security",
    vendor: "Microsoft",
    recommendedVersion: null,
    severity: "high",
    severityScore: 7.9,
    weaknessCount: 0,
    exposedMachinesCount: 5,
    totalMachineCount: 5,
    publicExploit: false,
    remediationType: "ConfigurationChange",
    category: "Accounts",
    recommendationStatus: "Active",
    osPlatform: "Windows10AndAbove",
    subCategory: "Authentication",
    relatedComponent: "Windows Security",
    exposureImpact: null,
    configScoreImpact: 6.0,
    activeAlert: false,
    associatedThreats: ["Credential relay and pass-the-hash"],
    detectedAt: daysFromAnchor(-27),
    status: "open",
  },
  {
    id: "3000000a-0000-0000-0000-00000000000a",
    tenantId: "contoso",
    recommendationId: "scid-91",
    recommendationName: "Turn on Windows Defender Firewall for the public network profile",
    productName: "Windows Defender Firewall",
    vendor: "Microsoft",
    recommendedVersion: null,
    severity: "high",
    severityScore: 7.1,
    weaknessCount: 0,
    exposedMachinesCount: 1,
    totalMachineCount: 5,
    publicExploit: false,
    remediationType: "ConfigurationChange",
    category: "Network",
    recommendationStatus: "Active",
    osPlatform: "Windows10AndAbove",
    subCategory: "Firewall",
    relatedComponent: "Windows Defender Firewall",
    exposureImpact: null,
    configScoreImpact: 4.5,
    activeAlert: false,
    associatedThreats: [],
    detectedAt: daysFromAnchor(-9),
    status: "open",
  },
  {
    id: "3000000b-0000-0000-0000-00000000000b",
    tenantId: "contoso",
    recommendationId: "scid-2010",
    recommendationName: "Block Office applications from creating child processes",
    productName: "Attack surface reduction rules",
    vendor: "Microsoft",
    recommendedVersion: null,
    severity: "medium",
    severityScore: 6.2,
    weaknessCount: 0,
    exposedMachinesCount: 4,
    totalMachineCount: 5,
    publicExploit: false,
    remediationType: "ConfigurationChange",
    category: "Security controls",
    recommendationStatus: "Active",
    osPlatform: "Windows10AndAbove",
    subCategory: "Attack surface reduction",
    relatedComponent: "Microsoft Defender Antivirus",
    exposureImpact: null,
    configScoreImpact: 3.0,
    activeAlert: false,
    associatedThreats: ["Macro-based initial access"],
    detectedAt: daysFromAnchor(-14),
    status: "open",
  },
  {
    id: "3000000c-0000-0000-0000-00000000000c",
    tenantId: "contoso",
    recommendationId: "scid-5008",
    recommendationName: "Require multifactor authentication for local administrator accounts",
    productName: "Windows Security",
    vendor: "Microsoft",
    recommendedVersion: null,
    severity: "medium",
    severityScore: 5.1,
    weaknessCount: 0,
    exposedMachinesCount: 3,
    totalMachineCount: 5,
    publicExploit: false,
    remediationType: "ConfigurationChange",
    category: "Accounts",
    recommendationStatus: "Active",
    osPlatform: "Windows10AndAbove",
    subCategory: "Authentication",
    relatedComponent: "Windows Security",
    exposureImpact: null,
    configScoreImpact: 2.5,
    activeAlert: false,
    associatedThreats: [],
    detectedAt: daysFromAnchor(-38),
    status: "open",
  },
];

/**
 * Winget catalog: the MDVM software-title -> winget package-id mapping. Covers
 * the third-party apps in demoVulnerabilities (so coverage shows as resolved)
 * plus a couple of extra packages to make the catalog page realistic. The OS
 * finding (Microsoft Windows) is intentionally absent — it's not winget-remediable.
 */
export const demoWingetCatalog: WingetCatalogRow[] = [
  {
    id: "c0000001-0000-0000-0000-000000000001",
    packageId: "7zip.7zip",
    name: "7-Zip",
    publisher: "Igor Pavlov",
    latestVersion: "24.08",
    softwareTitle: "7-Zip",
    source: "curated",
    lastRefreshedAt: null,
  },
  {
    id: "c0000002-0000-0000-0000-000000000002",
    packageId: "Mozilla.Firefox",
    name: "Mozilla Firefox",
    publisher: "Mozilla",
    latestVersion: "127.0.1",
    softwareTitle: "Mozilla Firefox",
    source: "curated",
    lastRefreshedAt: null,
  },
  {
    id: "c0000003-0000-0000-0000-000000000003",
    packageId: "Notepad++.Notepad++",
    name: "Notepad++",
    publisher: "Notepad++ Team",
    latestVersion: "8.6.9",
    softwareTitle: "Notepad++",
    source: "curated",
    lastRefreshedAt: null,
  },
  {
    id: "c0000004-0000-0000-0000-000000000004",
    packageId: "Google.Chrome",
    name: "Google Chrome",
    publisher: "Google LLC",
    latestVersion: "126.0.6478.127",
    softwareTitle: "Google Chrome",
    source: "curated",
    lastRefreshedAt: null,
  },
  {
    id: "c0000005-0000-0000-0000-000000000005",
    packageId: "VideoLAN.VLC",
    name: "VLC media player",
    publisher: "VideoLAN",
    latestVersion: "3.0.21",
    softwareTitle: "VLC media player",
    source: "curated",
    lastRefreshedAt: null,
  },
  {
    id: "c0000006-0000-0000-0000-000000000006",
    packageId: "Zoom.Zoom",
    name: "Zoom Workplace",
    publisher: "Zoom Video Communications, Inc.",
    latestVersion: "6.1.5",
    softwareTitle: "Zoom",
    source: "curated",
    lastRefreshedAt: null,
  },
  {
    // Software Inventory headline example: Defender lists this in inventory
    // (device software + telemetry) but doesn't run weakness/CVE detection on
    // it — see the CVE-free `demoSoftwareInventory` row below — yet it still
    // resolves to a winget package, so Fix Now works even though Vulnerabilities
    // never surfaces it.
    id: "c0000007-0000-0000-0000-000000000007",
    packageId: "Nvidia.App",
    name: "NVIDIA App",
    publisher: "NVIDIA Corporation",
    latestVersion: "11.0.4.204",
    softwareTitle: "NVIDIA App",
    source: "curated",
    lastRefreshedAt: null,
  },
];

/**
 * Manual catalog overrides. Empty in demo: the curated `demoWingetCatalog` above
 * already resolves every applicable demo finding, and overrides are an authored,
 * write-time feature that DEMO_MODE disables. The shape is exported so the API can
 * serve a stable empty list and the matcher's "manual" path stays well-typed.
 */
export const demoWingetCatalogOverrides: WingetCatalogOverrideRow[] = [];

/**
 * Chocolatey catalog: the user-context counterpart to `demoWingetCatalog` (see
 * chocolatey.ts's doc comment) — resolves software titles that a SYSTEM-context
 * Live Response session can't reach (per-user installs) or that winget simply
 * doesn't package. Greenshot has no winget package (see `demoVulnerabilities`
 * v0000006) so it routes here even though its install is machine-wide; Discord
 * is a genuine per-user install with no CVE row of its own, demonstrating the
 * same "Defender inventories it, doesn't score it, we can still fix it" story
 * as the NVIDIA App winget example above.
 */
export const demoChocolateyCatalog: ChocolateyCatalogRow[] = [
  {
    id: "70000001-0000-0000-0000-000000000001",
    packageId: "greenshot",
    name: "Greenshot",
    publisher: "Greenshot",
    latestVersion: "1.3.290",
    softwareTitle: "Greenshot",
    source: "curated",
    lastRefreshedAt: null,
  },
  {
    id: "70000002-0000-0000-0000-000000000002",
    packageId: "discord",
    name: "Discord",
    publisher: "Discord Inc.",
    latestVersion: "0.0.334",
    softwareTitle: "Discord",
    source: "curated",
    lastRefreshedAt: null,
  },
  {
    id: "70000003-0000-0000-0000-000000000003",
    packageId: "slack",
    name: "Slack",
    publisher: "Slack Technologies, Inc.",
    latestVersion: "4.42.115",
    softwareTitle: "Slack",
    source: "curated",
    lastRefreshedAt: null,
  },
];

/** Manual Chocolatey overrides — empty in demo, same rationale as `demoWingetCatalogOverrides`. */
export const demoChocolateyCatalogOverrides: ChocolateyCatalogOverrideRow[] = [];

/**
 * Per-device installed-software inventory — the Inventories > Software grain,
 * distinct from `demoDeviceVulnerabilities` (which is CVE-scoped). Reuses the
 * same disk/registry-path evidence as the vulnerability rows where a product
 * overlaps, plus two products Defender inventories but never scores for
 * weaknesses (NVIDIA App, Discord) — the part-3 "Defender doesn't support
 * weakness detection here, but we can still fix it" scenario. Registry hive
 * (HKEY_LOCAL_MACHINE vs HKEY_USERS) is what `detectInstallScope` reads to
 * compute `softwareInventory.context` at sync time.
 */
export const demoDeviceSoftware: DeviceSoftwareRow[] = [
  // CON-LT-014 (mde-1) — every product in the demo, including the two Defender
  // inventories but doesn't score (NVIDIA App, Discord).
  ...[
    {
      softwareId: "igor-pavlov-_-7-zip",
      name: "7-Zip",
      vendor: "Igor Pavlov",
      version: "23.01",
      diskPaths: ["C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files\\7-Zip\\7zFM.exe"],
      registryPaths: [
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\7-Zip",
      ],
    },
    {
      softwareId: "mozilla-_-firefox",
      name: "Mozilla Firefox",
      vendor: "Mozilla",
      version: "125.0.1",
      diskPaths: ["C:\\Program Files\\Mozilla Firefox\\firefox.exe"],
      registryPaths: [
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mozilla Firefox",
      ],
    },
    {
      softwareId: "notepad-_-notepad",
      name: "Notepad++",
      vendor: "Notepad++ Team",
      version: "8.6.2",
      diskPaths: ["C:\\Program Files\\Notepad++\\notepad++.exe"],
      registryPaths: [
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Notepad++",
      ],
    },
    {
      softwareId: "google-_-chrome",
      name: "Google Chrome",
      vendor: "Google LLC",
      version: "126.0.6478.127",
      diskPaths: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
      registryPaths: [
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Google Chrome",
      ],
    },
    {
      softwareId: "greenshot-_-greenshot",
      name: "Greenshot",
      vendor: "Greenshot",
      version: "1.2.10",
      diskPaths: ["C:\\Program Files\\Greenshot\\Greenshot.exe"],
      registryPaths: [
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Greenshot",
      ],
    },
    {
      softwareId: "whatsapp-_-whatsapp",
      name: "WhatsApp",
      vendor: "WhatsApp LLC",
      version: "2.2402.7.0",
      diskPaths: ["C:\\Users\\jdoe\\AppData\\Local\\WhatsApp\\WhatsApp.exe"],
      registryPaths: [
        "HKEY_USERS\\S-1-5-21-111111111-222222222-333333333-1001\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WhatsApp",
      ],
    },
    {
      softwareId: "nvidia-_-app",
      name: "NVIDIA App",
      vendor: "NVIDIA Corporation",
      version: "11.0.3.152",
      diskPaths: ["C:\\Program Files\\NVIDIA Corporation\\NVIDIA App\\CEF\\NVIDIA App.exe"],
      registryPaths: [
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NVIDIA App",
      ],
    },
    {
      softwareId: "discord-_-discord",
      name: "Discord",
      vendor: "Discord Inc.",
      version: "0.0.301",
      diskPaths: ["C:\\Users\\jdoe\\AppData\\Local\\Discord\\app-0.0.301\\Discord.exe"],
      registryPaths: [
        "HKEY_USERS\\S-1-5-21-111111111-222222222-333333333-1001\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Discord",
      ],
    },
  ].map((row, i) => ({
    id: `50000001-0000-0000-0000-00000000000${i + 1}`,
    tenantId: "contoso",
    defenderMachineId: "mde-1",
    ...row,
  })),
  // CON-DT-007 (mde-2) — compliant box, only up-to-date NVIDIA App (shows the
  // "already ready" version-gate state).
  {
    id: "50000002-0000-0000-0000-000000000001",
    tenantId: "contoso",
    defenderMachineId: "mde-2",
    softwareId: "nvidia-_-app",
    name: "NVIDIA App",
    vendor: "NVIDIA Corporation",
    version: "11.0.4.204",
    diskPaths: ["C:\\Program Files\\NVIDIA Corporation\\NVIDIA App\\CEF\\NVIDIA App.exe"],
    registryPaths: [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NVIDIA App",
    ],
  },
  // CON-LT-022 (mde-3) — Notepad++, Chrome, Greenshot, and NVIDIA App.
  ...[
    {
      softwareId: "notepad-_-notepad",
      name: "Notepad++",
      vendor: "Notepad++ Team",
      version: "8.6.2",
      diskPaths: ["C:\\Program Files\\Notepad++\\notepad++.exe"],
      registryPaths: [
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Notepad++",
      ],
    },
    {
      softwareId: "google-_-chrome",
      name: "Google Chrome",
      vendor: "Google LLC",
      version: "126.0.6478.127",
      diskPaths: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
      registryPaths: [
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Google Chrome",
      ],
    },
    {
      softwareId: "greenshot-_-greenshot",
      name: "Greenshot",
      vendor: "Greenshot",
      version: "1.2.10",
      diskPaths: ["C:\\Program Files\\Greenshot\\Greenshot.exe"],
      registryPaths: [
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Greenshot",
      ],
    },
    {
      softwareId: "nvidia-_-app",
      name: "NVIDIA App",
      vendor: "NVIDIA Corporation",
      version: "11.0.3.152",
      diskPaths: ["C:\\Program Files\\NVIDIA Corporation\\NVIDIA App\\CEF\\NVIDIA App.exe"],
      registryPaths: [
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NVIDIA App",
      ],
    },
  ].map((row, i) => ({
    id: `50000003-0000-0000-0000-00000000000${i + 1}`,
    tenantId: "contoso",
    defenderMachineId: "mde-3",
    ...row,
  })),
];

/**
 * Software Inventory — the consolidated per-product view backing the new
 * Software Inventory page, aggregated across devices the same way
 * `demoRecommendations` aggregates over `demoDeviceVulnerabilities` (counts
 * here reflect the tenant-wide picture, not just the concrete rows above).
 * `context` is the computed User/SYSTEM/mixed tag from part 1 of the request.
 * NVIDIA App and Discord are the part-3 headline cases: `weaknessCount: 0`
 * because Defender doesn't run weakness detection on them, but a populated
 * `matchedPackageId`/`matchedPackageSource` means Fix Now still works.
 * WhatsApp has no match at all — it's Store-published, so neither winget nor
 * Chocolatey resolves it (see `demoVulnerabilities` v0000007's comment).
 */
export const demoSoftwareInventory: SoftwareInventoryRow[] = [
  {
    id: "60000001-0000-0000-0000-000000000001",
    tenantId: "contoso",
    softwareId: "igor-pavlov-_-7-zip",
    name: "7-Zip",
    vendor: "Igor Pavlov",
    weaknessCount: 23,
    exposedMachinesCount: 4,
    installedMachinesCount: 4,
    publicExploit: true,
    context: "machine",
    matchedPackageId: "7zip.7zip",
    matchedPackageSource: "winget",
    matchedLatestVersion: "24.08",
    detectedAt: daysFromAnchor(-13),
    lastSeenAt: daysFromAnchor(0),
  },
  {
    id: "60000002-0000-0000-0000-000000000002",
    tenantId: "contoso",
    softwareId: "mozilla-_-firefox",
    name: "Mozilla Firefox",
    vendor: "Mozilla",
    weaknessCount: 148,
    exposedMachinesCount: 2,
    installedMachinesCount: 3,
    publicExploit: true,
    context: "machine",
    matchedPackageId: "Mozilla.Firefox",
    matchedPackageSource: "winget",
    matchedLatestVersion: "127.0.1",
    detectedAt: daysFromAnchor(-5),
    lastSeenAt: daysFromAnchor(0),
  },
  {
    id: "60000003-0000-0000-0000-000000000003",
    tenantId: "contoso",
    softwareId: "notepad-_-notepad",
    name: "Notepad++",
    vendor: "Notepad++ Team",
    weaknessCount: 11,
    exposedMachinesCount: 3,
    installedMachinesCount: 4,
    publicExploit: false,
    context: "machine",
    matchedPackageId: "Notepad++.Notepad++",
    matchedPackageSource: "winget",
    matchedLatestVersion: "8.6.9",
    detectedAt: daysFromAnchor(-20),
    lastSeenAt: daysFromAnchor(0),
  },
  {
    id: "60000004-0000-0000-0000-000000000004",
    tenantId: "contoso",
    softwareId: "google-_-chrome",
    name: "Google Chrome",
    vendor: "Google LLC",
    weaknessCount: 312,
    exposedMachinesCount: 1,
    installedMachinesCount: 4,
    publicExploit: false,
    context: "machine",
    matchedPackageId: "Google.Chrome",
    matchedPackageSource: "winget",
    matchedLatestVersion: "126.0.6478.127",
    detectedAt: daysFromAnchor(-6),
    lastSeenAt: daysFromAnchor(0),
  },
  {
    id: "60000005-0000-0000-0000-000000000005",
    tenantId: "contoso",
    softwareId: "greenshot-_-greenshot",
    name: "Greenshot",
    vendor: "Greenshot",
    weaknessCount: 9,
    exposedMachinesCount: 2,
    installedMachinesCount: 2,
    publicExploit: false,
    context: "machine",
    matchedPackageId: "greenshot",
    matchedPackageSource: "chocolatey",
    matchedLatestVersion: "1.3.290",
    detectedAt: daysFromAnchor(-19),
    lastSeenAt: daysFromAnchor(0),
  },
  {
    id: "60000006-0000-0000-0000-000000000006",
    tenantId: "contoso",
    softwareId: "whatsapp-_-whatsapp",
    name: "WhatsApp",
    vendor: "WhatsApp LLC",
    weaknessCount: 6,
    exposedMachinesCount: 1,
    installedMachinesCount: 1,
    publicExploit: false,
    context: "user",
    matchedPackageId: null,
    matchedPackageSource: null,
    matchedLatestVersion: null,
    detectedAt: daysFromAnchor(-6),
    lastSeenAt: daysFromAnchor(0),
  },
  {
    id: "60000007-0000-0000-0000-000000000007",
    tenantId: "contoso",
    softwareId: "nvidia-_-app",
    name: "NVIDIA App",
    vendor: "NVIDIA Corporation",
    weaknessCount: 0,
    exposedMachinesCount: 0,
    installedMachinesCount: 2,
    publicExploit: false,
    context: "machine",
    matchedPackageId: "Nvidia.App",
    matchedPackageSource: "winget",
    matchedLatestVersion: "11.0.4.204",
    detectedAt: daysFromAnchor(-2),
    lastSeenAt: daysFromAnchor(0),
  },
  {
    id: "60000008-0000-0000-0000-000000000008",
    tenantId: "contoso",
    softwareId: "discord-_-discord",
    name: "Discord",
    vendor: "Discord Inc.",
    weaknessCount: 0,
    exposedMachinesCount: 0,
    installedMachinesCount: 1,
    publicExploit: false,
    context: "user",
    matchedPackageId: "discord",
    matchedPackageSource: "chocolatey",
    matchedLatestVersion: "0.0.334",
    detectedAt: daysFromAnchor(-1),
    lastSeenAt: daysFromAnchor(0),
  },
];

/**
 * Per-device missing Windows Update KBs — Defender's `getmissingkbs` surface
 * (Ask 4 / "By OS"), distinct from `demoRecommendations`' single OS-product
 * roll-up ("Microsoft Windows 11"): this is the actual KB-level detail a
 * Missing-KB Fix Now dispatch acts on, keyed by `deviceId` (not
 * `defenderMachineId`, unlike the other device-scoped demo tables — the API
 * route joins on the devices table's own id). CON-LT-014 (Enterprise 23H2, the
 * worst box) is missing two; CON-LT-022 (Windows 10, overdue everywhere else)
 * is missing one. CON-DT-007 (compliant) and the Server box are fully patched.
 */
export const demoMissingKbs: MissingKbRow[] = [
  {
    id: "80000001-0000-0000-0000-000000000001",
    tenantId: "contoso",
    deviceId: "d0000001-0000-0000-0000-000000000001",
    kbId: "5040442",
    title: "2026-06 Cumulative Update for Windows 11 (KB5040442)",
    products: ["Windows 11 Enterprise, version 23H2"],
    cveCount: 12,
    cveIds: [
      "CVE-2026-30421",
      "CVE-2026-30422",
      "CVE-2026-30455",
      "CVE-2026-30478",
      "CVE-2026-30491",
      "CVE-2026-30502",
      "CVE-2026-30513",
      "CVE-2026-30519",
      "CVE-2026-30524",
      "CVE-2026-30530",
      "CVE-2026-30537",
      "CVE-2026-30541",
    ],
    url: "https://support.microsoft.com/kb/5040442",
    syncedAt: daysFromAnchor(0),
  },
  {
    id: "80000002-0000-0000-0000-000000000002",
    tenantId: "contoso",
    deviceId: "d0000001-0000-0000-0000-000000000001",
    kbId: "5039302",
    title: ".NET Framework 4.8.1 Security Update (KB5039302)",
    products: ["Windows 11 Enterprise, version 23H2", ".NET Framework 4.8.1"],
    cveCount: 3,
    cveIds: ["CVE-2026-29903", "CVE-2026-29912", "CVE-2026-29928"],
    url: "https://support.microsoft.com/kb/5039302",
    syncedAt: daysFromAnchor(0),
  },
  {
    id: "80000003-0000-0000-0000-000000000003",
    tenantId: "contoso",
    deviceId: "d0000003-0000-0000-0000-000000000003",
    kbId: "5040427",
    title: "2026-06 Cumulative Update for Windows 10 (KB5040427)",
    products: ["Windows 10 Pro, version 22H2"],
    cveCount: 9,
    cveIds: [
      "CVE-2026-30421",
      "CVE-2026-30422",
      "CVE-2026-30455",
      "CVE-2026-30478",
      "CVE-2026-30491",
      "CVE-2026-30502",
      "CVE-2026-30513",
      "CVE-2026-30519",
      "CVE-2026-30524",
    ],
    url: "https://support.microsoft.com/kb/5040427",
    syncedAt: daysFromAnchor(0),
  },
];

/**
 * A short history of remediation jobs so the Jobs page tells a story on first
 * load: one already-succeeded fix, one that failed (device unreachable), and
 * one mid-flight. New jobs created in the console are prepended to this list in
 * memory (DEMO_MODE) — see the API job engine.
 */
export const demoJobs: JobRow[] = [
  {
    id: "10000001-0000-0000-0000-000000000001",
    tenantId: "msp-root",
    deviceId: null,
    cveId: "CVE-2025-12345",
    coveredCveIds: null,
    deviceHostname: null,
    software: "7-Zip",
    kbId: null,
    featureUpdateVersion: null,
    channel: "intune-remediation",
    status: "succeeded",
    engineer: "demo.engineer@blackiron.example",
    exitCode: 0,
    output: "[demo] winget upgrade --id 7zip.7zip — exit 0",
    queueJobId: null,
    batchId: null,
    scheduleId: null,
    scheduleAt: null,
    queuedAt: daysFromAnchor(-2),
    startedAt: daysFromAnchor(-2),
    finishedAt: daysFromAnchor(-2),
    archivedAt: null,
    script: null,
    packageId: null,
    installScope: null,
    action: null,
    source: null,
    altPackageId: null,
  },
  {
    id: "10000002-0000-0000-0000-000000000002",
    tenantId: "msp-root",
    deviceId: null,
    cveId: "CVE-2025-33010",
    coveredCveIds: null,
    deviceHostname: null,
    software: "Notepad++",
    kbId: null,
    featureUpdateVersion: null,
    channel: "live-response",
    status: "failed",
    engineer: "demo.engineer@blackiron.example",
    exitCode: 1,
    output: "[demo] device offline — Live Response session could not be established",
    queueJobId: null,
    batchId: null,
    scheduleId: null,
    scheduleAt: null,
    queuedAt: daysFromAnchor(-1),
    startedAt: daysFromAnchor(-1),
    finishedAt: daysFromAnchor(-1),
    archivedAt: null,
    script: null,
    packageId: null,
    installScope: null,
    action: null,
    source: null,
    altPackageId: null,
  },
  {
    id: "10000003-0000-0000-0000-000000000003",
    tenantId: "msp-root",
    deviceId: null,
    cveId: "CVE-2025-40555",
    coveredCveIds: null,
    deviceHostname: null,
    software: "Google Chrome",
    kbId: null,
    featureUpdateVersion: null,
    channel: "intune-remediation",
    status: "running",
    engineer: "demo.engineer@blackiron.example",
    exitCode: null,
    output: null,
    queueJobId: null,
    batchId: null,
    scheduleId: null,
    scheduleAt: null,
    queuedAt: daysFromAnchor(0),
    startedAt: daysFromAnchor(0),
    finishedAt: null,
    archivedAt: null,
    script: null,
    packageId: null,
    installScope: null,
    action: null,
    source: null,
    altPackageId: null,
  },
];

/** Demo recurring schedules — one active, one paused. */
export const demoSchedules: ScheduleRow[] = [
  {
    id: "20000001-0000-0000-0000-000000000001",
    tenantId: "msp-root",
    name: "Nightly critical app patching",
    cron: "0 2 * * *",
    channel: "intune-remediation",
    target: { severity: "critical", patchType: "app" },
    enabled: true,
    engineer: "demo.engineer@blackiron.example",
    createdAt: daysFromAnchor(-30),
  },
  {
    id: "20000002-0000-0000-0000-000000000002",
    tenantId: "msp-root",
    name: "Weekly OS quality updates",
    cron: "0 3 * * 0",
    channel: "expedited-quality-update",
    target: { patchType: "os" },
    enabled: false,
    engineer: "demo.engineer@blackiron.example",
    createdAt: daysFromAnchor(-14),
  },
];

/**
 * Local-only exception records (see recommendationExceptions in schema.ts —
 * Defender has no public write API for exceptions, so this is PatchPilot's
 * own tracking). Starts empty, same as `demoManualRemediations`: exceptions
 * are created live through the ExceptionModal during a demo session, not
 * seeded, so the "hidden by default / revealable via status filter" behavior
 * is something the demo walkthrough itself creates rather than something
 * baked in from first load.
 */
export const demoRecommendationExceptions: RecommendationExceptionRow[] = [];

/**
 * Local-only device exclusions (see deviceExclusions in schema.ts). Empty for
 * the same reason as the exceptions above — excluding a device is a decision a
 * demo walkthrough makes on camera, and the interesting part is watching the
 * device and its findings drop out of every surface at that moment.
 */
export const demoDeviceExclusions: DeviceExclusionRow[] = [];

/**
 * PatchPilot-native device groups (see deviceGroups/deviceGroupMembers in
 * schema.ts). Empty for the same reason as the exclusions above — creating a
 * group and assigning members is a walkthrough action, not a fixture.
 */
export const demoDeviceGroups: DeviceGroupRow[] = [];
export const demoDeviceGroupMembers: DeviceGroupMemberRow[] = [];

/**
 * Seeded audit trail.
 *
 * Unlike most fixtures this one exists mainly so the Audit Log page has a story
 * on first load — DEMO_MODE writes real audit rows as you click around, but an
 * empty table on arrival makes the page look broken. The set deliberately
 * covers every actor type, every outcome, both categories, and a couple of
 * tenant-less global events, so each filter visibly does something.
 *
 * Written through a builder rather than 40 literal objects: the row has 18
 * columns and all but a handful are the same every time.
 */
const DEMO_ENGINEER = "demo.engineer@blackiron.example";

/** Minutes from the anchor — the audit story plays out over hours, not days. */
const minsFromAnchor = (n: number): Date => new Date(ANCHOR.getTime() + n * 60 * 1000);

let demoAuditSeq = 0;

function auditRow(
  at: Date,
  row: Partial<AuditLogRow> & Pick<AuditLogRow, "endpoint" | "method">,
): AuditLogRow {
  demoAuditSeq += 1;
  return {
    id: `a0000000-0000-4000-8000-${String(demoAuditSeq).padStart(12, "0")}`,
    tenantId: "contoso",
    engineer: DEMO_ENGINEER,
    payloadHash: null,
    responseStatus: null,
    latencyMs: null,
    category: "action",
    actorType: "user",
    action: null,
    resourceType: null,
    resourceId: null,
    resourceLabel: null,
    summary: null,
    outcome: null,
    detail: null,
    ...row,
    at,
  };
}

export const demoAuditLog: AuditLogRow[] = [
  // ---- engineer actions, newest first ----
  auditRow(minsFromAnchor(-25), {
    endpoint: "POST /api/machines/{id}/runliveresponse",
    method: "POST",
    action: "remediation:dispatch",
    resourceType: "vulnerability",
    resourceId: "CVE-2026-24912",
    resourceLabel: "Google Chrome",
    summary: "Dispatched live-response remediation for Google Chrome on FIN-LT-014",
    outcome: "success",
    responseStatus: 202,
    latencyMs: 1180,
    payloadHash: "9f2c4b7e1d6a08c35e9f4b21a7d0c68f3b5e1290a4c7d8e6f0b3a5c9d2e4f7108",
  }),
  auditRow(minsFromAnchor(-41), {
    endpoint: "job:archive",
    method: "PATCH",
    action: "job:archive",
    resourceType: "job",
    resourceId: "44444444-4444-4444-4444-444444444401",
    resourceLabel: "Google Chrome",
    summary: "Archived job 44444444 (Google Chrome)",
    outcome: "success",
    responseStatus: 200,
  }),
  auditRow(minsFromAnchor(-52), {
    endpoint: "settings:update",
    method: "PUT",
    tenantId: null,
    action: "setting:update",
    resourceType: "setting",
    resourceId: "sla",
    resourceLabel: "sla",
    summary: "Updated sla settings",
    outcome: "success",
    responseStatus: 200,
    payloadHash: "3d8a1f04c9b27e56a0d3f8b1c74e29650a8f3d2b7c1e4906f5a8b2d3c7e01945",
  }),
  auditRow(minsFromAnchor(-63), {
    endpoint: "POST /deviceManagement/deviceHealthScripts",
    method: "POST",
    action: "remediation:fix-all",
    resourceType: "recommendation",
    resourceId: "scid-2010",
    resourceLabel: "Update Microsoft Edge",
    summary: "Fix-all dispatched for “Update Microsoft Edge” across 6 device(s)",
    outcome: "success",
    responseStatus: 202,
    latencyMs: 2410,
    payloadHash: "c1e7b93a4f28d605e1a9c3b7f04d2856b9e1a7c3d5f8024e6b1a9c7d3f5e8021",
  }),
  auditRow(minsFromAnchor(-88), {
    endpoint: "POST /api/machines/{id}/runliveresponse",
    method: "POST",
    action: "remediation:dispatch",
    resourceType: "vulnerability",
    resourceId: "CVE-2026-31337",
    resourceLabel: "7-Zip",
    summary: "Dispatched live-response remediation for 7-Zip on WS-DEV-002",
    outcome: "failure",
    responseStatus: 503,
    latencyMs: 8940,
    detail: "Live Response session could not be established: device offline",
    payloadHash: "7a3f1c8e0b49d24f6a1c8e3b7d0f5926a4c8e1b3d7f0925a6c1e8b3d7f0a2946",
  }),
  auditRow(minsFromAnchor(-95), {
    endpoint: "manual-remediation:record",
    method: "POST",
    action: "remediation:manual-record",
    resourceType: "manual-remediation",
    resourceId: "CVE-2026-31337",
    resourceLabel: "7-Zip",
    summary: "Recorded manual remediation for 7-Zip (CVE-2026-31337)",
    outcome: "success",
    responseStatus: 201,
    payloadHash: "5b2e9d47a1c30f68b5e2a9d4c7f01836b2e5a9d4c7f0183b6e2a5d9c4f70b1836",
  }),
  auditRow(minsFromAnchor(-120), {
    endpoint: "job:bulk-delete",
    method: "POST",
    action: "job:bulk-delete",
    resourceType: "job",
    summary: "Deleted 11 of 12 job(s)",
    outcome: "partial",
    responseStatus: 200,
    detail: "Not found: 44444444-4444-4444-4444-444444444409",
  }),
  auditRow(minsFromAnchor(-142), {
    endpoint: "schedules:create",
    method: "POST",
    action: "schedule:create",
    resourceType: "schedule",
    resourceId: "55555555-5555-5555-5555-555555555501",
    resourceLabel: "Weekly browser patch run",
    summary: "Created schedule “Weekly browser patch run” (0 2 * * 1) for Contoso Ltd",
    outcome: "success",
    responseStatus: 201,
  }),
  auditRow(minsFromAnchor(-168), {
    endpoint: "recommendation-exception:create",
    method: "POST",
    action: "exception:create",
    resourceType: "exception",
    resourceId: "66666666-6666-6666-6666-666666666601",
    resourceLabel: "Enable attack surface reduction rules",
    summary: "Exception created for “Enable attack surface reduction rules” until 21 Sep 2026",
    outcome: "success",
    responseStatus: 201,
  }),
  auditRow(minsFromAnchor(-190), {
    endpoint: "sync:data",
    method: "POST",
    action: "tenant:sync",
    resourceType: "tenant",
    resourceId: "contoso",
    resourceLabel: "Contoso Ltd",
    summary: "Manual sync: 3 devices, 14 vulnerabilities, 9 recommendations",
    outcome: "success",
    responseStatus: 200,
    latencyMs: 14_820,
  }),
  auditRow(minsFromAnchor(-215), {
    endpoint: "tenants:update",
    method: "PATCH",
    action: "tenant:set-write-posture",
    resourceType: "tenant",
    resourceId: "contoso",
    resourceLabel: "Contoso Ltd",
    summary: "Set Contoso Ltd to write-enabled",
    outcome: "success",
    responseStatus: 200,
    payloadHash: "e4a1c7f2b8d5309a6e4c1b7f2d8a5093e6a4c1b7f2d85093ae6c4b1f72d8a5093",
  }),
  auditRow(minsFromAnchor(-240), {
    endpoint: "script-catalog:upload",
    method: "POST",
    action: "script:upload",
    resourceType: "script",
    resourceId: "77777777-7777-7777-7777-777777777701",
    resourceLabel: "Purge stale Chrome profiles",
    summary: "Uploaded script “Purge stale Chrome profiles”",
    outcome: "success",
    responseStatus: 201,
    payloadHash: "b8f3e1a05c7d29648b3f1e0a5c7d2964b8f31e0a5c7d29648bf31ea05c7d29648",
  }),

  // ---- three rows sharing one timestamp ----
  // The keyset cursor pages on (at, id): a bare `at <` comparison would silently
  // drop the rest of a tied group at a page boundary. Load the page with a small
  // ?limit so this trio straddles one, and confirm all three still appear exactly
  // once. Bursts like this are normal — the three client.ts audit sites fire
  // together on every probe.
  auditRow(minsFromAnchor(-300), {
    endpoint: "defender:/api/machines",
    method: "GET",
    category: "api_call",
    action: "connection:test",
    resourceType: "connection",
    resourceId: "defender",
    summary: "Connection test: Defender machines",
    outcome: "success",
    responseStatus: 200,
    latencyMs: 214,
  }),
  auditRow(minsFromAnchor(-300), {
    endpoint: "graph:/deviceManagement/managedDevices",
    method: "GET",
    category: "api_call",
    action: "connection:test",
    resourceType: "connection",
    resourceId: "graph",
    summary: "Connection test: Intune managed devices",
    outcome: "success",
    responseStatus: 200,
    latencyMs: 189,
  }),
  auditRow(minsFromAnchor(-300), {
    endpoint: "graph:/organization",
    method: "GET",
    category: "api_call",
    action: "connection:test",
    resourceType: "connection",
    resourceId: "graph",
    summary: "Connection test: Organization licensing",
    outcome: "failure",
    responseStatus: 403,
    latencyMs: 402,
    detail: "Organization.Read.All not consented for this tenant",
  }),

  // ---- background work ----
  auditRow(minsFromAnchor(-330), {
    endpoint: "worker:verify",
    method: "POST",
    engineer: DEMO_ENGINEER,
    actorType: "worker",
    action: "remediation:verified",
    resourceType: "vulnerability",
    resourceId: "CVE-2026-24912",
    resourceLabel: "Google Chrome",
    summary: "Remediation verified for Google Chrome on FIN-LT-014",
    outcome: "success",
  }),
  auditRow(minsFromAnchor(-355), {
    endpoint: "scheduler:fanout",
    method: "POST",
    actorType: "schedule",
    action: "schedule:fire",
    resourceType: "schedule",
    resourceId: "55555555-5555-5555-5555-555555555501",
    resourceLabel: "Weekly browser patch run",
    summary: "Schedule “Weekly browser patch run” fired: 4 job(s) enqueued, 1 skipped",
    outcome: "partial",
    detail: "Skipped 1: device not seen in 30 days",
  }),
  auditRow(minsFromAnchor(-372), {
    endpoint: "scheduler:fanout",
    method: "POST",
    tenantId: "northwind",
    actorType: "schedule",
    action: "schedule:fire",
    resourceType: "schedule",
    resourceId: "55555555-5555-5555-5555-555555555502",
    resourceLabel: "Monthly OS quality update",
    summary: "Schedule “Monthly OS quality update” did not fire",
    outcome: "skipped",
    detail: "tenant is read-only",
  }),
  auditRow(minsFromAnchor(-400), {
    endpoint: "auto-sync:cycle",
    method: "SYNC",
    engineer: "system:auto-sync",
    actorType: "system",
    action: "tenant:auto-sync",
    resourceType: "tenant",
    resourceId: "contoso",
    resourceLabel: "Contoso Ltd",
    summary: "Auto-sync: 3 devices, 14 vulnerabilities",
    outcome: "success",
    latencyMs: 12_640,
  }),
  auditRow(minsFromAnchor(-401), {
    endpoint: "auto-sync:cycle",
    method: "SYNC",
    tenantId: "northwind",
    engineer: "system:auto-sync",
    actorType: "system",
    action: "tenant:auto-sync",
    resourceType: "tenant",
    resourceId: "northwind",
    resourceLabel: "Northwind Traders",
    summary: "Auto-sync failed for Northwind Traders",
    outcome: "failure",
    detail: "Graph returned 429 after 3 retries (throttled)",
    latencyMs: 31_200,
  }),
  auditRow(minsFromAnchor(-430), {
    endpoint: "auto-sync:resync",
    method: "SYNC",
    engineer: "system:auto-sync",
    actorType: "system",
    action: "tenant:resync",
    resourceType: "tenant",
    resourceId: "contoso",
    resourceLabel: "Contoso Ltd",
    summary: "Post-remediation resync for Contoso Ltd",
    outcome: "success",
    latencyMs: 9840,
  }),
  auditRow(minsFromAnchor(-455), {
    endpoint: "worker:stale-sweep",
    method: "SWEEP",
    tenantId: null,
    engineer: "system:worker",
    actorType: "worker",
    action: "job:stale-swept",
    resourceType: "job",
    summary: "Failed 2 stale running and 0 stale queued job(s)",
    outcome: "partial",
  }),
  auditRow(minsFromAnchor(-470), {
    endpoint: "worker:orphan-sweep",
    method: "SWEEP",
    tenantId: null,
    engineer: "system:startup",
    actorType: "worker",
    action: "job:orphan-swept",
    resourceType: "job",
    summary: "Force-failed 1 orphaned running job(s) at worker startup",
    outcome: "partial",
  }),
  auditRow(minsFromAnchor(-500), {
    endpoint: "winget-mirror:source.msix",
    method: "INGEST",
    tenantId: null,
    engineer: "system:catalog-refresh",
    actorType: "system",
    action: "catalog:refresh",
    resourceType: "catalog",
    summary: "Scheduled catalog refresh (interval): 8412 packages",
    outcome: "success",
    latencyMs: 46_300,
  }),
  auditRow(minsFromAnchor(-505), {
    endpoint: "chocolatey-mirror:packages",
    method: "INGEST",
    tenantId: null,
    engineer: "system:chocolatey-refresh",
    actorType: "system",
    action: "chocolatey-catalog:refresh",
    resourceType: "catalog",
    summary: "Scheduled catalog refresh (interval): 5000 packages",
    outcome: "partial",
    detail: "Result truncated: feed page limit reached at 5000 packages",
    latencyMs: 38_100,
  }),

  // ---- access ----
  auditRow(minsFromAnchor(-540), {
    endpoint: "auth:callback",
    method: "GET",
    tenantId: "northwind",
    action: "auth:consent-granted",
    resourceType: "tenant",
    resourceId: "northwind",
    resourceLabel: "Northwind Traders",
    summary: "Admin consent granted for tenant northwind",
    outcome: "success",
  }),
  auditRow(minsFromAnchor(-560), {
    endpoint: "auth:callback",
    method: "GET",
    tenantId: "msp-root",
    action: "auth:login-success",
    resourceType: "session",
    summary: "Demo Engineer signed in",
    outcome: "success",
  }),
  auditRow(minsFromAnchor(-561), {
    endpoint: "auth:login",
    method: "GET",
    tenantId: null,
    engineer: "anonymous",
    action: "auth:login-start",
    resourceType: "session",
    summary: "Sign-in started",
    outcome: "success",
  }),
  auditRow(minsFromAnchor(-600), {
    endpoint: "auth:callback",
    method: "GET",
    tenantId: null,
    engineer: "anonymous",
    action: "auth:login-failed",
    resourceType: "session",
    summary: "Sign-in failed",
    outcome: "failure",
    detail: "access_denied: The user cancelled the sign-in request",
  }),
  auditRow(minsFromAnchor(-620), {
    endpoint: "auth:logout",
    method: "POST",
    tenantId: "msp-root",
    action: "auth:logout",
    resourceType: "session",
    summary: "Demo Engineer signed out",
    outcome: "success",
  }),

  // ---- raw Microsoft traffic (the "All events" tier) ----
  auditRow(minsFromAnchor(-186), {
    endpoint: "defender:/api/machines",
    method: "GET",
    category: "api_call",
    responseStatus: 200,
    latencyMs: 342,
  }),
  auditRow(minsFromAnchor(-187), {
    endpoint: "defender:/api/vulnerabilities/machinesVulnerabilities",
    method: "GET",
    category: "api_call",
    responseStatus: 200,
    latencyMs: 1290,
  }),
  auditRow(minsFromAnchor(-188), {
    endpoint: "defender:/api/recommendations",
    method: "GET",
    category: "api_call",
    responseStatus: 200,
    latencyMs: 508,
  }),
  auditRow(minsFromAnchor(-189), {
    endpoint: "defender:/api/software",
    method: "GET",
    category: "api_call",
    responseStatus: 200,
    latencyMs: 733,
  }),
  auditRow(minsFromAnchor(-191), {
    endpoint: "graph:/organization",
    method: "GET",
    category: "api_call",
    tenantId: "contoso",
    responseStatus: 200,
    latencyMs: 161,
  }),
  auditRow(minsFromAnchor(-402), {
    endpoint: "defender:/api/machines",
    method: "GET",
    category: "api_call",
    tenantId: "northwind",
    engineer: "system:auto-sync",
    actorType: "system",
    responseStatus: 429,
    latencyMs: 88,
  }),
  auditRow(minsFromAnchor(-403), {
    endpoint: "defender:/api/machines",
    method: "GET",
    category: "api_call",
    tenantId: "northwind",
    engineer: "system:auto-sync",
    actorType: "system",
    responseStatus: 429,
    latencyMs: 91,
  }),
  auditRow(minsFromAnchor(-404), {
    endpoint: "graph:/deviceManagement/managedDevices",
    method: "GET",
    category: "api_call",
    engineer: "system:auto-sync",
    actorType: "system",
    responseStatus: 200,
    latencyMs: 640,
  }),
  auditRow(minsFromAnchor(-64), {
    endpoint: "graph:/deviceManagement/deviceHealthScripts",
    method: "POST",
    category: "api_call",
    responseStatus: 201,
    latencyMs: 1102,
    payloadHash: "d2b6f8a3e0c15749d2b6f8a3e0c1574d9b2f6a8e3c015749db2f6a8e3c0157490",
  }),
  auditRow(minsFromAnchor(-26), {
    endpoint: "defender:/api/machines/{id}/runliveresponse",
    method: "POST",
    category: "api_call",
    responseStatus: 201,
    latencyMs: 1980,
    payloadHash: "9f2c4b7e1d6a08c35e9f4b21a7d0c68f3b5e1290a4c7d8e6f0b3a5c9d2e4f7108",
  }),
];

/**
 * Seeded posture history for the Dashboard trend charts.
 *
 * DELIBERATE DEVIATION FROM THE ANCHOR CONVENTION. Every other fixture in this
 * file is dated relative to ANCHOR so the seeded story is reproducible. A trend
 * cannot be: a 30-day chart whose newest point is six weeks stale reads as a
 * broken widget, not as a fixed date. So these days are generated relative to
 * the current UTC date instead. Reproducibility is preserved a different way —
 * the walk uses a seeded PRNG keyed on (tenantId, day), never Math.random, so
 * the same day always produces the same numbers.
 *
 * The newest point is DERIVED from the other fixtures (devices, vulnerabilities,
 * the winget catalog) rather than typed by hand, so the trend's right-hand edge
 * always agrees with the KPI tiles beside it. Earlier days walk backwards from
 * there: slightly more findings and more breaches the further back you go, so
 * the story is "posture improving", which is what an MSP wants their trend to
 * show.
 *
 * Coverage is `northwind` = 2 days only. That is what exercises the Dashboard's
 * honest "collecting history — 2 of 30 days captured" state, and it fits the
 * tenant that already has `lastSyncedAt: null`.
 */
export type PostureSnapshotRow = InferSelectModel<typeof postureSnapshots>;

/** How many days of history each demo tenant has. */
const DEMO_TREND_DAYS: Record<string, number> = {
  "msp-root": 30,
  contoso: 30,
  northwind: 2,
};

/**
 * mulberry32. Deterministic and seeded per (tenant, day), so a given day's
 * numbers never change between restarts even though the day itself moves.
 */
function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Midnight-UTC day string, `d` days before today. */
function dayString(d: number): string {
  const now = new Date();
  const utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(utc - d * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const wingetEntries: WingetCatalogEntry[] = demoWingetCatalog.map((c) => ({
  packageId: c.packageId,
  name: c.name,
  publisher: c.publisher,
  latestVersion: c.latestVersion,
  softwareTitle: c.softwareTitle,
}));

/** Today's posture for one tenant, read straight off the other fixtures. */
function currentPosture(tenantId: string, now: Date) {
  const tenantDevices = demoDevices.filter((d) => d.tenantId === tenantId);
  const tenantVulns = demoVulnerabilities.filter((v) => v.tenantId === tenantId);

  const severity = { critical: 0, high: 0, medium: 0, low: 0 };
  const sla = { breached: 0, dueSoon: 0, ok: 0 };
  for (const v of tenantVulns) {
    const s = v.severity as keyof typeof severity;
    if (s in severity) severity[s] += 1;
    const status = computeSla(v.severity as Severity, v.detectedAt, DEFAULT_SLA, now);
    const tone = slaTone(status);
    if (tone === "breached") sla.breached += 1;
    else if (tone === "due-soon") sla.dueSoon += 1;
    else sla.ok += 1;
  }

  // Same (tenant, software) grouping the Catalog coverage page uses. This is an
  // approximation of it, not a reproduction: computeCoverage() also consults
  // per-tenant winget overrides and the Chocolatey mirror, neither of which a
  // fixture can reach, so the split can differ from /api/catalog/coverage by a
  // package or two. Acceptable because no Dashboard widget reads these three
  // columns — the coverage donut calls /api/catalog/coverage directly, and the
  // trend chart's three lenses are severity, SLA state and device compliance.
  const software = new Map<string, { name: string; os: boolean }>();
  for (const v of tenantVulns) {
    const key = v.software.trim().toLowerCase();
    if (!software.has(key)) software.set(key, { name: v.software, os: isOsFinding(v.software) });
  }
  let covered = 0;
  let uncovered = 0;
  let os = 0;
  for (const s of software.values()) {
    if (s.os) os += 1;
    else if (matchWinget(s.name, wingetEntries, [])) covered += 1;
    else uncovered += 1;
  }

  return {
    devices: tenantDevices.length,
    devicesCompliant: tenantDevices.filter((d) => d.compliance === "compliant").length,
    devicesNoncompliant: tenantDevices.filter((d) => d.compliance === "noncompliant").length,
    devicesUnknown: tenantDevices.filter((d) => d.compliance === "unknown").length,
    openFindings: tenantVulns.length,
    ...severity,
    slaBreached: sla.breached,
    slaDueSoon: sla.dueSoon,
    slaOk: sla.ok,
    softwareCovered: covered,
    softwareUncovered: uncovered,
    softwareOs: os,
  };
}

function buildDemoPostureSnapshots(): PostureSnapshotRow[] {
  const now = new Date();
  const rows: PostureSnapshotRow[] = [];

  for (const [tenantIdx, tenant] of demoTenants.entries()) {
    const days = DEMO_TREND_DAYS[tenant.tenantId] ?? 0;
    if (days === 0) continue;
    const today = currentPosture(tenant.tenantId, now);

    for (let d = days - 1; d >= 0; d--) {
      const day = dayString(d);
      const rand = seededRandom(`${tenant.tenantId}:${day}`);
      // Findings decay ~3%/day towards today, with a little noise, so the series
      // slopes down-and-to-the-right without looking machine-straight. The demo
      // tenants only carry single-digit findings, so a gentler slope would round
      // away to a flat line.
      const drift = 1 + d * 0.03 + (rand() - 0.5) * 0.08;
      const grow = (n: number): number => (n === 0 ? 0 : Math.max(1, Math.round(n * drift)));

      const critical = grow(today.critical);
      const high = grow(today.high);
      const medium = grow(today.medium);
      const low = grow(today.low);
      const openFindings = critical + high + medium + low;

      // Older days had shorter SLA clocks, so proportionally fewer breaches.
      const breachShare = today.openFindings === 0 ? 0 : (today.slaBreached / today.openFindings) * (1 - d * 0.02);
      const dueSoonShare = today.openFindings === 0 ? 0 : today.slaDueSoon / today.openFindings;
      const slaBreached = Math.max(0, Math.round(openFindings * Math.max(0, breachShare)));
      const slaDueSoon = Math.min(openFindings - slaBreached, Math.round(openFindings * dueSoonShare));
      const slaOk = openFindings - slaBreached - slaDueSoon;

      // Fleet size is stable; what moves is how much of it is out of SLA.
      const devicesNoncompliant =
        slaBreached === 0 ? 0 : Math.min(today.devices - today.devicesUnknown, Math.max(1, today.devicesNoncompliant));
      const devicesCompliant = today.devices - today.devicesUnknown - devicesNoncompliant;

      rows.push({
        // Deterministic and uuid-shaped: tenant index in the first group, the
        // day offset in the last, so re-seeding reproduces the same ids.
        id: `9000000${tenantIdx}-0000-0000-0000-${String(d).padStart(12, "0")}`,
        tenantId: tenant.tenantId,
        day,
        capturedAt: new Date(`${day}T02:00:00Z`),
        source: d === 0 ? "scheduled" : "backfill",
        devices: today.devices,
        devicesCompliant,
        devicesNoncompliant,
        devicesUnknown: today.devicesUnknown,
        openFindings,
        critical,
        high,
        medium,
        low,
        slaBreached,
        slaDueSoon,
        slaOk,
        slaThresholds: DEFAULT_SLA,
        softwareCovered: today.softwareCovered,
        softwareUncovered: today.softwareUncovered,
        softwareOs: today.softwareOs,
        // The real writer counts jobs whose `finishedAt` falls on this day. No
        // demo job is dated inside the rolling trend window (demoJobs is
        // ANCHOR-based), so counting honestly would give a flat zero — these are
        // seeded instead: a few runs a day, failing occasionally. Nothing on the
        // Dashboard reads them; the throughput widget queries /api/jobs directly.
        jobsSucceeded: Math.round(rand() * 4),
        jobsFailed: rand() < 0.2 ? 1 : 0,
      });
    }
  }

  return rows;
}

export const demoPostureSnapshots: PostureSnapshotRow[] = buildDemoPostureSnapshots();

/**
 * Seeded remediation-event history for the Dashboard's time-to-remediate card
 * and the Remediation History page (apps/api/src/routes/remediation-history.ts).
 *
 * Same relative-to-now dating and seeded-PRNG approach as
 * buildDemoPostureSnapshots, for the same reason: a fixed ANCHOR date would
 * eventually fall outside every rolling window the UI offers (up to 365 days),
 * making the card go empty over time instead of showing a stable demo story.
 *
 * Remediation speed is severity-shaped (critical fixed fastest, low slowest) so
 * the card's per-severity breakdown and p90 tell a plausible story rather than
 * a flat one.
 *
 * Attribution is seeded per-row so the History page tells a believable story:
 * mostly job-attributed (device + engineer + a work clock inside the exposure
 * window), a handful manual, some genuinely unattributed (Autopatch/WSUS/user
 * action — still counts toward time-to-remediate, just uncredited), and a rare
 * `reclassified` row so the "not counted as a fix" tag has something to show.
 * Only "contoso" carries real device rows in demo data (see demoDevices above);
 * msp-root job/manual attributions go device-less, matching demoJobs' own
 * msp-root entries (deviceHostname: null) rather than inventing devices that
 * don't otherwise exist in the demo tenant.
 */
function buildDemoRemediationEvents(): RemediationEventRow[] {
  const now = new Date();
  const tenantIds = ["contoso", "msp-root"];
  const severities: Severity[] = ["critical", "high", "medium", "low"];
  const hourRangeBySeverity: Record<Severity, [number, number]> = {
    critical: [4, 48],
    high: [24, 120],
    medium: [72, 240],
    low: [120, 400],
  };
  const softwareNames = [
    "7-Zip",
    "Mozilla Firefox",
    "Google Chrome",
    "Adobe Acrobat Reader",
    "Zoom",
    "VLC media player",
  ];
  const channels = ["live-response", "intune-remediation", "win32-app", "expedited-quality-update"] as const;
  const contosoDevices = [
    { id: "d0000001-0000-0000-0000-000000000001", hostname: "CON-LT-014" },
    { id: "d0000002-0000-0000-0000-000000000002", hostname: "CON-DT-007" },
    { id: "d0000003-0000-0000-0000-000000000003", hostname: "CON-LT-022" },
  ];

  const rows: RemediationEventRow[] = [];
  let seq = 0;
  for (const [tenantIdx, tenantId] of tenantIds.entries()) {
    for (let d = 364; d >= 0; d--) {
      const rand = seededRandom(`remediation:${tenantId}:${d}`);
      // Roughly 1-in-3 days produces a remediation event, occasionally two.
      const eventCount = rand() < 0.12 ? 2 : rand() < 0.35 ? 1 : 0;
      for (let i = 0; i < eventCount; i++) {
        const r2 = seededRandom(`remediation:${tenantId}:${d}:${i}`);
        const severity = severities[Math.floor(r2() * severities.length) % severities.length]!;
        const [minHours, maxHours] = hourRangeBySeverity[severity];
        const hours = minHours + r2() * (maxHours - minHours);
        const remediatedAt = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
        const detectedAt = new Date(remediatedAt.getTime() - hours * 60 * 60 * 1000);
        const software = softwareNames[Math.floor(r2() * softwareNames.length) % softwareNames.length]!;
        seq += 1;

        // Attribution story: ~62% job, ~10% manual, ~2% reclassified (never
        // fixed, excluded from the metric), the rest genuinely unattributed.
        const roll = r2();
        const isReclassified = roll < 0.02;
        const attribution: RemediationEventRow["attribution"] = isReclassified
          ? "unattributed"
          : roll < 0.64
            ? "job"
            : roll < 0.74
              ? "manual"
              : "unattributed";

        const device = tenantId === "contoso" ? contosoDevices[Math.floor(r2() * contosoDevices.length)] : undefined;

        // Work clock: for a job, dispatch-to-finish is short (minutes) and
        // lands late in the exposure window, close to remediatedAt (Defender
        // confirms the clear on its next scan after the job finishes). For a
        // manual record there's one moment — markedAt — for both timestamps.
        let fixStartedAt: Date | null = null;
        let fixFinishedAt: Date | null = null;
        let deviceId: string | null = null;
        let deviceHostname: string | null = null;
        let engineer: string | null = null;
        let jobId: string | null = null;
        let channel: RemediationEventRow["channel"] = null;
        let contributingJobs = 0;

        if (attribution === "job") {
          const workMinutes = 5 + r2() * 85;
          fixFinishedAt = new Date(remediatedAt.getTime() - r2() * 30 * 60 * 1000);
          if (fixFinishedAt.getTime() < detectedAt.getTime()) fixFinishedAt = new Date(remediatedAt.getTime());
          fixStartedAt = new Date(fixFinishedAt.getTime() - workMinutes * 60 * 1000);
          if (fixStartedAt.getTime() < detectedAt.getTime()) fixStartedAt = new Date(detectedAt.getTime());
          deviceId = device?.id ?? null;
          deviceHostname = device?.hostname ?? null;
          engineer = DEMO_ENGINEER;
          jobId = `9300000${tenantIdx}-0000-0000-0000-${String(seq).padStart(12, "0")}`;
          channel = channels[Math.floor(r2() * channels.length)]!;
          contributingJobs = r2() < 0.15 ? 2 : 1;
        } else if (attribution === "manual") {
          const markedAt = new Date(remediatedAt.getTime() - r2() * 4 * 60 * 60 * 1000);
          fixStartedAt = markedAt;
          fixFinishedAt = markedAt;
          deviceId = device?.id ?? null;
          deviceHostname = device?.hostname ?? null;
          engineer = DEMO_ENGINEER;
        }

        rows.push({
          id: `9200000${tenantIdx}-0000-0000-0000-${String(seq).padStart(12, "0")}`,
          tenantId,
          kind: "vulnerability",
          cveId: `CVE-DEMO-${seq}`,
          recommendationId: null,
          software,
          severity,
          detectedAt,
          remediatedAt,
          deviceId,
          deviceHostname,
          engineer,
          jobId,
          channel,
          attribution,
          fixStartedAt,
          fixFinishedAt,
          contributingJobs,
          closure: isReclassified ? "reclassified" : "cleared",
        });
      }
    }
  }
  return rows;
}

export const demoRemediationEvents: RemediationEventRow[] = buildDemoRemediationEvents();

export const demoSla = DEFAULT_SLA;

export const demoBranding = {
  productName: "PatchPilot365",
  primary: "#4f46e5",
  secondary: "#0ea5e9",
  accent: "#f59e0b",
  background: "#0b1020",
  logoUrl: null as string | null,
};
