import { Fragment, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  altSourcesFor,
  csvRow,
  detectMicrosoftStoreInstall,
  isOsFinding,
  requiresManualRemediation,
} from "@patchpilot/shared";
import {
  api,
  type AltSource,
  type ExposedDevice,
  type MissingKbGroup,
  type Recommendation,
  type Severity,
  type Vulnerability,
  type WingetCatalogEntry,
} from "../lib/api";
import { useTenant } from "../lib/tenant";
import { SummarizeButton } from "../components/ai/SummarizeButton";
import { RunNowModal } from "../components/RunNowModal";
import { ExceptionModal } from "../components/ExceptionModal";
import { MissingKbFixNowModal } from "../components/MissingKbFixNowModal";
import { MissingKbFixAllModal } from "../components/MissingKbFixAllModal";
import { downloadCsv } from "../lib/csv";
import {
  Card,
  DetailRow,
  isRemediableType,
  ManualRemediationTag,
  MsStoreChip,
  PageHeader,
  ScopeChip,
  SeverityChip,
  SlaChip,
  slaTone,
  SlideOver,
  UNSUPPORTED_REMEDIATION_REASON,
} from "../components/ui";
import {
  CveDetailBody,
  CveSortableTh,
  daysAgo,
  DetectionEvidence,
  ExploitChip,
  formatDate,
  RemediationBadge,
  remediationRoute,
  SeverityCounts,
  SEVERITY_ORDER,
  SEVERITY_RANK,
  SortIcon,
  type CveSortKey,
  type SortDir,
} from "../components/cve";
import { toRemediationHistoryCve } from "./dashboard/links";

/** Loose enough to catch a pasted CVE id regardless of the reporter's own
 * digit-count convention (Defender, NVD and MITRE have each used 4-7). */
const CVE_ID_SHAPE = /^cve-\d{4}-\d{4,}$/i;

type SeverityFilter = "all" | "critical" | "high" | "medium" | "low";
const SEVERITY_FILTERS: SeverityFilter[] = [
  "all",
  "critical",
  "high",
  "medium",
  "low",
];

// SLA filter maps onto slaTone(): breached/due-soon/ok. The dashboard's "SLA
// breached" and "Due soon" KPIs deep-link here via the ?sla= param.
type SlaFilter = "all" | "breached" | "due-soon" | "ok";
const SLA_FILTERS: { value: SlaFilter; label: string }[] = [
  { value: "all", label: "All SLAs" },
  { value: "breached", label: "Breached" },
  { value: "due-soon", label: "Due soon" },
  { value: "ok", label: "On track" },
];

type RemediationFilter = "all" | "winget" | "os" | "manual" | "unsupported";

// How many CVE rows to put in the DOM at once.
//
// "All CVEs" is the only tab that isn't a roll-up — it's one row per finding,
// which on a real tenant is thousands (2873 here). Each row mounts a severity
// chip, remediation badge, SLA pill, manual-remediation tag and a Fix now
// button, so rendering the full set cost ~11s per keystroke in the search box
// and made the tab look hung. The other three tabs group to one row per
// product and never get near this, which is why only this table is capped.
const CVE_PAGE_SIZE = 100;

// Four ways to look at the same Defender data: the one-row-per-product
// software roll-up (default), the OS/Missing-KB roll-up, the
// unsupported-component roll-up (OpenSSL/MySQL/Log4j — already hard-fail
// preflight, fix stays manual), and the raw per-CVE list. Distinct from the
// Security Recommendations page, which mirrors Defender's own recommendation
// rows 1:1 rather than regrouping them by product.
type ViewMode = "grouped" | "os" | "components" | "cves";

/** A small "N CVEs (Total)" pill — the headline noise-reduction number on a roll-up. */
function WeaknessPill({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
      {count} {count === 1 ? "CVE" : "CVEs"} (Total)
    </span>
  );
}

/** Real CVE ids addressed by a missing KB, clickable to jump to the "All CVEs"
 *  tab pre-searched for that id. Falls back to the count-only pill when the
 *  underlying `cveAddressed` data hasn't synced yet (older rows). */
function CveIdChips({
  cveIds,
  count,
  onSelect,
  max = 3,
}: {
  cveIds: string[];
  count: number;
  onSelect: (cveId: string) => void;
  max?: number;
}) {
  if (cveIds.length === 0) return <WeaknessPill count={count} />;
  const shown = cveIds.slice(0, max);
  const hidden = cveIds.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((id) => (
        <button
          key={id}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(id);
          }}
          title={`Find ${id} in All CVEs`}
          className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-200"
        >
          {id}
        </button>
      ))}
      {hidden > 0 && <span className="text-xs text-slate-400">+{hidden} more</span>}
    </div>
  );
}

/**
 * The per-CVE findings that a recommendation rolls up. Defender's recommendation
 * objects don't carry their underlying CVE list in the fields we ingest, so we
 * re-associate by product: same tenant, and the vuln's software name matching the
 * recommendation's product (exact, or either-contains for "Microsoft Windows 11"
 * vs "Microsoft Windows"). This drives the detail panel's drill-down.
 */
function cvesForRecommendation(
  rec: Recommendation,
  vulns: Vulnerability[],
): Vulnerability[] {
  const product = rec.productName.toLowerCase();
  return vulns.filter((v) => {
    if (v.tenantId !== rec.tenantId) return false;
    const sw = v.software.toLowerCase();
    return sw === product || sw.includes(product) || product.includes(sw);
  });
}

/**
 * Seeds the "Run now" dialog from a consolidated recommendation: picks the
 * highest-severity rolled-up finding as the representative vulnId (the gate +
 * remediation contract is per-finding), and classifies app-vs-OS from the
 * product name so the modal auto-routes to the right channel. Returns null when
 * the recommendation has no associated CVEs to act on.
 */
function runTargetForRec(
  rec: Recommendation,
  vulns: Vulnerability[],
): {
  vulnId: string;
  software: string;
  patchType: "app" | "os";
  tenantId: string;
  altSources: AltSource[];
} | null {
  const cves = cvesForRecommendation(rec, vulns);
  if (cves.length === 0) return null;
  const worst = cves.reduce((best, v) =>
    (SEVERITY_RANK[v.severity] ?? 0) > (SEVERITY_RANK[best.severity] ?? 0) ? v : best,
  );
  const patchType = isOsFinding(rec.productName) ? "os" : "app";
  return {
    vulnId: worst.id,
    software: rec.productName,
    patchType,
    tenantId: rec.tenantId,
    // Alternate repos only apply to apps winget can't drive. Prefer the
    // server-resolved (live Chocolatey catalog) value; fall back to the
    // curated client-side map only if the API response didn't carry one.
    altSources:
      patchType === "app" && !worst.wingetRemediable
        ? (worst.altSources ?? [...altSourcesFor(rec.productName)])
        : [],
  };
}

