// The Dashboard's only three requests. This is also the single place the
// `ALL_TENANTS -> omit tenantId` translation happens for these three
// endpoints — every card below takes plain props and owns zero fetching.
import { useQuery } from "@tanstack/react-query";
import { api, type AuditListResponse, type CatalogCoverage, type DashboardSummary } from "../../lib/api";
import { useTenant, ALL_TENANTS } from "../../lib/tenant";

const ACTIVITY_FEED_LIMIT = 8;

export function useDashboardData(windowDays: number) {
  const { activeTenantId, isAllTenants } = useTenant();

  const summaryQuery = useQuery({
    queryKey: ["dashboard-summary", activeTenantId, windowDays],
    queryFn: () => {
      const params = new URLSearchParams({ windowDays: String(windowDays) });
      if (!isAllTenants && activeTenantId) params.set("tenantId", activeTenantId);
      return api.get<DashboardSummary>(`/api/dashboard/summary?${params.toString()}`);
    },
    enabled: !!activeTenantId,
  });

  const coverageQuery = useQuery({
    queryKey: ["catalog-coverage", activeTenantId],
    queryFn: () =>
      api.get<CatalogCoverage>(
        isAllTenants ? "/api/catalog/coverage" : `/api/catalog/coverage?tenantId=${activeTenantId}`,
      ),
    enabled: !!activeTenantId,
  });

  const activityQuery = useQuery({
    queryKey: ["dashboard-activity", activeTenantId],
    queryFn: () => {
      const params = new URLSearchParams({ category: "action", limit: String(ACTIVITY_FEED_LIMIT) });
      if (!isAllTenants && activeTenantId && activeTenantId !== ALL_TENANTS) {
        params.set("tenantId", activeTenantId);
      }
      return api.get<AuditListResponse>(`/api/audit?${params.toString()}`);
    },
    enabled: !!activeTenantId,
  });

  return {
    summary: summaryQuery.data,
    isSummaryLoading: summaryQuery.isLoading,
    coverage: coverageQuery.data,
    isCoverageLoading: coverageQuery.isLoading,
    activity: activityQuery.data?.rows ?? [],
    isActivityLoading: activityQuery.isLoading,
  };
}
