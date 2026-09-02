import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_APP_IDS, GRAPH_READONLY_SCOPES, DEFENDER_READONLY_SCOPES } from "@patchpilot/shared";
import { syncAppRegistrationScopes } from "./app-registration-sync.js";

const CLIENT_ID = "11111111-1111-1111-1111-111111111111";
const APP_OBJECT_ID = "app-obj-1";
const GRAPH_SP_ID = "sp-graph-1";
const DEFENDER_SP_ID = "sp-defender-1";
const PARTNER_SP_ID = "sp-partner-1";
const CLIENT_SP_ID = "sp-client-1";

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function publishedScopes(values: readonly string[]) {
  return values.map((value, i) => ({ id: `scope-id-${value}-${i}`, value }));
}

/**
 * Routes a mocked fetch call by (method, URL) the same way the real Graph API
 * would respond, given a scenario's servicePrincipal/grant fixtures. Kept as one
 * router rather than per-test mocks because syncAppRegistrationScopes fires the
 * three resource service-principal lookups in parallel — a call-order-dependent
 * mock would be flaky.
 */
function installFetchMock(scenario: {
  graphSp: { id: string; oauth2PermissionScopes: { id: string; value: string }[] } | null;
  defenderSp: { id: string; oauth2PermissionScopes: { id: string; value: string }[] } | null;
  partnerSp: { id: string; oauth2PermissionScopes: { id: string; value: string }[] } | null;
  clientSp: { id: string } | null;
  existingGrants: { id: string; clientId: string; resourceId: string; consentType: string; scope?: string }[];
}) {
  const patchCalls: { path: string; body: unknown }[] = [];
  const postCalls: { path: string; body: unknown }[] = [];

  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = url.toString().replace("https://graph.microsoft.com/v1.0", "");
    const method = (init?.method ?? "GET") as string;

    if (method === "GET" && path.startsWith("/applications?")) {
      return jsonRes(200, { value: [{ id: APP_OBJECT_ID }] });
    }

    if (method === "GET" && path.startsWith("/servicePrincipals?")) {
      if (path.includes(encodeURIComponent(RESOURCE_APP_IDS.graph))) {
        return jsonRes(200, { value: scenario.graphSp ? [scenario.graphSp] : [] });
      }
      if (path.includes(encodeURIComponent(RESOURCE_APP_IDS.defender))) {
        return jsonRes(200, { value: scenario.defenderSp ? [scenario.defenderSp] : [] });
      }
      if (path.includes(encodeURIComponent(RESOURCE_APP_IDS.partnerCenter))) {
        return jsonRes(200, { value: scenario.partnerSp ? [scenario.partnerSp] : [] });
      }
      if (path.includes(encodeURIComponent(CLIENT_ID))) {
        return jsonRes(200, { value: scenario.clientSp ? [scenario.clientSp] : [] });
      }
      throw new Error(`unexpected servicePrincipals filter: ${path}`);
    }

    if (method === "PATCH" && path.startsWith(`/applications/${APP_OBJECT_ID}`)) {
      patchCalls.push({ path, body: JSON.parse(init!.body as string) });
      return jsonRes(204, undefined);
    }

    if (method === "GET" && path.startsWith("/oauth2PermissionGrants?")) {
      return jsonRes(200, { value: scenario.existingGrants });
    }

    if (method === "PATCH" && path.startsWith("/oauth2PermissionGrants/")) {
      patchCalls.push({ path, body: JSON.parse(init!.body as string) });
      return jsonRes(204, undefined);
    }

    if (method === "POST" && path.startsWith("/oauth2PermissionGrants")) {
      postCalls.push({ path, body: JSON.parse(init!.body as string) });
      return jsonRes(201, { id: "new-grant-1" });
    }

    throw new Error(`unmocked fetch: ${method} ${path}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, patchCalls, postCalls };
}

const FULLY_PUBLISHED = {
  graphSp: { id: GRAPH_SP_ID, oauth2PermissionScopes: publishedScopes(GRAPH_READONLY_SCOPES) },
  defenderSp: { id: DEFENDER_SP_ID, oauth2PermissionScopes: publishedScopes(DEFENDER_READONLY_SCOPES) },
  partnerSp: { id: PARTNER_SP_ID, oauth2PermissionScopes: publishedScopes(["user_impersonation"]) },
  clientSp: { id: CLIENT_SP_ID },
  existingGrants: [] as { id: string; clientId: string; resourceId: string; consentType: string; scope?: string }[],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncAppRegistrationScopes", () => {
  it("applies every resource's scopes and grants consent when nothing exists yet", async () => {
    const { patchCalls, postCalls } = installFetchMock(FULLY_PUBLISHED);

    const result = await syncAppRegistrationScopes({
      accessToken: "tok",
      clientId: CLIENT_ID,
      includeWriteScopes: false,
    });

    expect(result.warnings).toEqual([]);
    expect(result.applied.map((a) => a.resource).sort()).toEqual(["defender", "graph", "partnerCenter"].sort());
    expect(result.consentGranted).toHaveLength(3);

    // requiredResourceAccess PATCH happened once, with all three resources.
    const appPatch = patchCalls.find((c) => c.path.startsWith(`/applications/${APP_OBJECT_ID}`));
    expect(appPatch).toBeDefined();
    expect((appPatch!.body as { requiredResourceAccess: unknown[] }).requiredResourceAccess).toHaveLength(3);

    // No existing grants, so every resource gets a POST, none a PATCH-merge.
    expect(postCalls).toHaveLength(3);
    for (const call of postCalls) {
      expect(call.body).toMatchObject({ clientId: CLIENT_SP_ID, consentType: "AllPrincipals" });
    }
  });

  it("warns and skips a scope the resource doesn't publish, but still applies the rest", async () => {
    const missingOneScope = {
      ...FULLY_PUBLISHED,
      graphSp: {
        id: GRAPH_SP_ID,
        // Drop "User.Read" from what the SP actually publishes.
        oauth2PermissionScopes: publishedScopes(GRAPH_READONLY_SCOPES.filter((s) => s !== "User.Read")),
      },
    };
    installFetchMock(missingOneScope);

    const result = await syncAppRegistrationScopes({
      accessToken: "tok",
      clientId: CLIENT_ID,
      includeWriteScopes: false,
    });

    expect(result.warnings).toContainEqual(expect.stringContaining("User.Read"));
    const graphApplied = result.applied.find((a) => a.resource === "graph");
    expect(graphApplied?.scopeCount).toBe(GRAPH_READONLY_SCOPES.length - 1);
  });

  it("warns and skips a resource whose service principal doesn't exist", async () => {
    const noDefenderSp = { ...FULLY_PUBLISHED, defenderSp: null };
    installFetchMock(noDefenderSp);

    const result = await syncAppRegistrationScopes({
      accessToken: "tok",
      clientId: CLIENT_ID,
      includeWriteScopes: false,
    });

    expect(result.warnings).toContainEqual(expect.stringContaining("Microsoft Defender"));
    expect(result.applied.some((a) => a.resource === "defender")).toBe(false);
    expect(result.consentGranted.some((c) => c.resource === "defender")).toBe(false);
    // Graph and Partner Center still went through.
    expect(result.applied.some((a) => a.resource === "graph")).toBe(true);
    expect(result.applied.some((a) => a.resource === "partnerCenter")).toBe(true);
  });

  it("reports PatchPilot's own service principal missing and stops before touching consent", async () => {
    const noClientSp = { ...FULLY_PUBLISHED, clientSp: null };
    const { postCalls, patchCalls } = installFetchMock(noClientSp);

    const result = await syncAppRegistrationScopes({
      accessToken: "tok",
      clientId: CLIENT_ID,
      includeWriteScopes: false,
    });

    expect(result.warnings).toContainEqual(expect.stringContaining("own service principal was not found"));
    expect(result.consentGranted).toEqual([]);
    // requiredResourceAccess was still applied (scopes were resolved fine)...
    expect(patchCalls.some((c) => c.path.startsWith(`/applications/${APP_OBJECT_ID}`))).toBe(true);
    // ...but no grant calls were attempted, since there's no client SP to grant from.
    expect(postCalls).toEqual([]);
  });

  it("union-merges scopes into an existing grant instead of replacing it", async () => {
    const existingGraphGrant = {
      id: "grant-graph-1",
      clientId: CLIENT_SP_ID,
      resourceId: GRAPH_SP_ID,
      consentType: "AllPrincipals",
      // Only one of the readonly scopes already granted — the rest are missing.
      scope: "User.Read",
    };
    const withExistingGrant = { ...FULLY_PUBLISHED, existingGrants: [existingGraphGrant] };
    const { patchCalls, postCalls } = installFetchMock(withExistingGrant);

    const result = await syncAppRegistrationScopes({
      accessToken: "tok",
      clientId: CLIENT_ID,
      includeWriteScopes: false,
    });

    const graphPatch = patchCalls.find((c) => c.path === "/oauth2PermissionGrants/grant-graph-1");
    expect(graphPatch).toBeDefined();
    const mergedScope = (graphPatch!.body as { scope: string }).scope.split(" ");
    expect(mergedScope).toEqual(expect.arrayContaining([...GRAPH_READONLY_SCOPES]));
    expect(mergedScope).toContain("User.Read"); // union kept the pre-existing scope too

    // Graph didn't need a POST since it already had a grant row; defender/partner still did.
    expect(postCalls.some((c) => (c.body as { resourceId: string }).resourceId === GRAPH_SP_ID)).toBe(false);
    expect(postCalls).toHaveLength(2);

    const graphConsent = result.consentGranted.find((c) => c.resource === "graph");
    expect(graphConsent?.scopeCount).toBe(mergedScope.length);
  });

  it("leaves an existing grant untouched when it already covers every wanted scope", async () => {
    const fullyGrantedAlready = {
      id: "grant-graph-1",
      clientId: CLIENT_SP_ID,
      resourceId: GRAPH_SP_ID,
      consentType: "AllPrincipals",
      scope: GRAPH_READONLY_SCOPES.join(" "),
    };
    const noChangeNeeded = { ...FULLY_PUBLISHED, existingGrants: [fullyGrantedAlready] };
    const { patchCalls } = installFetchMock(noChangeNeeded);

    const result = await syncAppRegistrationScopes({
      accessToken: "tok",
      clientId: CLIENT_ID,
      includeWriteScopes: false,
    });

    expect(patchCalls.some((c) => c.path === "/oauth2PermissionGrants/grant-graph-1")).toBe(false);
    const graphConsent = result.consentGranted.find((c) => c.resource === "graph");
    expect(graphConsent?.scopeCount).toBe(GRAPH_READONLY_SCOPES.length);
  });
});
