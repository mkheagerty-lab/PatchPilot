import { eq, isNotNull } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import {
  evaluateWriteGate,
  evaluateSyncGate,
  type WriteGateResult,
  type SyncGateResult,
} from "@patchpilot/shared";
import { env } from "./env.js";
import { resolveEffectiveEntitlement, FREE_TIER_TENANT_CAP } from "./entitlement.js";

/**
 * The single choke point for "can this tenant write right now" — combines the
 * customer's own `tenant.readOnly` toggle with PatchPilot's entitlement
 * (instance-wide write-enable + tenant-count cap). Replaces the 11 duplicated
 * inline `if (tenant.readOnly)` checks scattered across the API routes; every
 * one of them, plus the worker's fire-time/execution-time re-checks, should
 * call this instead of reading `tenant.readOnly` directly.
 *
 * DEMO_MODE short-circuits to fully-entitled-and-unlimited so every existing
 * demo flow keeps working unmodified — demo mode never touches an entitlement
 * token or a real tenant count.
 */
export async function assertWritesAllowed(tenant: {
  tenantId: string;
  readOnly: boolean;
}): Promise<WriteGateResult> {
  if (env.DEMO_MODE) return { allowed: true, reason: null };

  const effective = await resolveEffectiveEntitlement();
  const entitlement = {
    writeEnabled: effective.writeEnabled,
    tenantLimit: effective.tenantLimit,
    expired: !effective.writeEnabled,
    trialAvailable: effective.trialAvailable,
  };

  // Discovering a GDAP relationship never counts against the tenant limit —
  // only tenants actually consented into PatchPilot do. Without this filter,
  // a 5-tenant free/trial cap would be blown out by a single discovery run
  // that finds every GDAP relationship the MSP happens to hold.
  const consentedTenantCount = (
    await db
      .select({ tenantId: tables.tenants.tenantId })
      .from(tables.tenants)
      .where(eq(tables.tenants.consentStatus, "consented"))
  ).length;

  return evaluateWriteGate({ tenantReadOnly: tenant.readOnly, entitlement, consentedTenantCount });
}

/**
 * The choke point for "can this tenant's data be synced right now" — distinct
 * from `assertWritesAllowed`: sync is a READ into PatchPilot's own database,
 * not a write back to the customer's tenant, so it's gated purely by the free
 * tier's tenant cap, never by `tenant.readOnly` or the trial/write-enabled
 * state. A pro/unlimited token lifts the cap entirely; DEMO_MODE short-circuits
 * like every other gate here.
 *
 * "Already synced stays free" — `tenant.lastSyncedAt` is the existing column
 * stamped by the sync route on success (see apps/api/src/routes/sync.ts), so
 * a tenant that synced before the cap existed (or before it was lowered)
 * stays permanently exempt, matching the `entitlement_device_usage` pattern.
 */
export async function assertSyncAllowed(tenant: {
  tenantId: string;
  lastSyncedAt: Date | null;
}): Promise<SyncGateResult> {
  if (env.DEMO_MODE) return { allowed: true, reason: null };

  const effective = await resolveEffectiveEntitlement();
  const onFreeTier = effective.tier === "free";

  if (!onFreeTier || tenant.lastSyncedAt !== null) {
    return { allowed: true, reason: null };
  }

  const syncedTenantCount = (
    await db
      .select({ tenantId: tables.tenants.tenantId })
      .from(tables.tenants)
      .where(isNotNull(tables.tenants.lastSyncedAt))
  ).length;

  return evaluateSyncGate({
    tenantAlreadySynced: false,
    onFreeTier,
    freeTierTenantCap: FREE_TIER_TENANT_CAP,
    syncedTenantCount,
  });
}
