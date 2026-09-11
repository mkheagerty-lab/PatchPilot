import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { csvRow } from "@patchpilot/shared";
import { api, ApiError, type FeatureUpdateCampaign } from "../../lib/api";
import { useTenant } from "../../lib/tenant";
import { useCan } from "../../lib/auth";
import { Card, DetailRow, SlideOver } from "../../components/ui";
import { downloadCsv } from "../../lib/csv";
import { useSortableTable } from "../../lib/useSortableTable";
import { SortableTh } from "../../components/SortableTh";
import { AssignmentSummary, assignmentSummaryText } from "../../components/AssignmentSummary";
import { DropdownButton } from "../../components/DropdownButton";
import { NewFeatureUpdateCampaignModal } from "../../components/NewFeatureUpdateCampaignModal";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function SourceBadge({ source }: { source: FeatureUpdateCampaign["source"] }) {
  return source === "patchpilot" ? (
    <span className="inline-flex items-center rounded-full bg-indigo-50 dark:bg-indigo-500/10 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:text-indigo-300">
      PatchPilot
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-600 dark:text-slate-300">
      Intune
    </span>
  );
}

type SortKey = "displayName" | "source" | "targetVersion" | "createdAt";

const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  displayName: "asc",
  source: "asc",
  targetVersion: "asc",
  createdAt: "desc",
};

function sortValue(c: FeatureUpdateCampaign, key: SortKey): string | number {
  switch (key) {
    case "displayName":
      return c.displayName.toLowerCase();
    case "source":
      return c.source;
    case "targetVersion":
      return c.targetVersion.toLowerCase();
    case "createdAt":
      return new Date(c.createdAt).getTime();
  }
}

