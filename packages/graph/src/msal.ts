import {
  ConfidentialClientApplication,
  type Configuration,
  type AuthenticationResult,
  type ICachePlugin,
  type TokenCacheContext,
} from "@azure/msal-node";
import { env } from "./env.js";
import { encrypt, decrypt } from "./crypto.js";
import { redis } from "./token-store.js";

/**
 * MSAL Node confidential client for the MSP tenant. Handles the OIDC
 * Authorization Code + PKCE login, the On-Behalf-Of exchange into the MSP home
 * tenant, and the Secure Application Model refresh-token redemption into each
 * GDAP customer tenant. All of this runs server-side.
 *
 * GDAP only supports **delegated ("app + user") access** to customer tenants —
 * application-only consent to a customer tenant is unsupported and Entra roles
 * can no longer be granted to an application via relationships or security-group
 * membership. So customer access is delegated: the signed-in engineer carries the
 * GDAP roles, and a delegated token minted against the customer-tenant authority
 * (from the engineer's cached refresh token) inherits them.
 *
 * MSAL Node never exposes the refresh token on a result object; it lives inside
 * MSAL's own token cache. We therefore persist that cache per engineer (encrypted,
 * in Redis) so a later request can mint a customer-tenant token silently, and so
 * MSAL transparently rotates the refresh token for us.
 */
