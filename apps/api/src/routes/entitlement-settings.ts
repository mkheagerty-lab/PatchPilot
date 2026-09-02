import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db, tables, demoTenants, type TenantRow } from "@patchpilot/db";
import {
  audit,
  verifyEntitlement,
  loadStoredEntitlement,
  saveStoredEntitlement,
  decodeEntitlementClaims,
  loadStoredTrial,
  startTrial,
  trialExpiresAt,
  isTrialActive,
  FREE_TIER_TENANT_CAP,
  TRIAL_DEVICE_POOL,
  type StoredEntitlement,
  type StoredTrial,
} from "@patchpilot/graph";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import { demoSettings } from "./settings-store.js";

/**
 * Settings -> License: PatchPilot's three tiers — free (default fallback,
 * read-only above FREE_TIER_TENANT_CAP tenants, unlockable via a one-time
 * self-serve 30-day trial), pro (same shape as an active trial but with zero
 * included allowances — populated entirely by a real license key), and
 * unlimited (no numeric cap of any kind). See packages/graph/src/
 * entitlement.ts's `resolveEffectiveEntitlement` for the single source of
 * truth this view mirrors. Structurally mirrors notification-settings.ts — a
 * dedicated route rather than the generic `/api/settings/:key` in data.ts,
 * because the response is a decoded, human-readable view (never the raw
 * token) and needs to join against live tenant/device-usage/trial data the
 * generic route has no concept of.
 *
 * Named "entitlement" throughout the codebase to avoid colliding with the
 * existing, unrelated preflight check id "licensing" (per-tenant M365 SKU
 * ownership) — see entitlement.ts's own header comment. This page may still
 * say "License" since that's the natural customer-facing term.
 */

const SETTINGS_KEY = "entitlement";
const TRIAL_SETTINGS_KEY = "trial";

interface PerTenantDeviceUsage {
  tenantId: string;
  displayName: string;
  used: number;
  limit: number;
}

interface EntitlementView {
  hasEntitlement: boolean;
  instanceId: string | null;
  /** Always a real value now — "free" is the default/fallback tier, not the absence of one. */
  tier: string;
  /** `null` only when the `unlimited` tier applies — never enforced as a numeric cap there. */
  tenantLimit: number | null;
  /** `null` only when the `unlimited` tier applies — never enforced as a numeric cap there. */
  deviceLicensePool: number | null;
  deviceLicenseAllocated: number;
  unlimited: boolean;
  writeEnabled: boolean;
  issuedAt: string | null;
  expiresAt: string | null;
  /** True only for a verified, currently-valid pro/unlimited token. */
  valid: boolean;
  invalidReason: string | null;
  /** Tenants with `consentStatus === "consented"` only — a merely-discovered GDAP relationship never counts against the tenant limit. */
  consentedTenantCount: number;
  perTenantDeviceUsage: PerTenantDeviceUsage[];
  trialStartedAt: string | null;
  trialExpiresAt: string | null;
  trialActive: boolean;
  /** True when the free tier's one-time self-serve trial has never been started. */
  trialAvailable: boolean;
}

async function loadStored(): Promise<StoredEntitlement | null> {
  if (config.DEMO_MODE) {
    return (demoSettings[SETTINGS_KEY] as StoredEntitlement | undefined) ?? null;
  }
  return loadStoredEntitlement();
}

async function saveStored(next: StoredEntitlement): Promise<void> {
  if (config.DEMO_MODE) {
    demoSettings[SETTINGS_KEY] = next as unknown as Record<string, unknown>;
    return;
  }
  await saveStoredEntitlement(next);
}

async function loadTrial(): Promise<StoredTrial | null> {
  if (config.DEMO_MODE) {
    return (demoSettings[TRIAL_SETTINGS_KEY] as StoredTrial | undefined) ?? null;
  }
  return loadStoredTrial();
}

async function loadTenants(): Promise<TenantRow[]> {
  return config.DEMO_MODE ? demoTenants : db.select().from(tables.tenants);
}

/** Distinct devices dispatched-to per tenant, from `entitlement_device_usage`
 *  — never queried in DEMO_MODE, mirroring `live-response-quota.ts`'s own
 *  DEMO_MODE short-circuit (a fresh demo instance has no real quota state). */
