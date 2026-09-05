import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  type Recommendation,
  type RecommendationException,
  type RecommendationKind,
  type Severity,
  type Vulnerability,
  type WingetCatalogEntry,
} from "../lib/api";
import { useTenant } from "../lib/tenant";
import { RunNowModal } from "../components/RunNowModal";
import { ExceptionModal } from "../components/ExceptionModal";
import { downloadCsv } from "../lib/csv";
import {
  Card,
  DetailRow,
  isRemediableType,
  MsStoreChip,
  PageHeader,
  prettyRemediationType,
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
  ExceptionChip,
  ExploitChip,
  formatDate,
  SeverityCounts,
  SEVERITY_ORDER,
  SEVERITY_RANK,
  SortIcon,
  type CveSortKey,
  type SortDir,
} from "../components/cve";

/**
 * Defender's TVM "Recommendations" view, mirrored 1:1 — every row here is a row
 * Defender returns from `/recommendations`, shown under Defender's own
 * `recommendationName` ("Update Google Chrome to version 151.0.7922.71"). Like
 * the portal, the page splits into two tables: **Vulnerabilities** (software
 * updates, SLA-tracked, actionable) and **Misconfigurations** (configuration
 * changes — read-only here, exceptions only, since they're remediated in
 * Intune/Group Policy rather than by a package update).
 *
 * The per-software roll-up that used to live here is back on Vulnerabilities as
 * its "By software" tab; this page deliberately does *not* regroup.
 */

const REC_KINDS: { value: RecommendationKind; label: string }[] = [
  { value: "vulnerability", label: "Vulnerabilities" },
  { value: "misconfiguration", label: "Misconfigurations" },
];

type SeverityFilter = "all" | "critical" | "high" | "medium" | "low";
const SEVERITY_FILTERS: SeverityFilter[] = [
  "all",
  "critical",
  "high",
  "medium",
  "low",
];

type SlaFilter = "all" | "breached" | "due-soon" | "ok";
const SLA_FILTERS: { value: SlaFilter; label: string }[] = [
  { value: "all", label: "All SLAs" },
  { value: "breached", label: "Breached" },
  { value: "due-soon", label: "Due soon" },
  { value: "ok", label: "On track" },
];

