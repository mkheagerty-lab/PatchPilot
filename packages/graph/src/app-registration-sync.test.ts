import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_APP_IDS, GRAPH_READONLY_SCOPES, DEFENDER_READONLY_SCOPES } from "@patchpilot/shared";
import {
  syncAppRegistrationScopes,
  updateAppRegistrationRedirectUris,
  encodeRedirectUriRemoval,
  decodeRedirectUriRemoval,
} from "./app-registration-sync.js";
import { APP_REGISTRATION_TEST_SCOPES } from "./msal.js";

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
  // Real Microsoft Graph publishes Application.Read.All/Directory.Read.All as
  // standard delegated scopes alongside everything PatchPilot requests — the
  // fixture includes them so syncAppRegistrationScopes's testScopesFor()
  // merge (see app-registration-sync.ts) resolves cleanly here too, matching
  // real-world behavior rather than reporting a phantom "missing scope".
  graphSp: {
    id: GRAPH_SP_ID,
    oauth2PermissionScopes: publishedScopes([...GRAPH_READONLY_SCOPES, ...APP_REGISTRATION_TEST_SCOPES]),
  },
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
      // Must cover the test-connection scopes too, or syncAppRegistrationScopes
      // sees them as "missing" against this grant and issues a PATCH-merge,
      // defeating the point of this "already fully covered" scenario.
      scope: [...GRAPH_READONLY_SCOPES, ...APP_REGISTRATION_TEST_SCOPES].join(" "),
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
    expect(graphConsent?.scopeCount).toBe(GRAPH_READONLY_SCOPES.length + APP_REGISTRATION_TEST_SCOPES.length);
  });
});

/**
 * Routes just the two Graph calls updateAppRegistrationRedirectUris makes:
 * the application lookup by clientId, and a GET/PATCH pair against
 * /applications/{id}. Kept separate from installFetchMock above since this
 * function touches a disjoint set of endpoints.
 */
