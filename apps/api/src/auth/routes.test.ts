import Fastify, { type FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Same harness shape as quality-updates.test.ts, but the session is a plain
 * object held by reference (not a decorated-per-request fixture) so
 * assertions can inspect mutations `/auth/callback` makes to it
 * (session.regenerate(), session.engineer = ...) after `.inject()` returns.
 *
 * Scope follows the approved plan: the security-critical branches
 * (CSRF/state check, provisioning gate, happy path, logout, /auth/me, one
 * representative step-up mismatch) rather than exhaustive endpoint coverage —
 * the other four step-up prefixes share the same guard shape and each already
 * has its own Graph-layer test elsewhere.
 */

const { tableRows, updatedRows, auditSafeMock, redeemLoginCodeMock, storeTokenMock, clearTokensMock } = vi.hoisted(
  () => ({
    tableRows: new Map<unknown, unknown[]>(),
    updatedRows: new Map<unknown, unknown[]>(),
    auditSafeMock: vi.fn(),
    redeemLoginCodeMock: vi.fn(),
    storeTokenMock: vi.fn(),
    clearTokensMock: vi.fn(),
  }),
);

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
  return {
    ...actual,
    db: {
      select: () => ({ from: (table: unknown) => chain(tableRows.get(table) ?? []) }),
      update: (table: unknown) => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => {
            const list = updatedRows.get(table) ?? [];
            list.push(vals);
            updatedRows.set(table, list);
            return Promise.resolve();
          },
        }),
      }),
    },
  };
});

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      DEMO_MODE: false,
      ENTRA_CONFIGURED: true,
      ENTRA_CLIENT_ID: "client-1",
      ENTRA_TENANT_ID: "home-tenant",
      PUBLIC_URL: "https://app.example.com",
    },
    webOrigins: ["https://app.example.com"],
  };
});

vi.mock("@patchpilot/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@patchpilot/graph")>();
  return {
    ...actual,
    auditSafe: auditSafeMock,
    redeemLoginCode: redeemLoginCodeMock,
    storeToken: storeTokenMock,
    clearTokens: clearTokensMock,
  };
});

const { authRoutes } = await import("./routes.js");
const { tables } = await import("@patchpilot/db");
const { permissionsFor } = await import("@patchpilot/shared");

const ORIGIN = "https://app.example.com";

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    engineer: undefined,
    csrfToken: undefined,
    regenerate: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function buildApp(session: ReturnType<typeof fakeSession>, currentUser?: Record<string, unknown>) {
  const app = Fastify();
  app.decorateRequest("session", null as unknown as never);
  app.decorateRequest("currentUser", null as unknown as never);
  app.addHook("onRequest", async (req) => {
    req.session = session as unknown as FastifyRequest["session"];
    if (currentUser) req.currentUser = currentUser as never;
  });
  await app.register(authRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  tableRows.clear();
  updatedRows.clear();
  auditSafeMock.mockReset().mockResolvedValue(undefined);
  redeemLoginCodeMock.mockReset();
  storeTokenMock.mockReset().mockResolvedValue(undefined);
  clearTokensMock.mockReset().mockResolvedValue(undefined);
});

