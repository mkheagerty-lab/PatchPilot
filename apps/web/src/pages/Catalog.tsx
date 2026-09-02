import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type CatalogCoverage,
  type CatalogRefreshResult,
  type CatalogStatus,
  type CoverageRow,
  type CoverageStatus,
  type ExposedDevice,
  type Severity,
  type WingetCatalogEntry,
  type WingetCatalogOverride,
  type WingetMatch,
} from "../lib/api";
import { SEVERITY_RANK } from "@patchpilot/shared";
import { useCan } from "../lib/auth";
import { useTenant } from "../lib/tenant";
import {
  Card,
  DetailRow,
  KpiCard,
  ManualRemediationTag,
  PageHeader,
  SeverityChip,
  SlideOver,
} from "../components/ui";
import { formatDate } from "../components/cve";
import { RunNowModal } from "../components/RunNowModal";

const METHOD_LABELS: Record<WingetMatch["method"], string> = {
  manual: "Manual",
  exact: "Exact",
  contains: "Contains",
  "token-overlap": "Fuzzy",
};

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-slate-400 focus:outline-none";

/** Sort keys for the coverage table; mirrors the visible, sortable columns. */
type SortKey = "software" | "severity" | "status" | "devices" | "cves";

const STATUS_FILTERS: { id: CoverageStatus | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "covered", label: "Covered" },
  { id: "not-supported", label: "Not supported" },
  { id: "os", label: "OS / Windows Update" },
];

/** A refresh timestamp rendered as a local date + time; "Never" when absent. */
function formatRefreshed(iso: string | null): string {
  if (!iso) return "Never";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "Never";
  return new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ConfidenceBadge({ match }: { match: WingetMatch | null }) {
  if (!match) {
    return (
      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
        No match
      </span>
    );
  }
  const pct = Math.round(match.confidence * 100);
  const tone =
    match.confidence >= 0.9
      ? "bg-emerald-100 text-emerald-700"
      : match.confidence >= 0.7
        ? "bg-sky-100 text-sky-700"
        : "bg-amber-100 text-amber-700";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}
      title={`${METHOD_LABELS[match.method]} match`}
    >
      {pct}%<span className="opacity-60">·</span>
      {METHOD_LABELS[match.method]}
    </span>
  );
}

/** Coverage status pill — the honest "what channel patches this" signal. */
function StatusBadge({ status }: { status: CoverageStatus }) {
  if (status === "covered") {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
        Winget
      </span>
    );
  }
  if (status === "not-supported") {
    return (
      <span
        className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700"
        title="No winget package — candidate for another repo (MS Store / Intune / Chocolatey)"
      >
        Not supported
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600"
      title="OS finding — patched via Windows Update, out of winget scope by nature"
    >
      Windows Update
    </span>
  );
}

