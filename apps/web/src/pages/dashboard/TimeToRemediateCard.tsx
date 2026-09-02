import { SEVERITY_ORDER } from "@patchpilot/shared";
import { ChartCard } from "../../components/charts/ChartCard";
import { SeverityChip } from "../../components/ui";
import type { DashboardTimeToRemediate } from "../../lib/api";
import { toRemediationHistory } from "./links";

const CAVEAT =
  "Measures detected -> remediated intervals recorded since this metric shipped, so it starts sparse. " +
  "Findings Defender re-catalogued under a different software name (an internal data correction, not a " +
  "genuine fix) are excluded — see Remediation History for the attributed detail behind this number.";

function formatDuration(hours: number): string {
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function TimeToRemediateCard({
  timeToRemediate,
  isLoading,
}: {
  timeToRemediate: DashboardTimeToRemediate;
  isLoading: boolean;
}) {
  const { count, avgHours, p90Hours, bySeverity } = timeToRemediate;

  return (
    <ChartCard
      title="Time to remediate"
      subtitle={count === 0 ? "No remediations recorded in this window" : `${count} remediations in this window`}
      to={toRemediationHistory()}
      actions={
        <span className="cursor-help text-xs text-slate-400" title={CAVEAT}>
          ⓘ
        </span>
      }
      height={220}
      isLoading={isLoading}
      isEmpty={count === 0}
      emptyNote="No remediations recorded yet in this window — this metric starts accruing from today."
    >
      <div className="flex h-full flex-col justify-between">
        <div className="flex items-end gap-8">
          <div>
            <div className="text-xs font-medium text-slate-500">Average</div>
            <div className="mt-1 text-3xl font-semibold text-slate-900">
              {avgHours === null ? "—" : formatDuration(avgHours)}
            </div>
          </div>
          <div>
            <div className="text-xs font-medium text-slate-500">p90</div>
            <div className="mt-1 text-xl font-semibold text-slate-700">
              {p90Hours === null ? "—" : formatDuration(p90Hours)}
            </div>
          </div>
        </div>
        <div className="space-y-1.5">
          {SEVERITY_ORDER.map((s) => {
            const bucket = bySeverity[s];
            return (
              <div key={s} className="flex items-center justify-between gap-3 text-sm">
                <SeverityChip severity={s} />
                <span className="text-slate-600">
                  {bucket.count === 0
                    ? "—"
                    : `${formatDuration(bucket.avgHours ?? 0)} avg · ${bucket.count} remediated`}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </ChartCard>
  );
}
