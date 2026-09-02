import { csvRow } from "@patchpilot/shared";
import { api, type UpdateRingProfile } from "../../lib/api";
import { useTenant } from "../../lib/tenant";
import { useQuery } from "@tanstack/react-query";
import { Card } from "../../components/ui";
import { downloadCsv } from "../../lib/csv";
import { useSortableTable } from "../../lib/useSortableTable";
import { SortableTh } from "../../components/SortableTh";
import { AssignmentSummary, assignmentSummaryText } from "../../components/AssignmentSummary";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

type SortKey = "displayName" | "qualityUpdatesDeferralPeriodInDays" | "featureUpdatesDeferralPeriodInDays" | "automaticUpdateMode" | "createdAt";

const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  displayName: "asc",
  qualityUpdatesDeferralPeriodInDays: "asc",
  featureUpdatesDeferralPeriodInDays: "asc",
  automaticUpdateMode: "asc",
  createdAt: "desc",
};

function sortValue(p: UpdateRingProfile, key: SortKey): string | number {
  switch (key) {
    case "displayName":
      return p.displayName.toLowerCase();
    case "qualityUpdatesDeferralPeriodInDays":
      return p.qualityUpdatesDeferralPeriodInDays ?? -1;
    case "featureUpdatesDeferralPeriodInDays":
      return p.featureUpdatesDeferralPeriodInDays ?? -1;
    case "automaticUpdateMode":
      return p.automaticUpdateMode ?? "";
    case "createdAt":
      return new Date(p.createdAt).getTime();
  }
}

export function UpdateRingsTab() {
  const { activeTenantId, isAllTenants } = useTenant();

  const queryKey = ["update-ring-profiles", activeTenantId];
  const { data: profiles = [], isLoading } = useQuery<UpdateRingProfile[]>({
    queryKey,
    queryFn: async () => {
      const qs = isAllTenants || !activeTenantId ? "" : `?tenantId=${activeTenantId}`;
      const { profiles } = await api.get<{ profiles: UpdateRingProfile[] }>(`/api/update-rings${qs}`);
      return profiles;
    },
  });

  const table = useSortableTable<UpdateRingProfile, SortKey>({
    rows: profiles,
    id: (p) => p.id,
    searchText: (p) => `${p.displayName} ${p.automaticUpdateMode ?? ""}`,
    sortValue,
    defaultSortKey: "displayName",
    defaultDir: DEFAULT_DIR,
  });

  function exportCsv() {
    const rows = table.selected.size > 0 ? table.selectedRows : table.sorted;
    const csv =
      csvRow([
        "ring",
        "quality_deferral_days",
        "feature_deferral_days",
        "allow_windows_11_upgrade",
        "automatic_update_mode",
        "business_ready_updates_only",
        "assigned_to",
        "created_at",
      ]) +
      rows
        .map((p) =>
          csvRow([
            p.displayName,
            p.qualityUpdatesDeferralPeriodInDays != null ? String(p.qualityUpdatesDeferralPeriodInDays) : "",
            p.featureUpdatesDeferralPeriodInDays != null ? String(p.featureUpdatesDeferralPeriodInDays) : "",
            p.allowWindows11Upgrade != null ? String(p.allowWindows11Upgrade) : "",
            p.automaticUpdateMode ?? "",
            p.businessReadyUpdatesOnly ?? "",
            assignmentSummaryText(p.assignments),
            p.createdAt,
          ]),
        )
        .join("");
    downloadCsv("update-rings.csv", csv);
  }

  return (
    <div>
      {isAllTenants && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Select a single tenant from the switcher above to view update ring profiles.
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={table.search}
          onChange={(e) => table.setSearch(e.target.value)}
          placeholder="Search ring name, update mode…"
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
      </div>

      {isLoading ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">Loading update rings…</p>
        </Card>
      ) : profiles.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">
            No update ring profiles synced yet. Click "Sync now" above to pull Windows Update for
            Business configurations from Intune.
          </p>
        </Card>
      ) : table.sorted.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">No rings match "{table.search.trim()}".</p>
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
                    aria-label="Select all update rings"
                  />
                </th>
                <SortableTh label="Ring" sortKey="displayName" activeKey={table.sortKey} dir={table.sortDir} onSort={table.onSort} />
                <SortableTh
                  label="Quality deferral"
                  sortKey="qualityUpdatesDeferralPeriodInDays"
                  activeKey={table.sortKey}
                  dir={table.sortDir}
                  onSort={table.onSort}
                />
                <SortableTh
                  label="Feature deferral"
                  sortKey="featureUpdatesDeferralPeriodInDays"
                  activeKey={table.sortKey}
                  dir={table.sortDir}
                  onSort={table.onSort}
                />
                <SortableTh
                  label="Update mode"
                  sortKey="automaticUpdateMode"
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
                <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={table.selected.has(p.id)}
                      onChange={() => table.toggleSelect(p.id)}
                      className="rounded border-slate-300"
                      aria-label={`Select ${p.displayName}`}
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-800">{p.displayName}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {p.qualityUpdatesDeferralPeriodInDays != null ? `${p.qualityUpdatesDeferralPeriodInDays}d` : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {p.featureUpdatesDeferralPeriodInDays != null ? `${p.featureUpdatesDeferralPeriodInDays}d` : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{p.automaticUpdateMode ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">
                    <AssignmentSummary assignments={p.assignments} />
                  </td>
                  <td className="px-4 py-3 text-slate-500">{formatDate(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
