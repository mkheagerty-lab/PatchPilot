import {
  GRAPH_SCOPES,
  GRAPH_READONLY_SCOPES,
  DEFENDER_SCOPES,
  DEFENDER_READONLY_SCOPES,
  PARTNER_CENTER_SCOPES,
  RESOURCE_APP_IDS,
} from "@patchpilot/shared";
import { GraphError } from "./client.js";
import { APP_REGISTRATION_TEST_SCOPES } from "./msal.js";

/**
 * Ports Deploy-PatchPilot.ps1's `Resolve-ResourceAccess` + `Set-DelegatedAdminConsent`
 * functions to TypeScript, run against a one-time step-up access token (see the
 * "Sync permissions" flow in apps/api/src/routes/onboarding.ts and
 * apps/api/src/auth/routes.ts) instead of an interactive Graph PowerShell session.
 *
 * Deliberately bypasses client.ts's `graphGet`/`graphWrite`: those always resolve
 * their own token via `acquireTokenForTenant`/`acquireTokenForCustomerTenant`,
 * which is the wrong credential model for a one-shot elevated grant that must
 * never be persisted — the same reasoning behind win32-app.ts's raw-fetch blob
 * upload bypass.
 */

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

type ResourceKey = "graph" | "defender" | "partnerCenter";

interface Oauth2PermissionScope {
  id: string;
  value: string;
}

interface ServicePrincipal {
  id: string;
  appId: string;
  oauth2PermissionScopes?: Oauth2PermissionScope[];
}

interface Oauth2PermissionGrant {
  id: string;
  clientId: string;
  resourceId: string;
  consentType: string;
  scope?: string;
}

export interface ScopeSyncResult {
  applied: { resource: ResourceKey; scopeCount: number }[];
  consentGranted: { resource: ResourceKey; scopeCount: number }[];
  warnings: string[];
}

