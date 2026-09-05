import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { SEVERITY_ORDER, SEVERITY_RANK, csvRow, isSystemActor, systemActorLabel } from "@patchpilot/shared";
import {
  api,
  type RemediationAttributionKind,
  type RemediationClosure,
  type RemediationEventKind,
  type RemediationHistoryListResponse,
  type RemediationHistoryQuery,
  type RemediationHistoryRecord,
  type RemediationHistoryStats,
  type Severity,
} from "../lib/api";
import { useTenant } from "../lib/tenant";
import { SummarizeButton } from "../components/ai/SummarizeButton";
import {
  Card,
  DetailRow,
  KpiCard,
  PageHeader,
  ResponsiveTable,
  SeverityChip,
  SlideOver,
  type ResponsiveTableColumn,
} from "../components/ui";
import { SortIcon, formatDate, type SortDir } from "../components/cve";
import { toDevice } from "./dashboard/links";

/** Triggers a browser download of `text` without a server round-trip — used for
 *  the selection-scoped export, which has no server-side notion of "selected". */
function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Cleared/detected read best newest-first; exposure and fix time read worst
// (longest) first — same per-column convention as ScriptCatalog/Jobs.
type SortKey =
  | "remediatedAt"
  | "finding"
  | "software"
  | "severity"
  | "device"
  | "technician"
  | "detectedAt"
  | "exposure"
  | "fixTime";

const DEFAULT_DIR: Record<SortKey, SortDir> = {
  remediatedAt: "desc",
  finding: "asc",
  software: "asc",
  severity: "desc",
  device: "asc",
  technician: "asc",
  detectedAt: "desc",
  exposure: "desc",
  fixTime: "desc",
};

type SortableRow = RemediationHistoryRecord & { exposureHours: number; fixHours: number | null };

function sortValue(row: SortableRow, key: SortKey): string | number {
  switch (key) {
    case "remediatedAt":
      return new Date(row.remediatedAt).getTime();
    case "finding":
      return (row.kind === "vulnerability" ? row.cveId : row.recommendationId) ?? "";
    case "software":
      return row.software ?? "";
    case "severity":
      return SEVERITY_RANK[row.severity];
    case "device":
      return row.deviceHostname ?? "";
    case "technician":
      return row.engineer ?? "";
    case "detectedAt":
      return new Date(row.detectedAt).getTime();
    case "exposure":
      return row.exposureHours;
    case "fixTime":
      return row.fixHours ?? -1;
  }
}

/** A clickable column-header label that sorts by `sortKey` — used as a
 *  `ResponsiveTableColumn.header`, so it renders just the label/button
 *  (`ResponsiveTable` supplies the surrounding `<th>`). */
function SortableLabel({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
}: {
  label: ReactNode;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === activeKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className="group inline-flex items-center gap-1 whitespace-nowrap uppercase tracking-wide transition-colors hover:text-slate-700 dark:hover:text-slate-300"
    >
      {label}
      <SortIcon active={active} dir={dir} />
    </button>
  );
}

/** dd/mm/yyyy plus local time to the second — several findings routinely clear
 *  in the same sync run and would look identical at minute precision. */
