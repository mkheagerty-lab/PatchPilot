import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { csvRow } from "@patchpilot/shared";
import { api, ApiError, type QualityUpdateCampaign } from "../../lib/api";
import { useTenant } from "../../lib/tenant";
import { useCan } from "../../lib/auth";
import { Card } from "../../components/ui";
import { downloadCsv } from "../../lib/csv";
import { useSortableTable } from "../../lib/useSortableTable";
import { SortableTh } from "../../components/SortableTh";
import { AssignmentSummary, assignmentSummaryText } from "../../components/AssignmentSummary";
import { DropdownButton } from "../../components/DropdownButton";
import { NewExpediteQualityUpdateModal } from "../../components/NewExpediteQualityUpdateModal";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function SourceBadge({ source }: { source: QualityUpdateCampaign["source"] }) {
  return source === "patchpilot" ? (
    <span className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
      PatchPilot
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
      Intune
    </span>
  );
}

function PolicyTypeBadge({ policyType }: { policyType: QualityUpdateCampaign["policyType"] }) {
  return policyType === "expedite" ? (
    <span className="inline-flex items-center rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
      Expedite
    </span>
  ) : (
    <span
      className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
      title="Read-only — no PatchPilot write path exists for this policy type"
    >
      Quality update
    </span>
  );
}

type SortKey = "displayName" | "policyType" | "source" | "releaseLabel" | "createdAt";

const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  displayName: "asc",
  policyType: "asc",
  source: "asc",
  releaseLabel: "asc",
  createdAt: "desc",
};

function sortValue(c: QualityUpdateCampaign, key: SortKey): string | number {
  switch (key) {
    case "displayName":
      return c.displayName.toLowerCase();
    case "policyType":
      return c.policyType;
    case "source":
      return c.source;
    case "releaseLabel":
      return (c.releaseLabel ?? "").toLowerCase();
    case "createdAt":
      return new Date(c.createdAt).getTime();
  }
}

