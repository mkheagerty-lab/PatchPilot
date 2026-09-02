import { useEffect, useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type AltSource,
  type Device,
  type DeviceExclusion,
  type DeviceSoftwareInventoryRow,
  type FixAllResult,
  type MissingKbRow,
  type Recommendation,
  type Severity,
  type Vulnerability,
  type WingetCatalogEntry,
} from "../lib/api";
import {
  altSourcesFor,
  csvRow,
  detectInstallScope,
  detectMicrosoftStoreInstall,
  DEVICE_EXCLUSION_JUSTIFICATION_LABELS,
  hasNonLatinScript,
  isDeviceBehindFeatureUpdate,
  isOsFinding,
  isOsMisattributedSoftware,
  requiresManualRemediation,
  resolveTargetBuild,
  CLIENT_BUILDS,
  type InstallScope,
} from "@patchpilot/shared";
import { downloadCsv } from "../lib/csv";
import { useTenant } from "../lib/tenant";
import { SummarizeButton } from "../components/ai/SummarizeButton";
import { RunNowModal } from "../components/RunNowModal";
import { ExceptionModal } from "../components/ExceptionModal";
import {
  DeviceExclusionModal,
  invalidateExclusionQueries,
} from "../components/DeviceExclusionModal";
import { AddToGroupModal } from "../components/AddToGroupModal";
import { MissingKbFixNowModal } from "../components/MissingKbFixNowModal";
import { FixAllModal, type FixAllConfirmPayload } from "../components/FixAllModal";
import { SoftwareInventoryFixAllModal } from "../components/SoftwareInventoryFixAllModal";
import { WizardShell } from "../components/WizardShell";
import {
  Card,
  ComplianceChip,
  isRemediableType,
  ManualRemediationTag,
  MsStoreChip,
  PageHeader,
  prettyRemediationType,
  ScopeChip,
  SeverityChip,
  SlaChip,
  SlideOver,
  UNSUPPORTED_REMEDIATION_REASON,
} from "../components/ui";
import {
  CveDetailBody,
  DetectionEvidence,
  ExceptionChip,
  FixedOnDeviceChip,
  FixedOnDeviceNote,
  formatDate,
  RemediationBadge,
  SeverityCounts,
  SEVERITY_ORDER,
  SEVERITY_RANK,
  SortIcon,
  type FixedOnDevice,
  type SortDir,
} from "../components/cve";

// One remediable software group on a device: the whole device's findings for a
// single product rolled up to the worst-severity CVE, which seeds the Run Now
// dialog exactly like the Vulnerabilities page's "By software" runs.
type DeviceRunTarget = {
  software: string;
  /** Marketing-friendly label for display only; `software` stays the raw key. */
  displayName: string;
  /** Worst-severity finding id in the group — what the dialog seeds from. */
  vulnId: string;
  patchType: "app" | "os";
  wingetRemediable: boolean;
  /** Winget package id for the group's worst-severity finding, if known. */
  wingetPackageId: string | null;
  severity: Severity;
  cveCount: number;
  altSources: AltSource[];
  /** Vendor/publisher — surfaced as a Latin anchor under non-Latin app names. */
  publisher: string | null;
  /**
   * A remediation already applied on this device for this software that Defender
   * hasn't published yet, if any. Annotation only: the CVEs in the group are
   * still exactly what Defender reports.
   */
  fixedOnDevice: FixedOnDevice | null;
  /** Machine-wide vs per-user install, from the group's disk/registry evidence. */
  installScope: InstallScope;
  /** Microsoft Store (UWP/MSIX) install, from the group's disk/registry evidence. */
  isStoreInstall: boolean;
};

// Friendly labels for the delivery route shown next to each remediable app.
const SOURCE_LABEL: Record<string, string> = {
  chocolatey: "Chocolatey",
  "microsoft-store": "Microsoft Store",
};
function routeLabel(t: DeviceRunTarget): string {
  if (t.patchType === "os") return "OS · Update ring";
  if (t.wingetRemediable) return "Winget";
  if (t.altSources.length > 0)
    return t.altSources.map((s) => SOURCE_LABEL[s.source] ?? s.source).join(" / ");
  return "Manual";
}

/** A clickable table column header that sorts by `sortKey` — shared across the
 *  Findings tab's software/components/OS tables and the Inventories table. */
function SortableTh<K extends string>({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  title,
  className = "",
}: {
  label: string;
  sortKey: K;
  activeKey: K;
  dir: SortDir;
  onSort: (key: K) => void;
  title?: string;
  /** Extra <th> classes — used to pin narrow columns so the name column absorbs the slack. */
  className?: string;
}) {
  const active = sortKey === activeKey;
  return (
    <th className={`px-4 py-2.5 font-medium ${className}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
        title={title}
        className="group inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-slate-700"
      >
        {label}
        <SortIcon active={active} dir={dir} />
      </button>
    </th>
  );
}

// "By software"/"By Components" table sort — shared key set since only one of
// the two sub-tabs is visible at a time.
type RunTargetSortKey = "name" | "severity" | "cves" | "scope";
const RUN_TARGET_DEFAULT_DIR: Record<RunTargetSortKey, SortDir> = {
  name: "asc",
  severity: "desc",
  cves: "desc",
  scope: "asc",
};
function runTargetSortValue(t: DeviceRunTarget, key: RunTargetSortKey): string | number {
  switch (key) {
    case "name":
      return (t.displayName ?? t.software).toLowerCase();
    case "severity":
      return SEVERITY_RANK[t.severity] ?? 0;
    case "cves":
      return t.cveCount;
    case "scope":
      return t.installScope;
  }
}
function sortRunTargets(
  rows: DeviceRunTarget[],
  key: RunTargetSortKey,
  dir: SortDir,
): DeviceRunTarget[] {
  const d = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = runTargetSortValue(a, key);
    const bv = runTargetSortValue(b, key);
    let cmp: number;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    if (cmp === 0) cmp = (a.displayName ?? a.software).localeCompare(b.displayName ?? b.software);
    return cmp * d;
  });
}

// "By CVE" tab table sort — mirrors the Vulnerabilities page's "All CVEs"
// table column set (minus Devices, meaningless once already scoped to one
// device) so the two tables read as the same table.
type DeviceCveSortKey =
  | "cve"
  | "severity"
  | "cvss"
  | "software"
  | "detected"
  | "remediation"
  | "sla"
  | "status";
const DEVICE_CVE_DEFAULT_DIR: Record<DeviceCveSortKey, SortDir> = {
  cve: "asc",
  severity: "desc",
  cvss: "desc",
  software: "asc",
  detected: "desc",
  remediation: "asc",
  sla: "asc",
  status: "asc",
};
function deviceCveSortValue(v: Vulnerability, key: DeviceCveSortKey): string | number {
  switch (key) {
    case "cve":
      return (v.cveId ?? "").toLowerCase();
    case "severity":
      return SEVERITY_RANK[v.severity] ?? 0;
    case "cvss":
      return v.cvss ?? -1;
    case "software":
      return (v.displayName ?? v.software).toLowerCase();
    case "detected": {
      const ms = new Date(v.detectedAt).getTime();
      return Number.isNaN(ms) ? 0 : ms;
    }
    case "remediation":
      return v.wingetRemediable ? 1 : 0;
    case "sla":
      return v.sla.daysRemaining;
    case "status":
      return v.status;
  }
}
function sortDeviceCves(
  rows: Vulnerability[],
  key: DeviceCveSortKey,
  dir: SortDir,
): Vulnerability[] {
  const d = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = deviceCveSortValue(a, key);
    const bv = deviceCveSortValue(b, key);
    let cmp: number;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    if (cmp === 0) cmp = (a.cveId ?? "").localeCompare(b.cveId ?? "");
    return cmp * d;
  });
}

// "Missing KBs" table sort.
type KbSortKey = "kb" | "title" | "cves";
const KB_DEFAULT_DIR: Record<KbSortKey, SortDir> = {
  kb: "asc",
  title: "asc",
  cves: "desc",
};
function kbSortValue(k: MissingKbRow, key: KbSortKey): string | number {
  switch (key) {
    case "kb":
      return k.kbId.toLowerCase();
    case "title":
      return k.title.toLowerCase();
    case "cves":
      return k.cveCount;
  }
}
function sortMissingKbs(rows: MissingKbRow[], key: KbSortKey, dir: SortDir): MissingKbRow[] {
  const d = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = kbSortValue(a, key);
    const bv = kbSortValue(b, key);
    let cmp: number;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    if (cmp === 0) cmp = a.kbId.localeCompare(b.kbId);
    return cmp * d;
  });
}

// Inventories tab table sort.
type InventorySortKey = "name" | "vendor" | "version" | "scope" | "latest" | "weaknesses";
const INVENTORY_DEFAULT_DIR: Record<InventorySortKey, SortDir> = {
  name: "asc",
  vendor: "asc",
  version: "asc",
  scope: "asc",
  latest: "asc",
  weaknesses: "desc",
};
function inventorySortValue(
  row: DeviceSoftwareInventoryRow,
  key: InventorySortKey,
): string | number {
  switch (key) {
    case "name":
      return row.name.toLowerCase();
    case "vendor":
      return (row.vendor ?? "").toLowerCase();
    case "version":
      return (row.version ?? "").toLowerCase();
    case "scope":
      return row.installScope;
    case "latest":
      return (row.latestVersion ?? "").toLowerCase();
    case "weaknesses":
      return row.weaknessCount;
  }
}
function sortInventory(
  rows: DeviceSoftwareInventoryRow[],
  key: InventorySortKey,
  dir: SortDir,
): DeviceSoftwareInventoryRow[] {
  const d = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = inventorySortValue(a, key);
    const bv = inventorySortValue(b, key);
    let cmp: number;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    if (cmp === 0) cmp = a.name.localeCompare(b.name);
    return cmp * d;
  });
}

// Security Recommendations tab table sort.
type DeviceRecSortKey =
  | "recommendation"
  | "severity"
  | "cves"
  | "version"
  | "detected"
  | "sla"
  | "status";
const DEVICE_REC_DEFAULT_DIR: Record<DeviceRecSortKey, SortDir> = {
  recommendation: "asc",
  severity: "desc",
  cves: "desc",
  version: "asc",
  detected: "desc",
  sla: "asc",
  status: "asc",
};
function deviceRecSortValue(r: Recommendation, key: DeviceRecSortKey): string | number {
  switch (key) {
    case "recommendation":
      return r.recommendationName.toLowerCase();
    case "severity":
      return SEVERITY_RANK[r.severity] ?? 0;
    case "cves":
      return r.weaknessCount;
    case "version":
      return (r.recommendedVersion ?? "").toLowerCase();
    case "detected": {
      const ms = new Date(r.detectedAt).getTime();
      return Number.isNaN(ms) ? 0 : ms;
    }
    // Misconfigurations have no patch clock — sort them last.
    case "sla":
      return r.sla ? r.sla.daysRemaining : Number.MAX_SAFE_INTEGER;
    case "status":
      return r.status;
  }
}
function sortDeviceRecs<T extends Recommendation>(
  rows: T[],
  key: DeviceRecSortKey,
  dir: SortDir,
): T[] {
  const d = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = deviceRecSortValue(a, key);
    const bv = deviceRecSortValue(b, key);
    let cmp: number;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    if (cmp === 0) cmp = a.productName.localeCompare(b.productName);
    return cmp * d;
  });
}

// The per-CVE findings a device-scoped recommendation rolls up — same
// either-contains product-name match Recommendations.tsx uses, scoped to this
// device's own (already-loaded) findings instead of a fresh tenant-wide fetch.
function cvesForDeviceRec(rec: Recommendation, vulns: Vulnerability[]): Vulnerability[] {
  // Misconfigurations are config findings with no meaningful product name.
  if (rec.kind === "misconfiguration") return [];
  const product = rec.productName.toLowerCase();
  return vulns.filter((v) => {
    const sw = v.software.toLowerCase();
    return sw === product || sw.includes(product) || product.includes(sw);
  });
}

// Finds the existing (already-computed) DeviceRunTarget whose software fuzzy-
// matches a recommendation's product name, so "Fix now" on this tab reuses the
// exact same Run Now flow as the Findings > By software tab instead of a
// second remediation path.
function runTargetForDeviceRec(
  rec: Recommendation,
  targets: DeviceRunTarget[],
): DeviceRunTarget | null {
  const product = rec.productName.toLowerCase();
  return (
    targets.find((t) => {
      const name = (t.displayName ?? t.software).toLowerCase();
      return name === product || name.includes(product) || product.includes(name);
    }) ?? null
  );
}

/**
 * Whether "Fix now" can drive a device-scoped recommendation, and why not when
 * it can't — mirrors the same gate on the Recommendations page so a row reads
 * identically from either surface.
 */
function deviceFixNowState(
  rec: Recommendation,
  targets: DeviceRunTarget[],
): { target: DeviceRunTarget | null; reason: string } {
  if (rec.kind === "misconfiguration") {
    return {
      target: null,
      reason: "Configuration change — remediate in Intune or Group Policy, not by updating a package",
    };
  }
  if (isOsFinding(rec.productName)) {
    return {
      target: null,
      reason: "Ships via Windows Update — use the Missing KBs tab",
    };
  }
  if (requiresManualRemediation(rec.productName)) {
    return {
      target: null,
      reason: "Bundled library — the owning application has to ship the updated version",
    };
  }
  if (!isRemediableType(rec.remediationType)) {
    return {
      target: null,
      reason: UNSUPPORTED_REMEDIATION_REASON,
    };
  }
  const target = runTargetForDeviceRec(rec, targets);
  return {
    target,
    reason: target ? "Run remediation" : "No associated finding to remediate",
  };
}

/** Defender merges both recommendation kinds on a device page — the chip keeps
 *  them tellable apart in the merged list. */
function RecKindChip({ kind }: { kind: Recommendation["kind"] }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
        kind === "misconfiguration"
          ? "bg-violet-100 text-violet-700"
          : "bg-sky-100 text-sky-700"
      }`}
    >
      {kind === "misconfiguration" ? "Misconfiguration" : "Vulnerability"}
    </span>
  );
}