function installRedirectUriFetchMock(existingRedirectUris: string[]) {
  const patchCalls: { path: string; body: unknown }[] = [];

  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = url.toString().replace("https://graph.microsoft.com/v1.0", "");
    const method = (init?.method ?? "GET") as string;

    if (method === "GET" && path.startsWith("/applications?")) {
      return jsonRes(200, { value: [{ id: APP_OBJECT_ID }] });
    }
    if (method === "GET" && path.startsWith(`/applications/${APP_OBJECT_ID}?`)) {
      return jsonRes(200, { web: { redirectUris: existingRedirectUris } });
    }
    if (method === "PATCH" && path === `/applications/${APP_OBJECT_ID}`) {
      patchCalls.push({ path, body: JSON.parse(init!.body as string) });
      return jsonRes(204, undefined);
    }

    throw new Error(`unmocked fetch: ${method} ${path}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, patchCalls };
}

describe("updateAppRegistrationRedirectUris", () => {
  it("adds a new origin's redirect URI with a single PATCH", async () => {
    const { patchCalls } = installRedirectUriFetchMock(["https://patchpilot.example.com/auth/callback"]);

    const result = await updateAppRegistrationRedirectUris({
      accessToken: "tok",
      clientId: CLIENT_ID,
      redirectOrigins: ["https://patchpilot.example.com", "https://acme.patchpilot365.com"],
    });

    expect(result.added).toEqual(["https://acme.patchpilot365.com/auth/callback"]);
    expect(result.alreadyPresent).toEqual(["https://patchpilot.example.com/auth/callback"]);
    expect(patchCalls).toHaveLength(1);
    expect((patchCalls[0]!.body as { web: { redirectUris: string[] } }).web.redirectUris).toEqual(
      expect.arrayContaining([
        "https://patchpilot.example.com/auth/callback",
        "https://acme.patchpilot365.com/auth/callback",
      ]),
    );
  });

  it("issues zero PATCH calls when every wanted URI is already present — the idempotency guarantee", async () => {
    const { patchCalls } = installRedirectUriFetchMock([
      "https://patchpilot.example.com/auth/callback",
      "https://acme.patchpilot365.com/auth/callback",
    ]);

    const result = await updateAppRegistrationRedirectUris({
      accessToken: "tok",
      clientId: CLIENT_ID,
      redirectOrigins: ["https://patchpilot.example.com", "https://acme.patchpilot365.com"],
    });

    expect(result.added).toEqual([]);
    expect(result.alreadyPresent).toHaveLength(2);
    expect(patchCalls).toEqual([]);
  });

  it("merges mixed new/existing origins and preserves unrelated existing URIs untouched", async () => {
    const { patchCalls } = installRedirectUriFetchMock([
      "https://patchpilot.example.com/auth/callback",
      "https://some-other-unrelated-app.example.net/callback",
    ]);

    const result = await updateAppRegistrationRedirectUris({
      accessToken: "tok",
      clientId: CLIENT_ID,
      redirectOrigins: ["https://patchpilot.example.com", "https://acme.patchpilot365.com"],
    });

    expect(result.added).toEqual(["https://acme.patchpilot365.com/auth/callback"]);
    const merged = (patchCalls[0]!.body as { web: { redirectUris: string[] } }).web.redirectUris;
    expect(merged).toEqual(
      expect.arrayContaining([
        "https://patchpilot.example.com/auth/callback",
        "https://some-other-unrelated-app.example.net/callback",
        "https://acme.patchpilot365.com/auth/callback",
      ]),
    );
    expect(merged).toHaveLength(3);
  });

  it("removes an explicitly requested existing URI in the same PATCH, without re-adding it", async () => {
    const { patchCalls } = installRedirectUriFetchMock([
      "https://patchpilot.example.com/auth/callback",
      "https://stale-domain.example.net/auth/callback",
    ]);

    const result = await updateAppRegistrationRedirectUris({
      accessToken: "tok",
      clientId: CLIENT_ID,
      redirectOrigins: ["https://patchpilot.example.com"],
      removeUris: ["https://stale-domain.example.net/auth/callback"],
    });

    expect(result.removed).toEqual(["https://stale-domain.example.net/auth/callback"]);
    expect(result.added).toEqual([]);
    expect(patchCalls).toHaveLength(1);
    const merged = (patchCalls[0]!.body as { web: { redirectUris: string[] } }).web.redirectUris;
    expect(merged).toEqual(["https://patchpilot.example.com/auth/callback"]);
  });

  it("ignores a removeUris entry that isn't actually present — never reports it as removed, never PATCHes for it alone", async () => {
    const { patchCalls } = installRedirectUriFetchMock(["https://patchpilot.example.com/auth/callback"]);

    const result = await updateAppRegistrationRedirectUris({
      accessToken: "tok",
      clientId: CLIENT_ID,
      redirectOrigins: ["https://patchpilot.example.com"],
      removeUris: ["https://never-was-there.example.net/auth/callback"],
    });

    expect(result.removed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(patchCalls).toEqual([]);
  });

  it("never re-adds a wanted URI that's also in removeUris this same run", async () => {
    const { patchCalls } = installRedirectUriFetchMock(["https://patchpilot.example.com/auth/callback"]);

    const result = await updateAppRegistrationRedirectUris({
      accessToken: "tok",
      clientId: CLIENT_ID,
      // Wants this origin's URI, but also asks to remove that exact URI —
      // removal wins, so it should end up neither "added" nor present.
      redirectOrigins: ["https://patchpilot.example.com"],
      removeUris: ["https://patchpilot.example.com/auth/callback"],
    });

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(["https://patchpilot.example.com/auth/callback"]);
    const merged = (patchCalls[0]!.body as { web: { redirectUris: string[] } }).web.redirectUris;
    expect(merged).toEqual([]);
  });
});

describe("encodeRedirectUriRemoval / decodeRedirectUriRemoval", () => {
  it("round-trips a list of URIs through the base64url JSON payload", () => {
    const uris = ["https://acme.patchpilot365.com/auth/callback", "https://stale.example.net/auth/callback"];
    const encoded = encodeRedirectUriRemoval(uris);
    expect(encoded).not.toMatch(/[:/+=]/); // must be state-string-safe (no ":" especially)
    expect(decodeRedirectUriRemoval(encoded)).toEqual(uris);
  });

  it("decodes an empty/undefined payload to an empty list rather than throwing", () => {
    expect(decodeRedirectUriRemoval(undefined)).toEqual([]);
    expect(decodeRedirectUriRemoval("")).toEqual([]);
  });

  it("decodes garbage input to an empty list rather than throwing", () => {
    expect(decodeRedirectUriRemoval("not-valid-base64url-json!!!")).toEqual([]);
  });
});