async function loadUsageByTenant(): Promise<Map<string, number>> {
  if (config.DEMO_MODE) return new Map();
  const rows = await db
    .select({
      tenantId: tables.entitlementDeviceUsage.tenantId,
      count: sql<number>`count(*)::int`,
    })
    .from(tables.entitlementDeviceUsage)
    .groupBy(tables.entitlementDeviceUsage.tenantId);
  return new Map(rows.map((r) => [r.tenantId, r.count]));
}

async function loadView(): Promise<EntitlementView> {
  const [stored, tenants, trial] = await Promise.all([loadStored(), loadTenants(), loadTrial()]);
  // Discovery (tenant:discover) upserts a row for every GDAP relationship it
  // finds, consented or not — see sync.ts. Only consented tenants count
  // against the tier's tenant limit, matching assertWritesAllowed.
  const consentedTenantCount = tenants.filter((t) => t.consentStatus === "consented").length;
  // The MSP's own allocation of the pool — this is tenants' own state, not
  // the entitlement's, so it's always shown regardless of tier/validity (an
  // admin should be able to see what they've allocated even while sorting
  // out a lapsed license key).
  const deviceLicenseAllocated = tenants.reduce((sum, t) => sum + t.liveResponseDeviceLimit, 0);

  const trialActiveNow = isTrialActive(trial);
  const trialAvailable = trial === null;
  const trialStartedAtIso = trial?.startedAt ?? null;
  const trialExpiresAtIso = trial ? trialExpiresAt(trial).toISOString() : null;

  const verified = stored ? await verifyEntitlement(stored.token) : null;

  if (!verified) {
    // No token, or the stored one failed verification/expired — the exact
    // same free-tier fallback `resolveEffectiveEntitlement` uses, branched on
    // `verified` rather than `stored`, so this view can never disagree with
    // what `assertWritesAllowed`/`assertSyncAllowed` actually enforce.
    const claims = stored ? decodeEntitlementClaims(stored.token) : {};
    const claimsExpiresAt = claims.expiresAt ?? null;
    const invalidReason = !stored
      ? trialActiveNow
        ? null
        : trialAvailable
          ? "No license key has been uploaded — start the free 30-day trial below, or contact PatchPilot Support for a license key."
          : "No license key has been uploaded, and the free trial has ended. Contact PatchPilot Support for a license key."
      : claimsExpiresAt && claimsExpiresAt.getTime() < Date.now()
        ? "This license key has expired. Contact PatchPilot Support to renew it."
        : "This license key's signature could not be verified. Contact PatchPilot Support for a new one.";

    // An active trial behaves like a real token for device-usage display
    // purposes, even though no token exists — the pool is real for its
    // duration (TRIAL_DEVICE_POOL), so the usage-by-tenant breakdown should
    // be too.
    const trialUsageByTenant = trialActiveNow ? await loadUsageByTenant() : new Map<string, number>();
    const trialPerTenantDeviceUsage: PerTenantDeviceUsage[] = trialActiveNow
      ? tenants.map((t) => ({
          tenantId: t.tenantId,
          displayName: t.displayName,
          used: trialUsageByTenant.get(t.tenantId) ?? 0,
          limit: t.liveResponseDeviceLimit,
        }))
      : [];

    return {
      hasEntitlement: Boolean(stored),
      instanceId: claims.instanceId ?? null,
      tier: "free",
      tenantLimit: trialActiveNow ? FREE_TIER_TENANT_CAP : 0,
      deviceLicensePool: trialActiveNow ? TRIAL_DEVICE_POOL : 0,
      deviceLicenseAllocated,
      unlimited: false,
      writeEnabled: trialActiveNow,
      issuedAt: claims.issuedAt?.toISOString() ?? null,
      expiresAt: claimsExpiresAt?.toISOString() ?? null,
      valid: false,
      invalidReason,
      consentedTenantCount,
      perTenantDeviceUsage: trialPerTenantDeviceUsage,
      trialStartedAt: trialStartedAtIso,
      trialExpiresAt: trialExpiresAtIso,
      trialActive: trialActiveNow,
      trialAvailable,
    };
  }

  const unlimited = verified.tier === "unlimited";
  const usageByTenant = await loadUsageByTenant();
  const perTenantDeviceUsage: PerTenantDeviceUsage[] = tenants.map((t) => ({
    tenantId: t.tenantId,
    displayName: t.displayName,
    used: usageByTenant.get(t.tenantId) ?? 0,
    limit: t.liveResponseDeviceLimit,
  }));

  return {
    hasEntitlement: true,
    instanceId: verified.instanceId,
    tier: verified.tier,
    tenantLimit: unlimited ? null : verified.tenantLimit,
    deviceLicensePool: unlimited ? null : verified.deviceLicensePool,
    deviceLicenseAllocated,
    unlimited,
    writeEnabled: verified.writeEnabled,
    issuedAt: verified.issuedAt.toISOString(),
    expiresAt: verified.expiresAt.toISOString(),
    valid: true,
    invalidReason: null,
    consentedTenantCount,
    perTenantDeviceUsage,
    // A verified real token always wins over trial state (see
    // resolveEffectiveEntitlement) — trial is purely a free-tier concept, so
    // it's reported as inactive here even if one was started previously.
    trialStartedAt: trialStartedAtIso,
    trialExpiresAt: trialExpiresAtIso,
    trialActive: false,
    trialAvailable,
  };
}

