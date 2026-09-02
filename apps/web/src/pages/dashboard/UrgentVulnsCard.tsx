import { Link } from "react-router-dom";
import type { DashboardUrgentVuln } from "../../lib/api";
import { useTenant } from "../../lib/tenant";
import { Card, SeverityChip, SlaChip } from "../../components/ui";
import { VerifiedExploitChip } from "../../components/cve";
import { toSla } from "./links";

export function UrgentVulnsCard({
  rows,
  isLoading,
  isAllTenants,
  onSelect,
}: {
  rows: DashboardUrgentVuln[];
  isLoading: boolean;
  isAllTenants: boolean;
  onSelect: (id: string) => void;
}) {
  const { tenants } = useTenant();
  const tenantNames = new Map(tenants.map((t) => [t.tenantId, t.displayName]));

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Most urgent vulnerabilities</h2>
        <Link
          to={toSla("breached")}
          className="text-xs font-medium text-slate-500 transition-colors hover:text-slate-800"
        >
          View all →
        </Link>
      </div>
      <Card className="p-0">
        {isLoading ? (
          <div className="p-5 text-sm text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-5 text-sm text-slate-500">No vulnerabilities for this tenant.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Software</th>
                {isAllTenants && <th className="px-5 py-3 font-medium">Customer tenant</th>}
                <th className="px-5 py-3 font-medium">Severity</th>
                <th className="px-5 py-3 font-medium">Devices</th>
                <th className="px-5 py-3 font-medium">SLA</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr
                  key={v.id}
                  tabIndex={0}
                  role="button"
                  onClick={() => onSelect(v.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSelect(v.id);
                  }}
                  className="cursor-pointer border-b border-slate-100 outline-none last:border-0 hover:bg-slate-50 focus-visible:bg-slate-50"
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-800">{v.displayName}</span>
                      {v.exploitVerified && <VerifiedExploitChip />}
                    </div>
                    <div className="text-xs text-slate-400">{v.cveId}</div>
                  </td>
                  {isAllTenants && (
                    <td className="px-5 py-3 text-slate-600">
                      {tenantNames.get(v.tenantId) ?? v.tenantId}
                    </td>
                  )}
                  <td className="px-5 py-3">
                    <SeverityChip severity={v.severity} />
                  </td>
                  <td className="px-5 py-3 text-slate-700">{v.affectedDeviceCount}</td>
                  <td className="px-5 py-3">
                    <SlaChip sla={v.sla} />
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