async function graphFetch<T>(
  accessToken: string,
  method: "GET" | "PATCH" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${GRAPH_ROOT}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GraphError(
      res.status,
      `Graph ${method} ${path} failed (HTTP ${res.status})${text ? ` — ${text.slice(0, 500)}` : ""}`,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function findApplicationObjectId(accessToken: string, clientId: string): Promise<string> {
  const result = await graphFetch<{ value: { id: string }[] }>(
    accessToken,
    "GET",
    `/applications?$filter=${encodeURIComponent(`appId eq '${clientId}'`)}`,
  );
  const app = result.value[0];
  if (!app) {
    throw new GraphError(404, `No application registration found for client id ${clientId}`);
  }
  return app.id;
}

async function findServicePrincipal(accessToken: string, appId: string): Promise<ServicePrincipal | null> {
  const result = await graphFetch<{ value: ServicePrincipal[] }>(
    accessToken,
    "GET",
    `/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${appId}'`)}`,
  );
  return result.value[0] ?? null;
}

const RESOURCES: { key: ResourceKey; label: string; resourceAppId: string }[] = [
  { key: "graph", label: "Microsoft Graph", resourceAppId: RESOURCE_APP_IDS.graph },
  { key: "defender", label: "Microsoft Defender", resourceAppId: RESOURCE_APP_IDS.defender },
  { key: "partnerCenter", label: "Partner Center", resourceAppId: RESOURCE_APP_IDS.partnerCenter },
];

function scopesFor(resource: ResourceKey, includeWriteScopes: boolean): readonly string[] {
  switch (resource) {
    case "graph":
      return includeWriteScopes ? GRAPH_SCOPES : GRAPH_READONLY_SCOPES;
    case "defender":
      return includeWriteScopes ? DEFENDER_SCOPES : DEFENDER_READONLY_SCOPES;
    case "partnerCenter":
      return PARTNER_CENTER_SCOPES;
  }
}

/**
 * APP_REGISTRATION_TEST_SCOPES (Application.Read.All, Directory.Read.All)
 * folded into the Graph resource ONLY inside syncAppRegistrationScopes below —
 * never into scopesFor/testAppRegistrationScopes's display list, since these
 * aren't "requested" onboarding permissions and shouldn't render as pills in
 * Requested API permissions.
 *
 * Both are admin-restricted Graph delegated permissions: Microsoft blocks a
 * non-Global-Admin's consent to them with "Need admin approval" unless
 * they're already tenant-wide (AllPrincipals) granted. Sync is already the
 * one action gated to a Global Admin's write-capable step-up, so bundling
 * these into its publish + grant step here means every other engineer's
 * Test Connection afterward is just a sign-in redirect against an
 * already-consented scope — never a fresh admin-restricted consent prompt
 * that only a Global Admin could get past.
 */
function testScopesFor(resource: ResourceKey): readonly string[] {
  return resource === "graph" ? APP_REGISTRATION_TEST_SCOPES : [];
}

/**
 * Applies PatchPilot's current requested scopes (packages/shared/src/scopes.ts)
 * to an *existing* app registration, then grants/refreshes tenant-wide admin
 * consent for them — the two steps a Global Admin otherwise performs by
 * re-running Deploy-PatchPilot.ps1. Assumes the app registration and its
 * service principal already exist (first-time creation is still the script's
 * job); reports a warning rather than throwing if PatchPilot's own service
 * principal is missing, since that means the script has never been run here.
 */
export async function syncAppRegistrationScopes(input: {
  /** From the one-time step-up consent redirect. Never persisted by the caller. */
  accessToken: string;
  clientId: string;
  /** Mirrors Deploy-PatchPilot.ps1's -EnableRemediationWriteScopes. */
  includeWriteScopes: boolean;
}): Promise<ScopeSyncResult> {
  const { accessToken, clientId, includeWriteScopes } = input;
  const warnings: string[] = [];
  const applied: ScopeSyncResult["applied"] = [];
  const consentGranted: ScopeSyncResult["consentGranted"] = [];

  const [appObjectId, servicePrincipals] = await Promise.all([
    findApplicationObjectId(accessToken, clientId),
    Promise.all(RESOURCES.map((r) => findServicePrincipal(accessToken, r.resourceAppId))),
  ]);

  const requiredResourceAccess: { resourceAppId: string; resourceAccess: { id: string; type: "Scope" }[] }[] = [];

  for (const [i, resource] of RESOURCES.entries()) {
    const sp = servicePrincipals[i];
    if (!sp) {
      warnings.push(`${resource.label} service principal not found — skipped`);
      continue;
    }
    const wanted = [...scopesFor(resource.key, includeWriteScopes), ...testScopesFor(resource.key)];
    const published = sp.oauth2PermissionScopes ?? [];
    const access: { id: string; type: "Scope" }[] = [];
    for (const value of wanted) {
      const scope = published.find((s) => s.value === value);
      if (!scope) {
        warnings.push(`${resource.label} missing delegated scope: ${value}`);
        continue;
      }
      access.push({ id: scope.id, type: "Scope" });
    }
    if (access.length === 0) {
      warnings.push(`${resource.label} had no matching scopes — skipped`);
      continue;
    }
    requiredResourceAccess.push({ resourceAppId: resource.resourceAppId, resourceAccess: access });
    applied.push({ resource: resource.key, scopeCount: access.length });
  }

  if (requiredResourceAccess.length > 0) {
    await graphFetch(accessToken, "PATCH", `/applications/${appObjectId}`, { requiredResourceAccess });
  }

  const clientSp = await findServicePrincipal(accessToken, clientId);
  if (!clientSp) {
    warnings.push(
      "PatchPilot's own service principal was not found — admin consent could not be refreshed. " +
        "Deploy-PatchPilot.ps1 must be run at least once before permissions can be synced.",
    );
    return { applied, consentGranted, warnings };
  }

  for (const [i, resource] of RESOURCES.entries()) {
    const sp = servicePrincipals[i];
    if (!sp) continue; // already warned above

    const wanted = [...scopesFor(resource.key, includeWriteScopes), ...testScopesFor(resource.key)];
    const publishable = new Set((sp.oauth2PermissionScopes ?? []).map((s) => s.value));
    const valid = wanted.filter((v) => publishable.has(v));
    if (valid.length === 0) continue;

    const grants = await graphFetch<{ value: Oauth2PermissionGrant[] }>(
      accessToken,
      "GET",
      `/oauth2PermissionGrants?$filter=${encodeURIComponent(`clientId eq '${clientSp.id}' and consentType eq 'AllPrincipals'`)}`,
    );
    const existing = grants.value.find((g) => g.resourceId === sp.id);

    if (existing) {
      const current = existing.scope ? existing.scope.split(/\s+/).filter(Boolean) : [];
      const missing = valid.filter((v) => !current.includes(v));
      if (missing.length === 0) {
        consentGranted.push({ resource: resource.key, scopeCount: current.length });
        continue;
      }
      const merged = Array.from(new Set([...current, ...valid]));
      await graphFetch(accessToken, "PATCH", `/oauth2PermissionGrants/${existing.id}`, {
        scope: merged.join(" "),
      });
      consentGranted.push({ resource: resource.key, scopeCount: merged.length });
    } else {
      await graphFetch(accessToken, "POST", "/oauth2PermissionGrants", {
        clientId: clientSp.id,
        consentType: "AllPrincipals",
        resourceId: sp.id,
        scope: valid.join(" "),
      });
      consentGranted.push({ resource: resource.key, scopeCount: valid.length });
    }
  }

  return { applied, consentGranted, warnings };
}

export interface ScopeStatusEntry {
  resource: ResourceKey;
  scope: string;
  /** ok = published + currently granted. skipped = published but not yet
   * granted (needs a sync). failed = not published on the resource's own
   * service principal at all (or the SP/app couldn't be found). */
  status: "ok" | "skipped" | "failed";
}

export interface ScopeTestResult {
  results: ScopeStatusEntry[];
}

/**
 * Read-only counterpart to syncAppRegistrationScopes above: reports the live
 * status of every scope PatchPilot could ever request (the full write-gated
 * list per resource, matching what the "Requested API permissions" section
 * always displays) without issuing a single PATCH/POST. Backs that section's
 * per-scope status tags and its "Test Connection" button — a lighter,
 * read-only step-up token (APP_REGISTRATION_TEST_SCOPES, not a sync's
 * write-capable pair), and this function never mutates the app registration
 * or its consent grants, so it's safe to run as often as wanted.
 */
export async function testAppRegistrationScopes(input: {
  accessToken: string;
  clientId: string;
}): Promise<ScopeTestResult> {
  const { accessToken, clientId } = input;
  const results: ScopeStatusEntry[] = [];

  const [servicePrincipals, clientSp] = await Promise.all([
    Promise.all(RESOURCES.map((r) => findServicePrincipal(accessToken, r.resourceAppId))),
    findServicePrincipal(accessToken, clientId),
  ]);

  let grants: Oauth2PermissionGrant[] = [];
  if (clientSp) {
    const res = await graphFetch<{ value: Oauth2PermissionGrant[] }>(
      accessToken,
      "GET",
      `/oauth2PermissionGrants?$filter=${encodeURIComponent(`clientId eq '${clientSp.id}' and consentType eq 'AllPrincipals'`)}`,
    );
    grants = res.value;
  }

  for (const [i, resource] of RESOURCES.entries()) {
    const sp = servicePrincipals[i];
    // Always the maximal (write-gated) list — the section this backs shows
    // every scope PatchPilot could ever ask for, regardless of whether write
    // scopes happen to be opted in right now.
    const wanted = scopesFor(resource.key, true);
    const published = new Set((sp?.oauth2PermissionScopes ?? []).map((s) => s.value));
    const grant = sp ? grants.find((g) => g.resourceId === sp.id) : undefined;
    const granted = new Set(grant?.scope ? grant.scope.split(/\s+/).filter(Boolean) : []);

    for (const value of wanted) {
      if (!sp || !published.has(value)) {
        results.push({ resource: resource.key, scope: value, status: "failed" });
      } else if (!granted.has(value)) {
        results.push({ resource: resource.key, scope: value, status: "skipped" });
      } else {
        results.push({ resource: resource.key, scope: value, status: "ok" });
      }
    }
  }

  return { results };
}

export interface UpdateRedirectUrisResult {
  added: string[];
  removed: string[];
  alreadyPresent: string[];
  current: string[];
}

/**
 * Additively merges "<origin>/auth/callback" for every origin in
 * redirectOrigins into the app registration's Web platform redirect URIs,
 * using the same one-time step-up access token as syncAppRegistrationScopes
 * above, and — only when the caller explicitly asks via removeUris — drops
 * specific existing URIs at the same time, in the same PATCH. Idempotent:
 * issues no PATCH at all if nothing would actually change — this is the
 * "won't create duplicated or unexpected changes" guarantee for the in-app
 * "update via browser" button (apps/api/src/routes/domains.ts), mirroring
 * scripts/Deploy-PatchPilot.ps1's Merge-RedirectUris/Test-RedirectUriExists
 * functions. Deliberately does not touch the Spa platform — that PKCE-conflict
 * cleanup is a first-time-app-creation concern, not relevant to an incremental add.
 *
 * removeUris is intersected against `existing` here (nothing else this
 * function does can remove a URI), but the caller is still responsible for
 * making sure none of them is a URI this instance itself relies on to log
 * in — removing this instance's own active redirect URI would lock every
 * admin out of the app registration entirely (see routes/domains.ts's
 * protectedUris filter and auth/routes.ts's matching re-check right before
 * this is called).
 */
export async function updateAppRegistrationRedirectUris(input: {
  accessToken: string;
  clientId: string;
  redirectOrigins: string[];
  removeUris?: string[];
}): Promise<UpdateRedirectUrisResult> {
  const { accessToken, clientId, redirectOrigins, removeUris = [] } = input;
  const appObjectId = await findApplicationObjectId(accessToken, clientId);
  const current = await graphFetch<{ web?: { redirectUris?: string[] } }>(
    accessToken,
    "GET",
    `/applications/${appObjectId}?$select=web`,
  );
  const existing = current.web?.redirectUris ?? [];
  const wanted = redirectOrigins.map((o) => `${o.replace(/\/+$/, "")}/auth/callback`);
  const toRemove = new Set(removeUris);

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  let merged = [...existing];
  for (const uri of wanted) {
    if (toRemove.has(uri)) continue; // being explicitly removed this same run — don't re-add it
    if (existing.includes(uri)) {
      alreadyPresent.push(uri);
      continue;
    }
    if (!merged.includes(uri)) {
      merged.push(uri);
      added.push(uri);
    }
  }
  const removed = existing.filter((uri) => toRemove.has(uri));
  merged = merged.filter((uri) => !toRemove.has(uri));
  const deduped = Array.from(new Set(merged));

  if (added.length > 0 || removed.length > 0) {
    await graphFetch(accessToken, "PATCH", `/applications/${appObjectId}`, {
      web: { redirectUris: deduped },
    });
  }

  return { added, removed, alreadyPresent, current: deduped };
}

/**
 * Carries a redirect-URI removal request across the full-page OAuth redirect
 * to Microsoft and back, appended onto the `patchpilot-syncdomains:${sessionId}`
 * state string built in apps/api/src/routes/domains.ts and read back apart in
 * apps/api/src/auth/routes.ts's callback. base64url so it can't introduce a
 * `:` that would break that state string's `sessionId:payload` split, and JSON
 * so the two ends don't have to agree on a delimiter for the URIs themselves
 * (which contain their own `:` and `/`).
 *
 * This payload is round-tripped through the user's browser and Microsoft's
 * redirect, so it's treated as untrusted on the way back in: both ends of
 * this call still re-filter against a `protectedUris` set derived from this
 * instance's own webOrigins (once when domains.ts builds the state, again in
 * auth/routes.ts immediately before updateAppRegistrationRedirectUris is
 * called) rather than trusting that a URI surviving decode is safe to remove.
 */
export function encodeRedirectUriRemoval(uris: string[]): string {
  return Buffer.from(JSON.stringify(uris), "utf8").toString("base64url");
}

export function decodeRedirectUriRemoval(payload: string | undefined): string[] {
  if (!payload) return [];
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
