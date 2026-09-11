import { useState } from "react";
import { csvRow } from "@patchpilot/shared";
import { api, type DriverUpdateProfile } from "../../lib/api";
import { useTenant } from "../../lib/tenant";
import { useQuery } from "@tanstack/react-query";
import { Card, DetailRow, SlideOver } from "../../components/ui";
import { downloadCsv } from "../../lib/csv";
import { useSortableTable } from "../../lib/useSortableTable";
import { SortableTh } from "../../components/SortableTh";
import { AssignmentSummary, assignmentSummaryText } from "../../components/AssignmentSummary";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

type SortKey = "displayName" | "approvalType" | "deploymentDeferralInDays" | "createdAt";

const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  displayName: "asc",
  approvalType: "asc",
  deploymentDeferralInDays: "asc",
  createdAt: "desc",
};

function sortValue(p: DriverUpdateProfile, key: SortKey): string | number {
  switch (key) {
    case "displayName":
      return p.displayName.toLowerCase();
    case "approvalType":
      return p.approvalType ?? "";
    case "deploymentDeferralInDays":
      return p.deploymentDeferralInDays ?? -1;
    case "createdAt":
      return new Date(p.createdAt).getTime();
  }
}

export function DriverUpdatesTab() {
  const { activeTenantId, isAllTenants } = useTenant();
  const [detail, setDetail] = useState<DriverUpdateProfile | null>(null);

  const queryKey = ["driver-update-profiles", activeTenantId];
  const { data: profiles = [], isLoading } = useQuery<DriverUpdateProfile[]>({
    queryKey,
    queryFn: async () => {
      const qs = isAllTenants || !activeTenantId ? "" : `?tenantId=${activeTenantId}`;
      const { profiles } = await api.get<{ profiles: DriverUpdateProfile[] }>(`/api/driver-updates${qs}`);
      return profiles;
    },
  });

  const table = useSortableTable<DriverUpdateProfile, SortKey>({
    rows: profiles,
    id: (p) => p.id,
    searchText: (p) => `${p.displayName} ${p.approvalType ?? ""}`,
    sortValue,
    defaultSortKey: "displayName",
    defaultDir: DEFAULT_DIR,
  });

  function exportCsv() {
    const rows = table.selected.size > 0 ? table.selectedRows : table.sorted;
    const csv =
      csvRow(["profile", "approval_type", "deployment_deferral_days", "assigned_to", "created_at"]) +
      rows
        .map((p) =>
          csvRow([
            p.displayName,
            p.approvalType ?? "",
            p.deploymentDeferralInDays != null ? String(p.deploymentDeferralInDays) : "",
            assignmentSummaryText(p.assignments),
            p.createdAt,
          ]),
        )
        .join("");
    downloadCsv("driver-updates.csv", csv);
  }

  return (
    <div>
      {isAllTenants && (
        <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Select a single tenant from the switcher above to view driver update profiles.
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={table.search}
          onChange={(e) => table.setSearch(e.target.value)}
          placeholder="Search profile name, approval type…"
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
      </div>

      {isLoading ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500 dark:text-slate-400">Loading driver update profiles…</p>
        </Card>
      ) : profiles.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No driver update profiles synced yet. Click "Sync now" above to pull them in from Intune.
          </p>
        </Card>
      ) : table.sorted.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500 dark:text-slate-400">No profiles match "{table.search.trim()}".</p>
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
                    aria-label="Select all driver update profiles"
                  />
                </th>
                <SortableTh label="Profile" sortKey="displayName" activeKey={table.sortKey} dir={table.sortDir} onSort={table.onSort} />
                <SortableTh label="Approval type" sortKey="approvalType" activeKey={table.sortKey} dir={table.sortDir} onSort={table.onSort} />
                <SortableTh
                  label="Deployment deferral"
                  sortKey="deploymentDeferralInDays"
                  activeKey={table.sortKey}
                  dir={table.sortDir}
                  onSort={table.onSort}
                />
                <th className="px-4 py-2.5 font-medium">Assigned to</th>
                <SortableTh label="Synced" sortKey="createdAt" activeKey={table.sortKey} dir={table.sortDir} onSort={table.onSort} />
              </tr>
            </thead>
            <tbody>
              {table.sorted.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setDetail(p)}
                  className="cursor-pointer border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={table.selected.has(p.id)}
                      onChange={() => table.toggleSelect(p.id)}
                      className="rounded border-slate-300 dark:border-slate-700"
                      aria-label={`Select ${p.displayName}`}
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-100">{p.displayName}</td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{p.approvalType ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    {p.deploymentDeferralInDays != null ? `${p.deploymentDeferralInDays}d` : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    <AssignmentSummary assignments={p.assignments} />
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{formatDate(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <SlideOver open={!!detail} onClose={() => setDetail(null)} title={detail?.displayName ?? ""}>
        {detail && (
          <dl>
            <DetailRow label="Approval type">{detail.approvalType ?? "—"}</DetailRow>
            <DetailRow label="Deployment deferral">
              {detail.deploymentDeferralInDays != null ? `${detail.deploymentDeferralInDays}d` : "—"}
            </DetailRow>
            <DetailRow label="Assigned to">
              <AssignmentSummary assignments={detail.assignments} />
            </DetailRow>
            <DetailRow label="Synced">{formatDate(detail.createdAt)}</DetailRow>
            <DetailRow label="Intune profile ID">
              <span className="break-all font-mono text-xs">{detail.intuneProfileId}</span>
            </DetailRow>
          </dl>
        )}
      </SlideOver>
    </div>
  );
}
