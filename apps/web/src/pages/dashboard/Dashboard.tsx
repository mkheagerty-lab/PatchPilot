import { useState } from "react";
import { useTenant } from "../../lib/tenant";
import { PageHeader } from "../../components/ui";
import { SummarizeButton } from "../../components/ai/SummarizeButton";
import { useDashboardData } from "./useDashboardData";
import { VulnDrawer, DeviceDrawer } from "./drawers";
import { TenantHealthStrip } from "./TenantHealthStrip";
import { ExclusionNoticeBanners } from "./ExclusionNoticeBanners";
import { KpiRow } from "./KpiRow";
import { PostureTrendCard } from "./PostureTrendCard";
import { SeverityDonutCard } from "./SeverityDonutCard";
import { SlaComplianceCard } from "./SlaComplianceCard";
import { RemediationThroughputCard } from "./RemediationThroughputCard";
import { TimeToRemediateCard } from "./TimeToRemediateCard";
import { CveRemediationTrendCard } from "./CveRemediationTrendCard";
import { CoverageCard } from "./CoverageCard";
import { TopSoftwareCard } from "./TopSoftwareCard";
import { FleetBreakdownCard } from "./FleetBreakdownCard";
import { TenantComparisonCard } from "./TenantComparisonCard";
import { UrgentVulnsCard } from "./UrgentVulnsCard";
import { DevicesNeedingAttentionCard } from "./DevicesNeedingAttentionCard";
import { ActivityFeedCard } from "./ActivityFeedCard";

const EMPTY_SCOPE = {
  tenants: 0,
  reachable: 0,
  stale: 0,
  neverSynced: 0,
  readOnly: 0,
  oldestSyncAt: null,
  newestSyncAt: null,
};

const EMPTY_TILES = {
  critical: 0,
  high: 0,
  breached: 0,
  dueSoon: 0,
  openFindings: 0,
  devices: 0,
  noncompliantDevices: 0,
  compliantDevices: 0,
  unmonitoredDevices: 0,
  misconfigurations: 0,
  activeExceptions: 0,
  excludedDevices: 0,
  verifiedExploitOpen: 0,
  devicesBehindFeatureUpdate: 0,
};

const EMPTY_TREND_COVERAGE = { requestedDays: 30, capturedDays: 0, firstDay: null, complete: false };

const EMPTY_REMEDIATION = { days: [], succeeded: 0, failed: 0, successRate: null, failedLast24h: 0 };

const EMPTY_TIME_TO_REMEDIATE = {
  windowDays: 30,
  count: 0,
  avgHours: null,
  p90Hours: null,
  bySeverity: {
    critical: { count: 0, avgHours: null, p90Hours: null },
    high: { count: 0, avgHours: null, p90Hours: null },
    medium: { count: 0, avgHours: null, p90Hours: null },
    low: { count: 0, avgHours: null, p90Hours: null },
  },
};

const EMPTY_FLEET = { compliance: [], os: [] };

const WINDOW_OPTIONS: { label: string; days: number }[] = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All time", days: 365 },
];

export function Dashboard() {
  const { activeTenant, activeTenantId, isAllTenants } = useTenant();
  const [windowDays, setWindowDays] = useState(30);
  const { summary, isSummaryLoading, coverage, isCoverageLoading, activity, isActivityLoading } =
    useDashboardData(windowDays);

  const [openVulnId, setOpenVulnId] = useState<string | null>(null);
  const [openDeviceId, setOpenDeviceId] = useState<string | null>(null);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Dashboard"
          subtitle={
            isAllTenants
              ? "Patch posture across all reachable tenants"
              : activeTenant
                ? `Patch posture for ${activeTenant.displayName}`
                : "Select a tenant to view posture"
          }
          actions={
            <div className="flex items-center gap-2">
              <SummarizeButton
                page="dashboard"
                tenantId={isAllTenants ? null : activeTenantId}
                windowDays={windowDays}
              />
              <button
                type="button"
                onClick={() => window.print()}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 print:hidden"
              >
                Export PDF
              </button>
            </div>
          }
        />
        <div className="mt-1 inline-flex shrink-0 rounded-lg border border-slate-200 bg-white p-1 print:hidden">
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              type="button"
              onClick={() => setWindowDays(opt.days)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                windowDays === opt.days
                  ? "bg-[var(--pp-primary)] text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <TenantHealthStrip
        scope={summary?.scope ?? EMPTY_SCOPE}
        isAllTenants={isAllTenants}
        activeTenant={activeTenant}
      />

      <ExclusionNoticeBanners
        tiles={summary?.tiles ?? EMPTY_TILES}
        opensslExceptionTenantIds={summary?.opensslExceptionTenantIds ?? []}
        isAllTenants={isAllTenants}
        tenantCount={summary?.scope.tenants ?? 0}
      />

      <div className="space-y-6">
        <KpiRow
          tiles={summary?.tiles ?? EMPTY_TILES}
          scope={summary?.scope ?? EMPTY_SCOPE}
          isAllTenants={isAllTenants}
          trend={summary?.trend ?? []}
          trendCoverage={summary?.trendCoverage ?? EMPTY_TREND_COVERAGE}
        />

        <PostureTrendCard
          trend={summary?.trend ?? []}
          trendCoverage={summary?.trendCoverage ?? EMPTY_TREND_COVERAGE}
          isLoading={isSummaryLoading}
        />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <SeverityDonutCard severity={summary?.severity ?? []} isLoading={isSummaryLoading} />
          <SlaComplianceCard slaBuckets={summary?.slaBuckets ?? []} isLoading={isSummaryLoading} />
          <RemediationThroughputCard
            remediation={summary?.remediation ?? EMPTY_REMEDIATION}
            isLoading={isSummaryLoading}
          />
          <TimeToRemediateCard
            timeToRemediate={summary?.timeToRemediate ?? EMPTY_TIME_TO_REMEDIATE}
            isLoading={isSummaryLoading}
          />
          <CveRemediationTrendCard cveTrend={summary?.cveTrend ?? []} isLoading={isSummaryLoading} />
          <CoverageCard coverage={coverage} isLoading={isCoverageLoading} />
          <TopSoftwareCard topSoftware={summary?.topSoftware ?? []} isLoading={isSummaryLoading} />
          {isAllTenants ? (
            <TenantComparisonCard perTenant={summary?.perTenant ?? []} isLoading={isSummaryLoading} />
          ) : (
            <FleetBreakdownCard fleet={summary?.fleet ?? EMPTY_FLEET} isLoading={isSummaryLoading} />
          )}
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <UrgentVulnsCard
            rows={summary?.urgentVulns ?? []}
            isLoading={isSummaryLoading}
            isAllTenants={isAllTenants}
            onSelect={setOpenVulnId}
          />
          <DevicesNeedingAttentionCard
            rows={summary?.attentionDevices ?? []}
            isLoading={isSummaryLoading}
            isAllTenants={isAllTenants}
            onSelect={setOpenDeviceId}
          />
        </div>

        <ActivityFeedCard activity={activity} isLoading={isActivityLoading} />
      </div>

      <VulnDrawer vulnId={openVulnId} onClose={() => setOpenVulnId(null)} />
      <DeviceDrawer deviceId={openDeviceId} onClose={() => setOpenDeviceId(null)} />
    </div>
  );
}
