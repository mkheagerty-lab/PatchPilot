import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Tenant } from "./api";

/**
 * Sentinel activeTenantId meaning "aggregate across every tenant". Data routes
 * return all rows when no tenantId query param is sent, so pages translate this
 * sentinel into an unfiltered request. It's a value that can never be a real
 * Entra tenant id, so it round-trips through the switcher safely.
 */
export const ALL_TENANTS = "__all__";

interface TenantCtx {
  tenants: Tenant[];
  /** Only the tenants PatchPilot can actually reach — what the switcher offers. */
  reachableTenants: Tenant[];
  activeTenantId: string | null;
  setActiveTenantId: (id: string) => void;
  /** The selected tenant, or null when "All Tenants" (or nothing) is active. */
  activeTenant: Tenant | null;
  /** True when the aggregate "All Tenants" view is selected. */
  isAllTenants: boolean;
  isLoading: boolean;
}

const Ctx = createContext<TenantCtx | null>(null);

export function TenantProvider({ children }: { children: ReactNode }) {
  const [activeTenantId, setActiveTenantId] = useState<string | null>(null);

  const { data: tenants = [], isLoading } = useQuery({
    queryKey: ["tenants"],
    queryFn: () => api.get<Tenant[]>("/api/tenants"),
  });

  // Only reachable tenants are switchable — a consent-needed/unreachable tenant
  // has no working token path, so selecting it would just surface empty data.
  // (Distinct from consentStatus: a "consented" GDAP relationship can still be
  // unreachable.) Sorted alphabetically for a stable dropdown order.
  const reachableTenants = useMemo(
    () =>
      [...tenants]
        .filter((t) => t.reachability === "reachable")
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [tenants],
  );

  // activeTenantId is the Entra tenant id (tenantId), NOT the uuid PK — it's the
  // key every data route filters on (devices/vulns/jobs all carry tenant_id).
  // Default to the alphabetically-first reachable tenant, falling back to the
  // aggregate "All Tenants" view when nothing is reachable yet.
  const defaultActive = reachableTenants[0]?.tenantId ?? ALL_TENANTS;
  const resolvedActive = activeTenantId ?? defaultActive;
  const isAllTenants = resolvedActive === ALL_TENANTS;

  const activeTenant = isAllTenants
    ? null
    : tenants.find((t) => t.tenantId === resolvedActive) ?? null;

  return (
    <Ctx.Provider
      value={{
        tenants,
        reachableTenants,
        activeTenantId: resolvedActive,
        setActiveTenantId,
        activeTenant,
        isAllTenants,
        isLoading,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useTenant(): TenantCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTenant must be used within TenantProvider");
  return ctx;
}