function fmt(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${day}/${month}/${d.getFullYear()} ${time}`;
}

/** `datetime-local` yields "2026-08-02T14:30" in local time; the API wants ISO. */
function toIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Hours as a compact duration — same thresholds as TimeToRemediateCard, so the
 * page's headline number always reads the same way the dashboard card does. */
function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function hoursBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
}

const ATTRIBUTION_LABELS: Record<RemediationAttributionKind, string> = {
  job: "Job",
  manual: "Manual",
  unattributed: "Unattributed",
};

function AttributionTag({ attribution }: { attribution: RemediationAttributionKind }) {
  if (attribution === "job") return null;
  const styles = attribution === "manual" ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-500";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>
      {ATTRIBUTION_LABELS[attribution]}
    </span>
  );
}

function ClosureTag({ closure }: { closure: RemediationClosure }) {
  if (closure !== "reclassified") return null;
  return (
    <span
      className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700"
      title="Defender re-catalogued this finding under different software; nothing was actually fixed, so it isn't counted toward time-to-remediate."
    >
      Reclassified
    </span>
  );
}

const EMPTY_FILTERS: RemediationHistoryQuery = {
  cveId: "",
  software: "",
  deviceId: "",
  engineer: "",
  severity: "all",
  kind: "all",
  attribution: "all",
  closure: "cleared",
  q: "",
  from: "",
  to: "",
};

export function RemediationHistory() {
  const { activeTenantId, isAllTenants, tenants } = useTenant();
  // cveId is deep-link only (the Dashboard's trend chart, and Vulnerabilities'
  // "no matching CVE" empty state) — read once on load, same pattern as
  // AuditLog's resourceId.
  const [urlParams] = useSearchParams();
  const [filters, setFilters] = useState<RemediationHistoryQuery>(() => ({
    ...EMPTY_FILTERS,
    cveId: urlParams.get("cveId") ?? "",
  }));
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<RemediationHistoryRecord | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("remediatedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => ({ ...f, q: search.trim() })), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const tenantScope = isAllTenants ? null : activeTenantId;

  // Built once and reused for the list query, the stats query and the export
  // link, so the CSV and the stat tiles can never reflect a different set of
  // rows than the table below them.
  const params = useMemo(() => {
    const p = new URLSearchParams();
    // The all-tenants view must OMIT the param — sending the sentinel would
    // filter every row out (see the note in Jobs.tsx / AuditLog.tsx).
    if (tenantScope) p.set("tenantId", tenantScope);
    if (filters.cveId) p.set("cveId", filters.cveId);
    if (filters.severity !== "all") p.set("severity", filters.severity);
    if (filters.kind !== "all") p.set("kind", filters.kind);
    if (filters.attribution !== "all") p.set("attribution", filters.attribution);
    // "cleared" is the server default — only send when overridden to "all"
    // (surfacing reclassified rows too, tagged).
    if (filters.closure !== "cleared") p.set("closure", filters.closure);
    if (filters.q) p.set("q", filters.q);
    const from = toIso(filters.from);
    if (from) p.set("from", from);
    const to = toIso(filters.to);
    if (to) p.set("to", to);
    return p;
  }, [filters, tenantScope]);

  const queryString = params.toString();

  const {
    data,
    isLoading,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useInfiniteQuery<RemediationHistoryListResponse>({
    queryKey: ["remediation-history", queryString],
    queryFn: ({ pageParam }) => {
      const page = new URLSearchParams(queryString);
      if (pageParam) page.set("cursor", pageParam as string);
      return api.get<RemediationHistoryListResponse>(`/api/remediation-history?${page.toString()}`);
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const { data: stats } = useQuery<RemediationHistoryStats>({
    queryKey: ["remediation-history-stats", queryString],
    queryFn: () => api.get<RemediationHistoryStats>(`/api/remediation-history/stats?${queryString}`),
  });

  const rows = useMemo(() => data?.pages.flatMap((p) => p.rows) ?? [], [data]);

  // Sorting is client-side over whatever pages have been loaded so far — the
  // keyset cursor is hard-tied to (remediatedAt, id) server-side ordering, so
  // a full server-side sort would need its own cursor shape per column.
  const sortableRows: SortableRow[] = useMemo(
    () =>
      rows.map((record) => ({
        ...record,
        exposureHours: hoursBetween(record.detectedAt, record.remediatedAt),
        fixHours:
          record.fixStartedAt && record.fixFinishedAt
            ? hoursBetween(record.fixStartedAt, record.fixFinishedAt)
            : null,
      })),
    [rows],
  );

  const sorted = useMemo(() => {
    const list = [...sortableRows];
    list.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av !== bv) {
        const cmp =
          typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      }
      return a.id.localeCompare(b.id);
    });
    return list;
  }, [sortableRows, sortKey, sortDir]);

  function onSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  }

  // Prunes selection to ids still present in the loaded set — avoids phantom
  // selected rows surviving a filter change, tenant switch, or refetch.
  useEffect(() => {
    const ids = new Set(rows.map((r) => r.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const allVisibleSelected = sorted.length > 0 && sorted.every((r) => selected.has(r.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of sorted) {
        if (allVisibleSelected) next.delete(r.id);
        else next.add(r.id);
      }
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exportSelectedCsv() {
    const chosen = sorted.filter((r) => selected.has(r.id));
    const csv =
      csvRow([
        "cleared_at",
        "kind",
        "finding",
        "software",
        "severity",
        "device",
        "technician",
        "first_detected",
        "exposure_hours",
        "fix_hours",
        "attribution",
        "closure",
        "tenant",
      ]) +
      chosen
        .map((r) =>
          csvRow([
            r.remediatedAt,
            r.kind,
            r.kind === "vulnerability" ? r.cveId : r.recommendationId,
            r.software,
            r.severity,
            r.deviceHostname,
            r.engineer,
            r.detectedAt,
            r.exposureHours.toFixed(2),
            r.fixHours == null ? "" : r.fixHours.toFixed(2),
            r.attribution,
            r.closure,
            tenantNames.get(r.tenantId) ?? r.tenantId,
          ]),
        )
        .join("");
    downloadText("remediation-history-selected.csv", csv, "text/csv;charset=utf-8");
  }

  const tenantNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tenants) map.set(t.tenantId, t.displayName);
    return map;
  }, [tenants]);

  const hasFilters =
    filters.severity !== "all" ||
    filters.kind !== "all" ||
    filters.attribution !== "all" ||
    filters.closure !== "cleared" ||
    !!filters.q ||
    !!filters.from ||
    !!filters.to ||
    !!filters.cveId;

  const set = <K extends keyof RemediationHistoryQuery>(key: K, value: RemediationHistoryQuery[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const attributedShare =
    stats && stats.matchedRows > 0
      ? Math.round(((stats.byAttribution.job + stats.byAttribution.manual) / stats.matchedRows) * 100)
      : null;

  const historyColumns: ResponsiveTableColumn<SortableRow>[] = [
    {
      key: "remediatedAt",
      header: (
        <SortableLabel
          label={
            <>
              Cleared <span className="font-normal normal-case text-slate-400">(newest first)</span>
            </>
          }
          sortKey="remediatedAt"
          activeKey={sortKey}
          dir={sortDir}
          onSort={onSort}
        />
      ),
      mobileLabel: "Cleared",
      cell: (record) => (
        <div className="whitespace-nowrap">
          <div>{fmt(record.remediatedAt)}</div>
          {record.closure === "reclassified" && (
            <div className="mt-1">
              <ClosureTag closure={record.closure} />
            </div>
          )}
        </div>
      ),
    },
    {
      key: "finding",
      primary: true,
      header: <SortableLabel label="Finding" sortKey="finding" activeKey={sortKey} dir={sortDir} onSort={onSort} />,
      cell: (record) => (
        <span className="font-medium text-slate-800 dark:text-slate-100">
          {record.kind === "vulnerability" ? record.cveId ?? "—" : record.recommendationId ?? "—"}
          <div className="text-xs font-normal capitalize text-slate-400">{record.kind}</div>
        </span>
      ),
    },
    {
      key: "software",
      header: <SortableLabel label="Software" sortKey="software" activeKey={sortKey} dir={sortDir} onSort={onSort} />,
      mobileLabel: "Software",
      cell: (record) => record.software ?? "—",
    },
    {
      key: "severity",
      header: <SortableLabel label="Severity" sortKey="severity" activeKey={sortKey} dir={sortDir} onSort={onSort} />,
      mobileLabel: "Severity",
      cell: (record) => <SeverityChip severity={record.severity} />,
    },
    {
      key: "device",
      header: <SortableLabel label="Device" sortKey="device" activeKey={sortKey} dir={sortDir} onSort={onSort} />,
      mobileLabel: "Device",
      cell: (record) =>
        record.attribution === "unattributed" ? (
          <AttributionTag attribution={record.attribution} />
        ) : (
          record.deviceHostname ?? "—"
        ),
    },
    {
      key: "technician",
      header: (
        <SortableLabel label="Technician" sortKey="technician" activeKey={sortKey} dir={sortDir} onSort={onSort} />
      ),
      mobileLabel: "Technician",
      cell: (record) => (
        <>
          {record.attribution === "unattributed" ? (
            <span className="text-slate-400">—</span>
          ) : record.engineer ? (
            <span className="flex items-center gap-2">
              {isSystemActor(record.engineer) && (
                <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  System
                </span>
              )}
              {systemActorLabel(record.engineer)}
            </span>
          ) : (
            "—"
          )}
          {record.attribution === "manual" && (
            <div className="mt-1">
              <AttributionTag attribution={record.attribution} />
            </div>
          )}
        </>
      ),
    },
    {
      key: "detectedAt",
      header: (
        <SortableLabel
          label="First detected"
          sortKey="detectedAt"
          activeKey={sortKey}
          dir={sortDir}
          onSort={onSort}
        />
      ),
      mobileLabel: "First detected",
      cell: (record) => <span className="whitespace-nowrap">{formatDate(record.detectedAt)}</span>,
    },
    {
      key: "exposure",
      header: (
        <SortableLabel label="Exposure" sortKey="exposure" activeKey={sortKey} dir={sortDir} onSort={onSort} />
      ),
      mobileLabel: "Exposure",
      cell: (record) => formatDuration(record.exposureHours),
    },
    {
      key: "fixTime",
      header: (
        <SortableLabel label="Fix time" sortKey="fixTime" activeKey={sortKey} dir={sortDir} onSort={onSort} />
      ),
      mobileLabel: "Fix time",
      cell: (record) => (record.fixHours === null ? "—" : formatDuration(record.fixHours)),
    },
    ...(isAllTenants
      ? [
          {
            key: "tenant",
            header: "Tenant",
            cell: (record: SortableRow) => tenantNames.get(record.tenantId) ?? record.tenantId,
          } satisfies ResponsiveTableColumn<SortableRow>,
        ]
      : []),
  ];

  return (
    <div>
      <PageHeader
        title="Remediation History"
        subtitle="Every closed finding, attributed to the device, technician and job that closed it where one could be identified — the audit trail behind the time-to-remediate metric."
        actions={
          <>
            <SummarizeButton page="remediation-history" tenantId={tenantScope} />
            <a
              href={`/api/remediation-history/export.csv?${queryString}`}
              download
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
            >
              Export CSV
            </a>
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              {isFetching && !isFetchingNextPage ? "Refreshing…" : "Refresh"}
            </button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Matched findings" value={stats ? stats.matchedRows : "—"} hint={stats?.truncated ? "Capped — narrow the filters" : undefined} />
        <KpiCard
          label="Avg exposure"
          value={stats?.exposure.avgHours == null ? "—" : formatDuration(stats.exposure.avgHours)}
          hint="detected → cleared"
        />
        <KpiCard
          label="p90 exposure"
          value={stats?.exposure.p90Hours == null ? "—" : formatDuration(stats.exposure.p90Hours)}
        />
        <KpiCard
          label="Avg fix time"
          value={stats?.work.avgHours == null ? "—" : formatDuration(stats.work.avgHours)}
          hint="dispatch → finish, attributed only"
        />
        <KpiCard label="Attributed" value={attributedShare === null ? "—" : `${attributedShare}%`} hint="job or manual match" />
      </div>

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex overflow-hidden rounded-lg border border-slate-200">
            {(
              [
                ["cleared", "Cleared"],
                ["all", "All"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => set("closure", value)}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                  filters.closure === value ? "bg-[var(--pp-primary)] text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

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
              placeholder="Search CVE, software, device, technician…"
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
            />
          </div>

          <select
            value={filters.severity}
            onChange={(e) => set("severity", e.target.value as Severity | "all")}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="all">All severities</option>
            {SEVERITY_ORDER.map((s) => (
              <option key={s} value={s} className="capitalize">
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>

          <select
            value={filters.kind}
            onChange={(e) => set("kind", e.target.value as RemediationEventKind | "all")}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="all">Vulns + recommendations</option>
            <option value="vulnerability">Vulnerabilities</option>
            <option value="recommendation">Recommendations</option>
          </select>

          <select
            value={filters.attribution}
            onChange={(e) => set("attribution", e.target.value as RemediationAttributionKind | "all")}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="all">All attributions</option>
            <option value="job">Job</option>
            <option value="manual">Manual</option>
            <option value="unattributed">Unattributed</option>
          </select>

          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            From
            <input
              type="datetime-local"
              value={filters.from}
              onChange={(e) => set("from", e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-700"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            To
            <input
              type="datetime-local"
              value={filters.to}
              onChange={(e) => set("to", e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-700"
            />
          </label>

          {hasFilters && (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setFilters(EMPTY_FILTERS);
              }}
              className="text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              Clear filters
            </button>
          )}
        </div>

        {filters.cveId && (
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            <span>Filtered to CVE</span>
            <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-slate-700">{filters.cveId}</span>
            <button
              type="button"
              onClick={() => set("cveId", "")}
              className="font-medium text-slate-500 hover:text-slate-700"
            >
              Clear
            </button>
          </div>
        )}

        {!isAllTenants && (
          <p className="mt-3 text-xs text-slate-400">
            Showing closed findings for this tenant only. Switch to All Tenants to compare exposure across
            customers.
          </p>
        )}
      </Card>

      {isLoading ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">Loading remediation history…</p>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">
            {hasFilters
              ? "No closed findings match the current filters."
              : "No remediation history recorded yet."}
          </p>
        </Card>
      ) : (
        <>
          {selected.size > 0 && (
            <div className="mb-3 flex items-center gap-3 rounded-md border border-slate-300 bg-slate-50 px-4 py-2 text-sm">
              <span className="font-medium text-slate-700">
                {selected.size} finding{selected.size === 1 ? "" : "s"} selected
              </span>
              <button
                type="button"
                onClick={exportSelectedCsv}
                className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-white"
              >
                Export selected ({selected.size})
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-xs font-medium text-slate-500 hover:text-slate-700"
              >
                Clear selection
              </button>
            </div>
          )}

          <ResponsiveTable
            columns={historyColumns}
            rows={sorted}
            rowKey={(record) => record.id}
            onRowClick={setDetail}
            selection={{
              isSelected: (record) => selected.has(record.id),
              onToggle: (record) => toggleSelect(record.id),
              allSelected: allVisibleSelected,
              onToggleAll: toggleSelectAll,
              ariaLabel: (record) =>
                `Select ${record.kind === "vulnerability" ? record.cveId ?? "finding" : record.recommendationId ?? "finding"}`,
            }}
            footer={
              hasNextPage ? (
                <button
                  type="button"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  {isFetchingNextPage ? "Loading…" : "Load more"}
                </button>
              ) : undefined
            }
          />

          <p className="mt-3 text-xs text-slate-400">
            Showing {rows.length} finding{rows.length === 1 ? "" : "s"}
            {hasNextPage ? " — more available" : ""}.
          </p>
        </>
      )}

      <SlideOver
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? (detail.kind === "vulnerability" ? detail.cveId ?? "Finding" : detail.recommendationId ?? "Finding") : ""}
        subtitle={detail ? detail.software ?? undefined : undefined}
      >
        {detail && (
          <>
            {detail.attribution === "unattributed" && (
              <p className="mb-4 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
                No PatchPilot job or manual record matched this clearing — it was likely closed by
                Autopatch, WSUS, a user action, or a Defender re-scan.
              </p>
            )}
            {detail.closure === "reclassified" && (
              <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                Defender re-catalogued this finding under different software shortly after this row was
                recorded. Nothing was actually fixed — this row is excluded from time-to-remediate.
              </p>
            )}

            <dl>
              <DetailRow label="Kind">
                <span className="capitalize">{detail.kind}</span>
              </DetailRow>
              <DetailRow label="Severity">
                <SeverityChip severity={detail.severity} />
              </DetailRow>
              <DetailRow label="Software">{detail.software ?? "—"}</DetailRow>
              <DetailRow label="Tenant">{tenantNames.get(detail.tenantId) ?? detail.tenantId}</DetailRow>
            </dl>

            <div className="mt-5">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Chronology</div>
              <dl className="mt-1">
                <DetailRow label="First detected">{fmt(detail.detectedAt)}</DetailRow>
                <DetailRow label="Fix dispatched">{fmt(detail.fixStartedAt)}</DetailRow>
                <DetailRow label="Fix finished">{fmt(detail.fixFinishedAt)}</DetailRow>
                <DetailRow label="Defender confirmed cleared">{fmt(detail.remediatedAt)}</DetailRow>
              </dl>
            </div>

            <div className="mt-5">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Attribution</div>
              <dl className="mt-1">
                <DetailRow label="Matched by">
                  <span className="flex items-center gap-2">
                    {ATTRIBUTION_LABELS[detail.attribution]}
                    <AttributionTag attribution={detail.attribution} />
                  </span>
                </DetailRow>
                <DetailRow label="Device">
                  {detail.deviceId ? (
                    <a href={toDevice(detail.deviceId)} className="text-indigo-600 hover:underline">
                      {detail.deviceHostname ?? detail.deviceId}
                    </a>
                  ) : (
                    detail.deviceHostname ?? "—"
                  )}
                </DetailRow>
                <DetailRow label="Technician">
                  {detail.engineer ? systemActorLabel(detail.engineer) : "—"}
                </DetailRow>
                <DetailRow label="Channel">{detail.channel ?? "—"}</DetailRow>
                <DetailRow label="Job ID">
                  <span className="break-all font-mono text-xs">{detail.jobId ?? "—"}</span>
                </DetailRow>
                <DetailRow label="Contributing jobs">{detail.contributingJobs}</DetailRow>
              </dl>
            </div>

            <div className="mt-5">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Event ID</div>
              <p className="mt-1 break-all font-mono text-xs text-slate-700">{detail.id}</p>
            </div>
          </>
        )}
      </SlideOver>
    </div>
  );
}
