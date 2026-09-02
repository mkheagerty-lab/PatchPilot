import { graphGet, GraphError } from "@patchpilot/graph";
import {
  mapSkusToLicenses,
  mapAssignedPlansToLicenses,
  unmappedPlanIds,
  type AssignedPlan,
  type RequiredLicense,
} from "@patchpilot/shared";

/**
 * Live tenant reachability + licensing probe (Phase 4 / Phase A).
 *
 * Two questions, deliberately kept separate:
 *
 *  1. **Can PatchPilot reach this tenant at all?** Answered by a cheap directory
 *     read (`/organization`) that the GDAP-inherited role grants. This is the
 *     signal that gates ingestion and drives the Reachability column.
 *
 *  2. **Which licenses does it hold?** Answered from the **`assignedPlans`** array
 *     on that *same* `/organization` object — the GDAP role already lets us read
 *     it, so licensing detection is seamless for every customer with no extra
 *     consent. We map enabled service plan IDs to capabilities. `/subscribedSkus`
 *     is kept only as a fallback for the rare tenant that withholds assignedPlans
 *     but grants the (narrower) `Organization.Read.All`.
 *
 * The earlier design fused the two: it derived reachability from the SKU read
 * alone, so a 403 on `/subscribedSkus` (a single missing permission) flipped an
 * otherwise-healthy tenant to "consent-needed". That collapsed ~140 working
 * tenants into "0 reachable, 139 need access". Separating the probes honours the
 * graceful-licensing-degradation invariant (#4): a missing licensing permission
 * degrades the Licenses column to "unknown" without poisoning tenant status.
 *
 * For customer tenants both reads flow through the GDAP app-only path inside
 * `graphGet`; every call is audited. This never throws — both the HTTP result
 * and a token-acquisition (AADSTS) failure are mapped to a classification.
 *
 * Callers must only invoke this outside DEMO_MODE.
 */
interface SubscribedSku {
  skuPartNumber: string;
  capabilityStatus?: string;
}

interface OrgRow {
  id: string;
  displayName: string;
  /** Per-service entitlements; the seamless, GDAP-readable licensing signal. */
  assignedPlans?: AssignedPlan[];
}

/** Whether PatchPilot can actually call Graph for a tenant. Mirrors the DB enum. */
export type TenantReachability = "reachable" | "consent-needed" | "throttled" | "unreachable";

/** Whether the licensing read succeeded, independent of reachability. */
export type LicenseStatus = "detected" | "unavailable";

export interface TenantProbe {
  /** Reachability, decided by the `/organization` read — NOT by licensing. */
  status: TenantReachability;
  /** Licenses detected via `/subscribedSkus`; empty when unavailable. */
  licenses: RequiredLicense[];
  /** Whether licensing could be read. `unavailable` ≠ "no licenses". */
  licenseStatus: LicenseStatus;
  /** The reachability call's HTTP status, when it reached Microsoft. */
  httpStatus?: number;
  /** Short human-readable reason for the reachability verdict. */
  detail?: string;
  /** Short reason licensing couldn't be read, when `licenseStatus` is unavailable. */
  licenseDetail?: string;
}

/** Map a Graph HTTP status to a reachability classification. */
function classifyHttp(status: number): TenantReachability {
  if (status === 401 || status === 403) return "consent-needed";
  if (status === 429) return "throttled";
  return "unreachable";
}

/**
 * Probe a tenant's reachability and licensing in a single `/organization` read.
 *
 * Reachability: 200 → reachable; 401/403 → consent-needed; 429 → throttled;
 * anything else (incl. a token-mint AADSTS failure, which throws before any HTTP
 * call) → unreachable/consent-needed.
 *
 * Licensing is derived from the same response's `assignedPlans` (service plan IDs
 * the GDAP role already lets us read). If a tenant's 200 response withholds
 * `assignedPlans`, we fall back to a best-effort `/subscribedSkus` read. Either
 * way, a licensing miss NEVER changes the reachability verdict — it only sets
 * `licenseStatus: "unavailable"`.
 */
