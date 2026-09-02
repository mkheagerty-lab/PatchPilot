/**
 * Licensing detection (Phase 4).
 *
 * Maps Microsoft 365 subscribed-SKU part numbers (as returned by Graph
 * `/subscribedSkus`) to the internal {@link RequiredLicense} capabilities that
 * gate remediation channels. This is the data behind graceful degradation
 * (non-negotiable #4): a channel is only ever offered when its required
 * licenses are actually present in the tenant.
 *
 * Pure and deterministic — runs identically in demo and production. The Graph
 * read that supplies the SKU list lives in the API layer; this module never
 * touches the network.
 */
import type { RequiredLicense } from "./channels.js";

/**
 * Well-known SKU part numbers that grant each capability. A SKU grants a
 * capability if its part number (case-insensitive) appears in the matching set.
 * Kept intentionally broad — a tenant typically holds bundle SKUs (E3/E5/
 * Business Premium) rather than the standalone add-ons.
 */
const LICENSE_SKUS: Record<RequiredLicense, readonly string[]> = {
  // Microsoft Intune device management — present in EMS, M365 E3/E5/F1/F3 and
  // the Business Premium / Intune SMB bundles.
  intune: [
    "INTUNE_A",
    "INTUNE_A_D",
    "INTUNE_A_VL",
    "INTUNE_EDU",
    "Microsoft_Intune_SMB",
    "EMS",
    "EMSPREMIUM",
    "SPE_E3",
    "SPE_E5",
    "SPE_F1",
    "SPE_F5_SECCOMP",
    "M365_F1",
    "SPB",
  ],
  // Microsoft Defender for Business — the Defender tier in Microsoft 365
  // Business Premium and the standalone Defender for Business / Endpoint P1 SKUs.
  "defender-business-premium": [
    "SPB",
    "MDB",
    "DEFENDER_ENDPOINT_P1",
    "Microsoft_Defender_for_Business",
  ],
  // Microsoft Defender for Endpoint Plan 2 — present in M365 E5 and the
  // standalone Defender for Endpoint P2 / E5 Security SKUs.
  "mde-p2": [
    "SPE_E5",
    "WIN_DEF_ATP",
    "DEFENDER_ENDPOINT_P2",
    "MDE_P2",
    "IDENTITY_THREAT_PROTECTION",
  ],
};

/**
 * Maps a tenant's subscribed-SKU part numbers to the {@link RequiredLicense}
 * capabilities it holds. Order follows the {@link RequiredLicense} declaration;
 * the result is de-duplicated.
 */
export function mapSkusToLicenses(skuPartNumbers: readonly string[]): RequiredLicense[] {
  const owned = new Set(skuPartNumbers.map((s) => s.trim().toUpperCase()));
  const result: RequiredLicense[] = [];
  for (const license of Object.keys(LICENSE_SKUS) as RequiredLicense[]) {
    if (LICENSE_SKUS[license].some((sku) => owned.has(sku.toUpperCase()))) {
      result.push(license);
    }
  }
  return result;
}

/**
 * Well-known **service plan IDs** that grant each capability. Unlike SKU part
 * numbers (which need `/subscribedSkus` + `Organization.Read.All`), service
 * plans surface on the `assignedPlans` array of the `/organization` object —
 * which the GDAP-inherited directory role already lets PatchPilot read. This is
 * what makes licensing detection seamless for every GDAP customer with no extra
 * consent.
 *
 * Service plan IDs are **globally stable GUIDs** (Microsoft's "Product names and
 * service plan identifiers for licensing" reference), so the same GUID means the
 * same capability in every tenant. The map is intentionally easy to extend: a
 * tenant's unmapped-but-enabled plan IDs are surfaced by {@link unmappedPlanIds}
 * so the table can be completed from real data.
 */
const LICENSE_SERVICE_PLANS: Record<RequiredLicense, readonly string[]> = {
  // Microsoft Intune Plan 1 — the service plan inside EMS, M365 E3/E5/F1/F3 and
  // Business Premium. (Excludes the free "MDM for Office 365" plan 882e1d05.)
  intune: [
    "c1ec4a95-1f05-45b3-a911-aa3fa01094f5", // INTUNE_A
  ],
  // Microsoft Defender for Business (Business Premium) and Defender for Endpoint
  // Plan 1 — the lower Defender tier PatchPilot treats as Business-Premium-class.
  "defender-business-premium": [
    // Confirmed against a live M365 Business Premium tenant: this is the Defender
    // service plan that surfaces in `/organization` assignedPlans (service name
    // "WindowsDefenderATP"). The earlier bba890d4 GUID was a memory guess and was
    // absent from the real tenant — replaced.
    "bfc1bbd9-981b-4f71-9b82-17c35fd0e2a4", // MDE_SMB — Microsoft Defender for Business
    "292cc034-7b7c-4950-aaf5-943befd3f1d4", // MDE_P1 — Defender for Endpoint Plan 1 (standalone)
  ],
  // Microsoft Defender for Endpoint Plan 2 — present in M365 E5 / E5 Security.
  "mde-p2": [
    "871d91ec-ec1a-452b-a83f-bd76c7d770ef", // WINDEFATP — Defender for Endpoint P2
  ],
};

/** One entry of the `/organization` resource's `assignedPlans` array. */
export interface AssignedPlan {
  servicePlanId?: string;
  service?: string;
  capabilityStatus?: string;
}

/** Lower-cased set of every service plan ID we know how to map. */
const KNOWN_PLAN_IDS = new Set(
  Object.values(LICENSE_SERVICE_PLANS).flatMap((ids) => ids.map((id) => id.toLowerCase())),
);

/** Keep only the enabled plans (treating a missing status as enabled). */
function enabledPlans(plans: readonly AssignedPlan[]): AssignedPlan[] {
  return plans.filter((p) => (p.capabilityStatus ?? "Enabled") === "Enabled");
}

/**
 * Maps a tenant's `assignedPlans` (from `/organization`) to the
 * {@link RequiredLicense} capabilities it holds, by service plan ID. Only
 * enabled plans count; order follows the {@link RequiredLicense} declaration and
 * the result is de-duplicated.
 */
export function mapAssignedPlansToLicenses(plans: readonly AssignedPlan[]): RequiredLicense[] {
  const owned = new Set(
    enabledPlans(plans)
      .map((p) => (p.servicePlanId ?? "").toLowerCase())
      .filter(Boolean),
  );
  const result: RequiredLicense[] = [];
  for (const license of Object.keys(LICENSE_SERVICE_PLANS) as RequiredLicense[]) {
    if (LICENSE_SERVICE_PLANS[license].some((id) => owned.has(id.toLowerCase()))) {
      result.push(license);
    }
  }
  return result;
}

/**
 * The distinct enabled service plan IDs in `assignedPlans` that PatchPilot does
 * NOT yet map to a capability. Surfaced as diagnostics so the well-known table
 * can be completed from a real tenant's data without guessing GUIDs.
 */
export function unmappedPlanIds(plans: readonly AssignedPlan[]): string[] {
  const seen = new Set<string>();
  for (const p of enabledPlans(plans)) {
    const id = (p.servicePlanId ?? "").toLowerCase();
    if (id && !KNOWN_PLAN_IDS.has(id)) seen.add(id);
  }
  return [...seen];
}
