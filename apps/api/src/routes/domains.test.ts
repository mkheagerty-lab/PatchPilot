import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Full Fastify `.inject()` coverage for custom domain management, following
 * the harness pattern established in feature-updates.test.ts / groups.test.ts:
 * fake `session.engineer` + `currentUser` via a top-level `onRequest` hook,
 * `@patchpilot/db` mocked with an in-memory, table-reference-keyed store, and
 * every outward-facing boundary (`node:dns/promises`, `@patchpilot/graph`,
 * the Redis `connection`, `process.exit`) mocked directly.
 *
 * `drizzle-orm`'s `eq`/`and` are also mocked here (no other route test needs
 * this) because, unlike every other `routes/*.test.ts` file, domains.ts's
 * `update()`/`delete()` calls actually depend on `.where()` correctly
 * narrowing which row is affected (activate-by-id, delete-by-id, the
 * `/internal/domains/ask` active-row lookup) — a pass-through `where()` like
 * the existing `select()`-only mocks use would silently mutate/delete every
 * row in the table instead of just the targeted one.
 */

const { tableRows, auditSafeMock, resolveCnameMock, publishMock } = vi.hoisted(() => ({
  tableRows: new Map<unknown, Record<string, unknown>[]>(),
  auditSafeMock: vi.fn(),
  resolveCnameMock: vi.fn(),
  publishMock: vi.fn(),
}));

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

interface Chain extends PromiseLike<Row[]> {
  where: (pred?: Predicate) => Chain;
  limit: (n: number) => Chain;
  orderBy: () => Chain;
}

function chain(rows: Row[]): Chain {
  return {
    where: (pred) => chain(typeof pred === "function" ? rows.filter(pred) : rows),
    limit: (n) => chain(rows.slice(0, n)),
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
    insert: (table: unknown) => ({
      values: (vals: Row) => ({
        returning: async () => {
          const list = tableRows.get(table) ?? [];
          // Simulates the real unique index on `hostname` — the one
          // constraint domains.ts's isUniqueViolation() catch depends on.
          if (typeof vals.hostname === "string" && list.some((r) => r.hostname === vals.hostname)) {
            throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
          }
          const row: Row = {
            id: `row-${list.length + 1}`,
            status: "pending",
            createdAt: new Date(),
            activatedAt: null,
            lastCheckedAt: null,
            lastCheckError: null,
            ...vals,
          };
          list.push(row);
          tableRows.set(table, list);
          return [row];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (vals: Row) => ({
        where: (pred?: Predicate) => ({
          returning: async () => {
            const rows = tableRows.get(table) ?? [];
            const matched = typeof pred === "function" ? rows.filter(pred) : rows;
            matched.forEach((row) => Object.assign(row, vals));
            return matched;
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: (pred?: Predicate) => ({
        returning: async () => {
          const rows = tableRows.get(table) ?? [];
          const matched = typeof pred === "function" ? rows.filter(pred) : rows;
          tableRows.set(
            table,
            rows.filter((row) => !matched.includes(row)),
          );
          return matched;
        },
      }),
    }),
  };
  return { ...actual, db };
});

// Real drizzle `eq`/`and` build SQL fragments this in-memory store can't
// evaluate — swap in plain-object predicates instead. `tables.customDomains`
// columns are real drizzle PgColumn instances (from the un-mocked schema),
// so `column.name` is the actual snake_case-mapped JS property key.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq:
      (column: { name: string }, value: unknown): Predicate =>
      (row) =>
        row[column.name] === value,
    and:
      (...preds: Predicate[]): Predicate =>
      (row) =>
        preds.every((p) => p(row)),
  };
});

vi.mock("node:dns/promises", () => ({ resolveCname: resolveCnameMock }));

vi.mock("@patchpilot/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@patchpilot/graph")>();
  return { ...actual, auditSafe: auditSafeMock };
});

vi.mock("../queue.js", () => ({ connection: { publish: publishMock } }));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      DEMO_MODE: false,
      PUBLIC_URL: "https://patchpilot.example.com",
      PLATFORM_BASE_DOMAIN: "patchpilot365.com",
      ENTRA_TENANT_ID: "tenant-abc",
      ENTRA_CLIENT_ID: "client-abc",
    },
  };
});

