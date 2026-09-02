import {
  GRAPH_SCOPES,
  GRAPH_READONLY_SCOPES,
  DEFENDER_SCOPES,
  DEFENDER_READONLY_SCOPES,
  PARTNER_CENTER_SCOPES,
  RESOURCE_APP_IDS,
} from "@patchpilot/shared";
import { GraphError } from "./client.js";

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
    const wanted = scopesFor(resource.key, includeWriteScopes);
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

    const wanted = scopesFor(resource.key, includeWriteScopes);
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
