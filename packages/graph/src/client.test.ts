import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./token-store.js", () => ({
  getToken: vi.fn(async () => ({
    accessToken: "cached-token",
    expiresAt: Date.now() + 3_600_000,
    scopes: ["x"],
  })),
  storeToken: vi.fn(async () => {}),
}));
vi.mock("./msal.js", () => ({
  acquireTokenForTenant: vi.fn(),
  acquireTokenForCustomerTenant: vi.fn(),
  refreshLoginToken: vi.fn(),
}));
vi.mock("./audit.js", () => ({
  audit: vi.fn(async () => {}),
  API_CALL_HOSTS: ["graph", "beta", "defender"],
}));

import { graphGet } from "./client.js";

const baseOpts = {
  engineer: "eng@example.com",
  homeTenantId: "home-tenant",
  tenantId: "home-tenant",
  path: "/organization",
};

describe("graphGet retry-with-backoff", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries a 429 honoring Retry-After, then returns the success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ hello: "world" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await graphGet(baseOpts);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("gives up after the bounded retry count on a persistent 503", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await graphGet(baseOpts);

    // 1 initial attempt + 3 retries = 4 total.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  }, 15_000);

  it("does not retry a plain non-retryable failure like 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await graphGet(baseOpts);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
  });
});