export function FeatureUpdatesTab() {
  const { activeTenantId, isAllTenants } = useTenant();
  const canWrite = useCan("operations:write");
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FeatureUpdateCampaign[] | null>(null);
  const [detail, setDetail] = useState<FeatureUpdateCampaign | null>(null);

  const queryKey = ["feature-update-campaigns", activeTenantId];
  const { data: campaigns = [], isLoading } = useQuery<FeatureUpdateCampaign[]>({
    queryKey,
    queryFn: async () => {
      const qs = isAllTenants || !activeTenantId ? "" : `?tenantId=${activeTenantId}`;
      const { campaigns } = await api.get<{ campaigns: FeatureUpdateCampaign[] }>(
        `/api/feature-updates/campaigns${qs}`,
      );
      return campaigns;
    },
  });

  const table = useSortableTable<FeatureUpdateCampaign, SortKey>({
    rows: campaigns,
    id: (c) => c.id,
    searchText: (c) => `${c.displayName} ${c.targetVersion} ${c.source} ${c.createdBy ?? ""}`,
    sortValue,
    defaultSortKey: "createdAt",
    defaultDir: DEFAULT_DIR,
  });

  const deleteOne = useMutation({
    mutationFn: (id: string) => api.del<void>(`/api/feature-updates/campaigns/${id}`),
    onSuccess: () => {
      setPendingDelete(null);
      table.clearSelection();
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Delete failed." });
      setPendingDelete(null);
    },
  });

  const bulkDelete = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ deleted: string[]; notFound: string[]; failed: { id: string; label: string; reason: string }[] }>(
        "/api/feature-updates/campaigns/bulk-delete",
        { tenantId: activeTenantId, ids },
      ),
    onSuccess: (res) => {
      setPendingDelete(null);
      table.clearSelection();
      void queryClient.invalidateQueries({ queryKey });
      if (res.failed.length > 0) {
        setMessage({
          tone: "error",
          text: `Deleted ${res.deleted.length}, but ${res.failed.length} failed: ${res.failed.map((f) => f.label).join(", ")}`,
        });
      } else {
        setMessage({ tone: "ok", text: `Deleted ${res.deleted.length} campaign${res.deleted.length === 1 ? "" : "s"}.` });
      }
    },
    onError: (err) => {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Bulk delete failed." });
      setPendingDelete(null);
    },
  });

  const busy = deleteOne.isPending || bulkDelete.isPending;

  function confirmDelete() {
    if (!pendingDelete) return;
    const ids = pendingDelete.map((c) => c.id);
    if (ids.length === 1) deleteOne.mutate(ids[0]!);
    else bulkDelete.mutate(ids);
  }

  function exportCsv() {
    const rows = table.selected.size > 0 ? table.selectedRows : table.sorted;
    const csv =
      csvRow(["campaign", "source", "target_version", "assigned_to", "offer_start", "offer_end", "interval_days", "enforced", "created_by", "created_at"]) +
      rows
        .map((c) =>
          csvRow([
            c.displayName,
            c.source,
            c.targetVersion,
            assignmentSummaryText(c.assignments),
            c.offerStartDateTimeInUTC ?? "",
            c.offerEndDateTimeInUTC ?? "",
            c.offerIntervalInDays != null ? String(c.offerIntervalInDays) : "",
            c.installFeatureUpdatesOptional ? "no" : "yes",
            c.createdBy ?? "",
            c.createdAt,
          ]),
        )
        .join("");
    downloadCsv("feature-updates.csv", csv);
  }

  return (
    <div>
      {isAllTenants && (
        <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Select a single tenant from the switcher above to view, create, or delete feature update policies.
        </div>
      )}

      {message && (
        <div
          className={`mb-4 rounded-lg border px-3 py-2 text-xs ${
            message.tone === "ok" ? "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={table.search}
          onChange={(e) => table.setSearch(e.target.value)}
          placeholder="Search name, target version, source…"
          className="w-72 rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={exportCsv}
          disabled={table.sorted.length === 0}
          className="ml-auto rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-600 dark:text-slate-300 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          {table.selected.size > 0 ? `Export selected (${table.selected.size})` : "Export CSV"}
        </button>
        <DropdownButton
          label="Create"
          disabled={isAllTenants || !activeTenantId || !canWrite}
          options={[
            {
              key: "feature-update-policy",
              label: "Feature update policy",
              onSelect: () => setCreateOpen(true),
            },
          ]}
        />
      </div>

      {table.selected.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-4 py-2 text-sm">
          <span className="font-medium text-slate-700 dark:text-slate-200">
            {table.selected.size} campaign{table.selected.size === 1 ? "" : "s"} selected
          </span>
          <button
            type="button"
            onClick={() => setPendingDelete(table.selectedRows)}
            disabled={busy || !canWrite}
            className="rounded-md border border-rose-300 dark:border-rose-700 px-3 py-1 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 disabled:opacity-50"
          >
            Delete selected
          </button>
          <button
            type="button"
            onClick={table.clearSelection}
            className="text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            Clear selection
          </button>
        </div>
      )}

      {isLoading ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500 dark:text-slate-400">Loading campaigns…</p>
        </Card>
      ) : campaigns.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No feature-update policies yet for this tenant. Click "Create" to roll a feature-update
            version out to an Entra group on a schedule, or "Sync now" to pull in profiles created
            directly in Intune.
          </p>
        </Card>
      ) : table.sorted.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500 dark:text-slate-400">No campaigns match "{table.search.trim()}".</p>
        </Card>
      ) : (
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <th className="px-4 py-2.5 font-medium">
                  <input
                    type="checkbox"
                    checked={table.allVisibleSelected}
                    onChange={table.toggleSelectAll}
                    className="rounded border-slate-300 dark:border-slate-700"
                    aria-label="Select all campaigns"
                  />
                </th>
                <SortableTh label="Campaign" sortKey="displayName" activeKey={table.sortKey} dir={table.sortDir} onSort={table.onSort} />
                <SortableTh label="Source" sortKey="source" activeKey={table.sortKey} dir={table.sortDir} onSort={table.onSort} />
                <SortableTh label="Target" sortKey="targetVersion" activeKey={table.sortKey} dir={table.sortDir} onSort={table.onSort} />
                <th className="px-4 py-2.5 font-medium">Assigned to</th>
                <th className="px-4 py-2.5 font-medium">Offer window</th>
                <th className="px-4 py-2.5 font-medium">Interval</th>
                <th className="px-4 py-2.5 font-medium">Deadline</th>
                <SortableTh label="Created" sortKey="createdAt" activeKey={table.sortKey} dir={table.sortDir} onSort={table.onSort} />
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {table.sorted.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setDetail(c)}
                  className="cursor-pointer border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={table.selected.has(c.id)}
                      onChange={() => table.toggleSelect(c.id)}
                      className="rounded border-slate-300 dark:border-slate-700"
                      aria-label={`Select ${c.displayName}`}
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-100">{c.displayName}</td>
                  <td className="px-4 py-3">
                    <SourceBadge source={c.source} />
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{c.targetVersion}</td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    <AssignmentSummary assignments={c.assignments} />
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    {c.offerStartDateTimeInUTC && c.offerEndDateTimeInUTC
                      ? `${formatDate(c.offerStartDateTimeInUTC)} – ${formatDate(c.offerEndDateTimeInUTC)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    {c.offerIntervalInDays != null ? `every ${c.offerIntervalInDays}d` : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    {c.installFeatureUpdatesOptional ? (
                      <span className="inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                        Optional
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                        Enforced
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                    {c.createdBy ? `${c.createdBy} · ${formatDate(c.createdAt)}` : `Intune · ${formatDate(c.createdAt)}`}
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => setPendingDelete([c])}
                      disabled={busy || !canWrite}
                      className="text-xs font-medium text-rose-600 dark:text-rose-400 hover:underline disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <NewFeatureUpdateCampaignModal open={createOpen} onClose={() => setCreateOpen(false)} tenantId={activeTenantId} />

      <SlideOver
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.displayName ?? ""}
        subtitle={detail ? <SourceBadge source={detail.source} /> : undefined}
      >
        {detail && (
          <dl>
            <DetailRow label="Target version">{detail.targetVersion}</DetailRow>
            <DetailRow label="Target build">{detail.targetBuild ?? "—"}</DetailRow>
            <DetailRow label="Assigned to">
              <AssignmentSummary assignments={detail.assignments} />
            </DetailRow>
            <DetailRow label="Offer window">
              {detail.offerStartDateTimeInUTC && detail.offerEndDateTimeInUTC
                ? `${formatDate(detail.offerStartDateTimeInUTC)} – ${formatDate(detail.offerEndDateTimeInUTC)}`
                : "—"}
            </DetailRow>
            <DetailRow label="Rollout interval">
              {detail.offerIntervalInDays != null ? `every ${detail.offerIntervalInDays}d` : "—"}
            </DetailRow>
            <DetailRow label="Deadline">
              {detail.installFeatureUpdatesOptional ? (
                <span className="inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  Optional
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                  Enforced
                </span>
              )}
            </DetailRow>
            <DetailRow label="Created">
              {detail.createdBy ? `${detail.createdBy} · ${formatDate(detail.createdAt)}` : `Intune · ${formatDate(detail.createdAt)}`}
            </DetailRow>
            <DetailRow label="Intune profile ID">
              <span className="break-all font-mono text-xs">{detail.intuneProfileId}</span>
            </DetailRow>
          </dl>
        )}
      </SlideOver>

      {pendingDelete && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setPendingDelete(null)} aria-hidden />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {pendingDelete.length === 1
                ? `Delete "${pendingDelete[0]!.displayName}"?`
                : `Delete ${pendingDelete.length} campaigns?`}
            </h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              This removes the feature-update profile from Intune itself, not just PatchPilot's view of
              it. Any device still mid-rollout stops receiving the offer. The change is audited.
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
                onClick={confirmDelete}
                disabled={busy}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-50"
              >
                {busy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