const putBodySchema = z.object({
  token: z.string().trim().min(1, "token is required"),
});

export async function entitlementSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("settings:read"));

  app.get("/api/settings/entitlement", async () => {
    return loadView();
  });

  app.put(
    "/api/settings/entitlement",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      const parsed = putBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      const { token } = parsed.data;

      const verified = await verifyEntitlement(token);
      if (!verified) {
        return reply.code(400).send({
          error: "This license key is invalid, tampered, or expired. Contact PatchPilot Support for a valid one.",
        });
      }

      const next: StoredEntitlement = {
        token,
        uploadedAt: new Date().toISOString(),
        uploadedBy: req.session.engineer!.upn,
      };
      await saveStored(next);

      await audit({
        engineer: req.session.engineer!.upn,
        endpoint: "/api/settings/entitlement",
        method: "PUT",
        action: "entitlement:update",
        resourceType: "setting",
        resourceId: SETTINGS_KEY,
        resourceLabel: SETTINGS_KEY,
        summary: `Uploaded a new license key (tier: ${verified.tier}, instance: ${verified.instanceId})`,
        outcome: "success",
        payload: {
          instanceId: verified.instanceId,
          tier: verified.tier,
          tenantLimit: verified.tenantLimit,
          deviceLicensePool: verified.deviceLicensePool,
          writeEnabled: verified.writeEnabled,
          expiresAt: verified.expiresAt.toISOString(),
        },
        responseStatus: 200,
      });

      return loadView();
    },
  );

  app.post(
    "/api/settings/entitlement/trial/start",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      const existing = await loadTrial();
      if (existing) {
        return reply.code(400).send({ error: "The free trial has already been started on this instance." });
      }

      const startedBy = req.session.engineer!.upn;
      if (config.DEMO_MODE) {
        demoSettings[TRIAL_SETTINGS_KEY] = {
          startedAt: new Date().toISOString(),
          startedBy,
        } as unknown as Record<string, unknown>;
      } else {
        try {
          await startTrial(startedBy);
        } catch {
          // startTrial() re-checks "already started" itself against the real
          // table, closing the race between this check and the insert.
          return reply.code(400).send({ error: "The free trial has already been started on this instance." });
        }
      }

      await audit({
        engineer: startedBy,
        endpoint: "/api/settings/entitlement/trial/start",
        method: "POST",
        action: "entitlement:trial-start",
        resourceType: "setting",
        resourceId: TRIAL_SETTINGS_KEY,
        resourceLabel: TRIAL_SETTINGS_KEY,
        summary: "Started the free 30-day trial",
        outcome: "success",
        payload: { tenantLimit: FREE_TIER_TENANT_CAP, deviceLicensePool: TRIAL_DEVICE_POOL },
        responseStatus: 200,
      });

      return loadView();
    },
  );
}