type ComplianceFilter = "all" | "compliant" | "noncompliant" | "unknown";
const COMPLIANCE_FILTERS: { value: ComplianceFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "noncompliant", label: "Non-compliant" },
  { value: "compliant", label: "Compliant" },
  { value: "unknown", label: "Unknown" },
];

/**
 * Defender's "Exclusion state" filter, verbatim. Defaults to `not-excluded`,
 * which is also what the API returns when `includeExcluded` is absent — an
 * excluded device is meant to be invisible unless you go looking for it.
 */
type ExclusionFilter = "not-excluded" | "excluded" | "all";
const EXCLUSION_FILTERS: { value: ExclusionFilter; label: string }[] = [
  { value: "not-excluded", label: "Not excluded" },
  { value: "excluded", label: "Excluded" },
  { value: "all", label: "All" },
];

/** Marks a device covered by an active local exclusion. Mirrors `ExceptionChip`. */
function ExcludedChip({ reason }: { reason?: string | null }) {
  return (
    <span
      title={
        reason
          ? `Excluded — ${reason}`
          : "An active PatchPilot exclusion covers this device."
      }
      className="inline-flex items-center rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-700"
    >
      Excluded
    </span>
  );
}

/**
 * The shared "nothing here, because the device is excluded" body used by all
 * four device tabs. Defender's device page does the same thing — an excluded
 * device shows no vulnerabilities, no software inventory and no security
 * recommendations, and the reason is worth stating rather than leaving the
 * engineer to read an empty table as a sync failure.
 */
function ExcludedTabNotice({ what, reason }: { what: string; reason?: string | null }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
      <p className="font-medium text-slate-800">This device is excluded.</p>
      <p className="mt-1 text-xs leading-relaxed">
        Excluded devices report no {what}, and are blocked from remediation.
        {reason ? ` Reason: ${reason}.` : ""} Stop the exclusion from the
        Overview tab to bring it back.
      </p>
    </div>
  );
}

// Rank used to surface the devices that need attention first: breached SLA at
// the top, then the unmeasurable, then the healthy.
const COMPLIANCE_RANK: Record<Device["compliance"], number> = {
  noncompliant: 0,
  unknown: 1,
  compliant: 2,
};