const { domainsRoutes, domainsInternalRoutes } = await import("./domains.js");
const { tables } = await import("@patchpilot/db");

const ENGINEER = { upn: "engineer@example.com", displayName: "Engineer", homeTenantId: "home-tenant" };

async function buildApp(role: "admin" | "reader" = "admin") {
  const app = Fastify();
  app.decorateRequest("session", null as unknown as never);
  app.decorateRequest("currentUser", null as unknown as never);
  app.addHook("onRequest", async (req) => {
    // Test-only session stand-in — the real shape comes from @fastify/session.
    req.session = { engineer: ENGINEER, sessionId: "session-1" } as FastifyRequest["session"];
    req.currentUser = { id: "engineer-1", upn: ENGINEER.upn, displayName: ENGINEER.displayName, role };
  });
  await app.register(domainsRoutes);
  await app.register(domainsInternalRoutes);
  await app.ready();
  return app;
}

function seedDomain(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: "domain-1",
    hostname: "acme.patchpilot365.com",
    type: "subdomain",
    status: "pending",
    cnameTarget: "patchpilot.example.com",
    createdBy: ENGINEER.upn,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    activatedAt: null,
    lastCheckedAt: null,
    lastCheckError: null,
    ...overrides,
  };
  tableRows.set(tables.customDomains, [...(tableRows.get(tables.customDomains) ?? []), row]);
  return row;
}