export function QualityUpdatesTab() {
  const { activeTenantId, isAllTenants } = useTenant();
  const canWrite = useCan("operations:write");
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<QualityUpdateCampaign[] | null>(null);

  const queryKey = ["quality-update-campaigns", activeTenantId];
  const { data: campaigns = [], isLoading } = useQuery<QualityUpdateCampaign[]>({
    queryKey,
    queryFn: async () => {
      const qs = isAllTenants || !activeTenantId ? "" : `?tenantId=${activeTenantId}`;
      const { campaigns } = await api.get<{ campaigns: QualityUpdateCampaign[] }>(
        `/api/quality-updates/campaigns${qs}`,
      );
      return campaigns;
    },
  });

  const table = useSortableTable<QualityUpdateCampaign, SortKey>({
    rows: campaigns,
    id: (c) => c.id,
    searchText: (c) => `${c.displayName} ${c.releaseLabel ?? ""} ${c.source} ${c.policyType} ${c.createdBy ?? ""}`,
    sortValue,
    defaultSortKey: "createdAt",
    defaultDir: DEFAULT_DIR,
  });

  const deleteOne = useMutation({
    mutationFn: (id: string) => api.del<void>(`/api/quality-updates/campaigns/${id}`),
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
      api.post<{
        deleted: string[];
        notFound: string[];
        failed: { id: string; label: string; reason: string }[];
        skipped: string[];
      }>("/api/quality-updates/campaigns/bulk-delete", { tenantId: activeTenantId, ids }),
    onSuccess: (res) => {
      setPendingDelete(null);
      table.clearSelection();
      void queryClient.invalidateQueries({ queryKey });
      const parts: string[] = [`Deleted ${res.deleted.length}`];
      if (res.skipped.length > 0) parts.push(`${res.skipped.length} skipped (read-only policy type)`);
      if (res.failed.length > 0) parts.push(`${res.failed.length} failed`);
      setMessage({ tone: res.failed.length > 0 ? "error" : "ok", text: parts.join(", ") + "." });
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
      csvRow(["policy", "policy_type", "source", "release", "days_until_forced_reboot", "assigned_to", "created_by", "created_at"]) +
      rows
        .map((c) =>
          csvRow([
            c.displayName,
            c.policyType,
            c.source,
            c.releaseLabel ?? "",
            c.daysUntilForcedReboot != null ? String(c.daysUntilForcedReboot) : "",
            assignmentSummaryText(c.assignments),
            c.createdBy ?? "",
            c.createdAt,
          ]),
        )
        .join("");
    downloadCsv("quality-updates.csv", csv);
  }

  return (
    <div>
      {isAllTenants && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Select a single tenant from the switcher above to view, create, or delete quality-update policies.
        </div>
      )}

      {message && (
        <div
          className={`mb-4 rounded-lg border px-3 py-2 text-xs ${
            message.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"
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
          placeholder="Search name, release, source, type…"
          className="w-72 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={exportCsv}
          disabled={table.sorted.length === 0}
          className="ml-auto rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
        >
          {table.selected.size > 0 ? `Export selected (${table.selected.size})` : "Export CSV"}
        </button>
        <DropdownButton
          label="Create"
          disabled={isAllTenants || !activeTenantId || !canWrite}
          options={[
            {
              key: "expedite-policy",
              label: "Expedite policy",
              onSelect: () => setCreateOpen(true),
            },
          ]}
        />
      </div>

      {table.selected.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-md border border-slate-300 bg-slate-50 px-4 py-2 text-sm">
          <span className="font-medium text-slate-700">
            {table.selected.size} polic{table.selected.size === 1 ? "y" : "ies"} selected
          </span>
          <button
            type="button"
            onClick={() => setPendingDelete(table.selectedRows)}
            disabled={busy || !canWrite}
            className="rounded-md border border-rose-300 px-3 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
          >
            Delete selected
          </button>
          <button
            type="button"
            onClick={table.clearSelection}
            className="text-xs font-medium text-slate-500 hover:text-slate-700"
          >
            Clear selection
          </button>
        </div>
      )}

      {isLoading ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">Loading policies…</p>
        </Card>
      ) : campaigns.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">
            No quality-update policies yet for this tenant. Click "Create" to push an expedited
            release to an Entra group, or "Sync now" to pull in policies created directly in Intune.
          </p>
        </Card>
      ) : table.sorted.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">No policies match "{table.search.trim()}".</p>
        </Card>
      ) : (
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2.5 font-medium">
                  <input
                    type="checkbox"
                    checked={table.allVisibleSelected}
                    onChange={table.toggleSelectAll}
                    className="rounded border-slate-300"
                    aria-label="Select all policies"
                  />
                </th>
                <SortableTh label="Policy" sortKey="displayName" activeKey={table.sortKey} dir={table.sortDir} onSort={table.onSort} />
                <SortableTh label="Type" sortKey="policyType" activeKey={table.sortKey} dir={table.sortDir} onSort={table.onSort} />
                <SortableTh label="Source" sortKey="source" activeKey={table.sortKey} dir={table.sortDir} onSort={table.onSort} />
                <SortableTh label="Release" sortKey="releaseLabel" activeKey={table.sortKey} dir={table.sortDir} onSort={table.onSort} />
                <th className="px-4 py-2.5 font-medium">Reboot grace</th>
                <th className="px-4 py-2.5 font-medium">Assigned to</th>
                <SortableTh label="Created" sortKey="createdAt" activeKey={table.sortKey} dir={table.sortDir} onSort={table.onSort} />
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {table.sorted.map((c) => (
                <tr key={c.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={table.selected.has(c.id)}
                      onChange={() => table.toggleSelect(c.id)}
                      className="rounded border-slate-300"
                      aria-label={`Select ${c.displayName}`}
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-800">{c.displayName}</td>
                  <td className="px-4 py-3">
                    <PolicyTypeBadge policyType={c.policyType} />
                  </td>
                  <td className="px-4 py-3">
                    <SourceBadge source={c.source} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">{c.releaseLabel ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {c.daysUntilForcedReboot != null ? `${c.daysUntilForcedReboot}d` : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    <AssignmentSummary assignments={c.assignments} />
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {c.createdBy ? `${c.createdBy} · ${formatDate(c.createdAt)}` : `Intune · ${formatDate(c.createdAt)}`}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setPendingDelete([c])}
                      disabled={busy || !canWrite || c.policyType !== "expedite"}
                      title={c.policyType !== "expedite" ? "Read-only — no PatchPilot write path for this policy type" : undefined}
                      className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-40"
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

      <NewExpediteQualityUpdateModal open={createOpen} onClose={() => setCreateOpen(false)} tenantId={activeTenantId} />

      {pendingDelete && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setPendingDelete(null)} aria-hidden />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-slate-900">
              {pendingDelete.length === 1
                ? `Delete "${pendingDelete[0]!.displayName}"?`
                : `Delete ${pendingDelete.length} policies?`}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              This removes the quality-update profile from Intune itself, not just PatchPilot's view of
              it.{" "}
              {pendingDelete.length > 1 && pendingDelete.some((c) => c.policyType !== "expedite") && (
                <>Read-only policies in the selection will be skipped, not deleted. </>
              )}
              The change is audited.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
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