/** Clickable, sort-aware column header. */
function SortableTh({
  label,
  sortKey,
  active,
  dir,
  onSort,
  className = "",
}: {
  label: string;
  sortKey: SortKey;
  active: boolean;
  dir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  return (
    <th className={`px-5 py-3 font-medium ${className}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-700"
      >
        {label}
        <span className={active ? "text-slate-700" : "text-slate-300"}>
          {active ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

export function Catalog() {
  const { activeTenantId, activeTenant } = useTenant();
  const qc = useQueryClient();
  const canWrite = useCan("catalog:write");

  const { data: status } = useQuery<CatalogStatus>({
    queryKey: ["catalog-status"],
    queryFn: () => api.get<CatalogStatus>("/api/catalog/status"),
  });

  const { data: coverage, isLoading: coverageLoading } =
    useQuery<CatalogCoverage>({
      queryKey: ["catalog-coverage", activeTenantId],
      queryFn: () =>
        api.get<CatalogCoverage>(
          `/api/catalog/coverage?tenantId=${activeTenantId}`,
        ),
      enabled: !!activeTenantId,
    });

  const { data: catalog = [], isLoading: catalogLoading } = useQuery<
    WingetCatalogEntry[]
  >({
    queryKey: ["catalog"],
    queryFn: () => api.get<WingetCatalogEntry[]>("/api/catalog"),
  });

  const refresh = useMutation<CatalogRefreshResult, Error>({
    mutationFn: () => api.post<CatalogRefreshResult>("/api/catalog/refresh", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["catalog"] });
      qc.invalidateQueries({ queryKey: ["catalog-status"] });
      qc.invalidateQueries({ queryKey: ["catalog-coverage"] });
    },
  });

  const isDemo = status?.demo ?? false;
  const tenantReadOnly = activeTenant?.readOnly ?? false;

  const coveragePct =
    coverage && coverage.applicable > 0
      ? Math.round((coverage.covered / coverage.applicable) * 100)
      : 0;

  // Table controls: free-text search, status + severity filters, sortable cols.
  const [search, setSearch] = useState("");
  const [params, setParams] = useSearchParams();
  // Status filter lives in the URL so the Dashboard's coverage donut can
  // deep-link straight to a filtered catalog view.
  const statusFilter = (params.get("status") as CoverageStatus | "all") || "all";
  const setStatusFilter = (value: CoverageStatus | "all") =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "all") next.delete("status");
        else next.set("status", value);
        return next;
      },
      { replace: true },
    );
  const [severityFilter, setSeverityFilter] = useState<Severity | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("severity");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Drill-in + Run-now targets (one open at a time).
  const [detailRow, setDetailRow] = useState<CoverageRow | null>(null);
  const [runRow, setRunRow] = useState<CoverageRow | null>(null);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Text sorts default ascending; numeric/severity default descending.
      setSortDir(key === "software" ? "asc" : "desc");
    }
  };

  const rows = useMemo(() => {
    const all = coverage?.rows ?? [];
    const q = search.trim().toLowerCase();
    const filtered = all.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (severityFilter !== "all" && r.severity !== severityFilter) return false;
      if (!q) return true;
      return (
        r.software.toLowerCase().includes(q) ||
        (r.publisher ?? "").toLowerCase().includes(q) ||
        (r.match?.packageId ?? "").toLowerCase().includes(q) ||
        r.cveIds.some((c) => c.toLowerCase().includes(q))
      );
    });
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "software":
          return dir * a.software.localeCompare(b.software);
        case "severity":
          return dir * (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
        case "status":
          return dir * a.status.localeCompare(b.status);
        case "devices":
          return dir * (a.affectedDeviceCount - b.affectedDeviceCount);
        case "cves":
          return dir * (a.cveCount - b.cveCount);
        default:
          return 0;
      }
    });
  }, [coverage, search, statusFilter, severityFilter, sortKey, sortDir]);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (c) =>
        c.packageId.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.publisher.toLowerCase().includes(q) ||
        (c.softwareTitle ?? "").toLowerCase().includes(q),
    );
  }, [catalog, search]);

  return (
    <div>
      <PageHeader
        title="Winget Catalog"
        subtitle="Groups this tenant's findings by product and scores how each can be patched — via winget, another repo, or Windows Update. Coverage is derived live from the catalog, not the sync snapshot."
      />

      <Card className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="text-sm text-slate-600">
          <span className="font-medium text-slate-800">
            {status?.total ?? catalog.length}
          </span>{" "}
          packages
          {status && !isDemo && (
            <>
              {" · "}
              <span className="font-medium text-slate-800">{status.mirror}</span>{" "}
              from the winget mirror
              {status.curated > 0 && (
                <>
                  {" · "}
                  <span className="font-medium text-slate-800">
                    {status.curated}
                  </span>{" "}
                  curated
                </>
              )}
            </>
          )}
          <div className="mt-0.5 text-xs text-slate-400">
            {isDemo
              ? "Demo fixtures — catalog refresh is disabled."
              : `Last refreshed ${formatRefreshed(status?.lastRefreshedAt ?? null)}`}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={() => refresh.mutate()}
            disabled={isDemo || !canWrite || refresh.isPending || status?.refreshing}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
          >
            {refresh.isPending || status?.refreshing
              ? "Refreshing…"
              : "Refresh catalog"}
          </button>
          {!isDemo && !canWrite && (
            <span className="text-xs text-amber-600">
              Your role doesn't include catalog write access.
            </span>
          )}
          {refresh.isError && (
            <span className="text-xs text-rose-600">{refresh.error.message}</span>
          )}
          {refresh.isSuccess && !refresh.isPending && (
            <span className="text-xs text-emerald-600">
              Pulled {refresh.data.packages.toLocaleString()} packages
            </span>
          )}
        </div>
      </Card>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Winget-applicable"
          value={coverage?.applicable ?? 0}
          hint={`${coverage?.findingCount ?? 0} findings across ${coverage?.total ?? 0} products`}
        />
        <KpiCard
          label="Covered by winget"
          value={coverage?.covered ?? 0}
          hint={`${coveragePct}% of applicable`}
          tone={coveragePct >= 80 ? "good" : coveragePct >= 50 ? "warn" : "critical"}
        />
        <KpiCard
          label="Not supported"
          value={coverage?.uncovered ?? 0}
          hint="App, no winget package"
          tone={(coverage?.uncovered ?? 0) > 0 ? "warn" : "good"}
        />
        <KpiCard
          label="OS / Windows Update"
          value={coverage?.os ?? 0}
          hint="Out of winget scope"
        />
      </div>

      <div className="mb-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-700">
            Coverage for this tenant
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${INPUT_CLASS} w-56`}
              value={search}
              placeholder="Search product, publisher, CVE…"
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className={`${INPUT_CLASS} w-auto`}
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as CoverageStatus | "all")
              }
            >
              {STATUS_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              className={`${INPUT_CLASS} w-auto`}
              value={severityFilter}
              onChange={(e) =>
                setSeverityFilter(e.target.value as Severity | "all")
              }
            >
              <option value="all">All severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
        </div>
        <Card className="p-0">
          {coverageLoading ? (
            <div className="p-5 text-sm text-slate-500">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-5 text-sm text-slate-500">
              {coverage?.rows?.length
                ? "No products match the current filters."
                : "No findings for this tenant."}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <SortableTh
                    label="Product"
                    sortKey="software"
                    active={sortKey === "software"}
                    dir={sortDir}
                    onSort={onSort}
                  />
                  <SortableTh
                    label="Severity"
                    sortKey="severity"
                    active={sortKey === "severity"}
                    dir={sortDir}
                    onSort={onSort}
                  />
                  <SortableTh
                    label="Coverage"
                    sortKey="status"
                    active={sortKey === "status"}
                    dir={sortDir}
                    onSort={onSort}
                  />
                  <th className="px-5 py-3 font-medium uppercase tracking-wide">
                    Winget package
                  </th>
                  <SortableTh
                    label="Devices"
                    sortKey="devices"
                    active={sortKey === "devices"}
                    dir={sortDir}
                    onSort={onSort}
                    className="text-right"
                  />
                  <SortableTh
                    label="CVEs"
                    sortKey="cves"
                    active={sortKey === "cves"}
                    dir={sortDir}
                    onSort={onSort}
                    className="text-right"
                  />
                  <th className="px-5 py-3 text-right font-medium uppercase tracking-wide">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.tenantId}:${r.software}`}
                    className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                    onClick={() => setDetailRow(r)}
                  >
                    <td className="px-5 py-3">
                      <div className="font-medium text-slate-800">
                        {r.displayName ?? r.software}
                      </div>
                      {r.publisher && (
                        <div className="text-xs text-slate-400">
                          {r.publisher}
                        </div>
                      )}
                      <ManualRemediationTag software={r.software} className="mt-1" />
                    </td>
                    <td className="px-5 py-3">
                      <SeverityChip severity={r.severity} />
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-600">
                      {r.match ? (
                        <div className="flex flex-col gap-1">
                          <span>{r.match.packageId}</span>
                          <ConfidenceBadge match={r.match} />
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-slate-600">
                      {r.affectedDeviceCount}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-slate-600">
                      {r.cveCount}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {r.status === "not-supported" &&
                      r.altSources.length === 0 ? (
                        // Winget has no package and no alternate repo carries it
                        // either — the only move left is a manual mapping.
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDetailRow(r);
                          }}
                          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
                        >
                          Map package
                        </button>
                      ) : (
                        // Covered by winget, or a not-supported app an alternate
                        // repo (Chocolatey / Store) can still drive.
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setRunRow(r);
                          }}
                          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
                        >
                          Fix now
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">
          Package catalog
          {search.trim() && (
            <span className="ml-2 font-normal text-slate-400">
              {filteredCatalog.length.toLocaleString()} matching "{search.trim()}"
            </span>
          )}
        </h2>
        <Card className="p-0">
          {catalogLoading ? (
            <div className="p-5 text-sm text-slate-500">Loading…</div>
          ) : catalog.length === 0 ? (
            <div className="p-5 text-sm text-slate-500">Catalog is empty.</div>
          ) : filteredCatalog.length === 0 ? (
            <div className="p-5 text-sm text-slate-500">
              No packages match "{search.trim()}".
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-3 font-medium">Package ID</th>
                  <th className="px-5 py-3 font-medium">Name</th>
                  <th className="px-5 py-3 font-medium">Publisher</th>
                  <th className="px-5 py-3 font-medium">Latest</th>
                  <th className="px-5 py-3 font-medium">Defender title</th>
                </tr>
              </thead>
              <tbody>
                {filteredCatalog.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-slate-100 last:border-0 hover:bg-slate-50"
                  >
                    <td className="px-5 py-3 font-mono text-xs text-slate-700">
                      {c.packageId}
                    </td>
                    <td className="px-5 py-3 text-slate-800">{c.name}</td>
                    <td className="px-5 py-3 text-slate-500">{c.publisher}</td>
                    <td className="px-5 py-3 text-slate-500">
                      {c.latestVersion ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-slate-500">
                      {c.softwareTitle ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <CoverageDetail
        row={detailRow}
        canMap={!isDemo && canWrite}
        mapDeniedReason={
          isDemo
            ? "Mappings are read-only in demo mode."
            : "Your role doesn't include catalog write access."
        }
        onClose={() => setDetailRow(null)}
        onRunNow={(r) => {
          setDetailRow(null);
          setRunRow(r);
        }}
      />

      <RunNowModal
        open={!!runRow}
        onClose={() => setRunRow(null)}
        vulnId={runRow?.vulnId ?? ""}
        software={runRow?.software ?? ""}
        displayName={runRow?.displayName}
        patchType={runRow?.patchType ?? "app"}
        tenantId={runRow?.tenantId ?? null}
        tenantReadOnly={tenantReadOnly}
        altSources={runRow?.altSources ?? []}
      />
    </div>
  );
}

/**
 * The per-product drill-in. Surfaces the full coverage picture for one software
 * group — match provenance, latest catalog version, rolled-up CVEs, exposure —
 * and the "Add mapping" override affordance for not-supported app findings (which
 * pins the Defender title to a winget package so the next pass resolves it as a
 * `manual` match).
 */
function CoverageDetail({
  row,
  canMap,
  mapDeniedReason,
  onClose,
  onRunNow,
}: {
  row: CoverageRow | null;
  canMap: boolean;
  mapDeniedReason: string;
  onClose: () => void;
  onRunNow: (row: CoverageRow) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [packageId, setPackageId] = useState("");
  // On-demand device drill-down: stacked popout listing the machines this
  // software group is exposed on. Fetched only while open, keyed on the row.
  const [showDevices, setShowDevices] = useState(false);

  const { data: exposedDevices = [], isLoading: exposedLoading } = useQuery({
    queryKey: ["catalog-exposed-devices", row?.tenantId, row?.software],
    queryFn: () =>
      api.get<ExposedDevice[]>(
        `/api/catalog/exposed-devices?tenantId=${encodeURIComponent(
          row!.tenantId,
        )}&software=${encodeURIComponent(row!.software)}`,
      ),
    enabled: showDevices && !!row,
  });

  const addMapping = useMutation<WingetCatalogOverride, Error>({
    mutationFn: () =>
      api.post<WingetCatalogOverride>("/api/catalog/overrides", {
        // Pin against the row's own tenant — correct even in All-Tenants view.
        tenantId: row?.tenantId ?? null,
        softwareTitle: row?.software,
        packageId: packageId.trim(),
      }),
    onSuccess: () => {
      setPackageId("");
      qc.invalidateQueries({ queryKey: ["catalog-coverage"] });
      qc.invalidateQueries({ queryKey: ["catalog-overrides"] });
      onClose();
    },
  });

  const canSubmit = !!packageId.trim() && !addMapping.isPending;

  return (
    <>
    <SlideOver
      open={!!row}
      onClose={() => {
        setShowDevices(false);
        onClose();
      }}
      title={row?.displayName ?? row?.software ?? ""}
      subtitle={row?.publisher ?? undefined}
    >
      {row && (
        <div className="space-y-5">
          <ManualRemediationTag software={row.software} />
          <dl>
            <DetailRow label="Severity">
              <SeverityChip severity={row.severity} />
            </DetailRow>
            <DetailRow label="Coverage">
              <StatusBadge status={row.status} />
            </DetailRow>
            <DetailRow label="Patch type">
              {row.patchType === "app" ? "Application" : "Operating system"}
            </DetailRow>
            <DetailRow label="Affected devices">
              {row.affectedDeviceCount > 0 ? (
                <button
                  onClick={() => setShowDevices(true)}
                  className="font-medium text-indigo-600 underline-offset-2 hover:underline"
                  title="Show exposed devices"
                >
                  {row.affectedDeviceCount}
                </button>
              ) : (
                row.affectedDeviceCount
              )}
            </DetailRow>
            {row.match && (
              <>
                <DetailRow label="Winget package">
                  <span className="font-mono text-xs">{row.match.packageId}</span>
                </DetailRow>
                <DetailRow label="Match confidence">
                  <ConfidenceBadge match={row.match} />
                </DetailRow>
                <DetailRow label="Latest version">
                  {row.latestVersion ?? "—"}
                </DetailRow>
              </>
            )}
          </dl>

          <div>
            <div className="mb-1.5 text-xs font-medium text-slate-600">
              Rolled-up CVEs ({row.cveCount})
            </div>
            <div className="flex flex-wrap gap-1.5">
              {row.cveIds.map((c) => (
                <span
                  key={c}
                  className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>

          {row.status === "os" && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              This is an OS finding — patched via Windows Update / an expedited
              quality update, not winget. Use Fix now to push it through the
              Expedited Quality Update channel.
            </div>
          )}

          {row.status === "not-supported" && row.altSources.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="text-xs font-medium text-slate-700">
                Alternate repos{" "}
                <span className="font-normal text-slate-400">(preview)</span>
              </div>
              <p className="mt-0.5 text-[11px] leading-tight text-slate-500">
                Winget has no package, but PatchPilot can drive the fix through:
              </p>
              <ul className="mt-2 space-y-1.5">
                {row.altSources.map((a) => (
                  <li
                    key={a.source}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="text-xs font-medium text-slate-700">
                      {a.source === "chocolatey"
                        ? "Chocolatey"
                        : "Microsoft Store"}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500">
                      {a.packageId}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {row.status === "not-supported" && (
            <div className="space-y-2">
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                {row.altSources.length > 0
                  ? "No winget package matched this product. Pin a winget package ID below if one exists, or use Fix now to drive it through an alternate repo."
                  : "No winget package matched this product. It's a candidate for another repo (MS Store, Intune, Chocolatey) — or pin a winget package ID below if one exists."}
              </div>
              {canMap ? (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className={`${INPUT_CLASS} max-w-[16rem] font-mono`}
                    value={packageId}
                    placeholder="e.g. Mozilla.Firefox"
                    onChange={(e) => setPackageId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canSubmit) addMapping.mutate();
                    }}
                  />
                  <button
                    onClick={() => addMapping.mutate()}
                    disabled={!canSubmit}
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
                  >
                    {addMapping.isPending ? "Saving…" : "Save mapping"}
                  </button>
                  {addMapping.isError && (
                    <span className="text-xs text-rose-600">
                      {addMapping.error.message}
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-400">{mapDeniedReason}</p>
              )}
            </div>
          )}

          {(row.status !== "not-supported" || row.altSources.length > 0) && (
            <button
              onClick={() => onRunNow(row)}
              className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700"
            >
              Fix now
            </button>
          )}
        </div>
      )}
    </SlideOver>

    {/* Exposed devices — stacked popout over the coverage detail, listing the
        machines this software group's CVEs are exposed on. */}
    <SlideOver
      open={showDevices}
      onClose={() => setShowDevices(false)}
      title="Exposed devices"
      subtitle={row?.displayName ?? row?.software ?? undefined}
    >
      {row && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Devices exposed to {row.displayName ?? row.software} across its{" "}
            {row.cveCount} rolled-up {row.cveCount === 1 ? "CVE" : "CVEs"}.
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
                  <th className="py-2 font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {exposedDevices.map((d) => (
                  <tr
                    key={d.defenderMachineId ?? d.deviceName}
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
                    <td className="py-2 text-slate-600">{formatDate(d.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </SlideOver>
    </>
  );
}
