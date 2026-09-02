import { ChartCard } from "../../components/charts/ChartCard";
import { GroupedBarChart } from "../../components/charts/GroupedBarChart";
import { COVERAGE_TOKENS, JOB_STATUS_TOKENS } from "../../lib/palette";
import type { DashboardCveTrendDay } from "../../lib/api";
import { toRemediationHistory } from "./links";

const SERIES = [
  { key: "detected", label: "Detected", fill: COVERAGE_TOKENS.covered.fill },
  { key: "remediated", label: "Remediated", fill: JOB_STATUS_TOKENS.succeeded.fill },
];

export function CveRemediationTrendCard({
  cveTrend,
  isLoading,
}: {
  cveTrend: DashboardCveTrendDay[];
  isLoading: boolean;
}) {
  const detected = cveTrend.reduce((n, d) => n + d.detected, 0);
  const remediated = cveTrend.reduce((n, d) => n + d.remediated, 0);
  const total = detected + remediated;

  return (
    <ChartCard
      title="CVEs detected vs remediated"
      subtitle={`Last 30 days · ${detected} detected · ${remediated} remediated`}
      to={toRemediationHistory()}
      height={240}
      isLoading={isLoading}
      isEmpty={total === 0}
      emptyNote="No CVE activity recorded in the last 30 days."
    >
      <GroupedBarChart data={cveTrend as unknown as Record<string, unknown>[]} xKey="day" series={SERIES} />
    </ChartCard>
  );
}
