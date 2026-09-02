import { importJWK, jwtVerify, decodeJwt } from "jose";
import { eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { ENTITLEMENT_PUBLIC_KEY_JWK } from "./entitlement-public-key.js";

/**
 * PatchPilot's vendor-controlled write gate. Distinct from — and layered
 * above — the customer's own `tenants.readOnly` toggle: readOnly is the
 * customer opting a tenant IN to writes; an entitlement is the vendor
 * allowing this *instance* to write at all. See packages/graph/src/
 * write-gate.ts for where the two combine into one decision.
 *
 * Named "entitlement" (not "licensing") to avoid colliding with the
 * existing, unrelated preflight check id "licensing" — per-tenant M365 SKU
 * ownership (packages/shared/src/licensing.ts).
 */

const SETTINGS_KEY = "entitlement";

export interface EntitlementPayload {
  instanceId: string;
  tier: string;
  tenantLimit: number;
  // Total Live Response device pool for the WHOLE instance, not a per-tenant
  // number — the vendor sets the size of the pool, the MSP's own admin
  // decides how it's split across tenants (tenants.liveResponseDeviceLimit,
  // enforced to sum to at most this value — see apps/api/src/routes/data.ts
  // and packages/graph/src/live-response-quota.ts).
  deviceLicensePool: number;
  writeEnabled: boolean;
  issuedAt: Date;
  expiresAt: Date;
}

export interface StoredEntitlement {
  token: string;
  uploadedAt: string;
  uploadedBy: string;
}

// The compiled-in public key never changes at runtime — resolve it once
// rather than re-importing it on every verification call.
const publicKeyPromise = importJWK(ENTITLEMENT_PUBLIC_KEY_JWK, "EdDSA");

export async function loadStoredEntitlement(): Promise<StoredEntitlement | null> {
  const [row] = await db.select().from(tables.settings).where(eq(tables.settings.key, SETTINGS_KEY));
  return (row?.value as StoredEntitlement | undefined) ?? null;
}

export async function saveStoredEntitlement(next: StoredEntitlement): Promise<void> {
  const value = next as unknown as Record<string, unknown>;
  await db
    .insert(tables.settings)
    .values({ key: SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: tables.settings.key, set: { value, updatedAt: new Date() } });
}

/**
 * Verifies a raw entitlement token string. Returns null on ANY failure — bad
 * signature, malformed, wrong algorithm, or expired (jose's own `exp` check) —
 * deliberately collapsing every failure mode into "not entitled" rather than
 * distinguishing them here, so a tampered token can never be mistaken for a
 * valid-but-limited one. Callers that need to tell "expired" apart from
 * "never uploaded" for a UI message should decode the stored token's claims
 * themselves for display, not rely on this function's null.
 */
export async function verifyEntitlement(token: string): Promise<EntitlementPayload | null> {
  try {
    const publicKey = await publicKeyPromise;
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ["EdDSA"] });
    if (
      typeof payload.instanceId !== "string" ||
      typeof payload.tier !== "string" ||
      typeof payload.tenantLimit !== "number" ||
      typeof payload.deviceLicensePool !== "number" ||
      typeof payload.writeEnabled !== "boolean" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    return {
      instanceId: payload.instanceId,
      tier: payload.tier,
      tenantLimit: payload.tenantLimit,
      deviceLicensePool: payload.deviceLicensePool,
      writeEnabled: payload.writeEnabled,
      issuedAt: new Date(payload.iat * 1000),
      expiresAt: new Date(payload.exp * 1000),
    };
  } catch {
    return null;
  }
}

// ---- tiers: free (default/fallback), pro, unlimited ----
//
// A real vendor token (verifyEntitlement above) only ever represents "pro" or
// "unlimited" — paid, vendor-administered tiers. "free" is the default
// fallback with NO token at all: a fresh, unlicensed instance is on it
// automatically, and it's what an instance falls back to if a token expires.
// This is deliberately MORE restrictive than the pre-entitlement behavior (a
// fresh instance could write the moment `readOnly` was toggled off) — that
// tightening is the whole point of this feature. DEMO_MODE never reaches any
// of this: see write-gate.ts's/live-response-quota.ts's short-circuits.

const TRIAL_SETTINGS_KEY = "trial";
const TRIAL_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/** Free tier's self-serve trial and read/sync cap both apply to the SAME up-to-5
 *  tenants — a trial doesn't let more tenants in, it lets the already-active
 *  ones write. See `packages/graph/src/write-gate.ts`'s `assertSyncAllowed`. */
export const FREE_TIER_TENANT_CAP = 5;
/** Device pool granted for the duration of an active trial. */
export const TRIAL_DEVICE_POOL = 30;

export interface StoredTrial {
  startedAt: string;
  startedBy: string;
}

export async function loadStoredTrial(): Promise<StoredTrial | null> {
  const [row] = await db.select().from(tables.settings).where(eq(tables.settings.key, TRIAL_SETTINGS_KEY));
  return (row?.value as StoredTrial | undefined) ?? null;
}

