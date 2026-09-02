/**
 * Per-tenant readiness assessment.
 *
 * Before PatchPilot exposes any remediation control for a tenant it must know
 * the tenant is actually wired up: admin consent granted, the right licenses
 * present (graceful degradation, non-negotiable #4), and whether write actions
 * have been opted in (read-only-first, non-negotiable #6). For customer tenants
 * the delegated GDAP relationship is established by admin consent, so a
 * consented tenant passes the GDAP check and a non-consented one stays pending.
 *
 * Pure and deterministic — runs identically in demo and production.
 */
import {
  CHANNEL_SPECS,
  type RemediationChannel,
  type RequiredLicense,
} from "./channels.js";
import { REQUIRED_GDAP_ROLES } from "./scopes.js";

export type CheckStatus = "pass" | "warn" | "fail" | "pending";

export interface ReadinessCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

/** Minimal tenant shape needed to assess readiness (mirrors the tenants row). */
export interface ReadinessTenant {
  tenantId: string;
  displayName: string;
  consentStatus: "consented" | "pending" | "expired";
  readOnly: boolean;
  licenses: string[];
  isMspTenant: boolean;
}

export interface ReadinessReport {
  tenantId: string;
  displayName: string;
  /** Can PatchPilot operate read-only against this tenant? */
  ready: boolean;
  /** Can PatchPilot perform write/remediation actions? */
  canRemediate: boolean;
  /** Channels whose required licenses are all present. */
  enabledChannels: RemediationChannel[];
  checks: ReadinessCheck[];
}

const ALL_CHANNELS = Object.keys(CHANNEL_SPECS) as RemediationChannel[];

/** Channels whose required licenses are fully satisfied by the tenant. */
export function enabledChannels(licenses: string[]): RemediationChannel[] {
  const owned = new Set(licenses as RequiredLicense[]);
  return ALL_CHANNELS.filter((c) =>
    CHANNEL_SPECS[c].requiredLicenses.every((l) => owned.has(l)),
  );
}

/**
 * `writeGateAllowed` is PatchPilot's vendor-controlled write gate (entitlement
 * + instance-wide tenant cap), computed once by the caller via
 * `@patchpilot/graph`'s `assertWritesAllowed` — this module is pure/DB-free,
 * so it can't compute it itself (mirrors `preflight()`'s `writeGate` field).
 * Optional, defaulting to `true`, so existing callers/tests that only care
 * about the tenant's own posture are unaffected.
 */
export function evaluateReadiness(
  tenant: ReadinessTenant,
  writeGateAllowed = true,
): ReadinessReport {
  const enabled = enabledChannels(tenant.licenses);
  const checks: ReadinessCheck[] = [];

  // 1. Admin consent — gates everything, including reads.
  if (tenant.consentStatus === "consented") {
    checks.push({
      id: "consent",
      label: "Admin consent",
      status: "pass",
      detail: "Admin consent granted.",
    });
  } else if (tenant.consentStatus === "pending") {
    checks.push({
      id: "consent",
      label: "Admin consent",
      status: "fail",
      detail: "Admin consent not yet granted — onboarding incomplete.",
    });
  } else {
    checks.push({
      id: "consent",
      label: "Admin consent",
      status: "fail",
      detail: "Admin consent expired — re-consent required.",
    });
  }

  // 2. Licensing — drives which remediation channels can ever be offered.
  if (enabled.length === ALL_CHANNELS.length) {
    checks.push({
      id: "licensing",
      label: "Licensing",
      status: "pass",
      detail: `All ${ALL_CHANNELS.length} remediation channels licensed.`,
    });
  } else if (enabled.length > 0) {
    checks.push({
      id: "licensing",
      label: "Licensing",
      status: "warn",
      detail: `${enabled.length} of ${ALL_CHANNELS.length} channels licensed — others will stay hidden.`,
    });
  } else {
    checks.push({
      id: "licensing",
      label: "Licensing",
      status: "fail",
      detail: "No licensed remediation channels — read-only only.",
    });
  }

  // 3. Write posture — read-only is the safe default; remediation is opt-in.
  checks.push(
    tenant.readOnly
      ? {
          id: "write-actions",
          label: "Write actions",
          status: "warn",
          detail:
            "Tenant is read-only — remediation is disabled until write actions are opted in.",
        }
      : {
          id: "write-actions",
          label: "Write actions",
          status: "pass",
          detail: "Write actions enabled for this tenant.",
        },
  );

  // 3b. Entitlement — PatchPilot's vendor-controlled write gate, layered above
  // the tenant's own write-actions toggle (#3). Rendered only when the tenant
  // isn't already blocked by its own readOnly toggle — see preflight.ts's
  // matching "entitlement" check for why: with readOnly true this would
  // otherwise always fail too, duplicating check #3's own message under a
  // misleading "entitlement" id.
  if (!tenant.readOnly) {
    checks.push(
      writeGateAllowed
        ? {
            id: "entitlement",
            label: "License key",
            status: "pass",
            detail: "This instance's license key allows write actions.",
          }
        : {
            id: "entitlement",
            label: "License key",
            status: "fail",
            detail: "This instance's license key does not currently allow write actions.",
          },
    );
  }

  // 4. GDAP roles — the home tenant needs no delegation; for customer tenants
  //    admin consent establishes the delegated GDAP relationship, so a consented
  //    tenant passes and an unconsented one stays pending until consent is granted.
  if (tenant.isMspTenant) {
    checks.push({
      id: "gdap",
      label: "GDAP roles",
      status: "pass",
      detail: "Home (MSP) tenant — GDAP delegation not required.",
    });
  } else if (tenant.consentStatus === "consented") {
    checks.push({
      id: "gdap",
      label: "GDAP roles",
      status: "pass",
      detail: `GDAP delegation active via admin consent (${REQUIRED_GDAP_ROLES.join(", ")}).`,
    });
  } else {
    checks.push({
      id: "gdap",
      label: "GDAP roles",
      status: "pending",
      detail: `GDAP delegation pending — grant admin consent to establish it (requires: ${REQUIRED_GDAP_ROLES.join(", ")}).`,
    });
  }

  const ready = tenant.consentStatus === "consented";
  const canRemediate = ready && !tenant.readOnly && writeGateAllowed && enabled.length > 0;

  return {
    tenantId: tenant.tenantId,
    displayName: tenant.displayName,
    ready,
    canRemediate,
    enabledChannels: enabled,
    checks,
  };
}