/** A recommendation augmented with the per-severity breakdown of its rolled-up
 *  CVEs. `severity` is overridden to the worst level actually present (see the
 *  derivation in the component) so filters/sorting reflect real exposure. */
type RecWithBreakdown = Recommendation & {
  sevCounts: Record<Severity, number>;
  cveTotal: number;
};

// ---- CVE-view column sorting ----
type SortKey =
  | "cve"
  | "severity"
  | "cvss"
  | "software"
  | "devices"
  | "detected"
  | "tenant"
  | "remediation"
  | "sla"
  | "status";

// The natural first-click direction per column: severity/CVSS/devices read best
// most-significant first (desc); SLA most-urgent first (asc); the rest A→Z / oldest.
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  cve: "asc",
  severity: "desc",
  cvss: "desc",
  software: "asc",
  devices: "desc",
  detected: "desc",
  tenant: "asc",
  remediation: "asc",
  sla: "asc",
  status: "asc",
};

/**
 * Comparison key for a vulnerability under a given column. Numbers sort
 * numerically, strings lexically; nulls sort last (CVSS uses -1, dates 0).
 */
function sortValue(
  v: Vulnerability,
  key: SortKey,
  tenantName: (tenantId: string) => string,
): string | number {
  switch (key) {
    case "cve":
      return v.cveId ?? "";
    case "severity":
      return SEVERITY_RANK[v.severity] ?? 0;
    case "cvss":
      return v.cvss ?? -1;
    case "software":
      return v.software.toLowerCase();
    case "devices":
      return v.affectedDeviceCount;
    case "detected": {
      const ms = new Date(v.detectedAt).getTime();
      return Number.isNaN(ms) ? 0 : ms;
    }
    case "tenant":
      return tenantName(v.tenantId).toLowerCase();
    case "remediation":
      return v.wingetRemediable ? 1 : 0;
    case "sla":
      return v.sla.daysRemaining;
    case "status":
      return v.status;
  }
}

// ---- Grouped-view (recommendation) column sorting ----
type RecSortKey =
  | "recommendation"
  | "severity"
  | "cves"
  | "exposed"
  | "version"
  | "detected"
  | "tenant"
  | "sla"
  | "status";

const REC_DEFAULT_DIR: Record<RecSortKey, SortDir> = {
  recommendation: "asc",
  severity: "desc",
  cves: "desc",
  exposed: "desc",
  version: "asc",
  detected: "desc",
  tenant: "asc",
  sla: "asc",
  status: "asc",
};

function recSortValue(
  r: Recommendation,
  key: RecSortKey,
  tenantName: (tenantId: string) => string,
): string | number {
  switch (key) {
    case "recommendation":
      return r.productName.toLowerCase();
    case "severity":
      return SEVERITY_RANK[r.severity] ?? 0;
    case "cves":
      return r.weaknessCount;
    case "exposed":
      return r.exposedMachinesCount;
    case "version":
      return (r.recommendedVersion ?? "").toLowerCase();
    case "detected": {
      const ms = new Date(r.detectedAt).getTime();
      return Number.isNaN(ms) ? 0 : ms;
    }
    case "tenant":
      return tenantName(r.tenantId).toLowerCase();
    // Rows with no patch clock (Defender misconfigurations) sort last.
    case "sla":
      return r.sla ? r.sla.daysRemaining : Number.MAX_SAFE_INTEGER;
    case "status":
      return r.status;
  }
}

