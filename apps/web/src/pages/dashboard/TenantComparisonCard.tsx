import type { DashboardPerTenant } from "../../lib/api";
import { useTenant } from "../../lib/tenant";
import { Card } from "../../components/ui";
import { relativeTime } from "./TenantHealthStrip";

export function TenantComparisonCard({
  perTenant,
  isLoading,
}: {
  perTenant: DashboardPerTenant[];
  isLoading: boolean;
}) {
  const { setActiveTenantId } = useTenant();

  return (
    <Card className="p-0">
      <div className="border-b border-slate-100 dark:border-slate-800 px-5 py-4">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Tenant comparison</h3>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Sorted by SLA breaches — click a row to focus that tenant</p>
      </div>
      {isLoading ? (
        <div className="p-5 text-sm text-slate-500 dark:text-slate-400">Loading…</div>
      ) : perTenant.length === 0 ? (
        <div className="p-5 text-sm text-slate-500 dark:text-slate-400">No reachable tenants yet.</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
              <th className="px-5 py-3 font-medium">Tenant</th>
              <th className="px-5 py-3 font-medium">Devices</th>
              <th className="px-5 py-3 font-medium">Critical</th>
              <th className="px-5 py-3 font-medium">Breached</th>
              <th className="px-5 py-3 font-medium">Non-compliant</th>
              <th className="px-5 py-3 font-medium">Last synced</th>
            </tr>
          </thead>
          <tbody>
            {perTenant.map((t) => (
              <tr
                key={t.tenantId}
                tabIndex={0}
                role="button"
                onClick={() => setActiveTenantId(t.tenantId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setActiveTenantId(t.tenantId);
                }}
                className="cursor-pointer border-b border-slate-100 dark:border-slate-800 outline-none last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 focus-visible:bg-slate-50 dark:focus-visible:bg-slate-800"
              >
                <td className="px-5 py-3">
                  <div className="font-medium text-slate-800 dark:text-slate-100">{t.displayName}</div>
                  {t.readOnly && <div className="text-xs text-slate-400 dark:text-slate-500">Read-only</div>}
                </td>
                <td className="px-5 py-3 text-slate-700 dark:text-slate-200">{t.devices}</td>
                <td className="px-5 py-3 text-slate-700 dark:text-slate-200">{t.critical}</td>
                <td className="px-5 py-3 text-slate-700 dark:text-slate-200">{t.slaBreached}</td>
                <td className="px-5 py-3 text-slate-700 dark:text-slate-200">{t.noncompliantDevices}</td>
                <td className="px-5 py-3 text-slate-500 dark:text-slate-400">
                  {t.lastSyncedAt ? relativeTime(t.lastSyncedAt) : "Never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
