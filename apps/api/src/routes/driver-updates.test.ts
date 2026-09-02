import Fastify, { type FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Mirrors update-rings.test.ts exactly — driver-updates.ts is the same
 * read-only-list shape, just a different table. See that file's top comment
 * for why DEMO_MODE is a mutable hoisted flag read via a Proxy getter. */

const { tableRows, demoModeState } = vi.hoisted(() => ({
  tableRows: new Map<unknown, unknown[]>(),
  demoModeState: { value: false },
}));

interface Chain extends PromiseLike<unknown[]> {
  where: () => Chain;
  orderBy: () => Chain;
}

function chain(rows: unknown[]): Chain {
  return {
    where: () => chain(rows),
    orderBy: () => chain(rows),
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

const { driverUpdatesRoutes } = await import("./driver-updates.js");
const { tables } = await import("@patchpilot/db");

const TENANT_ID = "customer-tenant";
const ENGINEER = { upn: "engineer@example.com", displayName: "Engineer", homeTenantId: "home-tenant" };

async function buildApp() {
  const app = Fastify();
  app.decorateRequest("session", null as unknown as never);
  app.decorateRequest("currentUser", null as unknown as never);
  app.addHook("onRequest", async (req) => {
    req.session = { engineer: ENGINEER } as FastifyRequest["session"];
    req.currentUser = { id: "engineer-1", upn: ENGINEER.upn, displayName: ENGINEER.displayName, role: "admin" };
  });
  await app.register(driverUpdatesRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  tableRows.clear();
  demoModeState.value = false;
});

describe("GET /api/driver-updates", () => {
  it("returns the tenant's synced driver update profiles", async () => {
    tableRows.set(tables.driverUpdateProfiles, [
      { id: "driver-1", tenantId: TENANT_ID, displayName: "Dell driver approval" },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/driver-updates?tenantId=${TENANT_ID}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).profiles).toEqual([
      { id: "driver-1", tenantId: TENANT_ID, displayName: "Dell driver approval" },
    ]);
    await app.close();
  });

  it("returns an empty list in demo mode", async () => {
    demoModeState.value = true;
    tableRows.set(tables.driverUpdateProfiles, [{ id: "driver-1", tenantId: TENANT_ID, displayName: "Dell driver approval" }]);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/driver-updates?tenantId=${TENANT_ID}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).profiles).toEqual([]);
    await app.close();
  });

  it("returns 401 when unauthenticated", async () => {
    const app = Fastify();
    app.decorateRequest("session", null as unknown as never);
    app.decorateRequest("currentUser", null as unknown as never);
    app.addHook("onRequest", async (req) => {
      req.session = {} as FastifyRequest["session"];
    });
    await app.register(driverUpdatesRoutes);
    await app.ready();

    const res = await app.inject({ method: "GET", url: `/api/driver-updates?tenantId=${TENANT_ID}` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