async function saveStoredTrial(trial: StoredTrial): Promise<void> {
  const value = trial as unknown as Record<string, unknown>;
  await db
    .insert(tables.settings)
    .values({ key: TRIAL_SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: tables.settings.key, set: { value, updatedAt: new Date() } });
}

/**
 * Starts the instance's one-time, self-serve 30-day trial — no vendor token,
 * no vendor contact, just a timestamp. Throws if a trial has already been
 * started, even an expired one: one trial per instance, matching "after
 * expiry, write and devices license are disabled" — there's no re-up short
 * of a real license key.
 */
export async function startTrial(startedBy: string): Promise<StoredTrial> {
  const existing = await loadStoredTrial();
  if (existing) {
    throw new Error("trial_already_started");
  }
  const trial: StoredTrial = { startedAt: new Date().toISOString(), startedBy };
  await saveStoredTrial(trial);
  return trial;
}

export function trialExpiresAt(trial: StoredTrial): Date {
  return new Date(new Date(trial.startedAt).getTime() + TRIAL_DURATION_MS);
}

export function isTrialActive(trial: StoredTrial | null): boolean {
  return trial !== null && trialExpiresAt(trial).getTime() > Date.now();
}

export interface EffectiveEntitlement {
  /** "free" (no valid token), or whatever a verified token's own `tier` claim says. */
  tier: string;
  writeEnabled: boolean;
  /** `Number.POSITIVE_INFINITY` for the unlimited tier — never enforced as a numeric cap. */
  tenantLimit: number;
  /** `Number.POSITIVE_INFINITY` for the unlimited tier — never enforced as a numeric cap. */
  deviceLicensePool: number;
  unlimited: boolean;
  trialActive: boolean;
  /** True when the self-serve trial has never been started on this instance. */
  trialAvailable: boolean;
}

/**
 * The single source of truth for "what can this instance do right now" —
 * folds a real vendor token (pro/unlimited) and the free tier's self-serve
 * trial into one shape every enforcement point reads from
 * (`write-gate.ts`'s `assertWritesAllowed`/`assertSyncAllowed`,
 * `live-response-quota.ts`) so none of them can drift out of sync with each
 * other or with Settings > License's own display.
 *
 * A verified pro/unlimited token always wins over trial state — trial is
 * purely a free-tier concept, and a real token's own numeric claims (however
 * they're set) are authoritative once one exists.
 */
export async function resolveEffectiveEntitlement(): Promise<EffectiveEntitlement> {
  const stored = await loadStoredEntitlement();
  const verified = stored ? await verifyEntitlement(stored.token) : null;
  const trial = await loadStoredTrial();
  const trialActive = isTrialActive(trial);
  const trialAvailable = trial === null;

  if (verified) {
    const unlimited = verified.tier === "unlimited";
    return {
      tier: verified.tier,
      writeEnabled: verified.writeEnabled,
      tenantLimit: unlimited ? Number.POSITIVE_INFINITY : verified.tenantLimit,
      deviceLicensePool: unlimited ? Number.POSITIVE_INFINITY : verified.deviceLicensePool,
      unlimited,
      trialActive: false,
      trialAvailable,
    };
  }

  return {
    tier: "free",
    writeEnabled: trialActive,
    tenantLimit: trialActive ? FREE_TIER_TENANT_CAP : 0,
    deviceLicensePool: trialActive ? TRIAL_DEVICE_POOL : 0,
    unlimited: false,
    trialActive,
    trialAvailable,
  };
}

/**
 * Unverified peek at a token's claims — used only by Settings > License's
 * display when `verifyEntitlement` has already returned null, so the UI can
 * still show what an expired/tampered token claimed (e.g. "expired 3 days
 * ago") rather than a bare "invalid". Never used for access decisions; jose
 * itself, not this repo, owns keeping `decodeJwt` free of signature checks.
 */
export function decodeEntitlementClaims(token: string): Partial<Omit<EntitlementPayload, "issuedAt" | "expiresAt">> & {
  issuedAt?: Date;
  expiresAt?: Date;
} {
  try {
    const decoded = decodeJwt(token);
    return {
      instanceId: typeof decoded.instanceId === "string" ? decoded.instanceId : undefined,
      tier: typeof decoded.tier === "string" ? decoded.tier : undefined,
      tenantLimit: typeof decoded.tenantLimit === "number" ? decoded.tenantLimit : undefined,
      deviceLicensePool:
        typeof decoded.deviceLicensePool === "number" ? decoded.deviceLicensePool : undefined,
      writeEnabled: typeof decoded.writeEnabled === "boolean" ? decoded.writeEnabled : undefined,
      issuedAt: typeof decoded.iat === "number" ? new Date(decoded.iat * 1000) : undefined,
      expiresAt: typeof decoded.exp === "number" ? new Date(decoded.exp * 1000) : undefined,
    };
  } catch {
    return {};
  }
}