describe("GET /auth/callback — CSRF/state checks", () => {
  it("400s and audits login-failed when state is missing", async () => {
    const session = fakeSession();
    const app = await buildApp(session);
    const res = await app.inject({ method: "GET", url: "/auth/callback?code=abc123" });

    expect(res.statusCode).toBe(400);
    expect(auditSafeMock).toHaveBeenCalledWith(expect.objectContaining({ action: "auth:login-failed" }));
    expect(session.regenerate).not.toHaveBeenCalled();
    await app.close();
  });

  it("400s and audits login-failed when state doesn't match the session id", async () => {
    const session = fakeSession({ sessionId: "session-1" });
    const app = await buildApp(session);
    const res = await app.inject({ method: "GET", url: "/auth/callback?code=abc123&state=not-the-session-id" });

    expect(res.statusCode).toBe(400);
    expect(auditSafeMock).toHaveBeenCalledWith(expect.objectContaining({ action: "auth:login-failed" }));
    expect(session.regenerate).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /auth/callback — provisioning gate", () => {
  it("403s, audits login-denied, and creates no session when there is no active engineer row", async () => {
    redeemLoginCodeMock.mockResolvedValue({
      account: { username: "nobody@example.com", tenantId: "cust-tenant" },
      accessToken: "tok",
      expiresOn: new Date(),
      scopes: ["scope"],
    });
    tableRows.set(tables.engineers, []);

    const session = fakeSession({ sessionId: "session-1" });
    const app = await buildApp(session);
    const res = await app.inject({ method: "GET", url: "/auth/callback?code=abc123&state=session-1" });

    expect(res.statusCode).toBe(403);
    expect(auditSafeMock).toHaveBeenCalledWith(expect.objectContaining({ action: "auth:login-denied" }));
    expect(session.regenerate).not.toHaveBeenCalled();
    expect(session.engineer).toBeUndefined();
    expect(storeTokenMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /auth/callback — happy path", () => {
  it("regenerates the session, stores the token, and redirects on a valid login", async () => {
    redeemLoginCodeMock.mockResolvedValue({
      account: { username: "engineer@example.com", tenantId: "cust-tenant", name: "Engineer" },
      accessToken: "tok",
      expiresOn: new Date(),
      scopes: ["scope"],
    });
    tableRows.set(tables.engineers, [
      { id: "eng-1", upn: "engineer@example.com", displayName: "Engineer", status: "active", role: "admin" },
    ]);

    const session = fakeSession({ sessionId: "session-1" });
    const app = await buildApp(session);
    const res = await app.inject({ method: "GET", url: "/auth/callback?code=abc123&state=session-1" });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(ORIGIN);
    expect(session.regenerate).toHaveBeenCalled();
    expect(session.engineer).toMatchObject({ upn: "engineer@example.com" });
    expect(storeTokenMock).toHaveBeenCalledWith("engineer@example.com", "cust-tenant", expect.any(Object));
    expect(auditSafeMock).toHaveBeenCalledWith(expect.objectContaining({ action: "auth:login-success" }));
    await app.close();
  });

  it("matches the stored UPN case-insensitively", async () => {
    redeemLoginCodeMock.mockResolvedValue({
      account: { username: "Engineer@Example.com", tenantId: "cust-tenant", name: "Engineer" },
      accessToken: "tok",
      expiresOn: new Date(),
      scopes: ["scope"],
    });
    tableRows.set(tables.engineers, [
      { id: "eng-1", upn: "engineer@example.com", displayName: "Engineer", status: "active", role: "admin" },
    ]);

    const session = fakeSession({ sessionId: "session-1" });
    const app = await buildApp(session);
    const res = await app.inject({ method: "GET", url: "/auth/callback?code=abc123&state=session-1" });

    expect(res.statusCode).toBe(302);
    expect(session.engineer).toMatchObject({ upn: "engineer@example.com" });
    await app.close();
  });
});

describe("POST /auth/logout", () => {
  it("clears tokens, destroys the session, and audits logout", async () => {
    const session = fakeSession({ engineer: { upn: "engineer@example.com", homeTenantId: "cust-tenant" } });
    const app = await buildApp(session);
    const res = await app.inject({ method: "POST", url: "/auth/logout" });

    expect(res.statusCode).toBe(200);
    expect(clearTokensMock).toHaveBeenCalledWith("engineer@example.com");
    expect(session.destroy).toHaveBeenCalled();
    expect(auditSafeMock).toHaveBeenCalledWith(expect.objectContaining({ action: "auth:logout" }));
    await app.close();
  });

  it("still destroys the session and audits when there is no engineer on it", async () => {
    const session = fakeSession({ engineer: undefined });
    const app = await buildApp(session);
    const res = await app.inject({ method: "POST", url: "/auth/logout" });

    expect(res.statusCode).toBe(200);
    expect(clearTokensMock).not.toHaveBeenCalled();
    expect(session.destroy).toHaveBeenCalled();
    expect(auditSafeMock).toHaveBeenCalledWith(expect.objectContaining({ action: "auth:logout" }));
    await app.close();
  });
});

describe("GET /auth/me", () => {
  it("401s with entraConfigured still present when there is no session", async () => {
    const session = fakeSession({ engineer: undefined });
    const app = await buildApp(session);
    const res = await app.inject({ method: "GET", url: "/auth/me" });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ authenticated: false, entraConfigured: true });
    await app.close();
  });

  it("returns permissions and lazily issues a csrfToken when authenticated", async () => {
    const session = fakeSession({
      engineer: { upn: "engineer@example.com", displayName: "Engineer", homeTenantId: "cust-tenant" },
      csrfToken: undefined,
    });
    const currentUser = { id: "eng-1", upn: "engineer@example.com", displayName: "Engineer", role: "technician", theme: "light" };
    const app = await buildApp(session, currentUser);
    const res = await app.inject({ method: "GET", url: "/auth/me" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.authenticated).toBe(true);
    expect(body.engineer.permissions).toEqual(permissionsFor("technician"));
    expect(body.csrfToken).toBeTruthy();
    expect(session.csrfToken).toBe(body.csrfToken);
    await app.close();
  });
});

describe("GET /auth/callback — sync-permissions step-up (representative)", () => {
  it("400s and audits sync-failed on a session mismatch", async () => {
    const session = fakeSession({
      sessionId: "session-1",
      engineer: { upn: "engineer@example.com", displayName: "Engineer", homeTenantId: "cust-tenant" },
    });
    const app = await buildApp(session);
    const res = await app.inject({
      method: "GET",
      url: "/auth/callback?code=abc123&state=patchpilot-syncperm:wrong-session:0",
    });

    expect(res.statusCode).toBe(400);
    expect(auditSafeMock).toHaveBeenCalledWith(expect.objectContaining({ action: "app-registration:sync-failed" }));
    await app.close();
  });
});