beforeEach(() => {
  tableRows.clear();
  auditSafeMock.mockReset();
  resolveCnameMock.mockReset();
  publishMock.mockReset().mockResolvedValue(1);
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The route replies, then fires `setTimeout(() => process.exit(0), 250)` —
// real timers (fake ones stall Fastify's inject() body-parsing pipeline),
// so this just outwaits the real 250ms tail.
const RESTART_TAIL_MS = 300;
function waitForRestartTail() {
  return new Promise((resolve) => setTimeout(resolve, RESTART_TAIL_MS));
}

describe("POST /api/domains", () => {
  it("rejects an invalid subdomain label", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/domains",
      payload: { type: "subdomain", label: "-bad-" },
    });
    expect(res.statusCode).toBe(400);
    expect(tableRows.get(tables.customDomains) ?? []).toHaveLength(0);
    await app.close();
  });

  it("rejects a custom hostname that is actually a platform-domain subdomain", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/domains",
      payload: { type: "custom", hostname: "foo.patchpilot365.com" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a custom hostname equal to the instance's own primary domain", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/domains",
      payload: { type: "custom", hostname: "patchpilot.example.com" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("creates a pending subdomain row with server-computed instructions, and audits it", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/domains",
      payload: { type: "subdomain", label: "acme" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.hostname).toBe("acme.patchpilot365.com");
    expect(body.status).toBe("pending");
    expect(body.cnameTarget).toBe("patchpilot.example.com");
    expect(body.instructions.kind).toBe("email-support");
    expect(body.instructions.supportMailto).toContain("mailto:support@patchpilot365.com");
    expect(auditSafeMock).toHaveBeenCalledWith(expect.objectContaining({ action: "custom-domain:created" }));
    await app.close();
  });

  it("creates a pending custom-domain row with dns-cname instructions", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/domains",
      payload: { type: "custom", hostname: "updates.customer.com" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.instructions.kind).toBe("dns-cname");
    expect(body.instructions.cnameRecord).toEqual({
      name: "updates.customer.com",
      target: "patchpilot.example.com",
    });
    await app.close();
  });

  it("rejects a duplicate hostname with 409, not a raw constraint error", async () => {
    seedDomain({ hostname: "acme.patchpilot365.com" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/domains",
      payload: { type: "subdomain", label: "acme" },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("returns 403 when the current user lacks settings:write", async () => {
    const app = await buildApp("reader");
    const res = await app.inject({
      method: "POST",
      url: "/api/domains",
      payload: { type: "subdomain", label: "acme" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects domain creation when the instance's public hostname isn't a real DNS name (e.g. local dev)", async () => {
    const { config } = await import("../config.js");
    const original = config.PUBLIC_URL;
    config.PUBLIC_URL = "http://localhost:5173";
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/domains",
        payload: { type: "subdomain", label: "acme" },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain("isn't a real DNS name");
      expect(tableRows.get(tables.customDomains) ?? []).toHaveLength(0);
    } finally {
      config.PUBLIC_URL = original;
      await app.close();
    }
  });
});

describe("GET /api/domains/check", () => {
  it("reports available for a subdomain label with no existing row", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/domains/check?type=subdomain&label=acme" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ hostname: "acme.patchpilot365.com", available: true });
    await app.close();
  });

  it("reports unavailable, with a reason, for a hostname that already exists", async () => {
    seedDomain({ hostname: "acme.patchpilot365.com" });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/domains/check?type=subdomain&label=acme" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hostname).toBe("acme.patchpilot365.com");
    expect(body.available).toBe(false);
    expect(body.reason).toBe("a domain with this hostname already exists");
    await app.close();
  });

  it("reports unavailable (200, not 400) for a reserved hostname, explaining why", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/domains/check?type=custom&hostname=foo.patchpilot365.com",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hostname).toBeNull();
    expect(body.available).toBe(false);
    expect(body.reason).toContain("use the subdomain option");
    await app.close();
  });

  it("never inserts a row — it's read-only", async () => {
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/domains/check?type=subdomain&label=acme" });
    expect(tableRows.get(tables.customDomains) ?? []).toHaveLength(0);
    await app.close();
  });

  it("returns 400 for a malformed query (missing label)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/domains/check?type=subdomain" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 403 when the current user lacks settings:write", async () => {
    const app = await buildApp("reader");
    const res = await app.inject({ method: "GET", url: "/api/domains/check?type=subdomain&label=acme" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /api/domains", () => {
  it("reports the resolved CNAME target and its usability alongside every row", async () => {
    seedDomain();
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/domains" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.cnameTarget).toBe("patchpilot.example.com");
    expect(body.cnameTargetUsable).toBe(true);
    expect(body.domains).toHaveLength(1);
    await app.close();
  });

  it("flags cnameTargetUsable as false when the public hostname is localhost", async () => {
    const { config } = await import("../config.js");
    const original = config.PUBLIC_URL;
    config.PUBLIC_URL = "http://localhost:5173";
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/domains" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.cnameTarget).toBe("localhost:5173");
      expect(body.cnameTargetUsable).toBe(false);
    } finally {
      config.PUBLIC_URL = original;
      await app.close();
    }
  });
});

describe("POST /api/domains/:id/verify", () => {
  it("activates the domain and triggers a restart when the CNAME resolves to the expected target", async () => {
    const row = seedDomain();
    resolveCnameMock.mockResolvedValueOnce(["patchpilot.example.com"]);

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/api/domains/${row.id}/verify` });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.verified).toBe(true);
    expect(body.domain.status).toBe("active");
    expect(auditSafeMock).toHaveBeenCalledWith(expect.objectContaining({ action: "custom-domain:activated" }));
    expect(publishMock).toHaveBeenCalledWith("patchpilot:custom-domains-changed", "activated");

    await waitForRestartTail();
    expect(process.exit).toHaveBeenCalledWith(0);
    await app.close();
  });

  it("leaves the domain pending, with no restart, when the CNAME doesn't match yet", async () => {
    const row = seedDomain();
    resolveCnameMock.mockResolvedValueOnce(["somewhere-else.example.net"]);

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/api/domains/${row.id}/verify` });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.verified).toBe(false);
    expect(body.domain.status).toBe("pending");
    expect(body.domain.lastCheckError).toContain("somewhere-else.example.net");
    expect(auditSafeMock).toHaveBeenCalledWith(expect.objectContaining({ action: "custom-domain:verify-failed" }));
    expect(publishMock).not.toHaveBeenCalled();

    await waitForRestartTail();
    expect(process.exit).not.toHaveBeenCalled();
    await app.close();
  });

  it("leaves the domain pending, with no 5xx, when the DNS lookup itself throws (NXDOMAIN)", async () => {
    const row = seedDomain();
    resolveCnameMock.mockRejectedValueOnce(new Error("queryCname ENOTFOUND acme.patchpilot365.com"));

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: `/api/domains/${row.id}/verify` });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.verified).toBe(false);
    expect(body.domain.lastCheckError).toContain("ENOTFOUND");
    expect(process.exit).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 404 for an unknown domain id", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/domains/does-not-exist/verify" });
    expect(res.statusCode).toBe(404);
    expect(resolveCnameMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("DELETE /api/domains/:id", () => {
  it("deletes a pending row without triggering a restart", async () => {
    const row = seedDomain({ status: "pending" });
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `/api/domains/${row.id}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true });
    expect(tableRows.get(tables.customDomains) ?? []).toHaveLength(0);
    expect(auditSafeMock).toHaveBeenCalledWith(expect.objectContaining({ action: "custom-domain:deleted" }));
    expect(publishMock).not.toHaveBeenCalled();

    await waitForRestartTail();
    expect(process.exit).not.toHaveBeenCalled();
    await app.close();
  });

  it("deletes an active row and triggers a restart — its origin leaves the allowlist", async () => {
    const row = seedDomain({ status: "active", activatedAt: new Date("2026-01-02T00:00:00Z") });
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `/api/domains/${row.id}` });

    expect(res.statusCode).toBe(200);
    expect(publishMock).toHaveBeenCalledWith("patchpilot:custom-domains-changed", "deleted");

    await waitForRestartTail();
    expect(process.exit).toHaveBeenCalledWith(0);
    await app.close();
  });

  it("only removes the targeted row, leaving other rows untouched", async () => {
    const target = seedDomain({ id: "domain-1", hostname: "a.patchpilot365.com" });
    seedDomain({ id: "domain-2", hostname: "b.patchpilot365.com" });
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `/api/domains/${target.id}` });

    expect(res.statusCode).toBe(200);
    const remaining = tableRows.get(tables.customDomains) ?? [];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe("domain-2");
    await app.close();
  });

  it("returns 404 for an unknown domain id", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/domains/does-not-exist" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /internal/domains/ask", () => {
  it("requires no session or currentUser at all", async () => {
    // A bare Fastify app with no session/currentUser hook — the route must
    // still resolve, proving it sits outside every auth-bearing plugin.
    const app = Fastify();
    app.decorateRequest("session", null as unknown as never);
    app.decorateRequest("currentUser", null as unknown as never);
    await app.register(domainsInternalRoutes);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/internal/domains/ask?domain=patchpilot.example.com" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("allows the instance's own primary host", async () => {
    const app = Fastify();
    app.decorateRequest("session", null as unknown as never);
    app.decorateRequest("currentUser", null as unknown as never);
    await app.register(domainsInternalRoutes);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/internal/domains/ask?domain=patchpilot.example.com" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("allows an active custom-domain row", async () => {
    seedDomain({ hostname: "acme.patchpilot365.com", status: "active" });
    const app = Fastify();
    app.decorateRequest("session", null as unknown as never);
    app.decorateRequest("currentUser", null as unknown as never);
    await app.register(domainsInternalRoutes);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/internal/domains/ask?domain=acme.patchpilot365.com" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a pending (not-yet-verified) row", async () => {
    seedDomain({ hostname: "acme.patchpilot365.com", status: "pending" });
    const app = Fastify();
    app.decorateRequest("session", null as unknown as never);
    app.decorateRequest("currentUser", null as unknown as never);
    await app.register(domainsInternalRoutes);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/internal/domains/ask?domain=acme.patchpilot365.com" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejects an unrecognized domain", async () => {
    const app = Fastify();
    app.decorateRequest("session", null as unknown as never);
    app.decorateRequest("currentUser", null as unknown as never);
    await app.register(domainsInternalRoutes);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/internal/domains/ask?domain=evil.example.net" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 400 when the domain query param is missing", async () => {
    const app = Fastify();
    app.decorateRequest("session", null as unknown as never);
    app.decorateRequest("currentUser", null as unknown as never);
    await app.register(domainsInternalRoutes);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/internal/domains/ask" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
