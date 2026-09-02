/**
 * PatchPilot's vendor-controlled write gate — pure evaluation logic, shared
 * between the browser-safe `preflight()` report and the Node-side combinator
 * in `@patchpilot/graph`'s `write-gate.ts` (which loads + verifies the actual
 * entitlement token and calls this).
 *
 * Distinct from — and layered above — the tenant's own `readOnly` toggle
 * (customer opting IN to writes). This is the vendor opting the *instance*
 * in to writes at all, plus an instance-wide cap on how many tenants it may
 * write to. See `packages/graph/src/entitlement.ts` for why this is named
 * "entitlement" rather than "licensing" (an unrelated, pre-existing concept).
 */

export interface WriteGateEntitlement {
  writeEnabled: boolean;
  tenantLimit: number;
  /** True when no valid token is on file, or the stored one failed verification/expired, AND no trial is currently active. */
  expired: boolean;
  /** True when the free tier's one-time self-serve trial has never been started — only meaningful when `expired` is true. */
  trialAvailable: boolean;
}

export interface WriteGateInput {
  tenantReadOnly: boolean;
  entitlement: WriteGateEntitlement;
  /**
   * Tenants with `reachability === "reachable"` only — i.e. tenants
   * PatchPilot's own app has actually been granted admin consent in and can
   * call Graph for. A merely-discovered GDAP relationship (found by tenant
   * discovery, reflected in `consentStatus`, but never consented into
   * PatchPilot itself) never counts against the tenant limit. tenantLimit is
   * a write-only cap on top of that, never a read/discovery cap.
   */
  consentedTenantCount: number;
}

export interface WriteGateResult {
  allowed: boolean;
  reason: string | null;
}

export function evaluateWriteGate(input: WriteGateInput): WriteGateResult {
  if (input.tenantReadOnly) {
    return {
      allowed: false,
      reason: "Tenant is read-only — opt in to write actions before remediating.",
    };
  }
  if (input.entitlement.expired || !input.entitlement.writeEnabled) {
    return {
      allowed: false,
      reason: input.entitlement.trialAvailable
        ? "This instance is on the free tier — start the 30-day trial under Settings → License to enable write actions, or contact PatchPilot Support for a license key."
        : "This instance has no valid license key to perform write actions, and its free trial has ended. Contact PatchPilot Support to obtain or renew one.",
    };
  }
  if (input.consentedTenantCount > input.entitlement.tenantLimit) {
    return {
      allowed: false,
      reason: `This instance has ${input.consentedTenantCount} consented tenant(s), exceeding its licensed limit of ${input.entitlement.tenantLimit}. Contact PatchPilot Support to increase your tenant limit.`,
    };
  }
  return { allowed: true, reason: null };
}

// ---- free-tier sync (read) cap ----
//
// Discovery/GDAP-consent is never capped — a free instance can find and
// consent as many tenants as it likes. What the free tier caps is pulling
// actual DATA into one of those tenants ("Sync data"): capped to the same
// FREE_TIER_TENANT_CAP tenants a trial would unlock writes for. Pro/unlimited
// tokens have no such cap — `tenantLimit` there governs writes, not sync.

export interface SyncGateInput {
  /** True once this tenant has ever completed a data sync — permanently exempt from the cap even if it's later lowered. Mirrors "already-counted stays free" (see entitlement_device_usage). */
  tenantAlreadySynced: boolean;
  /** True only for the free tier (no valid pro/unlimited token). A real token never caps sync. */
  onFreeTier: boolean;
  freeTierTenantCap: number;
  /** Count of DISTINCT tenants that have ever synced, instance-wide — not just connected tenants. */
  syncedTenantCount: number;
}

export interface SyncGateResult {
  allowed: boolean;
  reason: string | null;
}

export function evaluateSyncGate(input: SyncGateInput): SyncGateResult {
  if (!input.onFreeTier || input.tenantAlreadySynced) {
    return { allowed: true, reason: null };
  }
  if (input.syncedTenantCount >= input.freeTierTenantCap) {
    return {
      allowed: false,
      reason: `The free tier can sync data for up to ${input.freeTierTenantCap} tenant(s). Start the 30-day trial or contact PatchPilot Support for a license key to sync more.`,
    };
  }
  return { allowed: true, reason: null };
}