const msalConfig: Configuration = {
  auth: {
    clientId: env.ENTRA_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}`,
    clientSecret: env.ENTRA_CLIENT_SECRET,
  },
  system: {
    loggerOptions: {
      loggerCallback: () => {},
      piiLoggingEnabled: false,
    },
  },
};

/**
 * Refresh tokens roll for up to 90 days, so the engineer's serialized MSAL cache
 * is kept that long. Each silent acquisition rotates the RT and re-stamps the TTL.
 */
const MSAL_CACHE_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Redis key prefix for the per-engineer encrypted, serialized MSAL token caches. */
const MSAL_CACHE_PREFIX = "pp:msalcache:";

/** Redis key holding an engineer's encrypted, serialized MSAL token cache. */
function msalCacheKey(engineerUpn: string): string {
  return `${MSAL_CACHE_PREFIX}${engineerUpn}`;
}

/**
 * Every engineer who currently has a persisted MSAL cache — i.e. has logged in
 * and whose refresh token has not expired/been evicted. This is the authoritative
 * "who can mint customer-tenant tokens headlessly right now" set, because login
 * seeds the cache but does NOT populate the engineers table. The background
 * auto-sync uses it to pick which engineers' delegated credentials to redeem,
 * with no live session required (see acquireTokenForCustomerTenant).
 *
 * Uses SCAN (not KEYS) to avoid blocking Redis, mirroring how clearTokens walks
 * the token namespace. Never runs in DEMO_MODE — the auto-sync loop is gated off.
 */
export async function listEngineersWithCache(): Promise<string[]> {
  const upns: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(
      cursor,
      "MATCH",
      `${MSAL_CACHE_PREFIX}*`,
      "COUNT",
      100,
    );
    cursor = next;
    for (const key of batch) upns.push(key.slice(MSAL_CACHE_PREFIX.length));
  } while (cursor !== "0");
  return upns;
}

/**
 * Whether a specific engineer currently has a usable background-access
 * credential, without pulling the whole set via listEngineersWithCache. Used
 * by the worker's per-schedule pre-flight check (a schedule is bound to one
 * engineer, not "any cached engineer").
 */
export async function hasCachedSession(engineerUpn: string): Promise<boolean> {
  return (await redis.exists(msalCacheKey(engineerUpn))) === 1;
}

/**
 * Per-engineer cache plugin: loads the engineer's serialized MSAL cache before
 * each access and persists it (re-encrypted) after any mutation. Partitioning by
 * engineer keeps one engineer's refresh token out of another's client instance.
 */
function cachePluginFor(engineerUpn: string): ICachePlugin {
  const cacheKey = msalCacheKey(engineerUpn);
  return {
    async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
      const raw = await redis.get(cacheKey);
      if (raw) ctx.tokenCache.deserialize(decrypt(raw));
    },
    async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
      if (ctx.cacheHasChanged) {
        await redis.set(cacheKey, encrypt(ctx.tokenCache.serialize()), "EX", MSAL_CACHE_TTL_SECONDS);
      }
    },
  };
}

/**
 * A confidential client bound to one engineer's Redis-backed token cache. A fresh
 * instance is built per operation (the recommended pattern for a confidential
 * client serving many users) so caches never bleed between engineers.
 */
export function ccaForEngineer(engineerUpn: string): ConfidentialClientApplication {
  return new ConfidentialClientApplication({
    ...msalConfig,
    cache: { cachePlugin: cachePluginFor(engineerUpn) },
  });
}

/**
 * Drop an engineer's persisted MSAL cache — the real revocation of their
 * background-access credential. NOT called on routine sign-out (that cache is
 * designed to self-renew for up to 90 days independent of any live session,
 * see the module comment above); called only from an explicit admin "revoke
 * background access" action or automatically when an account is disabled or
 * deleted (apps/api/src/routes/users.ts).
 */
export async function clearMsalCache(engineerUpn: string): Promise<void> {
  await redis.del(msalCacheKey(engineerUpn));
}

/** The UPN we key sessions and caches by — username, falling back to the stable id. */
function accountUpn(account: { username?: string; homeAccountId?: string } | null): string {
  return account?.username || account?.homeAccountId || "unknown";
}

/**
 * Redeems the login authorization code and seeds the engineer's persisted MSAL
 * cache with the refresh token. A fresh in-memory client is used so the serialized
 * cache contains only this login's account + RT (no cross-engineer bleed), then it
 * is encrypted into Redis under the engineer key for later silent customer-tenant
 * redemption. Returns the auth result so the caller can start the session.
 *
 * redirectUri must be byte-for-byte the same URI /auth/login used to obtain
 * this code (MSAL/Entra reject the exchange otherwise) — the caller resolves
 * it per-request rather than a fixed env default so a request arriving via an
 * alternate allow-listed origin (see apps/api/src/auth/origin.ts) round-trips
 * correctly instead of always exchanging against env.AUTH_REDIRECT_URI.
 */
export async function redeemLoginCode(code: string, redirectUri: string): Promise<AuthenticationResult> {
  if (env.DEMO_MODE) {
    throw new Error("Login code redemption must never run in DEMO_MODE");
  }
  const client = new ConfidentialClientApplication(msalConfig);
  const result = await client.acquireTokenByCode({
    code,
    scopes: LOGIN_SCOPES,
    redirectUri,
  });
  if (!result?.account) {
    throw new Error("Login code redemption returned no account");
  }
  await redis.set(
    msalCacheKey(accountUpn(result.account)),
    encrypt(client.getTokenCache().serialize()),
    "EX",
    MSAL_CACHE_TTL_SECONDS,
  );
  return result;
}

/**
 * Singleton confidential client used only for cache-independent operations:
 * building the auth-code URL (no token cache is touched until a code is redeemed).
 */
export const cca = new ConfidentialClientApplication(msalConfig);

/**
 * Scopes requested for the one-time "Sync permissions" step-up consent (Setup ->
 * App Registration). Elevated directory-write scopes PatchPilot's normal session
 * never carries — see redeemStepUpConsentCode below.
 */
export const APP_REGISTRATION_SYNC_SCOPES = [
  "Application.ReadWrite.All",
  "DelegatedPermissionGrant.ReadWrite.All",
];

/**
 * Redeems a one-time step-up consent authorization code for an elevated,
 * short-lived access token (Application.ReadWrite.All +
 * DelegatedPermissionGrant.ReadWrite.All), used once server-side to sync
 * PatchPilot's requested API permissions onto its own app registration (see
 * packages/graph/src/app-registration-sync.ts).
 *
 * Unlike redeemLoginCode, this NEVER persists anything: no Redis cache entry,
 * no cache plugin. A fresh in-memory client is used and simply discarded once
 * the caller is done with the returned access token — the whole point of the
 * step-up flow is that this elevated grant leaves no standing credential
 * behind. Must never run in DEMO_MODE, same as every other real
 * Microsoft-facing exchange in this module.
 */
export async function redeemStepUpConsentCode(
  code: string,
  redirectUri: string,
): Promise<AuthenticationResult> {
  if (env.DEMO_MODE) {
    throw new Error("Step-up consent redemption must never run in DEMO_MODE");
  }
  const client = new ConfidentialClientApplication(msalConfig);
  const result = await client.acquireTokenByCode({
    code,
    scopes: APP_REGISTRATION_SYNC_SCOPES,
    redirectUri,
  });
  if (!result?.accessToken) {
    throw new Error("Step-up consent code redemption returned no access token");
  }
  return result;
}

/**
 * Scopes requested at login. The engineer signs in for PatchPilot's OWN API
 * (`access_as_user`, audience = this app) — NOT for Graph. That session token is
 * useless against Microsoft APIs directly; it can only be exchanged, server-side
 * by this confidential client, via the OBO flow. Downstream Graph/Defender
 * tokens are minted per-tenant on demand. `offline_access` yields the refresh
 * token MSAL caches and later redeems against each customer-tenant authority.
 */
export const LOGIN_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  env.ENTRA_API_SCOPE,
];

/**
 * Silently mints a fresh "login" token (audience = PatchPilot API, scope
 * `ENTRA_API_SCOPE`) from the engineer's cached refresh token, without a live
 * browser session. This is what keeps `resolveToken`'s home-tenant OBO path
 * (client.ts) working past the initial login token's ~60-90min lifetime: that
 * token is normally only minted once, at /auth/callback, and if it's reused
 * past expiry every OBO exchange fails identically with AADSTS500133 ("Assertion
 * is not within its valid time range") until the engineer fully re-authenticates.
 * Returns null (not a throw) when there's no cached account — the caller should
 * surface that as "re-authentication required", same as a missing login token.
 */
export async function refreshLoginToken(
  engineerUpn: string,
  homeTenantId: string,
): Promise<AuthenticationResult | null> {
  if (env.DEMO_MODE) {
    throw new Error("Login token refresh must never run in DEMO_MODE");
  }
  const client = ccaForEngineer(engineerUpn);
  const accounts = await client.getTokenCache().getAllAccounts();
  const account = accounts[0];
  if (!account) return null;

  return client.acquireTokenSilent({
    account,
    authority: `https://login.microsoftonline.com/${homeTenantId}`,
    scopes: [env.ENTRA_API_SCOPE],
  });
}