export function Vulnerabilities() {
  const { activeTenantId, isAllTenants, tenants } = useTenant();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Vulnerability | null>(null);
  const [selectedRec, setSelectedRec] = useState<Recommendation | null>(null);
  // The CVE-scoped target the "Create exception" dialog is seeded from (opened
  // from the per-CVE detail panel), null when the dialog is closed.
  const [exceptionTarget, setExceptionTarget] = useState<{
    cveId?: string | null;
    tenantId: string;
    label: string;
  } | null>(null);
  // The missing-KB group whose exposed devices the "Missing KBs" drill-down shows.
  const [selectedKb, setSelectedKb] = useState<MissingKbGroup | null>(null);
  // The specific device+KB the Fix Now modal targets, chosen from selectedKb's
  // device drill-down list.
  const [kbFixTarget, setKbFixTarget] = useState<{
    tenantId: string;
    missingKbId: string;
    kbId: string;
    title: string;
    hostname: string;
  } | null>(null);
  // The missing-KB group the bulk "Fix all" dialog targets — every device in
  // the group's devices[] starts pre-selected.
  const [kbFixAllTarget, setKbFixAllTarget] = useState<MissingKbGroup | null>(null);
  // The recommendation whose exposed devices the (third, stacked) popout shows.
  // Opened from the Components table cell or the recommendation detail panel.
  const [exposedFor, setExposedFor] = useState<Recommendation | null>(null);
  // Which exposed-device row (by machine id) has its "how it was detected" panel open.
  const [expandedExposedId, setExpandedExposedId] = useState<string | null>(null);
  // The finding the "Run now" dialog is seeded from. Normalized so the same modal
  // serves both tables: a representative vulnId + the software group, the app/os
  // patch type, and the row's OWN tenantId (critical in All-Tenants, where the
  // context activeTenantId is an aggregate sentinel, not a real tenant).
  const [runTarget, setRunTarget] = useState<{
    vulnId: string;
    software: string;
    /** Marketing-friendly label for the dialog subtitle only. */
    displayName?: string;
    patchType: "app" | "os";
    tenantId: string;
    altSources: AltSource[];
  } | null>(null);

  // Local (non-URL) filters. Severity + SLA + view stay in the URL so Dashboard
  // KPIs can deep-link to a pre-filtered list; search/publisher/remediation are
  // ephemeral refinements that don't need to be shareable.
  const [search, setSearch] = useState("");
  const [publisherFilter, setPublisherFilter] = useState("all");
  const [remediationFilter, setRemediationFilter] =
    useState<RemediationFilter>("all");

  // View defaults to the consolidated per-software roll-up — the noise-reduction
  // story lands before the raw CVE firehose.
  const view = (params.get("view") as ViewMode) || "grouped";

  // How many of the matching CVE rows are currently rendered, and the filter
  // signature that count belongs to (see the reset below the sort).
  const [cveLimit, setCveLimit] = useState(CVE_PAGE_SIZE);
  const [lastCveFilterKey, setLastCveFilterKey] = useState("");

  // CVE-view column sort. Defaults to SLA ascending (most urgent first).
  const [sortKey, setSortKey] = useState<SortKey>("sla");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  };

  // Grouped-view column sort. Defaults to most CVEs first — the noise story.
  const [recSortKey, setRecSortKey] = useState<RecSortKey>("cves");
  const [recSortDir, setRecSortDir] = useState<SortDir>("desc");
  const toggleRecSort = (key: RecSortKey) => {
    if (key === recSortKey) {
      setRecSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setRecSortKey(key);
      setRecSortDir(REC_DEFAULT_DIR[key]);
    }
  };

  // Underlying-CVEs drill-down sort (detail panel). Defaults to worst severity.
  const [cveSortKey, setCveSortKey] = useState<CveSortKey>("severity");
  const [cveSortDir, setCveSortDir] = useState<SortDir>("desc");
  const toggleCveSort = (key: CveSortKey) => {
    if (key === cveSortKey) {
      setCveSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setCveSortKey(key);
      // CVE A→Z, severity worst-first, SLA most-urgent-first.
      setCveSortDir(key === "cve" ? "asc" : key === "severity" ? "desc" : "asc");
    }
  };

  const severityFilter = (params.get("severity") as SeverityFilter) || "all";
  const slaFilter = (params.get("sla") as SlaFilter) || "all";
  const setParam = (key: "severity" | "sla" | "view", value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        // "all" / "grouped" are the defaults — keep them out of the URL so a
        // bare ?severity= etc. doesn't accumulate noise. Must match the actual
        // fallback below (`|| "grouped"`) — this used to say "cves" here while
        // the fallback defaulted to "grouped", which meant clicking "All CVEs"
        // deleted the view param instead of setting it, silently landing back
        // on "By software" every time.
        if (value === "all" || (key === "view" && value === "grouped"))
          next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  // A Missing-KB row's CVE chip jumps straight to that CVE in the "All CVEs"
  // tab — same component, so this is a direct state update rather than a
  // <Link> navigation.
  const showCveInAllCves = (cveId: string) => {
    setParam("view", "cves");
    setSearch(cveId);
  };

  const { data: vulns = [], isLoading: vulnsLoading } = useQuery({
    queryKey: ["vulnerabilities", activeTenantId],
    queryFn: () =>
      api.get<Vulnerability[]>(
        isAllTenants
          ? "/api/vulnerabilities"
          : `/api/vulnerabilities?tenantId=${activeTenantId}`,
      ),
    enabled: !!activeTenantId,
  });

  const { data: recs = [], isLoading: recsLoading } = useQuery({
    queryKey: ["recommendations", activeTenantId],
    queryFn: () =>
      api.get<Recommendation[]>(
        isAllTenants
          ? "/api/recommendations"
          : `/api/recommendations?tenantId=${activeTenantId}`,
      ),
    enabled: !!activeTenantId,
  });

  // Missing Windows Updates (KBs), rolled up per KB across devices — backs the
  // "Missing KBs" tab. Real Defender getmissingkbs data, distinct from the single
  // per-tenant "Microsoft Windows 11" recommendation row.
  //
  // `refetchInterval` matters here specifically: `syncMissingKbs` fully deletes
  // and reinserts this tenant's missing_kbs rows on every sync (auto-sync runs
  // as often as every 5 min post-remediation), so every row's id — the thing
  // Fix Now/Fix All buttons carry into their dispatch calls — goes stale the
  // moment a sync completes. Without a periodic refetch, a tab left open across
  // a sync boundary keeps rendering buttons with dead ids that 404 on click.
  const { data: missingKbs = [], isLoading: kbsLoading } = useQuery({
    queryKey: ["missing-kbs", activeTenantId],
    queryFn: () =>
      api
        .get<{ missingKbs: MissingKbGroup[] }>(
          isAllTenants ? "/api/missing-kbs" : `/api/missing-kbs?tenantId=${activeTenantId}`,
        )
        .then((r) => r.missingKbs),
    enabled: !!activeTenantId,
    refetchInterval: 5 * 60 * 1000,
  });

  // Devices exposed to the recommendation in the drill-down popout. Fetched on
  // demand (only while the popout is open) and keyed on the collapsed Defender
  // ids so each consolidated row resolves the union of its machines.
  const { data: exposedDevices = [], isLoading: exposedLoading } = useQuery({
    queryKey: ["exposed-devices", exposedFor?.tenantId, exposedFor?.recommendationIds],
    queryFn: () =>
      api.get<ExposedDevice[]>(
        `/api/recommendations/exposed-devices?tenantId=${encodeURIComponent(
          exposedFor!.tenantId,
        )}&recommendationIds=${encodeURIComponent(exposedFor!.recommendationIds.join(","))}`,
      ),
    enabled: exposedFor !== null,
  });

  // Winget catalog (local mapping, no Microsoft call) — used in the detail
  // panel to surface the latest available version for a remediable finding.
  const { data: catalog = [] } = useQuery({
    queryKey: ["catalog"],
    queryFn: () => api.get<WingetCatalogEntry[]>("/api/catalog"),
  });
  const catalogByPackage = useMemo(
    () => new Map(catalog.map((c) => [c.packageId, c])),
    [catalog],
  );

  // Map Entra tenantId → display name for the "Customer Tenant" column shown
  // in the aggregate "All Tenants" view.
  const tenantNames = useMemo(
    () => new Map(tenants.map((t) => [t.tenantId, t.displayName])),
    [tenants],
  );
  const tenantName = (id: string) => tenantNames.get(id) ?? id;

  // Defender's recommendation `severityScore` is an exposure-weighted impact
  // number (usually < 4), NOT a CVSS severity — bucketing it labelled nearly
  // every recommendation "Low" and broke the severity filter. Instead derive
  // each recommendation's severity + a per-category breakdown from the CVEs it
  // actually rolls up (matched the same way the detail drill-down does), the
  // way the portal's Recommendations view reflects the worst underlying weakness.
  const recsWithBreakdown = useMemo<RecWithBreakdown[]>(
    () =>
      recs.map((r) => {
        const sevCounts: Record<Severity, number> = {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
        };
        const cves = cvesForRecommendation(r, vulns);
        for (const v of cves) sevCounts[v.severity] += 1;
        const cveTotal = cves.length;
        // Worst level present among the rolled-up CVEs; fall back to Defender's
        // score-derived label when none of its CVEs are ingested.
        const severity =
          cveTotal > 0
            ? (SEVERITY_ORDER.find((s) => sevCounts[s] > 0) ?? r.severity)
            : r.severity;
        // SLA for the bundle: the backend's recommendation-level SLA is anchored
        // on Defender's (bogus) severity score + earliest detection, so it's
        // wrong. Instead align it to the row's headline severity — take the most
        // urgent (fewest days remaining) CVE *within the highest-severity tier*.
        // Updating the software clears every bundled CVE at once, so the binding
        // deadline is the soonest-due finding at that worst severity; anchoring on
        // the highest tier also keeps the SLA chip consistent with the Sev chip.
        const tierCves = cves.filter((v) => v.severity === severity);
        const slaSource =
          tierCves.length > 0
            ? tierCves.reduce((worst, v) =>
                v.sla.daysRemaining < worst.sla.daysRemaining ? v : worst,
              )
            : null;
        const sla = slaSource ? slaSource.sla : r.sla;
        return { ...r, severity, sla, sevCounts, cveTotal };
      }),
    [recs, vulns],
  );

  // Distinct publishers/vendors present in the active dataset, for the filter
  // dropdown. The CVE view filters on the vuln publisher; the Components view
  // on the recommendation vendor.
  const publishers = useMemo(() => {
    const set = new Set<string>();
    if (view === "cves") {
      for (const v of vulns) if (v.publisher) set.add(v.publisher);
    } else if (view !== "os") {
      // Missing KBs have no vendor concept — the filter is hidden for that tab.
      for (const r of recs) if (r.vendor) set.add(r.vendor);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [view, vulns, recs]);

  const query = search.trim().toLowerCase();

  // ---- CVE view: filter + sort ----
  const filtered = vulns.filter((v) => {
    if (severityFilter !== "all" && v.severity !== severityFilter) return false;
    if (slaFilter !== "all" && slaTone(v.sla) !== slaFilter) return false;
    if (publisherFilter !== "all" && v.publisher !== publisherFilter)
      return false;
    if (
      remediationFilter !== "all" &&
      remediationRoute(v.software, v.wingetRemediable) !== remediationFilter
    )
      return false;
    if (query) {
      const haystack = [v.cveId, v.software, v.publisher, v.title, v.description]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  const dir = sortDir === "asc" ? 1 : -1;
  const sortedAll = [...filtered].sort((a, b) => {
    const av = sortValue(a, sortKey, tenantName);
    const bv = sortValue(b, sortKey, tenantName);
    let cmp: number;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    if (cmp === 0) return (a.cveId ?? "").localeCompare(b.cveId ?? "");
    return cmp * dir;
  });

  // Reset the render cap whenever the result set changes, *during* render rather
  // than in an effect. An effect would let one commit paint at the old (possibly
  // large) cap before shrinking it back — reintroducing the freeze for anyone who
  // had already pressed "Show more" a few times and then typed in the search box.
  const cveFilterKey = [
    view, query, severityFilter, slaFilter, publisherFilter, remediationFilter, sortKey, sortDir,
  ].join("|");
  if (cveFilterKey !== lastCveFilterKey) {
    setLastCveFilterKey(cveFilterKey);
    setCveLimit(CVE_PAGE_SIZE);
  }

  const sorted = sortedAll.slice(0, cveLimit);
  const hiddenCves = sortedAll.length - sorted.length;

  // ---- Grouped + Components views: filter + sort ---- (over the breakdown-augmented recs)
  const filteredRecs = recsWithBreakdown.filter((r) => {
    // Defender's misconfigurations aren't software findings — they live on the
    // Security Recommendations page's own Misconfigurations table.
    if (r.kind !== "vulnerability") return false;
    if (view === "components" && !requiresManualRemediation(r.productName)) return false;
    // "By software" excludes OS findings (their own "Missing KBs" tab) and
    // unsupported components (their own "By components" tab).
    if (
      view === "grouped" &&
      (isOsFinding(r.productName) || requiresManualRemediation(r.productName))
    )
      return false;
    if (severityFilter !== "all" && r.severity !== severityFilter) return false;
    if (r.sla && slaFilter !== "all" && slaTone(r.sla) !== slaFilter) return false;
    if (publisherFilter !== "all" && r.vendor !== publisherFilter) return false;
    if (query) {
      const haystack = [r.recommendationName, r.productName, r.vendor]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  // ---- By-OS view: filter + sort ---- (over the missing-KB roll-up)
  const filteredKbs = missingKbs.filter((k) => {
    if (query) {
      const haystack = [k.kbId, k.title, ...k.products, ...k.cveIds].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
  const sortedKbs = [...filteredKbs].sort(
    (a, b) => b.deviceCount - a.deviceCount || b.cveCount - a.cveCount,
  );

  const recDir = recSortDir === "asc" ? 1 : -1;
  const sortedRecs = [...filteredRecs].sort((a, b) => {
    const av = recSortValue(a, recSortKey, tenantName);
    const bv = recSortValue(b, recSortKey, tenantName);
    let cmp: number;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    if (cmp === 0) return a.productName.localeCompare(b.productName);
    return cmp * recDir;
  });

  // How many distinct tenants contributed to the unfiltered result set (uses the
  // active view's dataset for an honest subtitle count).
  const tenantCount = useMemo(() => {
    const ids =
      view === "cves"
        ? vulns.map((v) => v.tenantId)
        : view === "os"
          ? missingKbs.map((k) => k.tenantId)
          : recs.map((r) => r.tenantId);
    return new Set(ids).size;
  }, [view, vulns, recs, missingKbs]);

  // Findings outside SLA (breached) within the current filter — a posture pill.
  // Missing KBs don't carry an SLA today, so the "Missing KBs" tab omits this pill.
  const outsideSla =
    view === "cves"
      ? filtered.filter((v) => slaTone(v.sla) === "breached").length
      : view === "os"
        ? 0
        : filteredRecs.filter((r) => r.sla !== null && slaTone(r.sla) === "breached")
            .length;

  const isLoading = view === "cves" ? vulnsLoading : view === "os" ? kbsLoading : recsLoading;
  // The headline count is how many findings *match*, not how many are rendered —
  // the render cap is a display detail and must not look like a filter result.
  const resultCount = view === "cves" ? sortedAll.length : view === "os" ? sortedKbs.length : sortedRecs.length;
  const totalCount = view === "cves" ? vulns.length : view === "os" ? missingKbs.length : recs.length;
  const noun = view === "cves" ? "finding" : view === "os" ? "missing update" : "recommendation";

  const selectedCatalog = selected?.wingetPackageId
    ? catalogByPackage.get(selected.wingetPackageId)
    : undefined;

  // CVEs rolled up by the selected recommendation — drives the drill-down list.
  const selectedRecCves = useMemo(
    () => (selectedRec ? cvesForRecommendation(selectedRec, vulns) : []),
    [selectedRec, vulns],
  );

  // The same drill-down list, ordered by the sortable CVE/Sev/SLA header.
  const sortedRecCves = useMemo(() => {
    const dir = cveSortDir === "asc" ? 1 : -1;
    return [...selectedRecCves].sort((a, b) => {
      let cmp: number;
      if (cveSortKey === "cve") cmp = (a.cveId ?? "").localeCompare(b.cveId ?? "");
      else if (cveSortKey === "severity")
        cmp = (SEVERITY_RANK[a.severity] ?? 0) - (SEVERITY_RANK[b.severity] ?? 0);
      else cmp = a.sla.daysRemaining - b.sla.daysRemaining;
      if (cmp === 0) cmp = (a.cveId ?? "").localeCompare(b.cveId ?? "");
      return cmp * dir;
    });
  }, [selectedRecCves, cveSortKey, cveSortDir]);

  // Exports the currently active tab's full filtered+sorted result set (not
  // just the rendered page — "All CVEs" caps DOM rows at CVE_PAGE_SIZE, but
  // sortedAll holds every match).
  function exportCsv() {
    let filenameSuffix: string;
    let header: string[];
    let rows: (string | number | boolean)[][];

    if (view === "os") {
      filenameSuffix = "missing-kbs";
      header = [
        "kb", "title", "products", "cves", "exposed_devices",
        ...(isAllTenants ? ["tenant"] : []),
        "last_synced",
      ];
      rows = sortedKbs.map((k) => [
        `KB${k.kbId}`,
        k.title,
        k.products.join("; "),
        k.cveCount,
        k.deviceCount,
        ...(isAllTenants ? [tenantNames.get(k.tenantId) ?? k.tenantId] : []),
        k.latestSyncedAt,
      ]);
    } else if (view === "grouped" || view === "components") {
      filenameSuffix = view === "components" ? "by-components" : "by-software";
      header = [
        "software", "vendor", "context", "cves", "exposed_devices", "total_devices",
        "recommended_version", "detected_at",
        ...(isAllTenants ? ["tenant"] : []),
        "sla_days_remaining", "status",
      ];
      rows = sortedRecs.map((r) => [
        r.productName,
        r.vendor ?? "",
        isOsFinding(r.productName) ? "" : r.installScope,
        r.weaknessCount,
        r.exposedMachinesCount,
        r.totalMachineCount,
        r.recommendedVersion ?? "",
        r.detectedAt,
        ...(isAllTenants ? [tenantNames.get(r.tenantId) ?? r.tenantId] : []),
        r.sla ? r.sla.daysRemaining : "",
        r.status,
      ]);
    } else {
      filenameSuffix = "all-cves";
      header = [
        "cve", "severity", "cvss", "software", "publisher", "affected_devices", "detected_at",
        ...(isAllTenants ? ["tenant"] : []),
        "remediation", "sla_days_remaining", "status",
      ];
      rows = sortedAll.map((v) => [
        v.cveId ?? "",
        v.severity,
        v.cvss ?? "",
        v.displayName ?? v.software,
        v.publisher ?? "",
        v.affectedDeviceCount,
        v.detectedAt,
        ...(isAllTenants ? [tenantNames.get(v.tenantId) ?? v.tenantId] : []),
        remediationRoute(v.software, v.wingetRemediable),
        v.sla.daysRemaining,
        v.status,
      ]);
    }

    const csv = csvRow(header) + rows.map((row) => csvRow(row)).join("");
    downloadCsv(`vulnerabilities-${filenameSuffix}.csv`, csv);
  }

  return (
    <div>
      <PageHeader
        title="Vulnerabilities"
        subtitle={
          isAllTenants
            ? `Defender findings across ${tenantCount} ${
                tenantCount === 1 ? "tenant" : "tenants"
              }, with PatchPilot SLA tracking`
            : "Defender Vulnerability Management findings, with PatchPilot SLA tracking"
        }
        actions={
          <div className="flex items-center gap-2">
            <SummarizeButton
              page="vulnerabilities"
              tenantId={isAllTenants ? null : activeTenantId}
              requiresTenant
            />
            <button
              type="button"
              onClick={exportCsv}
              disabled={resultCount === 0}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              Export CSV
            </button>
          </div>
        }
      />

      {/* ---- View toggle: software roll-up / Missing KBs / unsupported components / raw CVEs ---- */}
      <div className="mb-4 flex items-center gap-1 rounded-lg bg-slate-100 p-1 w-fit">
        <button
          onClick={() => setParam("view", "grouped")}
          className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
            view === "grouped"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-800"
          }`}
        >
          By software
        </button>
        <button
          onClick={() => setParam("view", "os")}
          className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
            view === "os"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-800"
          }`}
        >
          Missing KBs
        </button>
        <button
          onClick={() => setParam("view", "components")}
          className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
            view === "components"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-800"
          }`}
        >
          By Components
        </button>
        <button
          onClick={() => setParam("view", "cves")}
          className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
            view === "cves"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-800"
          }`}
        >
          All CVEs
        </button>
      </div>

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
                placeholder={
                  view === "cves"
                    ? "Search CVE, software, publisher, description…"
                    : view === "os"
                      ? "Search KB, title, product…"
                      : "Search software or vendor…"
                }
                className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
              />
            </div>

            {/* Missing KBs have no vendor concept. */}
            {view !== "os" && (
              <select
                value={publisherFilter}
                onChange={(e) => setPublisherFilter(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
              >
                <option value="all">
                  {view === "cves" ? "All publishers" : "All vendors"}
                </option>
                {publishers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            )}

            {/* Remediation route only applies to per-CVE rows. */}
            {view === "cves" && (
              <select
                value={remediationFilter}
                onChange={(e) =>
                  setRemediationFilter(e.target.value as RemediationFilter)
                }
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
              >
                <option value="all">All remediation</option>
                <option value="winget">Winget</option>
                <option value="os">OS / Update Ring</option>
                <option value="manual">Manual</option>
                <option value="unsupported">Unsupported</option>
              </select>
            )}
          </div>

          {/* Severity/SLA filters key off fields missing KBs don't have. */}
          {view !== "os" && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
              {SEVERITY_FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setParam("severity", f)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                    severityFilter === f
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
            <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
              {SLA_FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setParam("sla", f.value)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    slaFilter === f.value
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          )}

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="text-slate-500">
              {resultCount} {resultCount === 1 ? noun : `${noun}s`}
              {resultCount !== totalCount && ` of ${totalCount}`}
            </span>
            {outsideSla > 0 && (
              <span className="inline-flex items-center rounded-full bg-rose-100 px-2.5 py-0.5 font-medium text-rose-700">
                {outsideSla} outside SLA
              </span>
            )}
          </div>
        </div>
      </Card>

      <Card className="p-0">
        {isLoading ? (
          <div className="p-5 text-sm text-slate-500">Loading…</div>
        ) : view === "grouped" || view === "components" ? (
          sortedRecs.length === 0 ? (
            <div className="p-5 text-sm text-slate-500">
              {view === "components"
                ? "No unsupported-component findings match this filter."
                : "No software recommendations match this filter."}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <RecSortableTh label="Software" sortKey="recommendation" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  <th className="px-5 py-3 font-medium">Context</th>
                  <RecSortableTh label="CVEs" sortKey="cves" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  <RecSortableTh label="Exposed" sortKey="exposed" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  <RecSortableTh label="Recommended" sortKey="version" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  <RecSortableTh label="Detected" sortKey="detected" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  {isAllTenants && (
                    <RecSortableTh label="Customer Tenant" sortKey="tenant" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  )}
                  <RecSortableTh label="SLA" sortKey="sla" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  <RecSortableTh label="Status" sortKey="status" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  <th className="px-5 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {sortedRecs.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setSelectedRec(r)}
                    className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2 font-medium text-slate-800">
                        {r.productName}
                        {r.publicExploit && <ExploitChip />}
                      </div>
                      {r.vendor && (
                        <div className="text-xs text-slate-400">{r.vendor}</div>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {isOsFinding(r.productName) ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <div className="flex items-center gap-1">
                          <ScopeChip scope={r.installScope} />
                          <MsStoreChip
                            isStoreInstall={detectMicrosoftStoreInstall(
                              r.diskPaths,
                              r.registryPaths,
                            )}
                          />
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-col items-start gap-1.5">
                        <WeaknessPill count={r.weaknessCount} />
                        <SeverityCounts counts={r.sevCounts} />
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExposedFor(r);
                        }}
                        className="rounded text-slate-700 underline-offset-2 hover:text-indigo-600 hover:underline"
                        title="View exposed devices"
                      >
                        {r.exposedMachinesCount}
                        <span className="text-slate-400">
                          {" / "}
                          {r.totalMachineCount}
                        </span>
                      </button>
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {r.recommendedVersion ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      <div>{formatDate(r.detectedAt)}</div>
                      <div className="text-xs text-slate-400">
                        {daysAgo(r.detectedAt)}d ago
                      </div>
                    </td>
                    {isAllTenants && (
                      <td className="px-5 py-3 text-slate-600">
                        {tenantNames.get(r.tenantId) ?? r.tenantId}
                      </td>
                    )}
                    <td className="px-5 py-3">
                      <SlaChip sla={r.sla} />
                    </td>
                    <td className="px-5 py-3 capitalize text-slate-600">
                      {r.status}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {(() => {
                        // Components (OpenSSL/MySQL/Log4j) and the OS itself have
                        // no package winget can update — the "By Components" view
                        // is made entirely of such rows.
                        const blockedReason = isOsFinding(r.productName)
                          ? "Ships via Windows Update — use the Missing KBs tab"
                          : requiresManualRemediation(r.productName)
                            ? "Bundled library — the owning application has to ship the updated version"
                            : !isRemediableType(r.remediationType)
                              ? UNSUPPORTED_REMEDIATION_REASON
                              : null;
                        const target = blockedReason ? null : runTargetForRec(r, vulns);
                        return (
                          <button
                            type="button"
                            disabled={!target}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (target) setRunTarget(target);
                            }}
                            className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                            title={
                              blockedReason ??
                              (target
                                ? "Run remediation"
                                : "No associated CVEs to remediate")
                            }
                          >
                            Fix now
                          </button>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : view === "os" ? (
          sortedKbs.length === 0 ? (
            <div className="p-5 text-sm text-slate-500">
              No missing Windows Updates match this filter.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-3 font-medium">Update</th>
                  <th className="px-5 py-3 font-medium">Products</th>
                  <th className="px-5 py-3 font-medium">CVEs</th>
                  <th className="px-5 py-3 font-medium">Exposed</th>
                  {isAllTenants && <th className="px-5 py-3 font-medium">Customer Tenant</th>}
                  <th className="px-5 py-3 font-medium">Last synced</th>
                  <th className="px-5 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {sortedKbs.map((k) => (
                  <tr
                    key={`${k.tenantId}:${k.kbId}`}
                    onClick={() => setSelectedKb(k)}
                    className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                  >
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-800">KB{k.kbId}</div>
                      <div className="text-xs text-slate-400">{k.title}</div>
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {k.products.length > 0 ? k.products.join(", ") : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <CveIdChips cveIds={k.cveIds} count={k.cveCount} onSelect={showCveInAllCves} />
                    </td>
                    <td className="px-5 py-3 text-slate-700">{k.deviceCount}</td>
                    {isAllTenants && (
                      <td className="px-5 py-3 text-slate-600">
                        {tenantNames.get(k.tenantId) ?? k.tenantId}
                      </td>
                    )}
                    <td className="px-5 py-3 text-slate-600">
                      <div>{formatDate(k.latestSyncedAt)}</div>
                      <div className="text-xs text-slate-400">{daysAgo(k.latestSyncedAt)}d ago</div>
                    </td>
                    <td className="px-5 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const onlyDevice = k.deviceCount === 1 ? k.devices[0] : null;
                            if (onlyDevice) {
                              setKbFixTarget({
                                tenantId: k.tenantId,
                                missingKbId: onlyDevice.missingKbId,
                                kbId: k.kbId,
                                title: k.title,
                                hostname: onlyDevice.hostname,
                              });
                            } else {
                              setSelectedKb(k);
                            }
                          }}
                          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
                        >
                          Fix now
                        </button>
                        <button
                          type="button"
                          onClick={() => setKbFixAllTarget(k)}
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                        >
                          Fix all
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : sortedAll.length === 0 ? (
          <div className="p-5 text-sm text-slate-500">
            No vulnerabilities match this filter.
            {CVE_ID_SHAPE.test(query) && (
              <>
                {" "}
                It may have already been remediated —{" "}
                <Link
                  to={toRemediationHistoryCve(query.toUpperCase())}
                  className="font-medium text-indigo-600 hover:text-indigo-700"
                >
                  check Remediation History
                </Link>
                .
              </>
            )}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <SortableTh label="CVE" sortKey="cve" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortableTh label="Severity" sortKey="severity" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortableTh label="CVSS" sortKey="cvss" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortableTh label="Software" sortKey="software" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortableTh label="Devices" sortKey="devices" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortableTh label="Detected" sortKey="detected" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                {isAllTenants && (
                  <SortableTh label="Customer Tenant" sortKey="tenant" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                )}
                <SortableTh label="Remediation" sortKey="remediation" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortableTh label="SLA" sortKey="sla" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                <th className="px-5 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((v) => (
                <tr
                  key={v.id}
                  onClick={() => setSelected(v)}
                  className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                >
                  <td className="px-5 py-3 font-medium text-slate-800">
                    {v.cveId ?? "—"}
                  </td>
                  <td className="px-5 py-3">
                    <SeverityChip severity={v.severity} />
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {v.cvss != null ? v.cvss.toFixed(1) : "—"}
                  </td>
                  <td className="px-5 py-3">
                    <div className="font-medium text-slate-800">
                      {v.displayName ?? v.software}
                    </div>
                    {v.publisher && (
                      <div className="text-xs text-slate-400">
                        {v.publisher}
                      </div>
                    )}
                    <ManualRemediationTag software={v.software} className="mt-1" />
                  </td>
                  <td className="px-5 py-3 text-slate-700">
                    {v.affectedDeviceCount}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    <div>{formatDate(v.detectedAt)}</div>
                    <div className="text-xs text-slate-400">
                      {daysAgo(v.detectedAt)}d ago
                    </div>
                  </td>
                  {isAllTenants && (
                    <td className="px-5 py-3 text-slate-600">
                      {tenantNames.get(v.tenantId) ?? v.tenantId}
                    </td>
                  )}
                  <td className="px-5 py-3">
                    <RemediationBadge software={v.software} wingetRemediable={v.wingetRemediable} />
                  </td>
                  <td className="px-5 py-3">
                    <SlaChip sla={v.sla} />
                  </td>
                  <td className="px-5 py-3 capitalize text-slate-600">
                    {v.status}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const pType = isOsFinding(v.software) ? "os" : "app";
                        setRunTarget({
                          vulnId: v.id,
                          software: v.software,
                          displayName: v.displayName ?? undefined,
                          patchType: pType,
                          tenantId: v.tenantId,
                          // Alternate repos only for apps winget can't drive.
                          // Prefer the server-resolved value; fall back to the
                          // curated client-side map if the API didn't supply one.
                          altSources:
                            pType === "app" && !v.wingetRemediable
                              ? (v.altSources ?? [...altSourcesFor(v.software)])
                              : [],
                        });
                      }}
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
                      title="Run remediation"
                    >
                      Fix now
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            {hiddenCves > 0 && (
              <tfoot>
                <tr>
                  <td
                    colSpan={isAllTenants ? 11 : 10}
                    className="border-t border-slate-100 px-5 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setCveLimit((n) => n + CVE_PAGE_SIZE)}
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
                      >
                        Show {Math.min(hiddenCves, CVE_PAGE_SIZE)} more
                      </button>
                      <span className="text-xs text-slate-500">
                        Showing {sorted.length} of {sortedAll.length} matching findings.
                        Sorting and filters apply to all {sortedAll.length}.
                      </span>
                    </div>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </Card>

      {/* ---- Per-CVE detail panel ---- */}
      <SlideOver
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.cveId ?? ""}
        subtitle="Vulnerability"
      >
        {selected && (
          <CveDetailBody
            vuln={selected}
            latestVersion={selectedCatalog?.latestVersion}
            tenantLabel={
              isAllTenants
                ? (tenantNames.get(selected.tenantId) ?? selected.tenantId)
                : null
            }
            onCreateException={() =>
              setExceptionTarget({
                cveId: selected.cveId,
                tenantId: selected.tenantId,
                label: selected.cveId ?? selected.title,
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

      {/* ---- Recommendation (consolidated) detail panel ---- */}
      <SlideOver
        open={selectedRec !== null}
        onClose={() => setSelectedRec(null)}
        title={selectedRec?.recommendationName ?? ""}
        subtitle="Security recommendation"
      >
        {selectedRec && (
          <div className="space-y-6">
            {/* Header chips */}
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <SeverityChip severity={selectedRec.severity} />
                {selectedRec.severityScore != null && (
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                    Score {selectedRec.severityScore.toFixed(1)}
                  </span>
                )}
                <WeaknessPill count={selectedRec.weaknessCount} />
                <SlaChip sla={selectedRec.sla} />
                {selectedRec.publicExploit && <ExploitChip />}
              </div>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">
                Consolidates {selectedRec.weaknessCount}{" "}
                {selectedRec.weaknessCount === 1 ? "CVE" : "CVEs"} Defender
                reports for {selectedRec.productName} into one action. Updating to
                the recommended version remediates them together.
              </p>
            </div>

            {/* Recommendation detail */}
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Recommendation
              </h4>
              <dl>
                <DetailRow label="Product">{selectedRec.productName}</DetailRow>
                {!isOsFinding(selectedRec.productName) && (
                  <DetailRow label="Context">
                    <div className="flex items-center gap-1">
                      <ScopeChip scope={selectedRec.installScope} />
                      <MsStoreChip
                        isStoreInstall={detectMicrosoftStoreInstall(
                          selectedRec.diskPaths,
                          selectedRec.registryPaths,
                        )}
                      />
                    </div>
                  </DetailRow>
                )}
                <DetailRow label="Vendor">
                  {selectedRec.vendor ?? "—"}
                </DetailRow>
                <DetailRow label="Recommended version">
                  {selectedRec.recommendedVersion ?? "Latest available"}
                </DetailRow>
                <DetailRow label="Remediation">
                  {selectedRec.remediationType ?? "—"}
                </DetailRow>
                <DetailRow label="Category">
                  {selectedRec.category ?? "—"}
                </DetailRow>
                <DetailRow label="Known CVEs">
                  {selectedRec.weaknessCount}
                </DetailRow>
                <DetailRow label="Public exploit">
                  {selectedRec.publicExploit ? (
                    <span className="text-rose-600">Yes</span>
                  ) : (
                    "None reported"
                  )}
                </DetailRow>
                {isAllTenants && (
                  <DetailRow label="Customer tenant">
                    {tenantNames.get(selectedRec.tenantId) ??
                      selectedRec.tenantId}
                  </DetailRow>
                )}
              </dl>
            </section>

            {/* How it was detected — aggregated across every device this
                recommendation's software matched to. */}
            <DetectionEvidence
              installedVersions={[]}
              diskPaths={selectedRec.diskPaths}
              registryPaths={selectedRec.registryPaths}
              showVersion={false}
            />

            {/* Exposure */}
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Exposure
              </h4>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">Exposed devices</dt>
                    <dd className="font-medium text-slate-800">
                      <button
                        type="button"
                        onClick={() => setExposedFor(selectedRec)}
                        className="rounded font-medium text-indigo-600 underline-offset-2 hover:underline"
                        title="View exposed devices"
                      >
                        {selectedRec.exposedMachinesCount} of{" "}
                        {selectedRec.totalMachineCount}
                      </button>
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">First detected</dt>
                    <dd className="font-medium text-slate-800">
                      {formatDate(selectedRec.detectedAt)} (
                      {daysAgo(selectedRec.detectedAt)}d ago)
                    </dd>
                  </div>
                </dl>
              </div>
            </section>

            {/* Drill-down: the underlying CVEs we can associate to this product.
                Clicking one hands off to the per-CVE detail panel. */}
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Underlying CVEs
              </h4>
              {selectedRecCves.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No matching per-CVE findings are ingested for this product.
                  Defender rolls up{" "}
                  {selectedRec.weaknessCount > 0
                    ? `${selectedRec.weaknessCount} weaknesses`
                    : "its weaknesses"}{" "}
                  into this recommendation; switch to the All CVEs view to browse
                  individual findings.
                </p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-slate-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <CveSortableTh label="CVE" sortKey="cve" activeKey={cveSortKey} dir={cveSortDir} onSort={toggleCveSort} />
                        <CveSortableTh label="Severity" sortKey="severity" activeKey={cveSortKey} dir={cveSortDir} onSort={toggleCveSort} />
                        <CveSortableTh label="SLA" sortKey="sla" activeKey={cveSortKey} dir={cveSortDir} onSort={toggleCveSort} />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRecCves.map((v) => (
                        <tr
                          key={v.id}
                          onClick={() => {
                            setSelectedRec(null);
                            setSelected(v);
                          }}
                          className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                        >
                          <td className="px-4 py-2.5">
                            <div className="font-medium text-slate-800">
                              {v.cveId ?? "—"}
                            </div>
                            <div className="max-w-[220px] truncate text-xs text-slate-500">
                              {v.title}
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            <SeverityChip severity={v.severity} />
                          </td>
                          <td className="px-4 py-2.5">
                            <SlaChip sla={v.sla} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* SLA detail */}
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                SLA
              </h4>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Status</dt>
                  <dd className="font-medium text-slate-800 capitalize">
                    {selectedRec.status}
                  </dd>
                </div>
                {selectedRec.sla && (
                  <>
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Due</dt>
                      <dd className="font-medium text-slate-800">
                        {new Date(selectedRec.sla.dueDate).toLocaleDateString()}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-500">Days remaining</dt>
                      <dd className="font-medium text-slate-800">
                        {selectedRec.sla.overdue
                          ? `${Math.abs(selectedRec.sla.daysRemaining)} overdue`
                          : selectedRec.sla.daysRemaining}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            </section>
          </div>
        )}
      </SlideOver>

      {/* Exposed devices — third, stacked popout. Opens over the recommendation
          detail (or directly from the Components table) and lists the machines a
          consolidated recommendation is exposed on. */}
      <SlideOver
        open={exposedFor !== null}
        onClose={() => {
          setExposedFor(null);
          setExpandedExposedId(null);
        }}
        title="Exposed devices"
        subtitle={exposedFor?.productName}
      >
        {exposedFor && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {exposedFor.exposedMachinesCount} of {exposedFor.totalMachineCount}{" "}
              devices exposed to {exposedFor.productName}.
            </p>
            {exposedLoading ? (
              <div className="text-sm text-slate-500">Loading devices…</div>
            ) : exposedDevices.length === 0 ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                No exposed device details available.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-3 font-medium">Device</th>
                    <th className="py-2 pr-3 font-medium">Owner</th>
                    <th className="py-2 pr-3 font-medium">Last seen</th>
                    <th className="py-2 font-medium">Reboot</th>
                  </tr>
                </thead>
                <tbody>
                  {exposedDevices.map((d) => {
                    const rowId = d.defenderMachineId ?? d.deviceName;
                    const hasEvidence =
                      d.diskPaths.length > 0 || d.registryPaths.length > 0;
                    const expanded = expandedExposedId === rowId;
                    return (
                      <Fragment key={rowId}>
                        <tr
                          onClick={() =>
                            navigate(
                              `/devices?device=${encodeURIComponent(
                                d.defenderMachineId ?? d.deviceName,
                              )}`,
                            )
                          }
                          className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                          title="Open in Devices"
                        >
                          <td className="py-2 pr-3 font-medium text-indigo-600">
                            {d.deviceName}
                          </td>
                          <td className="py-2 pr-3 text-slate-600">{d.owner ?? "—"}</td>
                          <td className="py-2 pr-3 text-slate-600">
                            {formatDate(d.lastSeen)}
                          </td>
                          <td className="py-2 text-slate-600">
                            <div className="flex items-center justify-between gap-2">
                              <span>
                                {d.pendingReboot === null
                                  ? "—"
                                  : d.pendingReboot
                                    ? "Pending"
                                    : "No"}
                              </span>
                              {hasEvidence && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedExposedId(expanded ? null : rowId);
                                  }}
                                  className="shrink-0 text-xs font-medium text-indigo-600 hover:text-indigo-800"
                                >
                                  {expanded ? "Hide detection" : "How detected"}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="border-b border-slate-100 last:border-0 bg-slate-50">
                            <td colSpan={4} className="px-3 py-3">
                              <DetectionEvidence
                                installedVersions={d.installedVersion ? [d.installedVersion] : []}
                                diskPaths={d.diskPaths}
                                registryPaths={d.registryPaths}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </SlideOver>

      {/* ---- Missing-KB device drill-down (Missing KBs tab) ---- */}
      <SlideOver
        open={selectedKb !== null}
        onClose={() => setSelectedKb(null)}
        title={selectedKb ? `KB${selectedKb.kbId}` : ""}
        subtitle={selectedKb?.title}
      >
        {selectedKb && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <CveIdChips
                  cveIds={selectedKb.cveIds}
                  count={selectedKb.cveCount}
                  onSelect={showCveInAllCves}
                />
                {selectedKb.url && (
                  <a
                    href={selectedKb.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded font-medium text-indigo-600 underline-offset-2 hover:underline text-xs"
                  >
                    KB article
                  </a>
                )}
              </div>
              <button
                type="button"
                onClick={() => setKbFixAllTarget(selectedKb)}
                className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
              >
                Fix all
              </button>
            </div>
            <p className="text-sm text-slate-600">
              {selectedKb.products.length > 0
                ? `Applies to ${selectedKb.products.join(", ")}.`
                : null}{" "}
              Missing on {selectedKb.deviceCount}{" "}
              {selectedKb.deviceCount === 1 ? "device" : "devices"}.
            </p>
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Devices
              </h4>
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-2.5 font-medium">Device</th>
                      <th className="px-4 py-2.5 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedKb.devices.map((d) => (
                      <tr key={d.deviceId} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-2.5 font-medium text-slate-800">{d.hostname}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() =>
                              setKbFixTarget({
                                tenantId: selectedKb.tenantId,
                                missingKbId: d.missingKbId,
                                kbId: selectedKb.kbId,
                                title: selectedKb.title,
                                hostname: d.hostname,
                              })
                            }
                            className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
                          >
                            Fix now
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </SlideOver>

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

      {kbFixAllTarget && (
        <MissingKbFixAllModal
          open={kbFixAllTarget !== null}
          onClose={() => setKbFixAllTarget(null)}
          tenantId={kbFixAllTarget.tenantId}
          kbId={kbFixAllTarget.kbId}
          title={kbFixAllTarget.title}
          devices={kbFixAllTarget.devices}
        />
      )}

      {/* ---- Run-now remediation dialog ---- */}
      <RunNowModal
        open={runTarget !== null}
        onClose={() => setRunTarget(null)}
        vulnId={runTarget?.vulnId ?? ""}
        software={runTarget?.software ?? ""}
        displayName={runTarget?.displayName}
        patchType={runTarget?.patchType ?? "app"}
        tenantId={runTarget?.tenantId ?? null}
        tenantReadOnly={
          runTarget
            ? (tenants.find((t) => t.tenantId === runTarget.tenantId)
                ?.readOnly ?? false)
            : false
        }
        altSources={runTarget?.altSources ?? []}
      />
    </div>
  );
}

/** A clickable CVE-view column header that sorts the table by `sortKey`. */
function SortableTh({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === activeKey;
  return (
    <th className="px-5 py-3 font-medium">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
        className="group inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-slate-700"
      >
        {label}
        <SortIcon active={active} dir={dir} />
      </button>
    </th>
  );
}

/** A clickable Components-view column header that sorts by `sortKey`. */
function RecSortableTh({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
}: {
  label: string;
  sortKey: RecSortKey;
  activeKey: RecSortKey;
  dir: SortDir;
  onSort: (key: RecSortKey) => void;
}) {
  const active = sortKey === activeKey;
  return (
    <th className="px-5 py-3 font-medium">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
        className="group inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-slate-700"
      >
        {label}
        <SortIcon active={active} dir={dir} />
      </button>
    </th>
  );
}

