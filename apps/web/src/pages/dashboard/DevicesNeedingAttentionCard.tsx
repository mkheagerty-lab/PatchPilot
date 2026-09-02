import { Link } from "react-router-dom";
import type { DashboardAttentionDevice } from "../../lib/api";
import { useTenant } from "../../lib/tenant";
import { Card, ComplianceChip } from "../../components/ui";
import { toCompliance } from "./links";

export function DevicesNeedingAttentionCard({
  rows,
  isLoading,
  isAllTenants,
  onSelect,
}: {
  rows: DashboardAttentionDevice[];
  isLoading: boolean;
  isAllTenants: boolean;
  onSelect: (id: string) => void;
}) {
  const { tenants } = useTenant();
  const tenantNames = new Map(tenants.map((t) => [t.tenantId, t.displayName]));

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Devices needing attention</h2>
        <Link
          to={toCompliance("noncompliant")}
          className="text-xs font-medium text-slate-500 transition-colors hover:text-slate-800"
        >
          View all →
        </Link>
      </div>
      <Card className="p-0">
        {isLoading ? (
          <div className="p-5 text-sm text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-5 text-sm text-slate-500">All devices are within SLA.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Hostname</th>
                {isAllTenants && <th className="px-5 py-3 font-medium">Customer tenant</th>}
                <th className="px-5 py-3 font-medium">OS</th>
                <th className="px-5 py-3 font-medium">Vulns</th>
                <th className="px-5 py-3 font-medium">Compliance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr
                  key={d.id}
                  tabIndex={0}
                  role="button"
                  onClick={() => onSelect(d.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSelect(d.id);
                  }}
                  className="cursor-pointer border-b border-slate-100 outline-none last:border-0 hover:bg-slate-50 focus-visible:bg-slate-50"
                >
                  <td className="px-5 py-3 font-medium text-slate-800">{d.hostname}</td>
                  {isAllTenants && (
                    <td className="px-5 py-3 text-slate-600">
                      {tenantNames.get(d.tenantId) ?? d.tenantId}
                    </td>
                  )}
                  <td className="px-5 py-3 text-slate-600">{d.os}</td>
                  <td className="px-5 py-3 text-slate-700">{d.vulnerabilityCount}</td>
                  <td className="px-5 py-3">
                    <ComplianceChip compliance={d.compliance} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}