/** Whole-number days since a timestamp, floored at 0. */
function daysAgo(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export function Devices() {
  const { activeTenantId, isAllTenants, tenants } = useTenant();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<Device | null>(null);
  // The per-device CVE whose detail pops out (stacked over the device panel).
  const [selectedCve, setSelectedCve] = useState<Vulnerability | null>(null);
  // The software group whose detail pops out (stacked over the device panel):
  // related CVEs + how it was detected (installed version + disk paths).
  const [softwareDetail, setSoftwareDetail] = useState<DeviceRunTarget | null>(null);
  // The software group the engineer chose to remediate on THIS device — seeds
  // the Run Now dialog, locked to the selected machine.
  const [runTarget, setRunTarget] = useState<DeviceRunTarget | null>(null);
  // The Security Recommendations row whose detail pops out (stacked over the
  // device panel), mirroring Recommendations.tsx's own detail SlideOver.
  const [selectedDeviceRec, setSelectedDeviceRec] = useState<Recommendation | null>(
    null,
  );
  // The target (recommendation- or CVE-scoped) the "Create exception" dialog
  // is seeded from (opened from the per-CVE or per-recommendation detail
  // panel), null when the dialog is closed.
  const [exceptionTarget, setExceptionTarget] = useState<{
    recommendationId?: string | null;
    cveId?: string | null;
    tenantId: string;
    label: string;
  } | null>(null);
  // The missing-KB row the engineer chose to remediate on THIS device — seeds
  // the missing-KB Fix Now modal.
  const [kbFixTarget, setKbFixTarget] = useState<{
    tenantId: string;
    missingKbId: string;
    kbId: string;
    title: string;
    hostname: string;
  } | null>(null);
  // Findings view: raw CVE list, per-app remediation, missing OS updates, and
  // unsupported components (OpenSSL/MySQL/Log4j) each get their own tab so a
  // fix is reachable without scrolling past hundreds of mixed rows.
  const [findingsTab, setFindingsTab] = useState<"cve" | "software" | "os" | "components">("cve");

  // Top-level device-panel tab. Full-screen (WizardShell) with four sections:
  // Overview (identity/posture), Inventories (all software, not just findings),
  // Findings (the CVE/software/OS/components breakdown above), Security
  // Recommendations (Defender's consolidated view, filtered to this device).
  const [deviceTab, setDeviceTab] = useState<
    "overview" | "inventories" | "findings" | "recommendations"
  >("overview");

  // One shared search box above the Findings sub-tabs, filtering whichever
  // sub-tab is currently active.
  const [findingsSearch, setFindingsSearch] = useState("");
  // Search + sort for the software/components sub-tabs (shared — only one is
  // visible at a time).
  const [runTargetSortKey, setRunTargetSortKey] = useState<RunTargetSortKey>("severity");
  const [runTargetSortDir, setRunTargetSortDir] = useState<SortDir>("desc");
  const toggleRunTargetSort = (key: RunTargetSortKey) => {
    if (key === runTargetSortKey) {
      setRunTargetSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setRunTargetSortKey(key);
      setRunTargetSortDir(RUN_TARGET_DEFAULT_DIR[key]);
    }
  };
  // Sort for the OS sub-tab.
  const [kbSortKey, setKbSortKey] = useState<KbSortKey>("kb");
  const [kbSortDir, setKbSortDir] = useState<SortDir>("asc");
  const toggleKbSort = (key: KbSortKey) => {
    if (key === kbSortKey) {
      setKbSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setKbSortKey(key);
      setKbSortDir(KB_DEFAULT_DIR[key]);
    }
  };

  // Search + sort for the Inventories tab.
  const [inventorySearch, setInventorySearch] = useState("");
  // The Inventories row whose detail pops out (stacked over the device panel),
  // mirroring the Findings > Software SlideOver pattern.
  const [inventoryDetail, setInventoryDetail] = useState<DeviceSoftwareInventoryRow | null>(
    null,
  );
  const [inventorySortKey, setInventorySortKey] = useState<InventorySortKey>("name");
  const [inventorySortDir, setInventorySortDir] = useState<SortDir>("asc");
  const toggleInventorySort = (key: InventorySortKey) => {
    if (key === inventorySortKey) {
      setInventorySortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setInventorySortKey(key);
      setInventorySortDir(INVENTORY_DEFAULT_DIR[key]);
    }
  };

  // Fix Now / Fix All for the Inventories tab — reuses the same
  // software-inventory dialogs as the standalone Software Inventory page,
  // just scoped to this one device instead of a per-software device list.
  const [inventoryFixTarget, setInventoryFixTarget] = useState<DeviceSoftwareInventoryRow | null>(
    null,
  );
  const [inventoryFixAllOpen, setInventoryFixAllOpen] = useState(false);

  // Search + sort for the Security Recommendations tab.
  const [recSearch, setRecSearch] = useState("");
  const [recSortKey, setRecSortKey] = useState<DeviceRecSortKey>("cves");
  const [recSortDir, setRecSortDir] = useState<SortDir>("desc");
  const toggleRecSort = (key: DeviceRecSortKey) => {
    if (key === recSortKey) {
      setRecSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setRecSortKey(key);
      setRecSortDir(DEVICE_REC_DEFAULT_DIR[key]);
    }
  };

  // The "Fix all" confirmation dialog — urgency/trigger/software checklist —
  // shown before any Fix All jobs are dispatched.
  const [fixAllModalOpen, setFixAllModalOpen] = useState(false);

  // Last "Fix All" outcome for the open device — cleared whenever a new run
  // starts or the panel is closed, so a stale result never survives a device
  // switch.
  const [fixAllResult, setFixAllResult] = useState<FixAllResult | null>(null);
  const [fixAllError, setFixAllError] = useState<string | null>(null);

  // Per-device CVE table sort. Defaults to worst severity first, mirroring the
  // Vulnerabilities page's "All CVEs" table.
  const [cveSortKey, setCveSortKey] = useState<DeviceCveSortKey>("severity");
  const [cveSortDir, setCveSortDir] = useState<SortDir>("desc");
  const toggleCveSort = (key: DeviceCveSortKey) => {
    if (key === cveSortKey) {
      setCveSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setCveSortKey(key);
      setCveSortDir(DEVICE_CVE_DEFAULT_DIR[key]);
    }
  };

  // Ephemeral refinements (not URL-backed — they don't need to be shareable).
  const [search, setSearch] = useState("");

  // Bulk exclusion: the checked rows, and the devices the exclusion dialog is
  // open for (one for a row action, many for the bulk bar). Keyed by
  // `devices.id` — the dialog resolves each to its managedDeviceId itself.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [exclusionTarget, setExclusionTarget] = useState<Device[] | null>(null);
  // Bulk "Add to group" — same one-for-row/many-for-bulk shape as the exclusion
  // dialog above, independent of exclusion status.
  const [groupTarget, setGroupTarget] = useState<Device[] | null>(null);

  // Compliance filter lives in the URL so the Dashboard's "Non-compliant
  // devices" KPI can deep-link straight to the filtered list.
  const filter = (params.get("compliance") as ComplianceFilter) || "all";
  const setFilter = (value: ComplianceFilter) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "all") next.delete("compliance");
        else next.set("compliance", value);
        return next;
      },
      { replace: true },
    );

  // OS filter lives in the URL so the Dashboard's Fleet breakdown OS bar can
  // deep-link straight to devices running that OS.
  const osFilter = params.get("os") || "all";
  const setOsFilter = (value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "all") next.delete("os");
        else next.set("os", value);
        return next;
      },
      { replace: true },
    );

  // Exclusion state filter lives in the URL so the Dashboard's exclusion
  // banner can deep-link straight to the Excluded view. Drives the *request*,
  // not a client-side filter: the API hides excluded devices unless asked, so
  // "Excluded"/"All" have to opt in with includeExcluded=true (and the flag
  // is part of the query key, or the two views would share one cache entry).
  const exclusionFilter = (params.get("exclusion") as ExclusionFilter) || "not-excluded";
  const setExclusionFilter = (value: ExclusionFilter) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "not-excluded") next.delete("exclusion");
        else next.set("exclusion", value);
        return next;
      },
      { replace: true },
    );
  const includeExcluded = exclusionFilter !== "not-excluded";
  const { data: devices = [], isLoading } = useQuery({
    queryKey: ["devices", activeTenantId, includeExcluded],
    queryFn: () => {
      const params = new URLSearchParams();
      if (!isAllTenants) params.set("tenantId", activeTenantId!);
      if (includeExcluded) params.set("includeExcluded", "true");
      const qs = params.toString();
      return api.get<Device[]>(`/api/devices${qs ? `?${qs}` : ""}`);
    },
    enabled: !!activeTenantId,
  });

  const queryClient = useQueryClient();

  // The active exclusions for the current tenant scope — backs the Exclusion
  // details panel and the Stop exclusion button. Tenant-scoped like the device
  // list, and optional-tenantId on the server so all-tenants mode still works.
  const { data: deviceExclusions = [] } = useQuery({
    queryKey: ["device-exclusions", activeTenantId],
    queryFn: () =>
      api.get<DeviceExclusion[]>(
        isAllTenants
          ? "/api/device-exclusions"
          : `/api/device-exclusions?tenantId=${activeTenantId}`,
      ),
    enabled: !!activeTenantId,
  });

  // Only the live ones, keyed the way an exclusion is actually identified.
  const activeExclusionByManagedId = useMemo(
    () =>
      new Map(
        deviceExclusions
          .filter((e) => e.derivedStatus === "active")
          .map((e) => [e.managedDeviceId, e]),
      ),
    [deviceExclusions],
  );

  // Defender's "Stop exclusion" — soft-cancels the row, then invalidates every
  // surface the device is about to reappear on.
  const stopExclusion = useMutation({
    mutationFn: (exclusionId: string) =>
      api.post<DeviceExclusion>(`/api/device-exclusions/${exclusionId}/cancel`, {}),
    onSuccess: () => invalidateExclusionQueries(queryClient),
  });

  // Dispatches one job per engineer-confirmed software group on the open
  // device, using the urgency/trigger method and (optionally edited) winget
  // package ids confirmed in the Fix All dialog. Skips anything the server's
  // preflight gate rejects (missing package, manual-remediation-only
  // software, no matching finding).
  const fixAllMutation = useMutation({
    mutationFn: (payload: FixAllConfirmPayload) =>
      api.post<FixAllResult>(`/api/devices/${selected!.id}/fix-all`, payload),
    onSuccess: (result) => {
      setFixAllResult(result);
      setFixAllError(null);
      setFixAllModalOpen(false);
      queryClient.invalidateQueries({
        queryKey: ["device-vulnerabilities", selected?.id],
      });
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (err) => {
      setFixAllResult(null);
      setFixAllError(
        err instanceof ApiError ? err.message : "Fix All failed to run.",
      );
    },
  });

  // Deep-link: another page (e.g. the Vulnerabilities exposed-devices popout)
  // can open a specific device's detail panel via ?device=<defenderMachineId|id|
  // hostname>. We resolve it once the devices have loaded.
  const deviceParam = params.get("device");
  useEffect(() => {
    if (!deviceParam || devices.length === 0) return;
    const match = devices.find(
      (d) =>
        d.defenderMachineId === deviceParam ||
        d.id === deviceParam ||
        d.hostname === deviceParam,
    );
    if (match) setSelected(match);
  }, [deviceParam, devices]);

  // A stale Fix All result/error from one device must never bleed into the
  // next one's panel, and every device opens on Overview with a clean search.
  useEffect(() => {
    setFixAllResult(null);
    setFixAllError(null);
    setDeviceTab("overview");
    setFindingsSearch("");
    setInventorySearch("");
    setRecSearch("");
    setSelectedDeviceRec(null);
  }, [selected?.id]);

  // Closing the detail panel also strips the deep-link param so the same device
  // can be re-opened later (a stale ?device= would otherwise immediately reopen).
  const closeDetail = () => {
    setSelected(null);
    if (deviceParam)
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("device");
          return next;
        },
        { replace: true },
      );
  };

  // Map Entra tenantId → display name so the "Customer Tenant" column reads
  // human-friendly. Falls back to the raw id for any device whose tenant has
  // dropped out of the tenants list.
  const tenantNames = useMemo(
    () => new Map(tenants.map((t) => [t.tenantId, t.displayName])),
    [tenants],
  );

  // Map Entra tenantId → resolved feature-update target build, so the
  // Devices table and detail panel can flag "Behind" without re-parsing
  // each tenant's featureUpdateTargetVersion label on every row.
  const featureUpdateTargetBuildByTenant = useMemo(
    () =>
      new Map(
        tenants.map((t) => [t.tenantId, resolveTargetBuild(t.featureUpdateTargetVersion)]),
      ),
    [tenants],
  );

  // The selected device's CVEs (same shape + SLA as the Vulnerabilities page),
  // fetched on demand only while its detail panel is open.
  const { data: deviceVulns = [], isLoading: deviceVulnsLoading } = useQuery({
    queryKey: ["device-vulnerabilities", selected?.id],
    queryFn: () =>
      api.get<Vulnerability[]>(`/api/devices/${selected!.id}/vulnerabilities`),
    enabled: selected !== null,
  });

  // This device's missing Windows Updates (KBs) — backs the "Missing KBs" tab with
  // real Defender getmissingkbs rows instead of the single rolled-up "Microsoft
  // Windows 11" recommendation.
  const { data: deviceMissingKbs = [], isLoading: deviceKbsLoading } = useQuery({
    queryKey: ["device-missing-kbs", selected?.id],
    queryFn: () =>
      api
        .get<{ missingKbs: MissingKbRow[] }>(`/api/devices/${selected!.id}/missing-kbs`)
        .then((r) => r.missingKbs),
    enabled: selected !== null,
  });

  // This device's full software inventory (not just findings with an open
  // CVE) — backs the Inventories tab.
  const { data: deviceSoftwareInventory = [], isLoading: inventoryLoading } = useQuery({
    queryKey: ["device-software-inventory", selected?.id],
    queryFn: () =>
      api
        .get<{ softwareInventory: DeviceSoftwareInventoryRow[] }>(
          `/api/devices/${selected!.id}/software-inventory`,
        )
        .then((r) => r.softwareInventory),
    enabled: selected !== null,
  });

  // This device's Security Recommendations — Defender's consolidated view,
  // filtered server-side to the products this device is actually exposed to.
  const { data: deviceRecommendations = [], isLoading: deviceRecsLoading } = useQuery({
    queryKey: ["device-recommendations", selected?.id],
    queryFn: () => api.get<Recommendation[]>(`/api/devices/${selected!.id}/recommendations`),
    enabled: selected !== null,
  });

  // Winget catalog (local mapping, no Microsoft call) — surfaces the latest
  // available version in the per-CVE popout, matching the Vulnerabilities page.
  const { data: catalog = [] } = useQuery({
    queryKey: ["catalog"],
    queryFn: () => api.get<WingetCatalogEntry[]>("/api/catalog"),
  });
  const catalogByPackage = useMemo(
    () => new Map(catalog.map((c) => [c.packageId, c])),
    [catalog],
  );
  const selectedCveCatalog = selectedCve?.wingetPackageId
    ? catalogByPackage.get(selectedCve.wingetPackageId)
    : undefined;

  // Per-severity breakdown of the device's CVEs — feeds the same severity pills
  // the Vulnerabilities page shows.
  const deviceSevCounts = useMemo<Record<Severity, number>>(() => {
    const counts: Record<Severity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    for (const v of deviceVulns) counts[v.severity] += 1;
    return counts;
  }, [deviceVulns]);

  // The shared Findings search box, applied to whichever sub-tab is active.
  const findingsQuery = findingsSearch.trim().toLowerCase();

  // Device CVE table, filtered by the shared search then ordered by the
  // sortable CVE/Severity/SLA header.
  const filteredDeviceVulns = useMemo(() => {
    if (!findingsQuery) return deviceVulns;
    return deviceVulns.filter(
      (v) =>
        (v.cveId ?? "").toLowerCase().includes(findingsQuery) ||
        (v.displayName ?? "").toLowerCase().includes(findingsQuery) ||
        v.software.toLowerCase().includes(findingsQuery),
    );
  }, [deviceVulns, findingsQuery]);
  const sortedDeviceVulns = useMemo(() => {
    return sortDeviceCves(filteredDeviceVulns, cveSortKey, cveSortDir);
  }, [filteredDeviceVulns, cveSortKey, cveSortDir]);

  // The device's findings grouped into distinct remediable software, so the
  // engineer can pick which application(s) to fix rather than one CVE at a time.
  // Apps first, then worst severity, then most CVEs.
  const deviceRunTargets = useMemo<DeviceRunTarget[]>(() => {
    const bySoftware = new Map<string, Vulnerability[]>();
    for (const v of deviceVulns) {
      const arr = bySoftware.get(v.software);
      if (arr) arr.push(v);
      else bySoftware.set(v.software, [v]);
    }
    const targets: DeviceRunTarget[] = [];
    for (const [software, group] of bySoftware) {
      const worst = group.reduce((best, v) =>
        (SEVERITY_RANK[v.severity] ?? 0) > (SEVERITY_RANK[best.severity] ?? 0)
          ? v
          : best,
      );
      const patchType = isOsFinding(software) ? "os" : "app";
      targets.push({
        software,
        displayName: worst.displayName ?? software,
        vulnId: worst.id,
        patchType,
        wingetRemediable: worst.wingetRemediable,
        wingetPackageId: worst.wingetPackageId,
        severity: worst.severity,
        cveCount: group.length,
        // Prefer the server-resolved (live Chocolatey catalog) value; fall
        // back to the curated client-side map if the API didn't supply one.
        altSources:
          patchType === "app" && !worst.wingetRemediable
            ? (worst.altSources ?? [...altSourcesFor(software)])
            : [],
        publisher: group.find((v) => v.publisher)?.publisher ?? null,
        // The API annotates every finding in a group it has device-side evidence
        // for, so any one of them carries the same fix.
        fixedOnDevice: group.find((v) => v.fixedOnDevice)?.fixedOnDevice ?? null,
        installScope: isOsMisattributedSoftware(software)
          ? "os"
          : detectInstallScope(
              group.flatMap((v) => v.diskPaths ?? []),
              group.flatMap((v) => v.registryPaths ?? []),
            ),
        isStoreInstall: detectMicrosoftStoreInstall(
          group.flatMap((v) => v.diskPaths ?? []),
          group.flatMap((v) => v.registryPaths ?? []),
        ),
      });
    }
    return targets.sort((a, b) => {
      if (a.patchType !== b.patchType) return a.patchType === "app" ? -1 : 1;
      const sev =
        (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
      if (sev !== 0) return sev;
      return b.cveCount - a.cveCount;
    });
  }, [deviceVulns]);

  // "By software" excludes OS findings (their own tab, real KB data below) and
  // unsupported components (their own tab); "By Components" is the mirror image.
  const appRunTargets = useMemo(
    () =>
      deviceRunTargets.filter(
        (t) => t.patchType === "app" && !requiresManualRemediation(t.software),
      ),
    [deviceRunTargets],
  );
  const componentRunTargets = useMemo(
    () => deviceRunTargets.filter((t) => requiresManualRemediation(t.software)),
    [deviceRunTargets],
  );

  // Search + sort applied to the software/components sub-tabs (shared search
  // filter, matching by name/software/publisher).
  const filterRunTargets = (rows: DeviceRunTarget[]) => {
    if (!findingsQuery) return rows;
    return rows.filter(
      (t) =>
        (t.displayName ?? "").toLowerCase().includes(findingsQuery) ||
        t.software.toLowerCase().includes(findingsQuery) ||
        (t.publisher ?? "").toLowerCase().includes(findingsQuery),
    );
  };
  const sortedAppRunTargets = useMemo(
    () => sortRunTargets(filterRunTargets(appRunTargets), runTargetSortKey, runTargetSortDir),
    [appRunTargets, findingsQuery, runTargetSortKey, runTargetSortDir],
  );
  const sortedComponentRunTargets = useMemo(
    () =>
      sortRunTargets(filterRunTargets(componentRunTargets), runTargetSortKey, runTargetSortDir),
    [componentRunTargets, findingsQuery, runTargetSortKey, runTargetSortDir],
  );

  // Search + sort applied to the OS sub-tab (matching by KB id/title/products).
  const sortedMissingKbs = useMemo(() => {
    const rows = !findingsQuery
      ? deviceMissingKbs
      : deviceMissingKbs.filter(
          (k) =>
            k.kbId.toLowerCase().includes(findingsQuery) ||
            k.title.toLowerCase().includes(findingsQuery) ||
            k.products.some((p) => p.toLowerCase().includes(findingsQuery)),
        );
    return sortMissingKbs(rows, kbSortKey, kbSortDir);
  }, [deviceMissingKbs, findingsQuery, kbSortKey, kbSortDir]);

  // Search + sort applied to the Inventories tab (matching by name/vendor).
  const sortedInventory = useMemo(() => {
    const q = inventorySearch.trim().toLowerCase();
    const rows = !q
      ? deviceSoftwareInventory
      : deviceSoftwareInventory.filter(
          (s) => s.name.toLowerCase().includes(q) || (s.vendor ?? "").toLowerCase().includes(q),
        );
    return sortInventory(rows, inventorySortKey, inventorySortDir);
  }, [deviceSoftwareInventory, inventorySearch, inventorySortKey, inventorySortDir]);

  // Recommendation severity is Defender's exposure-weighted score, not a CVSS
  // label — derive each row's severity + per-category breakdown from the
  // device's own rolled-up CVEs, the same way Recommendations.tsx does.
  const deviceRecsWithBreakdown = useMemo(() => {
    return deviceRecommendations.map((r) => {
      const sevCounts: Record<Severity, number> = {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
      };
      const cves = cvesForDeviceRec(r, deviceVulns);
      for (const v of cves) sevCounts[v.severity] += 1;
      const cveTotal = cves.length;
      const severity =
        cveTotal > 0
          ? (SEVERITY_ORDER.find((s) => sevCounts[s] > 0) ?? r.severity)
          : r.severity;
      const tierCves = cves.filter((v) => v.severity === severity);
      const slaSource =
        tierCves.length > 0
          ? tierCves.reduce((worst, v) =>
              v.sla.daysRemaining < worst.sla.daysRemaining ? v : worst,
            )
          : null;
      const sla = slaSource ? slaSource.sla : r.sla;
      return { ...r, severity, sla, sevCounts, cveTotal };
    });
  }, [deviceRecommendations, deviceVulns]);

  const filteredDeviceRecs = useMemo(() => {
    const q = recSearch.trim().toLowerCase();
    if (!q) return deviceRecsWithBreakdown;
    return deviceRecsWithBreakdown.filter(
      (r) =>
        r.recommendationName.toLowerCase().includes(q) ||
        r.productName.toLowerCase().includes(q) ||
        (r.vendor ?? "").toLowerCase().includes(q),
    );
  }, [deviceRecsWithBreakdown, recSearch]);

  const sortedDeviceRecs = useMemo(
    () => sortDeviceRecs(filteredDeviceRecs, recSortKey, recSortDir),
    [filteredDeviceRecs, recSortKey, recSortDir],
  );

  // The CVEs the selected recommendation rolls up on this device — drives the
  // detail panel's "Underlying CVEs" drill-down.
  const selectedDeviceRecCves = useMemo(
    () => (selectedDeviceRec ? cvesForDeviceRec(selectedDeviceRec, deviceVulns) : []),
    [selectedDeviceRec, deviceVulns],
  );

  // Distinct OS names present in the data, for the OS filter dropdown.
  const osNames = useMemo(() => {
    const set = new Set<string>();
    for (const d of devices) if (d.os) set.add(d.os);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [devices]);

  const query = search.trim().toLowerCase();
  const filtered = devices.filter((d) => {
    // "not-excluded" needs no check — the server already withheld them.
    if (exclusionFilter === "excluded" && !d.excluded) return false;
    if (filter !== "all" && d.compliance !== filter) return false;
    if (osFilter !== "all" && d.os !== osFilter) return false;
    if (query) {
      const haystack = [d.hostname, d.os, d.owner]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  // Most-urgent first: breached SLA, then unmeasurable, then by vuln load.
  const sorted = [...filtered].sort((a, b) => {
    const rank = COMPLIANCE_RANK[a.compliance] - COMPLIANCE_RANK[b.compliance];
    if (rank !== 0) return rank;
    if (b.vulnerabilityCount !== a.vulnerabilityCount)
      return b.vulnerabilityCount - a.vulnerabilityCount;
    return a.hostname.localeCompare(b.hostname);
  });

  // How many distinct tenants contributed to the unfiltered result set.
  const tenantCount = useMemo(
    () => new Set(devices.map((d) => d.tenantId)).size,
    [devices],
  );

  // Non-compliant devices within the current filter — a posture pill.
  const nonCompliant = filtered.filter(
    (d) => d.compliance === "noncompliant",
  ).length;

  // Excluded devices within the current filter — only ever non-zero once the
  // Exclusion state filter has asked for them.
  const excludedShown = filtered.filter((d) => d.excluded).length;

  // Bulk selection is over the *visible* rows only, so a filter change can't
  // leave an invisible device checked and silently excluded with the next
  // bulk action.
  const visibleIds = useMemo(() => new Set(sorted.map((d) => d.id)), [sorted]);
  const checkedDevices = useMemo(
    () => sorted.filter((d) => checkedIds.has(d.id)),
    [sorted, checkedIds],
  );
  const bulkTargets = checkedDevices.filter((d) => !d.excluded);
  // The bulk endpoint takes one tenantId — it resolves hostnames server-side
  // and scopes the lookup by tenant. A cross-tenant selection is a real thing
  // to do in all-tenants mode, so say why it can't go through rather than
  // silently excluding only one tenant's share.
  const bulkSpansTenants =
    new Set(bulkTargets.map((d) => d.tenantId)).size > 1;
  const allVisibleChecked =
    sorted.length > 0 && checkedDevices.length === sorted.length;
  const toggleChecked = (id: string) =>
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  useEffect(() => {
    setCheckedIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleIds]);

  // The open device's live exclusion, read from the exclusions query rather
  // than the device row: the row is a snapshot taken when the list loaded, and
  // it disappears from the list entirely the moment the device is excluded
  // under the default filter.
  const selectedExclusion = selected
    ? activeExclusionByManagedId.get(selected.managedDeviceId)
    : undefined;
  const selectedExcluded = !!selectedExclusion;
  const selectedExclusionReason = selectedExclusion
    ? DEVICE_EXCLUSION_JUSTIFICATION_LABELS[selectedExclusion.justification] +
      (selectedExclusion.notes ? ` — ${selectedExclusion.notes}` : "")
    : null;

  // The open device's feature-update target build, resolved from its
  // tenant's setting (or the shared default), and whether it's behind.
  const selectedFeatureUpdateTargetBuild = selected
    ? (featureUpdateTargetBuildByTenant.get(selected.tenantId) ?? resolveTargetBuild(null))
    : null;
  const selectedFeatureUpdateTargetLabel =
    selectedFeatureUpdateTargetBuild != null
      ? (CLIENT_BUILDS[selectedFeatureUpdateTargetBuild] ??
        String(selectedFeatureUpdateTargetBuild))
      : null;
  const selectedBehindFeatureUpdate =
    selected && selectedFeatureUpdateTargetBuild != null
      ? isDeviceBehindFeatureUpdate(
          selected.osBuild,
          selected.os,
          selectedFeatureUpdateTargetBuild,
        )
      : false;

  function exportCsv() {
    const header = [
      "hostname",
      "owner",
      ...(isAllTenants ? ["tenant"] : []),
      "os",
      "compliance",
      "excluded",
      "exclusion_reason",
      "vulnerability_count",
      "last_seen",
    ];
    const csv =
      csvRow(header) +
      sorted
        .map((d) =>
          csvRow([
            d.hostname,
            d.owner ?? "",
            ...(isAllTenants ? [tenantNames.get(d.tenantId) ?? d.tenantId] : []),
            d.os,
            d.compliance,
            !!d.excluded,
            d.exclusionReason ?? "",
            d.vulnerabilityCount,
            d.lastSeen ?? "",
          ]),
        )
        .join("");
    downloadCsv("devices.csv", csv);
  }

  return (
    <div>
      <PageHeader
        title="Devices"
        subtitle={
          isAllTenants
            ? `Managed endpoints across ${tenantCount} ${
                tenantCount === 1 ? "tenant" : "tenants"
              }, with SLA-based compliance`
            : "Managed endpoints reported by Intune & Defender, with SLA-based compliance"
        }
        actions={
          <div className="flex items-center gap-2">
            <SummarizeButton
              page="devices"
              tenantId={isAllTenants ? null : activeTenantId}
              requiresTenant
            />
            <button
              type="button"
              onClick={exportCsv}
              disabled={sorted.length === 0}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              Export CSV
            </button>
          </div>
        }
      />

      {/* ---- Search + filter bar ---- */}
      <Card className="mb-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1">
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              >
                <path
                  fillRule="evenodd"
                  d="M9 3.5a5.5 5.5 0 1 0 3.39 9.83l3.14 3.14a.75.75 0 1 0 1.06-1.06l-3.14-3.14A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"
                  clipRule="evenodd"
                />
              </svg>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search hostname, OS, owner…"
                className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
              />
            </div>

            <select
              value={osFilter}
              onChange={(e) => setOsFilter(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
            >
              <option value="all">All operating systems</option>
              {osNames.map((os) => (
                <option key={os} value={os}>
                  {os}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
              {COMPLIANCE_FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setFilter(f.value)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    filter === f.value
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Exclusion state — Defender's own filter, same three states. */}
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-slate-400">
                Exclusion state
              </span>
              <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
                {EXCLUSION_FILTERS.map((f) => (
                  <button
                    key={f.value}
                    onClick={() => setExclusionFilter(f.value)}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      exclusionFilter === f.value
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="text-slate-500">
              {sorted.length} {sorted.length === 1 ? "device" : "devices"}
              {sorted.length !== devices.length && ` of ${devices.length}`}
            </span>
            {nonCompliant > 0 && (
              <span className="inline-flex items-center rounded-full bg-rose-100 px-2.5 py-0.5 font-medium text-rose-700">
                {nonCompliant} non-compliant
              </span>
            )}
            {excludedShown > 0 && (
              <span className="inline-flex items-center rounded-full bg-slate-200 px-2.5 py-0.5 font-medium text-slate-700">
                {excludedShown} excluded
              </span>
            )}
          </div>
        </div>
      </Card>

      {/* ---- Bulk action bar. Defender supports bulk exclusion, and picking
              devices off one at a time after a decommission batch is the whole
              reason it does. Only appears once something is checked. ---- */}
      {checkedDevices.length > 0 && (
        <Card className="mb-4 border-slate-300 bg-slate-50">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-slate-700">
              <span className="font-semibold">{checkedDevices.length}</span>{" "}
              {checkedDevices.length === 1 ? "device" : "devices"} selected
              {bulkTargets.length !== checkedDevices.length && (
                <span className="text-slate-500">
                  {" "}
                  ({checkedDevices.length - bulkTargets.length} already excluded)
                </span>
              )}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCheckedIds(new Set())}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
              >
                Clear selection
              </button>
              <button
                type="button"
                onClick={() => setGroupTarget(checkedDevices)}
                disabled={bulkSpansTenants}
                title={
                  bulkSpansTenants
                    ? "Selected devices span more than one tenant — group one tenant's devices at a time."
                    : undefined
                }
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add to group…
              </button>
              <button
                type="button"
                onClick={() => setExclusionTarget(bulkTargets)}
                disabled={bulkTargets.length === 0 || bulkSpansTenants}
                title={
                  bulkTargets.length === 0
                    ? "Every selected device is already excluded."
                    : bulkSpansTenants
                      ? "Selected devices span more than one tenant — exclude one tenant's devices at a time."
                      : undefined
                }
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
              >
                Exclude {bulkTargets.length || ""}{" "}
                {bulkTargets.length === 1 ? "device" : "devices"}
              </button>
            </div>
          </div>
        </Card>
      )}

      <Card className="p-0">
        {isLoading ? (
          <div className="p-5 text-sm text-slate-500">Loading…</div>
        ) : sorted.length === 0 ? (
          <div className="p-5 text-sm text-slate-500">
            {devices.length === 0
              ? isAllTenants
                ? "No devices across any tenant yet."
                : "No devices for this tenant."
              : "No devices match this filter."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="w-10 px-5 py-3 font-medium">
                  <input
                    type="checkbox"
                    aria-label="Select all devices"
                    checked={allVisibleChecked}
                    onChange={() =>
                      setCheckedIds(
                        allVisibleChecked
                          ? new Set()
                          : new Set(sorted.map((d) => d.id)),
                      )
                    }
                    className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
                  />
                </th>
                <th className="px-5 py-3 font-medium">Hostname</th>
                {isAllTenants && (
                  <th className="px-5 py-3 font-medium">Customer Tenant</th>
                )}
                <th className="px-5 py-3 font-medium">OS</th>
                <th
                  className="px-5 py-3 font-medium"
                  title="Compliance against remediation SLAs, not Intune device compliance."
                >
                  SLA Compliance
                </th>
                <th className="px-5 py-3 font-medium">Vulns</th>
                <th className="px-5 py-3 font-medium">Last seen</th>
                <th className="px-5 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => {
                const exclusion = activeExclusionByManagedId.get(d.managedDeviceId);
                return (
                <tr
                  key={d.id}
                  onClick={() => setSelected(d)}
                  className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                >
                  <td className="px-5 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${d.hostname}`}
                      checked={checkedIds.has(d.id)}
                      onChange={() => toggleChecked(d.id)}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
                    />
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-800">
                        {d.hostname}
                      </span>
                      {d.excluded && <ExcludedChip reason={d.exclusionReason} />}
                    </div>
                    {d.owner && (
                      <div className="text-xs text-slate-400">{d.owner}</div>
                    )}
                  </td>
                  {isAllTenants && (
                    <td className="px-5 py-3 text-slate-600">
                      {tenantNames.get(d.tenantId) ?? d.tenantId}
                    </td>
                  )}
                  <td className="px-5 py-3 text-slate-600">
                    <div className="flex items-center gap-1.5">
                      <span>{d.os}</span>
                      {isDeviceBehindFeatureUpdate(
                        d.osBuild,
                        d.os,
                        featureUpdateTargetBuildByTenant.get(d.tenantId) ?? resolveTargetBuild(null),
                      ) && (
                        <span
                          className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                          title="Behind the feature-update target"
                        >
                          Behind
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <ComplianceChip compliance={d.compliance} />
                  </td>
                  <td className="px-5 py-3 text-slate-700">
                    {d.vulnerabilityCount}
                  </td>
                  <td className="px-5 py-3 text-slate-500">
                    {d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "—"}
                  </td>
                  <td className="px-5 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    {d.excluded ? (
                      <button
                        type="button"
                        onClick={() => exclusion && stopExclusion.mutate(exclusion.id)}
                        disabled={!exclusion || stopExclusion.isPending}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                      >
                        Stop exclusion
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setExclusionTarget([d])}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                      >
                        Exclude
                      </button>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <WizardShell
        open={selected !== null}
        onClose={closeDetail}
        title={selected?.hostname ?? ""}
        subtitle="Device"
      >
        {selected && (
          <div className="space-y-6">
            {/* OS + posture chips */}
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                {selected.os}
              </h3>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <ComplianceChip compliance={selected.compliance} />
                <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                  {selected.vulnerabilityCount}{" "}
                  {selected.vulnerabilityCount === 1 ? "vuln" : "vulns"}
                </span>
                {selectedExcluded && (
                  <ExcludedChip reason={selectedExclusionReason} />
                )}
                {selectedBehindFeatureUpdate && selectedFeatureUpdateTargetLabel && (
                  <span
                    className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700"
                    title={`Behind the ${selectedFeatureUpdateTargetLabel} feature-update target`}
                  >
                    Behind
                  </span>
                )}
                {selected.lastSeen && (
                  <span className="text-xs text-slate-400">
                    seen {daysAgo(selected.lastSeen)}d ago
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {selectedBehindFeatureUpdate &&
                    selectedFeatureUpdateTargetLabel &&
                    !selectedExcluded && (
                      <Link
                        to="/windows-updates"
                        title="Feature updates can only be pushed via a group campaign — there is no single-device push."
                        className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
                      >
                        Add to a campaign →
                      </Link>
                    )}
                  {selectedExcluded ? (
                    <button
                      type="button"
                      onClick={() =>
                        selectedExclusion &&
                        stopExclusion.mutate(selectedExclusion.id)
                      }
                      disabled={stopExclusion.isPending}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                    >
                      {stopExclusion.isPending ? "Stopping…" : "Stop exclusion"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setExclusionTarget([selected])}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                    >
                      Exclude device
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Top-level tabs */}
            <div className="inline-flex gap-1 rounded-lg bg-slate-100 p-1">
              {(
                [
                  ["overview", "Overview"],
                  ["inventories", `Inventories (${deviceSoftwareInventory.length})`],
                  ["findings", `Vulnerabilities (${deviceVulns.length})`],
                  [
                    "recommendations",
                    `Security Recommendations (${deviceRecommendations.length})`,
                  ],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDeviceTab(value)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    deviceTab === value
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {deviceTab === "overview" && (
              <>
            {/* Overview */}
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Overview
              </h4>
              <dl className="space-y-1.5 text-sm">
                {isAllTenants && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">Customer tenant</dt>
                    <dd className="min-w-0 truncate font-medium text-slate-800">
                      {tenantNames.get(selected.tenantId) ?? selected.tenantId}
                    </dd>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Operating system</dt>
                  <dd className="font-medium text-slate-800">{selected.os}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Owner</dt>
                  <dd className="min-w-0 truncate font-medium text-slate-800">
                    {selected.owner ?? "—"}
                  </dd>
                </div>
                {/* Hardware inventory from Intune (model/manufacturer/serial);
                    Defender exposes none reliably, so these are hidden when null. */}
                {selected.model && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">Device model</dt>
                    <dd className="min-w-0 truncate font-medium text-slate-800">
                      {selected.model}
                    </dd>
                  </div>
                )}
                {selected.manufacturer && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">Manufacturer</dt>
                    <dd className="min-w-0 truncate font-medium text-slate-800">
                      {selected.manufacturer}
                    </dd>
                  </div>
                )}
                {selected.serialNumber && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">Serial</dt>
                    <dd className="min-w-0 truncate font-mono text-xs text-slate-700">
                      {selected.serialNumber}
                    </dd>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Last seen</dt>
                  <dd className="font-medium text-slate-800">
                    {selected.lastSeen
                      ? new Date(selected.lastSeen).toLocaleString()
                      : "Never"}
                  </dd>
                </div>
              </dl>
            </section>

            {/* Security posture */}
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Security posture
              </h4>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                <dl className="space-y-1.5 text-sm">
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-slate-500">SLA compliance</dt>
                    <dd>
                      <ComplianceChip compliance={selected.compliance} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">Open vulnerabilities</dt>
                    <dd className="font-medium text-slate-800">
                      {selected.vulnerabilityCount}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">Defender coverage</dt>
                    <dd className="font-medium text-slate-800">
                      {selected.defenderMachineId ? "Onboarded" : "Not covered"}
                    </dd>
                  </div>
                </dl>
              </div>
            </section>

            {/* Identifiers */}
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Identifiers
              </h4>
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-slate-500">Intune device ID</dt>
                  <dd className="break-all font-mono text-xs text-slate-700">
                    {selected.managedDeviceId}
                  </dd>
                </div>
                {selected.defenderMachineId && (
                  <div>
                    <dt className="text-slate-500">Defender machine ID</dt>
                    <dd className="break-all font-mono text-xs text-slate-700">
                      {selected.defenderMachineId}
                    </dd>
                  </div>
                )}
              </dl>
            </section>

            {/* Exclusion details — Defender's flyout carries exactly this:
                justification, note, who and when. Only rendered while an
                exclusion is actually in force. */}
            {selectedExclusion && (
              <section>
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Exclusion details
                </h4>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                  <dl className="space-y-1.5 text-sm">
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Justification</dt>
                      <dd className="font-medium text-slate-800">
                        {
                          DEVICE_EXCLUSION_JUSTIFICATION_LABELS[
                            selectedExclusion.justification
                          ]
                        }
                      </dd>
                    </div>
                    {selectedExclusion.notes && (
                      <div>
                        <dt className="text-slate-500">Note</dt>
                        <dd className="mt-0.5 whitespace-pre-wrap text-slate-700">
                          {selectedExclusion.notes}
                        </dd>
                      </div>
                    )}
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Excluded by</dt>
                      <dd className="min-w-0 truncate font-medium text-slate-800">
                        {selectedExclusion.createdBy}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Excluded on</dt>
                      <dd className="font-medium text-slate-800">
                        {new Date(selectedExclusion.createdAt).toLocaleString()}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Review date</dt>
                      <dd className="font-medium text-slate-800">
                        {selectedExclusion.expiresAt
                          ? new Date(
                              selectedExclusion.expiresAt,
                            ).toLocaleString()
                          : "Never expires"}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                    This device is hidden from PatchPilot's vulnerability,
                    recommendation, inventory and catalog views, and is blocked
                    from Run Now, Fix Now, Fix All and scheduled remediation.
                    The matching exclusion in the Defender portal has to be
                    applied by hand — Microsoft exposes no write API for it.
                  </p>
                </div>
              </section>
            )}
              </>
            )}

            {deviceTab === "inventories" && (
              <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Inventories
                  </h4>
                  <span className="text-xs text-slate-400">
                    All software Defender reports installed on this device
                  </span>
                </div>
                {selectedExcluded ? (
                  <ExcludedTabNotice
                    what="software inventory"
                    reason={selectedExclusionReason}
                  />
                ) : (
                  <>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="relative max-w-sm flex-1">
                    <svg
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                    >
                      <path
                        fillRule="evenodd"
                        d="M9 3.5a5.5 5.5 0 1 0 3.39 9.83l3.14 3.14a.75.75 0 1 0 1.06-1.06l-3.14-3.14A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <input
                      type="search"
                      value={inventorySearch}
                      onChange={(e) => setInventorySearch(e.target.value)}
                      placeholder="Search software, vendor…"
                      className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
                    />
                  </div>
                  {selected.defenderMachineId && (
                    <button
                      type="button"
                      onClick={() => setInventoryFixAllOpen(true)}
                      disabled={!deviceSoftwareInventory.some((s) => s.packageSource && !s.upToDate)}
                      title={
                        deviceSoftwareInventory.some((s) => s.packageSource && !s.upToDate)
                          ? undefined
                          : deviceSoftwareInventory.some((s) => s.packageSource)
                            ? "All installed software is already up to date."
                            : "No installed software has a supported package source."
                      }
                      className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                    >
                      Fix all
                    </button>
                  )}
                </div>
                {!selected.defenderMachineId ? (
                  <p className="text-sm text-slate-500">
                    Not onboarded to Defender — no software inventory for this device.
                  </p>
                ) : inventoryLoading ? (
                  <p className="text-sm text-slate-500">Loading…</p>
                ) : sortedInventory.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    {deviceSoftwareInventory.length === 0
                      ? "No software inventory reported for this device yet."
                      : "No software matches your search."}
                  </p>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                          <SortableTh label="Software" sortKey="name" activeKey={inventorySortKey} dir={inventorySortDir} onSort={toggleInventorySort} />
                          <SortableTh label="Vendor" sortKey="vendor" activeKey={inventorySortKey} dir={inventorySortDir} onSort={toggleInventorySort} />
                          <SortableTh label="Installed version" sortKey="version" activeKey={inventorySortKey} dir={inventorySortDir} onSort={toggleInventorySort} />
                          <SortableTh label="Scope" sortKey="scope" activeKey={inventorySortKey} dir={inventorySortDir} onSort={toggleInventorySort} />
                          <SortableTh label="Latest version" sortKey="latest" activeKey={inventorySortKey} dir={inventorySortDir} onSort={toggleInventorySort} />
                          <SortableTh
                            label="Weaknesses"
                            sortKey="weaknesses"
                            activeKey={inventorySortKey}
                            dir={inventorySortDir}
                            onSort={toggleInventorySort}
                            title="Tenant-wide count, not specific to this device."
                          />
                          <th className="px-4 py-2.5 text-right font-medium">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedInventory.map((s) => {
                          // Not gated on packageSource: RunNowModal always has a
                          // path (Manual, or a live Microsoft Store search) even
                          // when there's no pre-matched winget/chocolatey entry.
                          const canFix = !s.upToDate;
                          return (
                            <tr
                              key={s.softwareId}
                              onClick={() => setInventoryDetail(s)}
                              className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                            >
                              <td className="px-4 py-2.5 font-medium text-slate-800">
                                {s.name}
                                {s.publicExploit && (
                                  <span className="ml-2 inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-700">
                                    Public exploit
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-slate-500">{s.vendor ?? "—"}</td>
                              <td className="px-4 py-2.5 text-slate-600">{s.version ?? "—"}</td>
                              <td className="px-4 py-2.5">
                                <div className="flex items-center gap-1">
                                  <ScopeChip scope={s.installScope} />
                                  <MsStoreChip
                                    isStoreInstall={detectMicrosoftStoreInstall(
                                      s.diskPaths,
                                      s.registryPaths,
                                    )}
                                  />
                                </div>
                              </td>
                              <td className="px-4 py-2.5 text-slate-600">{s.latestVersion ?? "—"}</td>
                              <td className="px-4 py-2.5 text-slate-600">{s.weaknessCount}</td>
                              <td className="px-4 py-2.5 text-right">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setInventoryFixTarget(s);
                                  }}
                                  disabled={!canFix}
                                  title={s.upToDate ? "Already up to date." : undefined}
                                  className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                                >
                                  Fix now
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                  </>
                )}
              </section>
            )}

            {deviceTab === "findings" && (
              <>
            {/* Findings — tabbed. "By CVE" is the raw finding list (filtered to
                this device, popping each CVE out via the stacked SlideOver
                below); "By software" rolls the findings into distinct apps/OS,
                each with a Run Now scoped to THIS machine. Splitting them keeps
                the fix action one click away instead of buried under hundreds of
                CVE rows, and the flex-row layout keeps the severity/SLA chips
                fully visible in the narrow drawer. */}
            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Vulnerabilities
                </h4>
                <SeverityCounts counts={deviceSevCounts} />
              </div>
              {selectedExcluded ? (
                <ExcludedTabNotice
                  what="vulnerabilities or missing updates"
                  reason={selectedExclusionReason}
                />
              ) : (
                <>
              {(fixAllResult || fixAllError) && (
                <div
                  className={`mb-3 rounded-lg border p-3 text-sm ${
                    fixAllError
                      ? "border-rose-200 bg-rose-50 text-rose-800"
                      : fixAllResult && fixAllResult.jobsCreated === 0
                        ? "border-rose-200 bg-rose-50 text-rose-800"
                        : fixAllResult && fixAllResult.skipped.length > 0
                          ? "border-amber-200 bg-amber-50 text-amber-800"
                          : "border-emerald-200 bg-emerald-50 text-emerald-800"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      {fixAllError ? (
                        <p className="font-medium">{fixAllError}</p>
                      ) : (
                        fixAllResult && (
                          <>
                            <p className="font-medium">
                              {fixAllResult.jobsCreated === 0
                                ? "No jobs created — every finding was skipped."
                                : `${fixAllResult.jobsCreated} remediation job${fixAllResult.jobsCreated === 1 ? "" : "s"} started.`}
                            </p>
                            {fixAllResult.jobsCreated > 0 && (
                              <Link
                                to="/jobs"
                                className={`mt-1.5 inline-block rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-colors ${
                                  fixAllResult.skipped.length > 0
                                    ? "bg-amber-600 hover:bg-amber-700"
                                    : "bg-emerald-600 hover:bg-emerald-700"
                                }`}
                              >
                                Track on Jobs page →
                              </Link>
                            )}
                            {fixAllResult.skipped.length > 0 && (
                              <ul className="mt-2 space-y-0.5 text-xs">
                                {fixAllResult.skipped.map((s, i) => (
                                  <li key={`${s.software}-${i}`}>
                                    <span className="font-medium">{s.software}</span>: {s.reason}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </>
                        )
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setFixAllResult(null);
                        setFixAllError(null);
                      }}
                      className="shrink-0 text-xs font-medium text-slate-500 hover:text-slate-700"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
              {!selected.defenderMachineId ? (
                <p className="text-sm text-slate-500">
                  Not onboarded to Defender — no CVE data for this device.
                </p>
              ) : deviceVulnsLoading ? (
                <p className="text-sm text-slate-500">Loading…</p>
              ) : deviceVulns.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No open vulnerabilities for this device.
                </p>
              ) : (
                <>
                  <div className="mb-3 relative max-w-sm">
                    <svg
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                    >
                      <path
                        fillRule="evenodd"
                        d="M9 3.5a5.5 5.5 0 1 0 3.39 9.83l3.14 3.14a.75.75 0 1 0 1.06-1.06l-3.14-3.14A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <input
                      type="search"
                      value={findingsSearch}
                      onChange={(e) => setFindingsSearch(e.target.value)}
                      placeholder="Search this device's findings…"
                      className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
                    />
                  </div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="inline-flex gap-1 rounded-lg bg-slate-100 p-1">
                      {(
                        [
                          ["cve", `By CVE (${deviceVulns.length})`],
                          ["software", `By software (${appRunTargets.length})`],
                          ["os", `Missing KBs (${deviceMissingKbs.length})`],
                          ["components", `By Components (${componentRunTargets.length})`],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setFindingsTab(value)}
                          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                            findingsTab === value
                              ? "bg-white text-slate-900 shadow-sm"
                              : "text-slate-500 hover:text-slate-800"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => setFixAllModalOpen(true)}
                      disabled={fixAllMutation.isPending}
                      title="Fixes winget-installed software only — does not include Windows/OS updates."
                      className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
                    >
                      {fixAllMutation.isPending ? "Fixing all…" : "Fix all"}
                    </button>
                  </div>
                  <p className="mb-3 text-xs text-slate-400">
                    Winget-installed software only — does not include Windows/OS updates.
                  </p>

                  {findingsTab === "cve" ? (
                    sortedDeviceVulns.length === 0 ? (
                      <p className="text-sm text-slate-500">
                        {deviceVulns.length === 0
                          ? "No vulnerability findings on this device."
                          : "No findings match your search."}
                      </p>
                    ) : (
                      /* Mirrors the Vulnerabilities page's "All CVEs" table —
                         same columns minus Devices, which is meaningless once
                         already scoped to this one device. Scrolls horizontally
                         instead of clipping: nine columns don't fit the modal's
                         narrower width, unlike the full-width Vulnerabilities page. */
                      <div className="overflow-x-auto rounded-lg border border-slate-200">
                        <table className="w-full min-w-[960px] text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                              <SortableTh label="CVE" sortKey="cve" activeKey={cveSortKey} dir={cveSortDir} onSort={toggleCveSort} />
                              <SortableTh label="Severity" sortKey="severity" activeKey={cveSortKey} dir={cveSortDir} onSort={toggleCveSort} />
                              <SortableTh label="CVSS" sortKey="cvss" activeKey={cveSortKey} dir={cveSortDir} onSort={toggleCveSort} />
                              <SortableTh label="Software" sortKey="software" activeKey={cveSortKey} dir={cveSortDir} onSort={toggleCveSort} />
                              <SortableTh label="Detected" sortKey="detected" activeKey={cveSortKey} dir={cveSortDir} onSort={toggleCveSort} />
                              <SortableTh label="Remediation" sortKey="remediation" activeKey={cveSortKey} dir={cveSortDir} onSort={toggleCveSort} />
                              <SortableTh label="SLA" sortKey="sla" activeKey={cveSortKey} dir={cveSortDir} onSort={toggleCveSort} />
                              <SortableTh label="Status" sortKey="status" activeKey={cveSortKey} dir={cveSortDir} onSort={toggleCveSort} />
                              <th className="px-4 py-2.5 text-right font-medium">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedDeviceVulns.map((v) => (
                              <tr
                                key={v.id}
                                onClick={() => setSelectedCve(v)}
                                className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                              >
                                <td className="px-4 py-2.5 font-medium text-slate-800">
                                  {v.cveId ?? "—"}
                                </td>
                                <td className="px-4 py-2.5">
                                  <SeverityChip severity={v.severity} />
                                </td>
                                <td className="px-4 py-2.5 text-slate-600">
                                  {v.cvss != null ? v.cvss.toFixed(1) : "—"}
                                </td>
                                <td className="px-4 py-2.5">
                                  <div className="min-w-0">
                                    <div className="truncate font-medium text-slate-800">
                                      {v.displayName ?? v.software}
                                    </div>
                                    {/* Latin anchor for a non-Latin software name. */}
                                    {hasNonLatinScript(v.software) && v.publisher && (
                                      <div className="truncate text-xs text-slate-400">
                                        {v.publisher}
                                      </div>
                                    )}
                                    <ManualRemediationTag software={v.software} className="mt-1" />
                                    {/* Already patched here; Defender just hasn't
                                        refreshed its inventory yet. */}
                                    {v.fixedOnDevice && (
                                      <div className="mt-1">
                                        <FixedOnDeviceChip fix={v.fixedOnDevice} />
                                      </div>
                                    )}
                                  </div>
                                </td>
                                <td className="px-4 py-2.5 text-slate-600">
                                  <div>{formatDate(v.detectedAt)}</div>
                                  <div className="text-xs text-slate-400">
                                    {daysAgo(v.detectedAt)}d ago
                                  </div>
                                </td>
                                <td className="px-4 py-2.5">
                                  <RemediationBadge software={v.software} wingetRemediable={v.wingetRemediable} />
                                </td>
                                <td className="px-4 py-2.5">
                                  <SlaChip sla={v.sla} />
                                </td>
                                <td className="px-4 py-2.5 capitalize text-slate-600">
                                  {v.status}
                                </td>
                                <td className="px-4 py-2.5 text-right">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const patchType = isOsFinding(v.software) ? "os" : "app";
                                      setRunTarget({
                                        software: v.software,
                                        displayName: v.displayName ?? v.software,
                                        vulnId: v.id,
                                        patchType,
                                        wingetRemediable: v.wingetRemediable,
                                        wingetPackageId: v.wingetPackageId,
                                        severity: v.severity,
                                        cveCount: 1,
                                        // Prefer the server-resolved value; fall
                                        // back to the curated client-side map.
                                        altSources:
                                          patchType === "app" && !v.wingetRemediable
                                            ? (v.altSources ?? [...altSourcesFor(v.software)])
                                            : [],
                                        publisher: v.publisher,
                                        fixedOnDevice: v.fixedOnDevice ?? null,
                                        installScope: isOsMisattributedSoftware(v.software)
                                          ? "os"
                                          : detectInstallScope(v.diskPaths ?? [], v.registryPaths ?? []),
                                        isStoreInstall: detectMicrosoftStoreInstall(
                                          v.diskPaths ?? [],
                                          v.registryPaths ?? [],
                                        ),
                                      });
                                    }}
                                    className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
                                    title="Run remediation"
                                  >
                                    Fix now
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  ) : findingsTab === "software" ? (
                    /* Per-app remediation: each distinct app rolled up to its
                       worst finding, with a Run Now scoped to THIS device —
                       the reachable "fix now" action. */
                    sortedAppRunTargets.length === 0 ? (
                      <p className="text-sm text-slate-500">
                        {appRunTargets.length === 0
                          ? "No app remediation findings on this device."
                          : "No software matches your search."}
                      </p>
                    ) : (
                      <div className="overflow-hidden rounded-lg border border-slate-200">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                              <SortableTh label="Software" sortKey="name" activeKey={runTargetSortKey} dir={runTargetSortDir} onSort={toggleRunTargetSort} />
                              <SortableTh label="Scope" sortKey="scope" activeKey={runTargetSortKey} dir={runTargetSortDir} onSort={toggleRunTargetSort} />
                              <SortableTh label="CVEs" sortKey="cves" activeKey={runTargetSortKey} dir={runTargetSortDir} onSort={toggleRunTargetSort} />
                              <SortableTh label="Severity" sortKey="severity" activeKey={runTargetSortKey} dir={runTargetSortDir} onSort={toggleRunTargetSort} />
                              <th className="px-4 py-2.5 font-medium uppercase tracking-wide">Route</th>
                              <th className="px-4 py-2.5 font-medium uppercase tracking-wide">Fix now</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedAppRunTargets.map((t) => (
                              <tr
                                key={t.software}
                                onClick={() => setSoftwareDetail(t)}
                                className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                              >
                                <td className="px-4 py-2.5">
                                  <div className="min-w-0">
                                    <div className="truncate font-medium text-slate-800">
                                      {t.displayName ?? t.software}
                                    </div>
                                    {/* Latin anchor for a non-Latin software name. */}
                                    {hasNonLatinScript(t.software) && t.publisher && (
                                      <div className="truncate text-xs text-slate-400">
                                        {t.publisher}
                                      </div>
                                    )}
                                    <ManualRemediationTag software={t.software} className="mt-1" />
                                    {/* Already patched here; Defender just hasn't
                                        refreshed its inventory yet. */}
                                    {t.fixedOnDevice && (
                                      <div className="mt-1">
                                        <FixedOnDeviceChip fix={t.fixedOnDevice} />
                                      </div>
                                    )}
                                  </div>
                                </td>
                                <td className="px-4 py-2.5">
                                  {t.patchType === "app" && (
                                    <div className="flex items-center gap-1">
                                      <ScopeChip scope={t.installScope} />
                                      <MsStoreChip isStoreInstall={t.isStoreInstall} />
                                    </div>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 text-slate-600">{t.cveCount}</td>
                                <td className="px-4 py-2.5">
                                  <SeverityChip severity={t.severity} />
                                </td>
                                <td className="px-4 py-2.5 text-slate-600">{routeLabel(t)}</td>
                                <td className="px-4 py-2.5">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setRunTarget(t);
                                    }}
                                    className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
                                  >
                                    Fix now
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  ) : findingsTab === "components" ? (
                    /* Unsupported components (OpenSSL/MySQL/Log4j) — Fix now
                       stays offered but already hard-fails preflight check #8,
                       same manual-remediation behavior as today. */
                    sortedComponentRunTargets.length === 0 ? (
                      <p className="text-sm text-slate-500">
                        {componentRunTargets.length === 0
                          ? "No unsupported-component findings on this device."
                          : "No components match your search."}
                      </p>
                    ) : (
                      <div className="overflow-hidden rounded-lg border border-slate-200">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                              <SortableTh label="Software" sortKey="name" activeKey={runTargetSortKey} dir={runTargetSortDir} onSort={toggleRunTargetSort} />
                              <SortableTh label="Scope" sortKey="scope" activeKey={runTargetSortKey} dir={runTargetSortDir} onSort={toggleRunTargetSort} />
                              <SortableTh label="CVEs" sortKey="cves" activeKey={runTargetSortKey} dir={runTargetSortDir} onSort={toggleRunTargetSort} />
                              <SortableTh label="Severity" sortKey="severity" activeKey={runTargetSortKey} dir={runTargetSortDir} onSort={toggleRunTargetSort} />
                              <th className="px-4 py-2.5 font-medium uppercase tracking-wide">Route</th>
                              <th className="px-4 py-2.5 font-medium uppercase tracking-wide">Fix now</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedComponentRunTargets.map((t) => (
                              <tr
                                key={t.software}
                                onClick={() => setSoftwareDetail(t)}
                                className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                              >
                                <td className="px-4 py-2.5">
                                  <div className="min-w-0">
                                    <div className="truncate font-medium text-slate-800">
                                      {t.displayName ?? t.software}
                                    </div>
                                    {/* Latin anchor for a non-Latin software name. */}
                                    {hasNonLatinScript(t.software) && t.publisher && (
                                      <div className="truncate text-xs text-slate-400">
                                        {t.publisher}
                                      </div>
                                    )}
                                    <ManualRemediationTag software={t.software} className="mt-1" />
                                    {t.fixedOnDevice && (
                                      <div className="mt-1">
                                        <FixedOnDeviceChip fix={t.fixedOnDevice} />
                                      </div>
                                    )}
                                  </div>
                                </td>
                                <td className="px-4 py-2.5">
                                  {t.patchType === "app" && (
                                    <div className="flex items-center gap-1">
                                      <ScopeChip scope={t.installScope} />
                                      <MsStoreChip isStoreInstall={t.isStoreInstall} />
                                    </div>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 text-slate-600">{t.cveCount}</td>
                                <td className="px-4 py-2.5">
                                  <SeverityChip severity={t.severity} />
                                </td>
                                <td className="px-4 py-2.5 text-slate-600">{routeLabel(t)}</td>
                                <td className="px-4 py-2.5">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setRunTarget(t);
                                    }}
                                    className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
                                  >
                                    Fix now
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  ) : (
                    /* Missing KBs: real per-device missing-KB rows (getmissingkbs),
                       not the single rolled-up "Microsoft Windows 11" recommendation. */
                    deviceKbsLoading ? (
                      <p className="text-sm text-slate-500">Loading…</p>
                    ) : sortedMissingKbs.length === 0 ? (
                      <p className="text-sm text-slate-500">
                        {deviceMissingKbs.length === 0
                          ? "No missing Windows Updates on this device."
                          : "No updates match your search."}
                      </p>
                    ) : (
                      <div className="overflow-hidden rounded-lg border border-slate-200">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                              <SortableTh label="KB" sortKey="kb" activeKey={kbSortKey} dir={kbSortDir} onSort={toggleKbSort} />
                              <SortableTh label="Title" sortKey="title" activeKey={kbSortKey} dir={kbSortDir} onSort={toggleKbSort} />
                              <SortableTh label="CVEs" sortKey="cves" activeKey={kbSortKey} dir={kbSortDir} onSort={toggleKbSort} />
                              <th className="px-4 py-2.5 font-medium uppercase tracking-wide">Products</th>
                              <th className="px-4 py-2.5 font-medium uppercase tracking-wide">Fix now</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedMissingKbs.map((k) => (
                              <tr key={k.id} className="border-b border-slate-100 last:border-0">
                                <td className="px-4 py-2.5 font-medium text-slate-800">KB{k.kbId}</td>
                                <td className="px-4 py-2.5 text-slate-600">{k.title}</td>
                                <td className="px-4 py-2.5 text-slate-600">{k.cveCount}</td>
                                <td className="px-4 py-2.5 text-slate-500">
                                  {k.products.length > 0 ? k.products.join(", ") : "—"}
                                </td>
                                <td className="px-4 py-2.5">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setKbFixTarget({
                                        tenantId: selected.tenantId,
                                        missingKbId: k.id,
                                        kbId: k.kbId,
                                        title: k.title,
                                        hostname: selected.hostname,
                                      })
                                    }
                                    className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
                                  >
                                    Fix now
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  )}
                </>
              )}
                </>
              )}
            </section>
              </>
            )}

            {deviceTab === "recommendations" && (
              <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Security Recommendations
                  </h4>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-400">
                      Defender's consolidated update recommendations for this device
                    </span>
                    <Link
                      to="/recommendations"
                      className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                    >
                      Go to Security Recommendations
                    </Link>
                  </div>
                </div>
                {selectedExcluded ? (
                  <ExcludedTabNotice
                    what="security recommendations"
                    reason={selectedExclusionReason}
                  />
                ) : !selected.defenderMachineId ? (
                  <p className="text-sm text-slate-500">
                    Not onboarded to Defender — no recommendations for this device.
                  </p>
                ) : (
                  <>
                    <div className="mb-3 relative max-w-sm">
                      <svg
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden
                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                      >
                        <path
                          fillRule="evenodd"
                          d="M9 3.5a5.5 5.5 0 1 0 3.39 9.83l3.14 3.14a.75.75 0 1 0 1.06-1.06l-3.14-3.14A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <input
                        type="search"
                        value={recSearch}
                        onChange={(e) => setRecSearch(e.target.value)}
                        placeholder="Search recommendations, software or vendor…"
                        className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
                      />
                    </div>
                    {deviceRecsLoading ? (
                      <p className="text-sm text-slate-500">Loading…</p>
                    ) : sortedDeviceRecs.length === 0 ? (
                      <p className="text-sm text-slate-500">
                        {deviceRecommendations.length === 0
                          ? "No security recommendations for this device."
                          : "No recommendations match your search."}
                      </p>
                    ) : (
                      <div className="overflow-hidden rounded-lg border border-slate-200">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                              <SortableTh label="Security recommendation" sortKey="recommendation" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} className="w-full" />
                              <th className="whitespace-nowrap px-4 py-2.5 font-medium">Severity</th>
                              <SortableTh label="CVEs" sortKey="cves" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} className="whitespace-nowrap" />
                              <SortableTh label="Recommended" sortKey="version" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} className="whitespace-nowrap" />
                              <SortableTh label="SLA" sortKey="sla" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} className="whitespace-nowrap" />
                              <th className="whitespace-nowrap px-4 py-2.5 font-medium uppercase tracking-wide text-right">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedDeviceRecs.map((r) => (
                              <tr
                                key={r.id}
                                onClick={() => setSelectedDeviceRec(r)}
                                className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                              >
                                <td className="max-w-0 px-4 py-2.5">
                                  <div
                                    className="truncate font-medium text-slate-800"
                                    title={r.recommendationName}
                                  >
                                    {r.recommendationName}
                                  </div>
                                  {/* Kind + vendor sit under the title so the name
                                      column keeps as much width as possible. */}
                                  <div className="mt-1 flex items-center gap-2">
                                    <RecKindChip kind={r.kind} />
                                    {r.vendor && (
                                      <span className="truncate text-xs text-slate-400">
                                        {r.vendor}
                                      </span>
                                    )}
                                    {r.exception && <ExceptionChip />}
                                  </div>
                                </td>
                                <td className="whitespace-nowrap px-4 py-2.5">
                                  {/* Defender scores misconfigurations by score impact, not severity. */}
                                  {r.kind === "misconfiguration" ? (
                                    <span className="text-slate-400">—</span>
                                  ) : (
                                    <SeverityChip severity={r.severity} />
                                  )}
                                </td>
                                <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                                  {r.kind === "misconfiguration" ? "—" : r.cveTotal}
                                </td>
                                <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                                  {r.recommendedVersion ?? "—"}
                                </td>
                                <td className="whitespace-nowrap px-4 py-2.5">
                                  <SlaChip sla={r.sla} />
                                </td>
                                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                                  <div className="flex items-center justify-end gap-2">
                                    {r.kind === "vulnerability" &&
                                      (() => {
                                        const { target, reason } = deviceFixNowState(
                                          r,
                                          deviceRunTargets,
                                        );
                                        return (
                                          <button
                                            type="button"
                                            disabled={!target}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              if (target) setRunTarget(target);
                                            }}
                                            className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                                            title={reason}
                                          >
                                            Fix now
                                          </button>
                                        );
                                      })()}
                                    <button
                                      type="button"
                                      disabled={r.exception}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setExceptionTarget({
                                          recommendationId: r.recommendationIds[0] ?? null,
                                          tenantId: r.tenantId,
                                          label: r.recommendationName,
                                        });
                                      }}
                                      className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                                      title={
                                        r.exception
                                          ? "An exception already covers this recommendation"
                                          : "Record a local exception"
                                      }
                                    >
                                      Create exception
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}
          </div>
        )}
      </WizardShell>

      {/* Per-CVE detail, stacked over the device panel — identical body to the
          Vulnerabilities page so a CVE pops out the same way from either surface. */}
      <SlideOver
        open={selectedCve !== null}
        onClose={() => setSelectedCve(null)}
        title={selectedCve?.cveId ?? ""}
        subtitle="Vulnerability"
        elevated
      >
        {selectedCve && (
          <CveDetailBody
            vuln={selectedCve}
            latestVersion={selectedCveCatalog?.latestVersion}
            tenantLabel={
              isAllTenants
                ? (tenantNames.get(selectedCve.tenantId) ?? selectedCve.tenantId)
                : null
            }
            onCreateException={() =>
              setExceptionTarget({
                cveId: selectedCve.cveId,
                tenantId: selectedCve.tenantId,
                label: selectedCve.cveId ?? selectedCve.title,
              })
            }
          />
        )}
      </SlideOver>

      {/* ---- Create exception dialog (CVE-scoped, from the per-CVE panel above) ---- */}
      <ExceptionModal
        open={exceptionTarget !== null}
        onClose={() => setExceptionTarget(null)}
        tenantId={exceptionTarget?.tenantId ?? null}
        target={exceptionTarget ?? {}}
        subjectLabel={exceptionTarget?.label ?? ""}
      />

      {/* Security Recommendation detail, stacked over the device panel —
          trimmed version of Recommendations.tsx's own detail panel, scoped to
          this device's own (already-loaded) findings. */}
      <SlideOver
        open={selectedDeviceRec !== null}
        onClose={() => setSelectedDeviceRec(null)}
        title={selectedDeviceRec?.recommendationName ?? ""}
        subtitle="Security recommendation"
        elevated
      >
        {selectedDeviceRec && (
          <div className="space-y-6">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <RecKindChip kind={selectedDeviceRec.kind} />
                {/* Misconfigurations are scored by configuration-score impact,
                    not CVE severity. */}
                {selectedDeviceRec.kind === "vulnerability" && (
                  <>
                    <SeverityChip severity={selectedDeviceRec.severity} />
                    <SlaChip sla={selectedDeviceRec.sla} />
                  </>
                )}
                {selectedDeviceRec.exception && <ExceptionChip />}
              </div>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">
                {selectedDeviceRec.kind === "misconfiguration" ? (
                  <>
                    A device-configuration finding on this device. Remediate it
                    through Intune or Group Policy — PatchPilot can't drive it with
                    a package update.
                  </>
                ) : (
                  <>
                    Consolidates {selectedDeviceRecCves.length}{" "}
                    {selectedDeviceRecCves.length === 1 ? "CVE" : "CVEs"} on this
                    device for {selectedDeviceRec.productName} into one action.
                    Updating to the recommended version remediates them together.
                  </>
                )}
              </p>
              {!selectedDeviceRec.exception && (
                <button
                  type="button"
                  onClick={() =>
                    setExceptionTarget({
                      recommendationId: selectedDeviceRec.recommendationIds[0] ?? null,
                      tenantId: selectedDeviceRec.tenantId,
                      label: selectedDeviceRec.recommendationName,
                    })
                  }
                  className="mt-3 inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                  title="Record a local exception"
                >
                  Create exception
                </button>
              )}
            </div>

            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Recommendation
              </h4>
              <dl className="space-y-1.5 text-sm">
                {selectedDeviceRec.kind === "vulnerability" ? (
                  <>
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Related component</dt>
                      <dd className="min-w-0 truncate font-medium text-slate-800">
                        {selectedDeviceRec.relatedComponent ??
                          selectedDeviceRec.productName}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Vendor</dt>
                      <dd className="min-w-0 truncate font-medium text-slate-800">
                        {selectedDeviceRec.vendor ?? "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Recommended version</dt>
                      <dd className="font-medium text-slate-800">
                        {selectedDeviceRec.recommendedVersion ?? "Latest available"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Remediation</dt>
                      <dd className="font-medium text-slate-800">
                        {prettyRemediationType(selectedDeviceRec.remediationType)}
                      </dd>
                    </div>
                  </>
                ) : (
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">Devices score impact</dt>
                    <dd className="font-medium text-slate-800">
                      {selectedDeviceRec.configScoreImpact?.toFixed(2) ?? "—"}
                    </dd>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Category</dt>
                  <dd className="font-medium text-slate-800">
                    {selectedDeviceRec.subCategory
                      ? `${selectedDeviceRec.category ?? "—"} · ${selectedDeviceRec.subCategory}`
                      : (selectedDeviceRec.category ?? "—")}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Threats</dt>
                  <dd className="min-w-0 truncate font-medium text-slate-800">
                    {selectedDeviceRec.activeAlert
                      ? "Active alert"
                      : selectedDeviceRec.associatedThreats.length > 0
                        ? selectedDeviceRec.associatedThreats.join(", ")
                        : "None"}
                  </dd>
                </div>
              </dl>
            </section>

            {/* How it was detected — this device's install evidence for the
                matched software; misconfigurations have none to show. */}
            {selectedDeviceRec.kind === "vulnerability" && (
              <DetectionEvidence
                installedVersions={[]}
                diskPaths={selectedDeviceRec.diskPaths}
                registryPaths={selectedDeviceRec.registryPaths}
                showVersion={false}
              />
            )}

            {selectedDeviceRec.kind === "vulnerability" && (
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Underlying CVEs (this device)
              </h4>
              {selectedDeviceRecCves.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No matching per-CVE findings on this device.
                </p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-slate-200">
                  <ul>
                    {selectedDeviceRecCves.map((v) => (
                      <li
                        key={v.id}
                        onClick={() => {
                          setSelectedDeviceRec(null);
                          setSelectedCve(v);
                        }}
                        className="flex cursor-pointer items-center justify-between gap-3 border-b border-slate-100 px-4 py-2 last:border-0 hover:bg-slate-50"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-slate-800">
                            {v.cveId}
                          </div>
                          <div className="truncate text-xs text-slate-400">
                            {v.displayName ?? v.software}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <SeverityChip severity={v.severity} />
                          <SlaChip sla={v.sla} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
            )}
          </div>
        )}
      </SlideOver>

      {/* Per-software detail, stacked over the device panel: the CVEs detected
          for this application on THIS device, plus how Defender detected it —
          the installed version and the disk path(s) it was found at. */}
      <SlideOver
        open={softwareDetail !== null}
        onClose={() => setSoftwareDetail(null)}
        title={softwareDetail?.displayName ?? softwareDetail?.software ?? ""}
        subtitle="Software finding"
      >
        {softwareDetail &&
          (() => {
            const related = deviceVulns
              .filter((v) => v.software === softwareDetail.software)
              .sort(
                (a, b) =>
                  (SEVERITY_RANK[b.severity] ?? 0) -
                  (SEVERITY_RANK[a.severity] ?? 0),
              );
            // "How it was detected": the installed version(s) and the union of
            // disk/registry paths Defender reported across this software's
            // findings. Registry paths matter on their own — a HKEY_USERS
            // path is Defender's own evidence of a per-user install (the
            // case winget running as SYSTEM can't correlate against), so it
            // must be shown even when no disk path was reported.
            const versions = [
              ...new Set(
                related
                  .map((v) => v.installedVersion)
                  .filter((x): x is string => !!x),
              ),
            ];
            const paths = [
              ...new Set(related.flatMap((v) => v.diskPaths ?? [])),
            ];
            const registryPaths = [
              ...new Set(related.flatMap((v) => v.registryPaths ?? [])),
            ];
            return (
              <div className="space-y-6">
                {/* Latin anchor for a non-Latin software name. */}
                {hasNonLatinScript(softwareDetail.software) &&
                  softwareDetail.publisher && (
                    <p className="-mt-2 text-sm text-slate-500">
                      {softwareDetail.publisher}
                    </p>
                  )}

                {softwareDetail.patchType === "app" && (
                  <div className="flex items-center gap-1">
                    <ScopeChip scope={softwareDetail.installScope} />
                    <MsStoreChip
                      isStoreInstall={detectMicrosoftStoreInstall(paths, registryPaths)}
                    />
                  </div>
                )}

                <ManualRemediationTag software={softwareDetail.software} />

                {/* Already patched here, per the remediation job's own transcript.
                    Above "How it was detected" on purpose: it explains why the
                    Defender-reported version below is the pre-fix one. */}
                {softwareDetail.fixedOnDevice && (
                  <FixedOnDeviceNote fix={softwareDetail.fixedOnDevice} />
                )}

                <DetectionEvidence
                  installedVersions={versions}
                  diskPaths={paths}
                  registryPaths={registryPaths}
                />

                {/* Related CVEs — each pops out the same CVE detail panel. */}
                <section>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Detected CVEs ({related.length})
                  </h4>
                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    <ul>
                      {related.map((v) => (
                        <li
                          key={v.id}
                          onClick={() => setSelectedCve(v)}
                          className="flex cursor-pointer items-center justify-between gap-3 border-b border-slate-100 px-4 py-2 last:border-0 hover:bg-slate-50"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium text-slate-800">
                              {v.cveId}
                            </div>
                            {v.title && (
                              <div className="truncate text-xs text-slate-400">
                                {v.title}
                              </div>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <SeverityChip severity={v.severity} />
                            <SlaChip sla={v.sla} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>
              </div>
            );
          })()}
      </SlideOver>

      {/* Run Now, scoped to the selected device. Seeded from the chosen software
          group's worst-severity finding; the picker is locked to this machine. */}
      <RunNowModal
        open={runTarget !== null}
        onClose={() => setRunTarget(null)}
        vulnId={runTarget?.vulnId ?? ""}
        software={runTarget?.software ?? ""}
        displayName={runTarget?.displayName}
        patchType={runTarget?.patchType ?? "app"}
        tenantId={selected?.tenantId ?? null}
        tenantReadOnly={
          selected
            ? (tenants.find((t) => t.tenantId === selected.tenantId)?.readOnly ??
              false)
            : false
        }
        altSources={runTarget?.altSources ?? []}
        lockedDevice={selected}
      />

      {/* Missing-KB Fix Now, scoped to the selected device — opened from the
          "Missing KBs" tab. */}
      {kbFixTarget && (
        <MissingKbFixNowModal
          open={kbFixTarget !== null}
          onClose={() => setKbFixTarget(null)}
          tenantId={kbFixTarget.tenantId}
          missingKbId={kbFixTarget.missingKbId}
          kbId={kbFixTarget.kbId}
          title={kbFixTarget.title}
          hostname={kbFixTarget.hostname}
        />
      )}


      {/* Fix all, scoped to the selected device — urgency/trigger/package
          confirmation before fanning out one job per affected software. */}
      <FixAllModal
        open={fixAllModalOpen}
        onClose={() => setFixAllModalOpen(false)}
        targets={deviceRunTargets
          .filter((t) => t.patchType === "app")
          .map((t) => ({
            software: t.software,
            displayName: t.displayName,
            severity: t.severity,
            cveCount: t.cveCount,
            wingetRemediable: t.wingetRemediable,
            wingetPackageId: t.wingetPackageId,
            installScope: t.installScope,
            isStoreInstall: t.isStoreInstall,
          }))}
        device={selected}
        tenantReadOnly={
          selected
            ? (tenants.find((t) => t.tenantId === selected.tenantId)?.readOnly ??
              false)
            : false
        }
        isPending={fixAllMutation.isPending}
        error={fixAllError}
        onConfirm={(payload) => fixAllMutation.mutate(payload)}
      />

      {/* Inventories tab detail, stacked over the device panel: this
          software's scope + how Defender detected it on this device. */}
      <SlideOver
        open={inventoryDetail !== null}
        onClose={() => setInventoryDetail(null)}
        title={inventoryDetail?.name ?? ""}
        subtitle="Software inventory"
      >
        {inventoryDetail && (
          <div className="space-y-6">
            <div className="flex items-center gap-1">
              <ScopeChip scope={inventoryDetail.installScope} />
              <MsStoreChip
                isStoreInstall={detectMicrosoftStoreInstall(
                  inventoryDetail.diskPaths,
                  inventoryDetail.registryPaths,
                )}
              />
            </div>
            <DetectionEvidence
              installedVersions={inventoryDetail.version ? [inventoryDetail.version] : []}
              diskPaths={inventoryDetail.diskPaths ?? []}
              registryPaths={inventoryDetail.registryPaths ?? []}
            />
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Details
              </h4>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Vendor</dt>
                  <dd className="font-medium text-slate-800">
                    {inventoryDetail.vendor ?? "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Latest version</dt>
                  <dd className="font-medium text-slate-800">
                    {inventoryDetail.latestVersion ?? "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Weaknesses</dt>
                  <dd className="font-medium text-slate-800">
                    {inventoryDetail.weaknessCount}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Public exploit</dt>
                  <dd className="font-medium text-slate-800">
                    {inventoryDetail.publicExploit ? (
                      <span className="text-rose-600">Yes</span>
                    ) : (
                      "None reported"
                    )}
                  </dd>
                </div>
              </dl>
            </section>
            <button
              type="button"
              onClick={() => setInventoryFixTarget(inventoryDetail)}
              disabled={inventoryDetail.upToDate}
              title={inventoryDetail.upToDate ? "Already up to date." : undefined}
              className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            >
              Fix now
            </button>
          </div>
        )}
      </SlideOver>

      {/* Inventories tab Fix Now — same full RunNowModal Software Inventory
          uses, seeded from this device + the clicked inventory row, locked
          to this machine. */}
      {selected && inventoryFixTarget && (
        <RunNowModal
          open={inventoryFixTarget !== null}
          onClose={() => setInventoryFixTarget(null)}
          vulnId=""
          softwareId={inventoryFixTarget.softwareId}
          software={inventoryFixTarget.name}
          patchType="app"
          tenantId={selected.tenantId}
          tenantReadOnly={
            tenants.find((t) => t.tenantId === selected.tenantId)?.readOnly ??
            false
          }
          altSources={
            !inventoryFixTarget.wingetPackageId &&
            inventoryFixTarget.chocolateyPackageId
              ? [
                  {
                    source: "chocolatey",
                    packageId: inventoryFixTarget.chocolateyPackageId,
                    name: inventoryFixTarget.name,
                  },
                ]
              : []
          }
          lockedDevice={selected}
        />
      )}

      {/* Exclude device / Exclude N devices — shared by the row action, the
          detail-panel header and the bulk action bar. On success the modal
          invalidates every surface an exclusion moves, and clearing the
          selection here keeps the bulk bar from lingering over rows that have
          just vanished from the default filter. */}
      <DeviceExclusionModal
        open={exclusionTarget !== null}
        onClose={() => {
          setExclusionTarget(null);
          setCheckedIds(new Set());
        }}
        tenantId={exclusionTarget?.[0]?.tenantId ?? null}
        devices={exclusionTarget ?? []}
      />

      {/* Add to group — same one-for-row/many-for-bulk shape as the exclusion
          modal above, independent of it. */}
      <AddToGroupModal
        open={groupTarget !== null}
        onClose={() => {
          setGroupTarget(null);
          setCheckedIds(new Set());
        }}
        tenantId={groupTarget?.[0]?.tenantId ?? null}
        devices={groupTarget ?? []}
      />

      {/* Inventories tab Fix All — every fixable title on this one device. */}
      {selected && (
        <SoftwareInventoryFixAllModal
          open={inventoryFixAllOpen}
          onClose={() => setInventoryFixAllOpen(false)}
          tenantId={selected.tenantId}
          target={{ kind: "device", deviceId: selected.id }}
          title={selected.hostname}
          subtitle="full software inventory"
        />
      )}
    </div>
  );
}