/** A small "N CVEs (Total)" pill — the headline noise-reduction number on a roll-up. */
function WeaknessPill({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
      {count} {count === 1 ? "CVE" : "CVEs"} (Total)
    </span>
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
  // Misconfigurations are device-config findings with no meaningful product —
  // matching on it would pull in unrelated CVEs.
  if (rec.kind === "misconfiguration") return [];
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

type RunTarget = NonNullable<ReturnType<typeof runTargetForRec>>;

/**
 * Whether "Fix now" can drive this recommendation, and why not when it can't.
 * Defender lists rows PatchPilot has no package-update path for — the OS itself
 * (Windows Update, not winget) and bundled libraries like OpenSSL (the owning
 * app has to ship the fix) — so we show them, disabled, with the reason.
 */
function fixNowState(
  rec: Recommendation,
  vulns: Vulnerability[],
): { target: RunTarget | null; reason: string } {
  if (rec.kind === "misconfiguration") {
    return {
      target: null,
      reason: "Configuration change — remediate in Intune or Group Policy, not by updating a package",
    };
  }
  if (isOsFinding(rec.productName)) {
    return {
      target: null,
      reason: "Ships via Windows Update — use the Missing KBs workflow",
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
  const target = runTargetForRec(rec, vulns);
  return {
    target,
    reason: target ? "Run remediation" : "No associated CVEs to remediate",
  };
}

/** Defender's "Threats" column: an active alert outranks a named threat tag. */
function ThreatCell({ rec }: { rec: Recommendation }) {
  if (rec.activeAlert) {
    return (
      <span
        className="inline-flex items-center rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-medium text-rose-700"
        title={rec.associatedThreats.join(", ") || "Active alert on an exposed device"}
      >
        Active alert
      </span>
    );
  }
  if (rec.associatedThreats.length > 0) {
    return (
      <span
        className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700"
        title={rec.associatedThreats.join(", ")}
      >
        {rec.associatedThreats.length}{" "}
        {rec.associatedThreats.length === 1 ? "threat" : "threats"}
      </span>
    );
  }
  return <span className="text-slate-400">—</span>;
}

/** A recommendation augmented with the per-severity breakdown of its rolled-up
 *  CVEs. `severity` is overridden to the worst level actually present (see the
 *  derivation in the component) so filters/sorting reflect real exposure. */
type RecWithBreakdown = Recommendation & {
  sevCounts: Record<Severity, number>;
  cveTotal: number;
};

// ---- Column sorting (union spans both tables; each renders its own subset) ----
type RecSortKey =
  | "recommendation"
  | "impact"
  | "scoreImpact"
  | "osPlatform"
  | "severity"
  | "cves"
  | "component"
  | "threats"
  | "exposed"
  | "remediation"
  | "category"
  | "context"
  | "tenant"
  | "sla"
  | "status";

const REC_DEFAULT_DIR: Record<RecSortKey, SortDir> = {
  recommendation: "asc",
  impact: "desc",
  scoreImpact: "desc",
  osPlatform: "asc",
  severity: "desc",
  cves: "desc",
  component: "asc",
  threats: "desc",
  exposed: "desc",
  remediation: "asc",
  category: "asc",
  context: "asc",
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
      return r.recommendationName.toLowerCase();
    case "impact":
      return r.exposureImpact ?? r.severityScore ?? -1;
    case "scoreImpact":
      return r.configScoreImpact ?? -1;
    case "osPlatform":
      return (r.osPlatform ?? "").toLowerCase();
    case "severity":
      return SEVERITY_RANK[r.severity] ?? 0;
    case "cves":
      return r.weaknessCount;
    case "component":
      return (r.relatedComponent ?? r.productName).toLowerCase();
    // Active alert sorts above named threats, which sort above none.
    case "threats":
      return r.activeAlert ? 1000 : r.associatedThreats.length;
    case "exposed":
      return r.exposedMachinesCount;
    case "remediation":
      return (r.remediationType ?? "").toLowerCase();
    case "category":
      return (r.subCategory ?? r.category ?? "").toLowerCase();
    case "context":
      return r.installScope;
    case "tenant":
      return tenantName(r.tenantId).toLowerCase();
    // Rows without an SLA clock (misconfigurations) sort last.
    case "sla":
      return r.sla ? r.sla.daysRemaining : Number.MAX_SAFE_INTEGER;
    case "status":
      return r.status;
  }
}

export function Recommendations() {
  const { activeTenantId, isAllTenants, tenants } = useTenant();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [selectedRec, setSelectedRec] = useState<Recommendation | null>(null);
  const [selected, setSelected] = useState<Vulnerability | null>(null);
  // The recommendation whose exposed devices the drill-down popout shows.
  const [exposedFor, setExposedFor] = useState<Recommendation | null>(null);
  // Which exposed-device row (by machine id) has its "how it was detected" panel open.
  const [expandedExposedId, setExpandedExposedId] = useState<string | null>(null);
  // The target (recommendation- or CVE-scoped) the "Create exception" dialog
  // is seeded from; null when the dialog is closed.
  const [exceptionTarget, setExceptionTarget] = useState<{
    recommendationId?: string | null;
    cveId?: string | null;
    tenantId: string;
    label: string;
  } | null>(null);
  // Deep-linkable (?panel=exceptions) so the Dashboard's exclusion/exception
  // banner can open straight to it, same pattern as Devices.tsx's ?device=.
  const exceptionsPanelOpen = params.get("panel") === "exceptions";
  const openExceptionsPanel = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("panel", "exceptions");
        return next;
      },
      { replace: true },
    );
  const closeExceptionsPanel = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("panel");
        return next;
      },
      { replace: true },
    );
  // The finding the "Run now" dialog is seeded from.
  const [runTarget, setRunTarget] = useState<{
    vulnId: string;
    software: string;
    displayName?: string;
    patchType: "app" | "os";
    tenantId: string;
    altSources: AltSource[];
  } | null>(null);

  const [search, setSearch] = useState("");
  const [publisherFilter, setPublisherFilter] = useState("all");

  // Which of Defender's two tables is showing. Kept in the URL so the tab is
  // deep-linkable and survives a reload; "vulnerability" is the default (and so
  // is never written to the querystring).
  const kind: RecommendationKind =
    params.get("kind") === "misconfiguration" ? "misconfiguration" : "vulnerability";
  const severityFilter = (params.get("severity") as SeverityFilter) || "all";
  const slaFilter = (params.get("sla") as SlaFilter) || "all";
  const showExceptions = params.get("showExceptions") === "true";
  const setParam = (key: "severity" | "sla" | "kind", value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "all" || (key === "kind" && value === "vulnerability")) {
          next.delete(key);
        } else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  const toggleShowExceptions = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (showExceptions) next.delete("showExceptions");
        else next.set("showExceptions", "true");
        return next;
      },
      { replace: true },
    );

  // Defender orders both tables by impact, descending.
  const defaultSortKey = (k: RecommendationKind): RecSortKey =>
    k === "misconfiguration" ? "scoreImpact" : "impact";
  const [recSortKey, setRecSortKey] = useState<RecSortKey>(defaultSortKey(kind));
  const [recSortDir, setRecSortDir] = useState<SortDir>("desc");
  const toggleRecSort = (key: RecSortKey) => {
    if (key === recSortKey) {
      setRecSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setRecSortKey(key);
      setRecSortDir(REC_DEFAULT_DIR[key]);
    }
  };
  // The two tables share no columns beyond the name, so switching tabs resets
  // the sort rather than leaving an invisible column active.
  const selectKind = (next: RecommendationKind) => {
    if (next === kind) return;
    setParam("kind", next);
    setRecSortKey(defaultSortKey(next));
    setRecSortDir("desc");
  };

  // Underlying-CVEs drill-down sort (detail panel). Defaults to worst severity.
  const [cveSortKey, setCveSortKey] = useState<CveSortKey>("severity");
  const [cveSortDir, setCveSortDir] = useState<SortDir>("desc");
  const toggleCveSort = (key: CveSortKey) => {
    if (key === cveSortKey) {
      setCveSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setCveSortKey(key);
      setCveSortDir(key === "cve" ? "asc" : key === "severity" ? "desc" : "asc");
    }
  };

  const { data: vulns = [] } = useQuery({
    queryKey: ["vulnerabilities", activeTenantId, showExceptions],
    queryFn: () =>
      api.get<Vulnerability[]>(
        isAllTenants
          ? `/api/vulnerabilities${showExceptions ? "?includeExceptions=true" : ""}`
          : `/api/vulnerabilities?tenantId=${activeTenantId}${showExceptions ? "&includeExceptions=true" : ""}`,
      ),
    enabled: !!activeTenantId,
  });

  const { data: recs = [], isLoading: recsLoading } = useQuery({
    queryKey: ["recommendations", activeTenantId, showExceptions],
    queryFn: () =>
      api.get<Recommendation[]>(
        isAllTenants
          ? `/api/recommendations${showExceptions ? "?includeExceptions=true" : ""}`
          : `/api/recommendations?tenantId=${activeTenantId}${showExceptions ? "&includeExceptions=true" : ""}`,
      ),
    enabled: !!activeTenantId,
  });

  // Devices exposed to the recommendation in the drill-down popout.
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

  // Winget catalog (local mapping, no Microsoft call) — used in the per-CVE
  // detail panel to surface the latest available version for a remediable finding.
  const { data: catalog = [] } = useQuery({
    queryKey: ["catalog"],
    queryFn: () => api.get<WingetCatalogEntry[]>("/api/catalog"),
  });
  const catalogByPackage = useMemo(
    () => new Map(catalog.map((c) => [c.packageId, c])),
    [catalog],
  );

  const tenantNames = useMemo(
    () => new Map(tenants.map((t) => [t.tenantId, t.displayName])),
    [tenants],
  );
  const tenantName = (id: string) => tenantNames.get(id) ?? id;

  // Defender's recommendation `severityScore` is an exposure-weighted impact
  // number (usually < 4), NOT a CVSS severity — derive each recommendation's
  // severity + a per-category breakdown from the CVEs it actually rolls up.
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
        const severity =
          cveTotal > 0
            ? (SEVERITY_ORDER.find((s) => sevCounts[s] > 0) ?? r.severity)
            : r.severity;
        // SLA for the bundle: align to the row's headline severity — the most
        // urgent (fewest days remaining) CVE within the highest-severity tier.
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

  // Distinct vendors present in the active dataset, for the filter dropdown.
  const publishers = useMemo(() => {
    const set = new Set<string>();
    for (const r of recs) if (r.vendor) set.add(r.vendor);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [recs]);

  const query = search.trim().toLowerCase();

  // Every row Defender returns is shown — including the OS and bundled-library
  // rows the portal lists. The search/severity filters apply to both tables;
  // the SLA filter only means anything on the vulnerabilities side.
  const matchedRecs = recsWithBreakdown.filter((r) => {
    if (severityFilter !== "all" && r.severity !== severityFilter) return false;
    if (r.sla && slaFilter !== "all" && slaTone(r.sla) !== slaFilter) return false;
    if (publisherFilter !== "all" && r.vendor !== publisherFilter) return false;
    if (query) {
      const haystack = [r.recommendationName, r.productName, r.vendor, r.relatedComponent]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  const kindCounts = {
    vulnerability: matchedRecs.filter((r) => r.kind === "vulnerability").length,
    misconfiguration: matchedRecs.filter((r) => r.kind === "misconfiguration").length,
  };
  const filteredRecs = matchedRecs.filter((r) => r.kind === kind);

  const recDir = recSortDir === "asc" ? 1 : -1;
  const sortedRecs = [...filteredRecs].sort((a, b) => {
    const av = recSortValue(a, recSortKey, tenantName);
    const bv = recSortValue(b, recSortKey, tenantName);
    let cmp: number;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    if (cmp === 0) return a.recommendationName.localeCompare(b.recommendationName);
    return cmp * recDir;
  });

  // Defender's /recommendations feed doesn't populate osPlatform on every
  // tenant, and an all-em-dash column is just noise — only show it when at
  // least one row in this table actually carries a value.
  const showOsPlatform = filteredRecs.some((r) => r.osPlatform);

  const tenantCount = useMemo(
    () => new Set(recs.map((r) => r.tenantId)).size,
    [recs],
  );

  const outsideSla = filteredRecs.filter(
    (r) => r.sla !== null && slaTone(r.sla) === "breached",
  ).length;
  const resultCount = sortedRecs.length;
  const totalCount = recs.filter((r) => r.kind === kind).length;

  const selectedCatalog = selected?.wingetPackageId
    ? catalogByPackage.get(selected.wingetPackageId)
    : undefined;

  // CVEs rolled up by the selected recommendation — drives the drill-down list.
  const selectedRecCves = useMemo(
    () => (selectedRec ? cvesForRecommendation(selectedRec, vulns) : []),
    [selectedRec, vulns],
  );

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

  // Deep-link support: a CVE detail panel's "Go to related Security
  // Recommendation" button navigates here with ?tenantId=&recommendationId=.
  // Once recommendations are loaded, switch to the table the match lives on,
  // auto-open it, and strip the params so a refresh/back doesn't reopen it.
  useEffect(() => {
    const recommendationId = params.get("recommendationId");
    if (!recommendationId || recsLoading) return;
    const match = recs.find((r) => r.recommendationIds.includes(recommendationId));
    if (match) setSelectedRec(match);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("recommendationId");
        next.delete("tenantId");
        if (match) {
          if (match.kind === "misconfiguration") next.set("kind", "misconfiguration");
          else next.delete("kind");
        }
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recs, recsLoading]);

  function exportCsv() {
    const header =
      kind === "misconfiguration"
        ? ["name", "devices_score_impact", "os_platform", "category", "threats", "exposed", "tenant", "status"]
        : [
            "security_recommendation",
            "impact",
            "os_platform",
            "weaknesses",
            "related_component",
            "threats",
            "exposed",
            "remediation_type",
            "context",
            "tenant",
            "sla",
            "status",
          ];
    const rows = sortedRecs.map((r) => {
      const threats = r.activeAlert
        ? "Active alert"
        : r.associatedThreats.length > 0
          ? `${r.associatedThreats.length} ${r.associatedThreats.length === 1 ? "threat" : "threats"}`
          : "";
      const exposed = `${r.exposedMachinesCount}/${r.totalMachineCount}`;
      const tenant = tenantNames.get(r.tenantId) ?? r.tenantId;
      return kind === "misconfiguration"
        ? [
            r.recommendationName,
            r.configScoreImpact ?? "",
            r.osPlatform ?? "",
            r.subCategory ?? r.category ?? "",
            threats,
            exposed,
            tenant,
            r.status,
          ]
        : [
            r.recommendationName,
            r.exposureImpact ?? r.severityScore ?? "",
            r.osPlatform ?? "",
            r.weaknessCount,
            r.relatedComponent ?? r.productName,
            threats,
            exposed,
            prettyRemediationType(r.remediationType),
            isOsFinding(r.productName) ? "" : r.installScope,
            tenant,
            r.sla ? `${r.sla.daysRemaining}d` : "",
            r.status,
          ];
    });
    const csv = csvRow(header) + rows.map((row) => csvRow(row)).join("");
    downloadCsv(`recommendations-${kind}.csv`, csv);
  }

  return (
    <div>
      <PageHeader
        title="Security Recommendations"
        subtitle={
          isAllTenants
            ? `Defender's security recommendations across ${tenantCount} ${
                tenantCount === 1 ? "tenant" : "tenants"
              }, with PatchPilot SLA tracking`
            : "Defender's security recommendations, with PatchPilot SLA tracking"
        }
        actions={
          <>
            <button
              type="button"
              onClick={exportCsv}
              disabled={sortedRecs.length === 0}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={openExceptionsPanel}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Exceptions
            </button>
          </>
        }
      />

      {/* ---- Defender's two recommendation tables ---- */}
      <div className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1">
        {REC_KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            onClick={() => selectKind(k.value)}
            aria-pressed={kind === k.value}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              kind === k.value
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {k.label}
            <span className="ml-1.5 text-xs text-slate-400">
              {kindCounts[k.value]}
            </span>
          </button>
        ))}
      </div>

      {/* ---- Search + filter bar ---- */}
      <Card className="mb-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[160px] flex-1">
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
                placeholder="Search recommendations, software or vendor…"
                className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
              />
            </div>

            <select
              value={publisherFilter}
              onChange={(e) => setPublisherFilter(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
            >
              <option value="all">All vendors</option>
              {publishers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

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
            {/* Misconfigurations have no patch clock, so no SLA filter. */}
            {kind === "vulnerability" && (
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
            )}
            <button
              type="button"
              onClick={toggleShowExceptions}
              aria-pressed={showExceptions}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                showExceptions
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-500 hover:text-slate-800"
              }`}
            >
              {showExceptions ? "Hide exceptions" : "Show exceptions"}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="text-slate-500">
              {resultCount} {resultCount === 1 ? "recommendation" : "recommendations"}
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
        {recsLoading ? (
          <div className="p-5 text-sm text-slate-500">Loading…</div>
        ) : sortedRecs.length === 0 ? (
          <div className="p-5 text-sm text-slate-500">
            No recommendations match this filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <RecSortableTh
                    label={kind === "misconfiguration" ? "Name" : "Security recommendation"}
                    sortKey="recommendation"
                    activeKey={recSortKey}
                    dir={recSortDir}
                    onSort={toggleRecSort}
                  />
                  {kind === "misconfiguration" ? (
                    <RecSortableTh label="Devices score impact" sortKey="scoreImpact" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  ) : (
                    <RecSortableTh label="Impact" sortKey="impact" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  )}
                  {showOsPlatform && (
                    <RecSortableTh label="OS platform" sortKey="osPlatform" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  )}
                  {kind === "misconfiguration" ? (
                    <RecSortableTh label="Category" sortKey="category" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  ) : (
                    <>
                      <RecSortableTh label="Weaknesses" sortKey="cves" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                      <RecSortableTh label="Related component" sortKey="component" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                    </>
                  )}
                  <RecSortableTh label="Threats" sortKey="threats" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  <RecSortableTh label="Exposed devices" sortKey="exposed" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  {kind === "vulnerability" && (
                    <>
                      <RecSortableTh label="Remediation type" sortKey="remediation" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                      <RecSortableTh label="Context" sortKey="context" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                    </>
                  )}
                  {isAllTenants && (
                    <RecSortableTh label="Customer Tenant" sortKey="tenant" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  )}
                  {kind === "vulnerability" && (
                    <RecSortableTh label="SLA" sortKey="sla" activeKey={recSortKey} dir={recSortDir} onSort={toggleRecSort} />
                  )}
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
                        <span className="max-w-[26rem] truncate" title={r.recommendationName}>
                          {r.recommendationName}
                        </span>
                        {r.publicExploit && <ExploitChip />}
                        {r.exception && <ExceptionChip />}
                      </div>
                      {r.vendor && (
                        <div className="text-xs text-slate-400">{r.vendor}</div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {kind === "misconfiguration"
                        ? (r.configScoreImpact?.toFixed(2) ?? "—")
                        : ((r.exposureImpact ?? r.severityScore)?.toFixed(2) ?? "—")}
                    </td>
                    {showOsPlatform && (
                      <td className="px-5 py-3 text-slate-600">{r.osPlatform ?? "—"}</td>
                    )}
                    {kind === "misconfiguration" ? (
                      <td className="px-5 py-3 text-slate-600">
                        {r.subCategory ?? r.category ?? "—"}
                      </td>
                    ) : (
                      <>
                        <td className="px-5 py-3">
                          <div className="flex flex-col items-start gap-1.5">
                            <WeaknessPill count={r.weaknessCount} />
                            <SeverityCounts counts={r.sevCounts} />
                          </div>
                        </td>
                        <td className="px-5 py-3 text-slate-600">
                          {r.relatedComponent ?? r.productName}
                        </td>
                      </>
                    )}
                    <td className="px-5 py-3">
                      <ThreatCell rec={r} />
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
                    {kind === "vulnerability" && (
                      <>
                        <td className="px-5 py-3 text-slate-600">
                          {prettyRemediationType(r.remediationType)}
                        </td>
                        <td className="px-5 py-3">
                          {/* Install scope is meaningless for the OS itself. */}
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
                      </>
                    )}
                    {isAllTenants && (
                      <td className="px-5 py-3 text-slate-600">
                        {tenantNames.get(r.tenantId) ?? r.tenantId}
                      </td>
                    )}
                    {kind === "vulnerability" && (
                      <td className="px-5 py-3">
                        <SlaChip sla={r.sla} />
                      </td>
                    )}
                    <td className="px-5 py-3 capitalize text-slate-600">
                      {r.status}
                    </td>
                    {/* Misconfigurations can only be excepted; vulnerabilities get
                        both a remediation and an exception path. */}
                    <td className="whitespace-nowrap px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {kind === "vulnerability" &&
                          (isOsFinding(r.productName) ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                navigate("/vulnerabilities?view=os");
                              }}
                              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                              title="Windows Update patches ship via the Missing KBs workflow, not a package update"
                            >
                              Missing KBs →
                            </button>
                          ) : (
                            (() => {
                              const { target, reason } = fixNowState(r, vulns);
                              return (
                                <button
                                  type="button"
                                  disabled={!target}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (target) setRunTarget(target);
                                  }}
                                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                                  title={reason}
                                >
                                  Fix now
                                </button>
                              );
                            })()
                          ))}
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
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
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
      </Card>

      {/* ---- Recommendation (consolidated) detail panel ---- */}
      <SlideOver
        open={selectedRec !== null}
        onClose={() => setSelectedRec(null)}
        title={selectedRec?.recommendationName ?? ""}
        subtitle={
          selectedRec?.kind === "misconfiguration"
            ? "Security recommendation · Misconfiguration"
            : "Security recommendation · Vulnerability"
        }
      >
        {selectedRec && (
          <div className="space-y-6">
            {/* Header chips */}
            <div>
              <div className="flex flex-wrap items-center gap-2">
                {/* Defender scores misconfigurations by configuration-score impact,
                    not CVE severity — so no severity chip for them. */}
                {selectedRec.kind === "vulnerability" && (
                  <>
                    <SeverityChip severity={selectedRec.severity} />
                    {selectedRec.severityScore != null && (
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                        Score {selectedRec.severityScore.toFixed(1)}
                      </span>
                    )}
                    <WeaknessPill count={selectedRec.weaknessCount} />
                    <SlaChip sla={selectedRec.sla} />
                  </>
                )}
                <ThreatCell rec={selectedRec} />
                {selectedRec.publicExploit && <ExploitChip />}
                {selectedRec.exception && <ExceptionChip />}
              </div>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">
                {selectedRec.kind === "misconfiguration" ? (
                  <>
                    A device-configuration finding. Defender scores it against your
                    configuration score; remediate it through Intune or Group Policy —
                    PatchPilot can't drive it with a package update.
                  </>
                ) : isOsFinding(selectedRec.productName) ? (
                  <>
                    Consolidates {selectedRec.weaknessCount}{" "}
                    {selectedRec.weaknessCount === 1 ? "CVE" : "CVEs"} Defender
                    reports for {selectedRec.productName}. These ship as Windows
                    Update KBs, not a package update — remediate them from the
                    Missing KBs tab in Vulnerabilities, where each device's specific
                    missing KB is tracked individually.
                  </>
                ) : (
                  <>
                    Consolidates {selectedRec.weaknessCount}{" "}
                    {selectedRec.weaknessCount === 1 ? "CVE" : "CVEs"} Defender
                    reports for {selectedRec.productName} into one action. Updating to
                    the recommended version remediates them together.
                  </>
                )}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {selectedRec.kind === "vulnerability" &&
                  (isOsFinding(selectedRec.productName) ? (
                    <button
                      type="button"
                      onClick={() => navigate("/vulnerabilities?view=os")}
                      className="inline-flex items-center rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
                    >
                      Go to Missing KBs →
                    </button>
                  ) : (
                    (() => {
                      const { target, reason } = fixNowState(selectedRec, vulns);
                      return (
                        <button
                          type="button"
                          disabled={!target}
                          onClick={() => {
                            if (target) setRunTarget(target);
                          }}
                          className="inline-flex items-center rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                          title={reason}
                        >
                          Fix now
                        </button>
                      );
                    })()
                  ))}
                {!selectedRec.exception && (
                  <button
                    type="button"
                    onClick={() =>
                      setExceptionTarget({
                        recommendationId: selectedRec.recommendationIds[0] ?? null,
                        tenantId: selectedRec.tenantId,
                        label: selectedRec.recommendationName,
                      })
                    }
                    className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                    title="Record a local exception"
                  >
                    Create exception
                  </button>
                )}
              </div>
            </div>

            {/* Recommendation detail */}
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Recommendation
              </h4>
              <dl>
                {selectedRec.kind === "vulnerability" ? (
                  <>
                    <DetailRow label="Related component">
                      {selectedRec.relatedComponent ?? selectedRec.productName}
                    </DetailRow>
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
                      {prettyRemediationType(selectedRec.remediationType)}
                    </DetailRow>
                    <DetailRow label="Impact">
                      {(selectedRec.exposureImpact ?? selectedRec.severityScore)?.toFixed(
                        2,
                      ) ?? "—"}
                    </DetailRow>
                  </>
                ) : (
                  <DetailRow label="Devices score impact">
                    {selectedRec.configScoreImpact?.toFixed(2) ?? "—"}
                  </DetailRow>
                )}
                <DetailRow label="Category">
                  {selectedRec.subCategory
                    ? `${selectedRec.category ?? "—"} · ${selectedRec.subCategory}`
                    : (selectedRec.category ?? "—")}
                </DetailRow>
                {selectedRec.osPlatform && (
                  <DetailRow label="OS platform">{selectedRec.osPlatform}</DetailRow>
                )}
                <DetailRow label="Threats">
                  {selectedRec.activeAlert
                    ? "Active alert"
                    : selectedRec.associatedThreats.length > 0
                      ? selectedRec.associatedThreats.join(", ")
                      : "None"}
                </DetailRow>
                {selectedRec.kind === "vulnerability" && (
                  <>
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
                  </>
                )}
                {isAllTenants && (
                  <DetailRow label="Customer tenant">
                    {tenantNames.get(selectedRec.tenantId) ??
                      selectedRec.tenantId}
                  </DetailRow>
                )}
              </dl>
            </section>

            {/* How it was detected — aggregated across every device this
                recommendation's software matched to; misconfigurations have no
                install evidence to show. */}
            {selectedRec.kind === "vulnerability" && (
              <DetectionEvidence
                installedVersions={[]}
                diskPaths={selectedRec.diskPaths}
                registryPaths={selectedRec.registryPaths}
                showVersion={false}
              />
            )}

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
                Clicking one hands off to the per-CVE detail panel. Misconfigurations
                have no CVEs behind them, so the section is skipped entirely. */}
            {selectedRec.kind === "vulnerability" && (
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
                  into this recommendation; open Vulnerabilities to browse
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
            )}

            {/* SLA detail — vulnerabilities only; misconfigurations have no patch clock. */}
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {selectedRec.sla ? "SLA" : "Status"}
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

      {/* ---- Per-CVE detail panel (reached via the Underlying CVEs drill-down) ---- */}
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

      {/* Exposed devices — stacked popout, opens over the recommendation detail
          (or directly from the table) and lists the machines a consolidated
          recommendation is exposed on. */}
      <SlideOver
        open={exposedFor !== null}
        onClose={() => {
          setExposedFor(null);
          setExpandedExposedId(null);
        }}
        title="Exposed devices"
        subtitle={exposedFor?.recommendationName}
      >
        {exposedFor && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {exposedFor.exposedMachinesCount} of {exposedFor.totalMachineCount}{" "}
              devices affected by this recommendation.
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

      {/* ---- Create exception dialog ---- */}
      <ExceptionModal
        open={exceptionTarget !== null}
        onClose={() => setExceptionTarget(null)}
        tenantId={exceptionTarget?.tenantId ?? null}
        target={exceptionTarget ?? {}}
        subjectLabel={exceptionTarget?.label ?? ""}
      />

      {/* ---- Exceptions list (view/cancel active local exceptions) ---- */}
      <ExceptionsPanel
        open={exceptionsPanelOpen}
        onClose={closeExceptionsPanel}
        tenantId={isAllTenants ? null : activeTenantId}
      />
    </div>
  );
}

/** Lists a tenant's local exception records with cancel support — the
 *  Defender-portal-mirroring "Remediation > Exceptions" surface. */
function ExceptionsPanel({
  open,
  onClose,
  tenantId,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
}) {
  const queryClient = useQueryClient();

  const { data: exceptions = [], isLoading } = useQuery({
    queryKey: ["recommendation-exceptions", tenantId],
    queryFn: () =>
      api.get<RecommendationException[]>(
        `/api/recommendations/exceptions?tenantId=${encodeURIComponent(tenantId!)}`,
      ),
    enabled: open && !!tenantId,
  });

  const cancel = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/recommendations/exceptions/${encodeURIComponent(id)}/cancel`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recommendation-exceptions"] });
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
      queryClient.invalidateQueries({ queryKey: ["vulnerabilities"] });
      queryClient.invalidateQueries({ queryKey: ["device-recommendations"] });
      queryClient.invalidateQueries({ queryKey: ["device-vulnerabilities"] });
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
  });

  const statusTone: Record<RecommendationException["derivedStatus"], string> = {
    active: "bg-emerald-100 text-emerald-700",
    expired: "bg-slate-200 text-slate-600",
    cancelled: "bg-slate-200 text-slate-500",
  };

  return (
    <SlideOver open={open} onClose={onClose} title="Exceptions" subtitle="Local-only records — not written to Defender">
      {!tenantId ? (
        <p className="text-sm text-slate-500">Select a single tenant to view its exceptions.</p>
      ) : isLoading ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : exceptions.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
          No exceptions recorded for this tenant.
        </div>
      ) : (
        <div className="space-y-3">
          {exceptions.map((e) => (
            <div key={e.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-800">
                    {e.recommendationId ?? e.cveId}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {e.justification.replace(/-/g, " ")} · {e.scope === "global" ? "Global" : `${e.deviceGroupIds.length} device group${e.deviceGroupIds.length === 1 ? "" : "s"}`}
                  </div>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${statusTone[e.derivedStatus]}`}>
                  {e.derivedStatus}
                </span>
              </div>
              {e.notes && <p className="mt-2 text-xs leading-relaxed text-slate-600">{e.notes}</p>}
              <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
                <span>
                  by {e.createdBy} on {formatDate(e.createdAt)}
                </span>
                <span>expires {formatDate(e.expiresAt)}</span>
              </div>
              {e.derivedStatus === "active" && (
                <button
                  type="button"
                  onClick={() => cancel.mutate(e.id)}
                  disabled={cancel.isPending}
                  className="mt-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel exception
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </SlideOver>
  );
}

/** A clickable column header that sorts the table by `sortKey`. */
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
