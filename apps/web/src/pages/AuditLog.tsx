import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  AUDIT_ACTION_GROUPS,
  AUDIT_ACTION_LABELS,
  AUDIT_OUTCOMES,
  isAuditAction,
  isSystemActor,
  systemActorLabel,
  type AuditOutcome,
} from "@patchpilot/shared";
import {
  api,
  type AuditListResponse,
  type AuditQuery,
  type AuditRecord,
} from "../lib/api";
import { useTenant } from "../lib/tenant";
import { Card, DetailRow, PageHeader, SlideOver } from "../components/ui";

const OUTCOME_STYLES: Record<AuditOutcome, string> = {
  success: "bg-emerald-100 text-emerald-700",
  failure: "bg-rose-100 text-rose-700",
  partial: "bg-amber-100 text-amber-700",
  skipped: "bg-slate-100 text-slate-600",
};

function OutcomeChip({ outcome }: { outcome: AuditOutcome | null }) {
  if (!outcome) return <span className="text-slate-400">—</span>;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${OUTCOME_STYLES[outcome]}`}
    >
      {outcome}
    </span>
  );
}

/** dd/mm/yyyy plus local time to the second — audit rows burst within the same
 *  minute, so minute precision would make a page of them look identical. */
function fmt(ts: string): string {
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

/** Legacy rows carry no `action`; the endpoint is the only thing to show. */
function actionLabel(record: AuditRecord): string {
  if (record.action && isAuditAction(record.action)) return AUDIT_ACTION_LABELS[record.action];
  return record.action ?? record.endpoint;
}

const EMPTY_FILTERS: AuditQuery = {
  category: "action",
  action: "all",
  actor: "all",
  outcome: "all",
  q: "",
  from: "",
  to: "",
  resourceId: "",
};

export function AuditLog() {
  const { activeTenantId, isAllTenants, tenants } = useTenant();
  // resourceId is deep-link only (e.g. the Dashboard activity feed) — read
  // once on load rather than kept in sync with the URL like Devices/Jobs/
  // Catalog do for their filters, since nothing else on this page writes it.
  const [urlParams] = useSearchParams();
  const [filters, setFilters] = useState<AuditQuery>(() => ({
    ...EMPTY_FILTERS,
    resourceId: urlParams.get("resourceId") ?? "",
  }));
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<AuditRecord | null>(null);

  // Every keystroke is a server round-trip on an unbounded table, so the search
  // box is debounced rather than bound straight to the query key.
  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => ({ ...f, q: search.trim() })), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const tenantScope = isAllTenants ? null : activeTenantId;

  // Built once and reused for both the query and the export link, so a CSV can
  // never contain a different set of rows than the table above it.
  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set("category", filters.category);
    // The all-tenants view must OMIT the param — sending the "__all__" sentinel
    // would filter every row out (see the note in Jobs.tsx).
    if (tenantScope) p.set("tenantId", tenantScope);
    if (filters.action !== "all") p.set("action", filters.action);
    if (filters.actor !== "all") p.set("actor", filters.actor);
    if (filters.outcome !== "all") p.set("outcome", filters.outcome);
    if (filters.resourceId) p.set("resourceId", filters.resourceId);
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
  } = useInfiniteQuery<AuditListResponse>({
    queryKey: ["audit", queryString],
    queryFn: ({ pageParam }) => {
      const page = new URLSearchParams(queryString);
      if (pageParam) page.set("cursor", pageParam as string);
      return api.get<AuditListResponse>(`/api/audit?${page.toString()}`);
    },
    // Required in react-query v5 — omitting it is a runtime error, not a type one.
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Deliberately no refetchInterval (unlike Jobs): an infinite query refetches
    // every loaded page on each tick. Refresh is explicit.
  });

  const rows = useMemo(() => data?.pages.flatMap((p) => p.rows) ?? [], [data]);

  const tenantNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tenants) map.set(t.tenantId, t.displayName);
    return map;
  }, [tenants]);

  // Faceted from the rows actually loaded — no extra endpoint. The current
  // selection is unioned in so it survives its own filter narrowing the page.
  const actorOptions = useMemo(() => {
    const set = new Set(rows.map((r) => r.engineer));
    if (filters.actor !== "all") set.add(filters.actor);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows, filters.actor]);

  const hasFilters =
    filters.action !== "all" ||
    filters.actor !== "all" ||
    filters.outcome !== "all" ||
    !!filters.q ||
    !!filters.from ||
    !!filters.to ||
    !!filters.resourceId;

  const set = <K extends keyof AuditQuery>(key: K, value: AuditQuery[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const columnCount = isAllTenants ? 7 : 6;

  return (
    <div>
      <PageHeader
        title="Audit Log"
        subtitle="Every action taken in PatchPilot — by an engineer, a schedule, or a background process. Actions are shown by default; switch to All events to include the raw Microsoft API traffic behind them."
        actions={
          <>
            <a
              href={`/api/audit/export.csv?${queryString}`}
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

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* The page's primary mode switch — visible at a glance rather than
              buried as one option inside a <select>. */}
          <div className="inline-flex overflow-hidden rounded-lg border border-slate-200">
            {(
              [
                ["action", "Actions"],
                ["all", "All events"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => set("category", value)}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                  filters.category === value
                    ? "bg-indigo-600 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-50"
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
              placeholder="Search summary, resource, actor…"
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
            />
          </div>

          <select
            value={filters.action}
            onChange={(e) => set("action", e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="all">All actions</option>
            {AUDIT_ACTION_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.actions.map((a) => (
                  <option key={a} value={a}>
                    {AUDIT_ACTION_LABELS[a]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <select
            value={filters.outcome}
            onChange={(e) => set("outcome", e.target.value as AuditOutcome | "all")}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="all">All outcomes</option>
            {AUDIT_OUTCOMES.map((o) => (
              <option key={o} value={o} className="capitalize">
                {o.charAt(0).toUpperCase() + o.slice(1)}
              </option>
            ))}
          </select>

          <select
            value={filters.actor}
            onChange={(e) => set("actor", e.target.value)}
            title="Actors seen in the rows loaded so far"
            className="max-w-[16rem] rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="all">All actors</option>
            {actorOptions.map((a) => (
              <option key={a} value={a}>
                {systemActorLabel(a)}
              </option>
            ))}
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
                setFilters({ ...EMPTY_FILTERS, category: filters.category });
              }}
              className="text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              Clear filters
            </button>
          )}
        </div>

        {filters.resourceId && (
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            <span>Filtered to resource</span>
            <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-slate-700">
              {filters.resourceId}
            </span>
            <button
              type="button"
              onClick={() => set("resourceId", "")}
              className="font-medium text-slate-500 hover:text-slate-700"
            >
              Clear
            </button>
          </div>
        )}

        {!isAllTenants && (
          <p className="mt-3 text-xs text-slate-400">
            Showing events for this tenant only. Events that belong to no single tenant —
            catalog refreshes, tenant discovery, sign-ins that failed before a tenant was
            known — appear in the All Tenants view. A successful sign-in is attributed to the
            engineer's home tenant, not to this list.
          </p>
        )}
      </Card>

      {isLoading ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">Loading audit events…</p>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">
            {hasFilters
              ? "No audit events match the current filters."
              : "No audit events recorded yet."}
          </p>
        </Card>
      ) : (
        <>
          <Card className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  {/* No sortable headers: with a server cursor window, a column
                      sort would reorder only the rows already loaded. */}
                  <th className="px-5 py-3 font-medium">
                    When <span className="font-normal normal-case text-slate-400">(newest first)</span>
                  </th>
                  <th className="px-5 py-3 font-medium">Actor</th>
                  <th className="px-5 py-3 font-medium">Action</th>
                  <th className="px-5 py-3 font-medium">Resource</th>
                  <th className="px-5 py-3 font-medium">Summary</th>
                  <th className="px-5 py-3 font-medium">Outcome</th>
                  {isAllTenants && <th className="px-5 py-3 font-medium">Tenant</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((record) => (
                  <tr
                    key={record.id}
                    onClick={() => setDetail(record)}
                    className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                  >
                    <td className="whitespace-nowrap px-5 py-3 text-slate-500">
                      {fmt(record.at)}
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {isSystemActor(record.engineer) ? (
                        <span className="flex items-center gap-2">
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                            System
                          </span>
                          {systemActorLabel(record.engineer)}
                        </span>
                      ) : (
                        record.engineer
                      )}
                    </td>
                    <td className="px-5 py-3 font-medium text-slate-800">
                      {actionLabel(record)}
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {record.resourceLabel ?? record.resourceId ?? "—"}
                      {record.resourceType && (
                        <div className="text-xs text-slate-400">{record.resourceType}</div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-slate-600">{record.summary ?? "—"}</td>
                    <td className="px-5 py-3">
                      <OutcomeChip outcome={record.outcome} />
                    </td>
                    {isAllTenants && (
                      <td className="px-5 py-3 text-slate-500">
                        {record.tenantId
                          ? tenantNames.get(record.tenantId) ?? record.tenantId
                          : "—"}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              {hasNextPage && (
                <tfoot>
                  <tr>
                    <td colSpan={columnCount} className="border-t border-slate-100 px-5 py-3">
                      <button
                        type="button"
                        onClick={() => fetchNextPage()}
                        disabled={isFetchingNextPage}
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {isFetchingNextPage ? "Loading…" : "Load more"}
                      </button>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </Card>

          <p className="mt-3 text-xs text-slate-400">
            Showing {rows.length} event{rows.length === 1 ? "" : "s"}
            {hasNextPage ? " — more available" : ""}.
          </p>
        </>
      )}

      <SlideOver
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? actionLabel(detail) : ""}
        subtitle={detail ? fmt(detail.at) : undefined}
      >
        {detail && (
          <>
            <dl>
              <DetailRow label="Outcome">
                <OutcomeChip outcome={detail.outcome} />
              </DetailRow>
              <DetailRow label="Actor">{systemActorLabel(detail.engineer)}</DetailRow>
              <DetailRow label="Actor type">{detail.actorType}</DetailRow>
              <DetailRow label="Category">{detail.category}</DetailRow>
              <DetailRow label="Tenant">
                {detail.tenantId
                  ? tenantNames.get(detail.tenantId) ?? detail.tenantId
                  : "All tenants / none"}
              </DetailRow>
              <DetailRow label="Resource">
                {detail.resourceLabel ?? detail.resourceId ?? "—"}
              </DetailRow>
              <DetailRow label="Resource type">{detail.resourceType ?? "—"}</DetailRow>
              <DetailRow label="Resource ID">
                <span className="break-all font-mono text-xs">{detail.resourceId ?? "—"}</span>
              </DetailRow>
              <DetailRow label="Endpoint">
                <span className="break-all font-mono text-xs">{detail.endpoint}</span>
              </DetailRow>
              <DetailRow label="Method">{detail.method}</DetailRow>
              <DetailRow label="Response status">{detail.responseStatus ?? "—"}</DetailRow>
              <DetailRow label="Latency">
                {detail.latencyMs === null ? "—" : `${detail.latencyMs} ms`}
              </DetailRow>
              <DetailRow label="Event ID">
                <span className="break-all font-mono text-xs">{detail.id}</span>
              </DetailRow>
            </dl>

            {detail.summary && (
              <div className="mt-5">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Summary
                </div>
                <p className="mt-1 text-sm text-slate-700">{detail.summary}</p>
              </div>
            )}

            {detail.detail && (
              <div className="mt-5">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Detail
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                  {detail.detail}
                </p>
              </div>
            )}

            <div className="mt-5">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Request payload
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Request payloads are SHA-256 hashed, never stored.
              </p>
              <p className="mt-1 break-all font-mono text-xs text-slate-700">
                {detail.payloadHash ?? "— (no payload)"}
              </p>
            </div>
          </>
        )}
      </SlideOver>
    </div>
  );
}