export async function probeTenant(
  engineer: string,
  homeTenantId: string,
  tenantId: string,
): Promise<TenantProbe> {
  // --- 1. Reachability + licensing: one directory read the GDAP role grants. ---
  let org: OrgRow | undefined;
  let orgStatus: number;
  try {
    const res = await graphGet<{ value: OrgRow[] }>({
      engineer,
      homeTenantId,
      tenantId,
      host: "graph",
      path: "/organization?$select=id,displayName,assignedPlans",
    });
    orgStatus = res.status;
    if (!res.ok) {
      return {
        status: classifyHttp(res.status),
        licenses: [],
        licenseStatus: "unavailable",
        httpStatus: res.status,
        detail: `Graph /organization returned HTTP ${res.status}`,
        licenseDetail: "tenant not reachable",
      };
    }
    org = res.data?.value[0];
  } catch (err) {
    // acquireTokenForTenant / acquireTokenForCustomerTenant throw before any HTTP
    // call when a token can't be minted for this tenant (e.g. the engineer's cached
    // refresh token has expired, or GDAP access to the customer was revoked). A
    // GraphError carries a status; a raw MSAL/AADSTS error does not, so treat an
    // un-mintable token as consent-needed.
    const httpStatus = err instanceof GraphError ? err.status : undefined;
    return {
      status: httpStatus ? classifyHttp(httpStatus) : "consent-needed",
      licenses: [],
      licenseStatus: "unavailable",
      httpStatus,
      detail: err instanceof Error ? err.message : "token acquisition failed",
      licenseDetail: "tenant not reachable",
    };
  }

  // --- 2a. Licensing from assignedPlans — the seamless, GDAP-readable path. ---
  // A *non-empty* assignedPlans array is the authoritative signal. An empty array
  // (observed on some home/partner tenants whose org object omits plan detail) is
  // NOT "this tenant has no licenses" — it's "no licensing signal here", so we let
  // it fall through to the /subscribedSkus best-effort read below rather than
  // reporting a misleading empty result.
  const plans = org?.assignedPlans;
  if (Array.isArray(plans) && plans.length > 0) {
    const licenses = mapAssignedPlansToLicenses(plans);
    const unmapped = unmappedPlanIds(plans);
    return {
      status: "reachable",
      licenses,
      licenseStatus: "detected",
      httpStatus: orgStatus,
      // Surface unmapped-but-enabled plan IDs so the well-known table can be
      // extended from real data, without ever blocking detection.
      licenseDetail:
        unmapped.length > 0
          ? `${licenses.length} capability(ies) from assignedPlans; ${unmapped.length} unmapped service plan(s): ${unmapped.slice(0, 12).join(", ")}`
          : undefined,
    };
  }

  // --- 2b. Fallback: assignedPlans withheld — try /subscribedSkus best-effort. ---
  try {
    const lic = await graphGet<{ value: SubscribedSku[] }>({
      engineer,
      homeTenantId,
      tenantId,
      host: "graph",
      path: "/subscribedSkus?$select=skuPartNumber,capabilityStatus",
    });
    if (!lic.ok || !lic.data) {
      return {
        status: "reachable",
        licenses: [],
        licenseStatus: "unavailable",
        httpStatus: orgStatus,
        licenseDetail: `assignedPlans unavailable and /subscribedSkus returned HTTP ${lic.status} (needs Organization.Read.All)`,
      };
    }
    // Only count SKUs that are actually enabled in the tenant.
    const active = lic.data.value
      .filter((s) => (s.capabilityStatus ?? "Enabled") === "Enabled")
      .map((s) => s.skuPartNumber);
    return {
      status: "reachable",
      licenses: mapSkusToLicenses(active),
      licenseStatus: "detected",
      httpStatus: orgStatus,
    };
  } catch (err) {
    // Reachable, but the licensing read itself couldn't even mint/run. Degrade
    // licensing to unknown; the tenant stays reachable.
    return {
      status: "reachable",
      licenses: [],
      licenseStatus: "unavailable",
      httpStatus: orgStatus,
      licenseDetail: err instanceof Error ? err.message : "licensing read failed",
    };
  }
}