/**
 * Multi-tenant On-Behalf-Of exchange for the MSP **home** tenant (Phase 4).
 *
 * Exchanges the engineer's session token — the OBO *assertion*, whose audience
 * is PatchPilot's own API — for a delegated access token scoped to the home
 * tenant. The confidential client's base authority is fixed at the MSP tenant, so
 * we override the authority to `https://login.microsoftonline.com/{homeTenantId}`.
 * The minted token carries the engineer's identity, preserving Entra-enforced
 * per-engineer least privilege in the MSP's own directory.
 *
 * Customer tenants do NOT use OBO — see acquireTokenForCustomerTenant. OBO
 * redeems an assertion against the tenant that issued it; reaching a foreign GDAP
 * customer needs the Secure Application Model refresh-token flow instead.
 *
 * This must NEVER run in DEMO_MODE (non-negotiable #9): the demo is
 * zero-dependency and never touches Microsoft. The caller (Graph client) only
 * reaches this path outside demo mode, but we hard-block here as a backstop.
 */
export async function acquireTokenForTenant(
  userAssertion: string,
  tenantId: string,
  scopes: string[],
): Promise<AuthenticationResult> {
  if (env.DEMO_MODE) {
    throw new Error("OBO exchange must never run in DEMO_MODE");
  }
  if (!userAssertion) {
    throw new Error(
      `OBO exchange for tenant ${tenantId} requires the engineer's session assertion token`,
    );
  }

  const result = await cca.acquireTokenOnBehalfOf({
    oboAssertion: userAssertion,
    authority: `https://login.microsoftonline.com/${tenantId}`,
    scopes,
  });

  if (!result) {
    throw new Error(`OBO exchange returned no token for tenant ${tenantId}`);
  }
  return result;
}

/**
 * Delegated token acquisition for a GDAP **customer** tenant (Secure Application
 * Model). This is the only Microsoft-supported way to reach a customer tenant:
 * app-only consent to a customer tenant is unsupported under GDAP, and Entra
 * roles can no longer be granted to an application via a security group. Instead
 * the signed-in engineer holds the GDAP roles, and we redeem their cached refresh
 * token against the customer-tenant authority to mint a delegated token that
 * inherits those roles.
 *
 * MSAL `acquireTokenSilent` does the redemption: it loads the engineer's cached
 * account + refresh token, and because we pass the customer-tenant authority it
 * mints (and caches) a delegated access token for that customer. RT rotation and
 * persistence are handled by the per-engineer cache plugin. No engineer-supplied
 * assertion is needed — the refresh token is the credential — but the engineer is
 * still recorded on every audited call (invariant #3).
 *
 * Like OBO this must NEVER run in DEMO_MODE (non-negotiable #9). The Graph client
 * only reaches this outside demo mode; we hard-block here as a backstop.
 */
export async function acquireTokenForCustomerTenant(
  engineerUpn: string,
  customerTenantId: string,
  scopes: string[],
): Promise<AuthenticationResult> {
  if (env.DEMO_MODE) {
    throw new Error("Customer-tenant token acquisition must never run in DEMO_MODE");
  }

  const client = ccaForEngineer(engineerUpn);
  // The cache is partitioned per engineer, so it holds exactly this engineer's
  // account (seeded at login). If it's gone the refresh token has expired/been
  // revoked — the engineer must sign in again.
  const accounts = await client.getTokenCache().getAllAccounts();
  const account = accounts[0];
  if (!account) {
    throw new Error(
      `No cached session for ${engineerUpn} — re-authentication required before customer-tenant access`,
    );
  }

  const result = await client.acquireTokenSilent({
    account,
    authority: `https://login.microsoftonline.com/${customerTenantId}`,
    scopes,
  });

  if (!result) {
    throw new Error(`Silent token acquisition returned no token for customer tenant ${customerTenantId}`);
  }
  return result;
}
