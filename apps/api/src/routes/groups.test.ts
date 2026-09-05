import Fastify, { type FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Full Fastify `.inject()` coverage for the group search route, following
 * the harness pattern established in feature-updates.test.ts: fake
 * `session.engineer` + `currentUser` via a top-level `onRequest` hook, and
 * the Graph-calling boundary (`searchGroups`) mocked directly.
 */

const { searchGroupsMock } = vi.hoisted(() => ({ searchGroupsMock: vi.fn() }));

vi.mock("@patchpilot/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@patchpilot/graph")>();
  return { ...actual, searchGroups: searchGroupsMock };
});

const { groupsRoutes } = await import("./groups.js");

const TENANT_ID = "customer-tenant";
const ENGINEER = { upn: "engineer@example.com", displayName: "Engineer", homeTenantId: "home-tenant" };

async function buildApp(role: "admin" | "reader" = "admin") {
  const app = Fastify();
  app.decorateRequest("session", null as unknown as never);
  app.decorateRequest("currentUser", null as unknown as never);
  app.addHook("onRequest", async (req) => {
    // Test-only session stand-in — the real shape comes from @fastify/session.
    req.session = { engineer: ENGINEER } as FastifyRequest["session"];
    req.currentUser = { id: "engineer-1", upn: ENGINEER.upn, displayName: ENGINEER.displayName, role, theme: "light" };
  });
  await app.register(groupsRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  searchGroupsMock.mockReset();
});

describe("GET /api/groups/search", () => {
  it("returns matched groups from searchGroups", async () => {
    searchGroupsMock.mockResolvedValueOnce([{ id: "group-abc", displayName: "Finance Laptops" }]);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/groups/search?tenantId=${TENANT_ID}&q=Fin`,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ groups: [{ id: "group-abc", displayName: "Finance Laptops" }] });
    expect(searchGroupsMock).toHaveBeenCalledWith(
      expect.objectContaining({ engineer: ENGINEER.upn, homeTenantId: ENGINEER.homeTenantId, tenantId: TENANT_ID, query: "Fin" }),
    );
    await app.close();
  });

  it("returns 400 when tenantId is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/groups/search?q=Fin" });

    expect(res.statusCode).toBe(400);
    expect(searchGroupsMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns an empty groups array without calling Graph when q is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/groups/search?tenantId=${TENANT_ID}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ groups: [] });
    expect(searchGroupsMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns an empty groups array without calling Graph when q is shorter than 2 chars", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/groups/search?tenantId=${TENANT_ID}&q=F` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ groups: [] });
    expect(searchGroupsMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps a 403 GraphError to 409 needs-reconsent", async () => {
    const { GraphError } = await import("@patchpilot/graph");
    searchGroupsMock.mockRejectedValueOnce(new GraphError(403, "forbidden"));

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/groups/search?tenantId=${TENANT_ID}&q=Fin`,
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("needs-reconsent");
    await app.close();
  });

  it("passes through the status and message for a non-403 GraphError", async () => {
    const { GraphError } = await import("@patchpilot/graph");
    searchGroupsMock.mockRejectedValueOnce(new GraphError(429, "rate limited"));

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/groups/search?tenantId=${TENANT_ID}&q=Fin`,
    });

    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).error).toBe("rate limited");
    await app.close();
  });

  it("returns 403 when the current user lacks operations:write permission", async () => {
    const app = await buildApp("reader");
    const res = await app.inject({
      method: "GET",
      url: `/api/groups/search?tenantId=${TENANT_ID}&q=Fin`,
    });

    expect(res.statusCode).toBe(403);
    expect(searchGroupsMock).not.toHaveBeenCalled();
    await app.close();
  });
});
