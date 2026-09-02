import Fastify, { type FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Same harness shape as feature-updates.test.ts's `POST .../sync` block, but
 * this route calls all 5 sync functions in one request — the assertions here
 * check every mock was called and every count landed in both the response
 * and the single combined audit summary.
 */

const { tableRows, auditMock, demoModeState, syncMocks } = vi.hoisted(() => ({
  tableRows: new Map<unknown, unknown[]>(),
  auditMock: vi.fn(),
  demoModeState: { value: false },
  syncMocks: {
    syncFeatureUpdateProfiles: vi.fn(),
    syncQualityUpdateProfiles: vi.fn(),
    syncQualityUpdatePolicies: vi.fn(),
    syncUpdateRingProfiles: vi.fn(),
    syncDriverUpdateProfiles: vi.fn(),
  },
}));

interface Chain extends PromiseLike<unknown[]> {
  where: () => Chain;
  limit: (n: number) => Chain;
}

function chain(rows: unknown[]): Chain {
  return {
    where: () => chain(rows),
    limit: (n: number) => chain(rows.slice(0, n)),
    then: (onFulfilled, onRejected) => Promise.resolve(rows).then(onFulfilled, onRejected),
  };
}

vi.mock("@patchpilot/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@patchpilot/db")>();
  const db = {
    select: () => ({
      from: (table: unknown) => chain(tableRows.get(table) ?? []),
    }),
  };
  return { ...actual, db };
});

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, prop) => (prop === "DEMO_MODE" ? demoModeState.value : Reflect.get(target, prop)),
    }),
  };
});

vi.mock("@patchpilot/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@patchpilot/graph")>();
  return { ...actual, audit: auditMock };
});

vi.mock("../graph/sync.js", () => syncMocks);

const { windowsUpdatesRoutes } = await import("./windows-updates.js");
const { tables } = await import("@patchpilot/db");

const TENANT_ID = "customer-tenant";
const ENGINEER = { upn: "engineer@example.com", displayName: "Engineer", homeTenantId: "home-tenant" };

function setTenant(overrides: Record<string, unknown> = {}) {
  tableRows.set(tables.tenants, [
    { tenantId: TENANT_ID, displayName: "Customer", readOnly: false, consentStatus: "consented", ...overrides },
  ]);
}

async function buildApp() {
  const app = Fastify();
  app.decorateRequest("session", null as unknown as never);
  app.decorateRequest("currentUser", null as unknown as never);
  app.addHook("onRequest", async (req) => {
    req.session = { engineer: ENGINEER } as FastifyRequest["session"];
    req.currentUser = { id: "engineer-1", upn: ENGINEER.upn, displayName: ENGINEER.displayName, role: "admin" };
  });
  await app.register(windowsUpdatesRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  tableRows.clear();
  demoModeState.value = false;
  auditMock.mockReset().mockResolvedValue(undefined);
  syncMocks.syncFeatureUpdateProfiles.mockReset().mockResolvedValue({ count: 1 });
  syncMocks.syncQualityUpdateProfiles.mockReset().mockResolvedValue({ count: 2 });
  syncMocks.syncQualityUpdatePolicies.mockReset().mockResolvedValue({ count: 3 });
  syncMocks.syncUpdateRingProfiles.mockReset().mockResolvedValue({ count: 4 });
  syncMocks.syncDriverUpdateProfiles.mockReset().mockResolvedValue({ count: 5 });
  setTenant();
});

describe("POST /api/windows-updates/sync", () => {
  it("runs all five sync functions and returns their counts", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/windows-updates/sync", payload: { tenantId: TENANT_ID } });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      counts: {
        featureUpdates: 1,
        expeditePolicies: 2,
        qualityUpdatePolicies: 3,
        updateRings: 4,
        driverUpdates: 5,
      },
    });
    for (const mock of Object.values(syncMocks)) {
      expect(mock).toHaveBeenCalledWith(expect.objectContaining({ upn: ENGINEER.upn }), TENANT_ID);
    }
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "windows-updates:sync",
        outcome: "success",
        summary: expect.stringMatching(/1 feature updates.*2 expedite policies.*3 quality update policies.*4 update rings.*5 driver update profiles/),
      }),
    );
    await app.close();
  });

  it("returns 409 in demo mode without calling any sync function", async () => {
    demoModeState.value = true;

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/windows-updates/sync", payload: { tenantId: TENANT_ID } });

    expect(res.statusCode).toBe(409);
    for (const mock of Object.values(syncMocks)) {
      expect(mock).not.toHaveBeenCalled();
    }
    await app.close();
  });

  it("returns 400 when tenantId is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/windows-updates/sync", payload: {} });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 when the tenant is unknown", async () => {
    tableRows.set(tables.tenants, []);

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/windows-updates/sync", payload: { tenantId: TENANT_ID } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("surfaces a Graph error status and records a failed audit entry", async () => {
    const { GraphError } = await import("@patchpilot/graph");
    syncMocks.syncQualityUpdatePolicies.mockRejectedValue(new GraphError(502, "upstream error"));

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/windows-updates/sync", payload: { tenantId: TENANT_ID } });

    expect(res.statusCode).toBe(502);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "windows-updates:sync", outcome: "failure" }),
    );
    await app.close();
  });
});
