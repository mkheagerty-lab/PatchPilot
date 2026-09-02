import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChartCard } from "../../components/charts/ChartCard";
import { TrendAreaChart, type TrendAreaSeries } from "../../components/charts/TrendAreaChart";
import { COMPLIANCE_TOKENS, SEVERITY_TOKENS, SLA_TOKENS } from "../../lib/palette";
import type { DashboardTrendCoverage, DashboardTrendPoint } from "../../lib/api";
import { toCompliance, toSeverity, toSla } from "./links";

type Lens = "severity" | "sla" | "compliance";

const LENS_LABELS: Record<Lens, string> = {
  severity: "Severity",
  sla: "SLA",
  compliance: "Compliance",
};

function seriesFor(lens: Lens): TrendAreaSeries[] {
  if (lens === "severity") {
    return (["critical", "high", "medium", "low"] as const).map((k) => ({
      key: k,
      label: SEVERITY_TOKENS[k].label,
      color: SEVERITY_TOKENS[k].fill,
    }));
  }
  if (lens === "sla") {
    return [
      { key: "slaBreached", label: SLA_TOKENS.breached.label, color: SLA_TOKENS.breached.fill },
      { key: "slaDueSoon", label: SLA_TOKENS["due-soon"].label, color: SLA_TOKENS["due-soon"].fill },
      { key: "slaOk", label: SLA_TOKENS.ok.label, color: SLA_TOKENS.ok.fill },
    ];
  }
  return [
    { key: "devicesCompliant", label: COMPLIANCE_TOKENS.compliant.label, color: COMPLIANCE_TOKENS.compliant.fill },
    {
      key: "devicesNoncompliant",
      label: COMPLIANCE_TOKENS.noncompliant.label,
      color: COMPLIANCE_TOKENS.noncompliant.fill,
    },
    { key: "devicesUnknown", label: COMPLIANCE_TOKENS.unknown.label, color: COMPLIANCE_TOKENS.unknown.fill },
  ];
}

function hrefFor(lens: Lens, seriesKey: string): string {
  if (lens === "severity") return toSeverity(seriesKey as "critical" | "high" | "medium" | "low");
  if (lens === "sla") {
    if (seriesKey === "slaBreached") return toSla("breached");
    if (seriesKey === "slaDueSoon") return toSla("due-soon");
    return toSla("ok");
  }
  const state = seriesKey === "devicesCompliant" ? "compliant" : seriesKey === "devicesNoncompliant" ? "noncompliant" : "unknown";
  return toCompliance(state);
}

export function PostureTrendCard({
  trend,
  trendCoverage,
  isLoading,
}: {
  trend: DashboardTrendPoint[];
  trendCoverage: DashboardTrendCoverage;
  isLoading: boolean;
}) {
  const [lens, setLens] = useState<Lens>("severity");
  const nav = useNavigate();
  const series = seriesFor(lens);

  return (
    <ChartCard
      title="Posture trend"
      subtitle={`Last ${trendCoverage.requestedDays} days`}
      height={280}
      isLoading={isLoading}
      isEmpty={trend.length === 0}
      emptyNote="No history captured yet."
      notice={
        !trendCoverage.complete && trend.length > 0
          ? `Collecting history — ${trendCoverage.capturedDays} of ${trendCoverage.requestedDays} days captured.`
          : undefined
      }
      actions={
        <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 p-0.5">
          {(Object.keys(LENS_LABELS) as Lens[]).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLens(l)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                lens === l ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              {LENS_LABELS[l]}
            </button>
          ))}
        </div>
      }
      legend={
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
          {series.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => nav(hrefFor(lens, s.key))}
                className="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-slate-50"
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="text-slate-600">{s.label}</span>
              </button>
            </li>
          ))}
        </ul>
      }
    >
      <TrendAreaChart
        data={trend as unknown as Record<string, unknown>[]}
        xKey="day"
        series={series}
        sparse={trend.length < 3}
      />
    </ChartCard>
  );
}
