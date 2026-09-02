import { useNavigate } from "react-router-dom";
import { Card } from "../../components/ui";
import { DonutChart, type DonutDatum } from "../../components/charts/DonutChart";
import { StackedBarChart } from "../../components/charts/StackedBarChart";
import { COMPLIANCE_TOKENS } from "../../lib/palette";
import type { DashboardFleet, DeviceCompliance } from "../../lib/api";
import { toCompliance, toDeviceOs, toDevices } from "./links";

const OS_TOP_N = 6;
const OS_SERIES = [
  { key: "compliant", label: COMPLIANCE_TOKENS.compliant.label, fill: COMPLIANCE_TOKENS.compliant.fill },
  { key: "noncompliant", label: COMPLIANCE_TOKENS.noncompliant.label, fill: COMPLIANCE_TOKENS.noncompliant.fill },
  { key: "unknown", label: COMPLIANCE_TOKENS.unknown.label, fill: COMPLIANCE_TOKENS.unknown.fill },
];

function topOsRows(fleet: DashboardFleet) {
  const sorted = [...fleet.os].sort((a, b) => b.total - a.total);
  const head = sorted.slice(0, OS_TOP_N);
  const rest = sorted.slice(OS_TOP_N);
  if (rest.length === 0) return head;
  const other = rest.reduce(
    (acc, r) => ({
      os: "Other",
      total: acc.total + r.total,
      compliant: acc.compliant + r.compliant,
      noncompliant: acc.noncompliant + r.noncompliant,
      unknown: acc.unknown + r.unknown,
    }),
    { os: "Other", total: 0, compliant: 0, noncompliant: 0, unknown: 0 },
  );
  return [...head, other];
}

export function FleetBreakdownCard({
  fleet,
  isLoading,
}: {
  fleet: DashboardFleet;
  isLoading: boolean;
}) {
  const nav = useNavigate();
  const totalDevices = fleet.compliance.reduce((n, c) => n + c.count, 0);

  const complianceData: DonutDatum[] = fleet.compliance.map((c) => ({
    key: c.compliance,
    label: COMPLIANCE_TOKENS[c.compliance].label,
    value: c.count,
    fill: COMPLIANCE_TOKENS[c.compliance].fill,
  }));

  return (
    <Card className="p-0">
      <div className="border-b border-slate-100 px-5 py-4">
        <h3 className="text-sm font-semibold text-slate-900">Fleet breakdown</h3>
        <p className="mt-0.5 text-xs text-slate-500">Compliance and OS mix across the fleet</p>
      </div>
      <div className="px-5 py-4">
        {isLoading ? (
          <div className="flex h-[220px] items-center justify-center text-xs text-slate-400">Loading…</div>
        ) : totalDevices === 0 ? (
          <div className="flex h-[220px] items-center justify-center text-xs text-slate-400">No devices yet.</div>
        ) : (
          <div className="space-y-4">
            <div style={{ height: 140 }}>
              <DonutChart
                data={complianceData}
                centerValue={totalDevices}
                centerLabel="Devices"
                onSelect={(d) => nav(toCompliance(d.key as DeviceCompliance))}
              />
            </div>
            <div style={{ height: 140 }}>
              <StackedBarChart
                data={topOsRows(fleet) as unknown as Record<string, unknown>[]}
                xKey="os"
                series={OS_SERIES}
                onSelect={(d) => {
                  const os = d.os as string;
                  // "Other" is a rolled-up bucket (top N + rest), not a real OS
                  // value any device carries — filtering by it would always be empty.
                  nav(os === "Other" ? toDevices() : toDeviceOs(os));
                }}
              />
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
