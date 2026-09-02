import { useNavigate } from "react-router-dom";
import { ChartCard } from "../../components/charts/ChartCard";
import { DonutChart, type DonutDatum } from "../../components/charts/DonutChart";
import { SEVERITY_TOKENS } from "../../lib/palette";
import type { DashboardSeverityCount } from "../../lib/api";
import { toSeverity } from "./links";

export function SeverityDonutCard({
  severity,
  isLoading,
}: {
  severity: DashboardSeverityCount[];
  isLoading: boolean;
}) {
  const nav = useNavigate();
  const total = severity.reduce((n, s) => n + s.count, 0);

  const data: DonutDatum[] = severity.map((s) => ({
    key: s.severity,
    label: SEVERITY_TOKENS[s.severity].label,
    value: s.count,
    fill: SEVERITY_TOKENS[s.severity].fill,
    href: toSeverity(s.severity),
  }));

  return (
    <ChartCard
      title="Severity breakdown"
      subtitle="Open findings, exceptions and exclusions applied"
      height={220}
      isLoading={isLoading}
      isEmpty={total === 0}
      emptyNote="No open findings."
    >
      <DonutChart
        data={data}
        centerValue={total}
        centerLabel="Findings"
        onSelect={(d) => d.href && nav(d.href)}
      />
    </ChartCard>
  );
}
