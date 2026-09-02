import { KpiCard } from "../../components/ui";
import { Sparkline } from "../../components/charts/Sparkline";
import { SEVERITY_TOKENS, SLA_TOKENS, COMPLIANCE_TOKENS } from "../../lib/palette";
import type { DashboardScope, DashboardTiles, DashboardTrendCoverage, DashboardTrendPoint } from "../../lib/api";
import { toCompliance, toDevices, toMisconfigurations, toSeverity, toSla } from "./links";

const MIN_SPARKLINE_DAYS = 3;

export function KpiRow({
  tiles,
  scope,
  isAllTenants,
  trend,
  trendCoverage,
}: {
  tiles: DashboardTiles;
  scope: DashboardScope;
  isAllTenants: boolean;
  trend: DashboardTrendPoint[];
  trendCoverage: DashboardTrendCoverage;
}) {
  const showSparklines = trendCoverage.capturedDays >= MIN_SPARKLINE_DAYS;

  const sparkline = (key: keyof DashboardTrendPoint, color: string) =>
    showSparklines ? (
      <Sparkline data={trend as unknown as Record<string, unknown>[]} dataKey={key as string} color={color} />
    ) : undefined;

  return (
    <div
      className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${
        isAllTenants ? "lg:grid-cols-7" : "lg:grid-cols-6"
      }`}
    >
      {isAllTenants && (
        <KpiCard
          label="Tenants"
          value={scope.reachable}
          hint={`${scope.tenants} total · ${scope.stale + scope.neverSynced} need attention`}
          to="/settings/tenants"
        />
      )}
      <KpiCard
        label="Critical vulnerabilities"
        value={tiles.critical}
        tone={tiles.critical > 0 ? "critical" : "good"}
        hint="Severity = critical"
        to={toSeverity("critical")}
        sparkline={sparkline("critical", SEVERITY_TOKENS.critical.stroke)}
      />
      <KpiCard
        label="SLA breached"
        value={tiles.breached}
        tone={tiles.breached > 0 ? "critical" : "good"}
        hint={
          tiles.verifiedExploitOpen > 0
            ? `Past remediation deadline · ${tiles.verifiedExploitOpen} verified exploit`
            : "Past remediation deadline"
        }
        to={toSla("breached")}
        sparkline={sparkline("slaBreached", SLA_TOKENS.breached.stroke)}
      />
      <KpiCard
        label="Due soon"
        value={tiles.dueSoon}
        tone={tiles.dueSoon > 0 ? "warn" : "good"}
        hint="Approaching SLA deadline"
        to={toSla("due-soon")}
        sparkline={sparkline("slaDueSoon", SLA_TOKENS["due-soon"].stroke)}
      />
      <KpiCard
        label="Non-compliant devices"
        value={tiles.noncompliantDevices}
        tone={tiles.noncompliantDevices > 0 ? "warn" : "good"}
        hint={
          tiles.unmonitoredDevices > 0
            ? `${tiles.devices} devices · ${tiles.unmonitoredDevices} unmonitored`
            : `${tiles.devices} devices total`
        }
        to={toCompliance("noncompliant")}
        sparkline={sparkline("devicesNoncompliant", COMPLIANCE_TOKENS.noncompliant.stroke)}
      />
      <KpiCard
        label="Misconfigurations"
        value={tiles.misconfigurations}
        tone={tiles.misconfigurations > 0 ? "warn" : "good"}
        hint="Security-control & account findings"
        to={toMisconfigurations()}
      />
      <KpiCard
        label="Behind on feature updates"
        value={tiles.devicesBehindFeatureUpdate}
        tone={tiles.devicesBehindFeatureUpdate > 0 ? "warn" : "good"}
        hint="Windows client devices below the feature-update target"
        to={toDevices()}
      />
    </div>
  );
}
