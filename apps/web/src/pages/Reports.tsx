import { Fragment, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { REPORT_CSV_METRICS, REPORT_TYPES, REPORT_TYPE_DEFS, type ReportType } from "@patchpilot/shared";
import { useCan } from "../lib/auth";
import { ALL_TENANTS, useTenant } from "../lib/tenant";
import { aiApi } from "../lib/ai";
import { ApiError } from "../lib/api";
import {
  reportCsvMetricUrl,
  reportDownloadUrl,
  reportsApi,
  type ReportStatus,
  type ReportSummary,
} from "../lib/reports";
import { Card, PageHeader, Placeholder } from "../components/ui";

/**
 * Generated reports: branded PDFs rendered by the worker, stored, re-downloadable.
 *
 * Gated on `operations:read`, not `ai:use` — a reader's whole job is reading
 * these, and a report is a complete document with AI switched off. The AI
 * narration toggle below is an opt-in extra, shown only to engineers who hold
 * `ai:use`, and even then disabled (with a hint) when the cached `["ai","status"]`
 * query — same key `ChatWidget`/`SummarizeButton` use, so this page adds no
 * extra request — reports the feature unavailable on this deployment.
 *
 * Downloads and CSV exports are plain `<a href>` links (see `lib/reports.ts`),
 * not fetched through this component — the session cookie carries the request
 * and `content-disposition` does the rest, same as RemediationHistory and
 * AuditLog's server-side exports.
 *
 * Deliberately not used here: `lib/csv.ts` (the metric exports are fully
 * server-generated — the complete row set, truncation headers, and the
 * formula-injection guard — re-deriving a browser-side subset would be a
 * second, lesser copy) and `components/charts/*` (the charts live inside the
 * PDF itself; a Recharts preview here would be a second charting
 * implementation to keep in sync with the one the worker draws in pure SVG).
 */

const STATUS_LABEL: Record<ReportStatus, string> = {
  pending: "Queued",
  rendering: "Rendering",
  ready: "Ready",
  failed: "Failed",
};

const STATUS_STYLES: Record<ReportStatus, string> = {
  pending: "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300",
  rendering: "bg-sky-100 dark:bg-sky-500/15 text-sky-700 dark:text-sky-300",
  ready: "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  failed: "bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400",
};

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function StatusChip({ status }: { status: ReportStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function NarrationChip({ row }: { row: ReportSummary }) {
  if (row.narrated) {
    return (
      <span className="inline-flex items-center rounded-full bg-indigo-100 dark:bg-indigo-500/15 px-2.5 py-0.5 text-xs font-medium text-indigo-700 dark:text-indigo-300">
        AI
      </span>
    );
  }
  const degraded = row.narrationSkippedReason != null;
  return (
    <span
      title={row.narrationSkippedReason ?? undefined}
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        degraded ? "bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
      }`}
    >
      Data only
    </span>
  );
}

export function Reports() {
  const canRead = useCan("operations:read");
  const canNarrate = useCan("ai:use");
  const { reachableTenants, activeTenantId, isAllTenants } = useTenant();
  const queryClient = useQueryClient();

  const aiStatus = useQuery({
    queryKey: ["ai", "status"],
    queryFn: aiApi.status,
    staleTime: 60_000,
    enabled: canNarrate,
  });
  const aiAvailable = canNarrate && aiStatus.data?.enabled === true;

  const [reportType, setReportType] = useState<ReportType>("executive-summary");
  const def = REPORT_TYPE_DEFS[reportType];

  const [tenantId, setTenantId] = useState<string>(
    isAllTenants ? ALL_TENANTS : (activeTenantId ?? ALL_TENANTS),
  );
  const [windowDays, setWindowDays] = useState<number>(def.defaultWindowDays);
  const [narrate, setNarrate] = useState(false);
  const [activeReportId, setActiveReportId] = useState<string | null>(null);
  const [expandedWarnings, setExpandedWarnings] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ReportSummary | null>(null);

  const scopedTenantId = tenantId === ALL_TENANTS ? undefined : tenantId;

  function selectReportType(next: ReportType) {
    setReportType(next);
    const nextDef = REPORT_TYPE_DEFS[next];
    setWindowDays(nextDef.defaultWindowDays);
    if (nextDef.requiresTenant && tenantId === ALL_TENANTS) {
      setTenantId(reachableTenants[0]?.tenantId ?? ALL_TENANTS);
    }
  }

  const history = useQuery({
    queryKey: ["reports", "list"],
    queryFn: () => reportsApi.list({ limit: 50 }),
    enabled: canRead,
  });

  const activeReport = useQuery({
    queryKey: ["reports", activeReportId],
    queryFn: () => reportsApi.get(activeReportId!),
    enabled: activeReportId != null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "rendering" ? 2000 : false;
    },
  });

  const generate = useMutation({
    mutationFn: () =>
      reportsApi.create({
        reportType,
        tenantId: scopedTenantId ?? null,
        windowDays,
        narrate: aiAvailable ? narrate : false,
      }),
    onSuccess: (result) => {
      setActiveReportId(result.id);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["reports", "list"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => reportsApi.remove(id),
    onSuccess: (_data, id) => {
      if (activeReportId === id) setActiveReportId(null);
      void queryClient.invalidateQueries({ queryKey: ["reports", "list"] });
    },
  });

  // Once a polled report reaches a terminal status, the history list needs to
  // pick up its final size/status — invalidate once on the transition rather
  // than polling the list itself.
  const activeStatus = activeReport.data?.status;
  useEffect(() => {
    if (activeStatus === "ready" || activeStatus === "failed") {
      void queryClient.invalidateQueries({ queryKey: ["reports", "list"] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStatus]);

  if (!canRead) {
    return (
      <div>
        <PageHeader title="Reports" />
        <Placeholder note="You don't have permission to view reports." />
      </div>
    );
  }

  const rows = history.data?.rows ?? [];
  const inFlight = activeReportId != null && (activeStatus === "pending" || activeStatus === "rendering" || activeStatus == null);

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Branded PDF reports and metric exports, generated entirely from PatchPilot's own data."
      />

      <Card className="mb-6">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Generate a report</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {REPORT_TYPES.map((type) => {
            const typeDef = REPORT_TYPE_DEFS[type];
            const active = type === reportType;
            return (
              <label
                key={type}
                className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm transition-colors ${
                  active ? "border-indigo-400 dark:border-indigo-500 bg-indigo-50/60 dark:bg-indigo-500/10" : "border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                }`}
              >
                <span className="flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100">
                  <input
                    type="radio"
                    name="reportType"
                    checked={active}
                    onChange={() => selectReportType(type)}
                    className="text-indigo-600 dark:text-indigo-400"
                  />
                  {typeDef.label}
                </span>
                <span className="pl-6 text-xs text-slate-500 dark:text-slate-400">{typeDef.description}</span>
              </label>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-600 dark:text-slate-300">Tenant</span>
            <select
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-200"
            >
              {!def.requiresTenant && <option value={ALL_TENANTS}>All Tenants</option>}
              {reachableTenants.map((t) => (
                <option key={t.tenantId} value={t.tenantId}>
                  {t.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-600 dark:text-slate-300">Window</span>
            <select
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}
              className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-200"
            >
              {def.windowOptions.map((d) => (
                <option key={d} value={d}>
                  Last {d} days
                </option>
              ))}
            </select>
          </label>

          {canNarrate && (
            <label
              className={`flex flex-col gap-1 text-sm ${aiAvailable ? "" : "opacity-60"}`}
              title={aiAvailable ? undefined : "AI features aren't enabled on this deployment."}
            >
              <span className="font-medium text-slate-600 dark:text-slate-300">Narration</span>
              <span className="flex items-center gap-2 rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5">
                <input
                  type="checkbox"
                  checked={narrate && aiAvailable}
                  disabled={!aiAvailable}
                  onChange={(e) => setNarrate(e.target.checked)}
                />
                <span className="text-sm text-slate-700 dark:text-slate-200">AI-written summaries</span>
              </span>
            </label>
          )}

          <button
            type="button"
            onClick={() => generate.mutate()}
            disabled={generate.isPending || inFlight}
            className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {generate.isPending || inFlight ? "Generating…" : "Generate Report"}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
          Charts, tables and exports are produced either way — narration only adds AI-written prose
          on top.
        </p>

        {generate.isError && (
          <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">
            {generate.error instanceof ApiError
              ? generate.error.message
              : "Couldn't start report generation."}
          </p>
        )}
      </Card>

      {activeReportId && activeReport.data && (
        <Card className="mb-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{activeReport.data.title}</p>
              <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                {inFlight
                  ? "Rendering — this can take up to a minute…"
                  : activeReport.data.status === "ready"
                    ? `Ready · ${formatBytes(activeReport.data.pdfBytes)}`
                    : (activeReport.data.error ?? "Report generation failed.")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusChip status={activeReport.data.status} />
              {activeReport.data.status === "ready" && (
                <a
                  href={reportDownloadUrl(activeReport.data.id)}
                  download
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
                >
                  Download PDF
                </a>
              )}
            </div>
          </div>
        </Card>
      )}

      <Card className="mb-6">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Report history</h2>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400 dark:text-slate-500">No reports generated yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500">
                  <th className="py-2 pr-3 font-medium">Type</th>
                  <th className="py-2 pr-3 font-medium">Tenant</th>
                  <th className="py-2 pr-3 font-medium">Window</th>
                  <th className="py-2 pr-3 font-medium">Generated</th>
                  <th className="py-2 pr-3 font-medium">Size</th>
                  <th className="py-2 pr-3 font-medium">AI</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Expires</th>
                  <th className="py-2 pr-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Fragment key={row.id}>
                    <tr className="border-b border-slate-100 dark:border-slate-800 align-top">
                      <td className="py-2 pr-3">
                        {REPORT_TYPE_DEFS[row.reportType as ReportType]?.label ?? row.reportType}
                      </td>
                      <td className="py-2 pr-3">{row.tenantName ?? "All Tenants"}</td>
                      <td className="py-2 pr-3">{row.windowDays}d</td>
                      <td className="py-2 pr-3 text-xs text-slate-500 dark:text-slate-400">
                        {new Date(row.requestedAt).toLocaleString()}
                      </td>
                      <td className="py-2 pr-3">{formatBytes(row.pdfBytes)}</td>
                      <td className="py-2 pr-3">
                        <NarrationChip row={row} />
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-1.5">
                          <StatusChip status={row.status} />
                          {row.factCheckWarnings.length > 0 && (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedWarnings(expandedWarnings === row.id ? null : row.id)
                              }
                              className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400 transition-colors hover:bg-amber-200"
                            >
                              {row.factCheckWarnings.length} note
                              {row.factCheckWarnings.length === 1 ? "" : "s"}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-xs text-slate-500 dark:text-slate-400">
                        {new Date(row.expiresAt).toLocaleDateString()}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-3">
                          {row.status === "ready" && (
                            <a
                              href={reportDownloadUrl(row.id)}
                              download
                              className="text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                            >
                              Download
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => setPendingDelete(row)}
                            className="text-sm font-medium text-rose-600 dark:text-rose-400 hover:underline"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expandedWarnings === row.id && row.factCheckWarnings.length > 0 && (
                      <tr className="border-b border-slate-100 dark:border-slate-800 bg-amber-50/60">
                        <td colSpan={9} className="px-3 py-2">
                          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                            Data verification notes
                          </p>
                          <ul className="mt-1 list-disc pl-5 text-xs text-amber-700 dark:text-amber-400">
                            {row.factCheckWarnings.map((warning) => (
                              <li key={warning}>{warning}</li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Metric exports</h2>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Server-generated CSVs for the current tenant/window selection above — no separate export
          UI, no client-side row limit.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {REPORT_CSV_METRICS.map((metric) => (
            <a
              key={metric.id}
              href={reportCsvMetricUrl(metric.path, {
                tenantId: metric.scoped ? scopedTenantId : undefined,
                windowDays: metric.windowed ? windowDays : undefined,
              })}
              download
              className="flex flex-col gap-1 rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/40"
            >
              <span className="font-medium text-slate-800 dark:text-slate-100">{metric.label}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">{metric.description}</span>
            </a>
          ))}
        </div>
      </Card>

      {pendingDelete && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setPendingDelete(null)}
            aria-hidden
          />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Delete &quot;{pendingDelete.title}&quot;?
            </h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              This permanently removes the stored PDF. It can't be regenerated from this row once
              deleted.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-600 dark:text-slate-300 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  remove.mutate(pendingDelete.id);
                  setPendingDelete(null);
                }}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rose-500"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
