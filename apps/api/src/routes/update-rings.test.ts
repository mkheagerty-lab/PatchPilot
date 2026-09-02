import Fastify, { type FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * update-rings.ts is read-only (no write path exists for this Intune
 * resource — see its top-of-file comment), so this harness is a trimmed-down
 * version of feature-updates.test.ts's: no Graph mocks, no insert/delete
 * tracking, just the `db.select().from().where().orderBy()` chain.
 *
 * DEMO_MODE is exposed as a mutable hoisted flag (read via a `Proxy` getter,
 * not a static mock value) so a single test can flip it without the
 * `vi.resetModules()`/`vi.doMock()` dance, which would also blow away the
 * `@patchpilot/db` mock's shared `tableRows` wiring.
 */

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

const { updateRingsRoutes } = await import("./update-rings.js");
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
  await app.register(updateRingsRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  tableRows.clear();
  demoModeState.value = false;
});

describe("GET /api/update-rings", () => {
  it("returns the tenant's synced update ring profiles", async () => {
    tableRows.set(tables.updateRingProfiles, [
      { id: "ring-1", tenantId: TENANT_ID, displayName: "IT Pilot Ring" },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/update-rings?tenantId=${TENANT_ID}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).profiles).toEqual([
      { id: "ring-1", tenantId: TENANT_ID, displayName: "IT Pilot Ring" },
    ]);
    await app.close();
  });

  it("returns an empty list in demo mode", async () => {
    demoModeState.value = true;
    tableRows.set(tables.updateRingProfiles, [{ id: "ring-1", tenantId: TENANT_ID, displayName: "IT Pilot Ring" }]);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/update-rings?tenantId=${TENANT_ID}` });

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
    await app.register(updateRingsRoutes);
    await app.ready();

    const res = await app.inject({ method: "GET", url: `/api/update-rings?tenantId=${TENANT_ID}` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
