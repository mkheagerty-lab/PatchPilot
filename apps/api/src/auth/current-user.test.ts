import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Mirrors quality-updates.test.ts's harness shape, but resolveCurrentUser is a
 * plain function (not a route) so it's exercised directly against fake
 * req/reply rather than through Fastify's `.inject()`.
 */

const { tableRows, demoModeMock } = vi.hoisted(() => ({
  tableRows: new Map<unknown, unknown[]>(),
  demoModeMock: { value: false },
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
  return {
    ...actual,
    db: {
      select: () => ({ from: (table: unknown) => chain(tableRows.get(table) ?? []) }),
    },
  };
});

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    get config() {
      return { ...actual.config, DEMO_MODE: demoModeMock.value };
    },
  };
});

const { resolveCurrentUser } = await import("./current-user.js");
const { tables } = await import("@patchpilot/db");
const { DEMO_ENGINEER_UPN } = await import("./demo-engineers.js");

function fakeRequest(upn: string | undefined): FastifyRequest & { currentUser?: unknown } {
  return {
    session: {
      engineer: upn ? { upn } : undefined,
      destroy: vi.fn().mockResolvedValue(undefined),
    },
    currentUser: undefined,
  } as unknown as FastifyRequest;
}

function fakeReply() {
  const send = vi.fn();
  const code = vi.fn(() => ({ send }));
  return { code, send } as unknown as FastifyReply & { code: typeof code; send: typeof send };
}

beforeEach(() => {
  tableRows.clear();
  demoModeMock.value = false;
});

describe("resolveCurrentUser", () => {
  it("no-ops when there is no session.engineer", async () => {
    const req = fakeRequest(undefined);
    const reply = fakeReply();
    await resolveCurrentUser(req, reply);
    expect(req.currentUser).toBeUndefined();
    expect(req.session.destroy).not.toHaveBeenCalled();
    expect(reply.code).not.toHaveBeenCalled();
  });

  describe("DEMO_MODE", () => {
    beforeEach(() => {
      demoModeMock.value = true;
    });

    it("populates currentUser from the seeded demo engineer", async () => {
      const req = fakeRequest(DEMO_ENGINEER_UPN);
      const reply = fakeReply();
      await resolveCurrentUser(req, reply);
      expect(req.currentUser).toMatchObject({ upn: DEMO_ENGINEER_UPN, role: "admin" });
      expect(reply.code).not.toHaveBeenCalled();
    });

    it("destroys the session and 403s for an unknown UPN", async () => {
      const req = fakeRequest("nobody@meridianmsp.example");
      const reply = fakeReply();
      await resolveCurrentUser(req, reply);
      expect(req.session.destroy).toHaveBeenCalled();
      expect(reply.code).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith({ error: "not_provisioned" });
      expect(req.currentUser).toBeUndefined();
    });
  });

  describe("real db", () => {
    it("populates currentUser from an active db row", async () => {
      tableRows.set(tables.engineers, [
        { id: "eng-1", upn: "engineer@example.com", displayName: "Engineer", role: "technician", status: "active", theme: "dark" },
      ]);
      const req = fakeRequest("engineer@example.com");
      const reply = fakeReply();
      await resolveCurrentUser(req, reply);
      expect(req.currentUser).toEqual({
        id: "eng-1",
        upn: "engineer@example.com",
        displayName: "Engineer",
        role: "technician",
        theme: "dark",
      });
      expect(reply.code).not.toHaveBeenCalled();
    });

    it("destroys the session and 403s when the row is missing", async () => {
      tableRows.set(tables.engineers, []);
      const req = fakeRequest("nobody@example.com");
      const reply = fakeReply();
      await resolveCurrentUser(req, reply);
      expect(req.session.destroy).toHaveBeenCalled();
      expect(reply.code).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith({ error: "not_provisioned" });
    });

    it("destroys the session and 403s when the row is disabled", async () => {
      tableRows.set(tables.engineers, [
        { id: "eng-1", upn: "engineer@example.com", displayName: "Engineer", role: "technician", status: "disabled", theme: "light" },
      ]);
      const req = fakeRequest("engineer@example.com");
      const reply = fakeReply();
      await resolveCurrentUser(req, reply);
      expect(req.session.destroy).toHaveBeenCalled();
      expect(reply.code).toHaveBeenCalledWith(403);
    });

    it("matches the stored UPN case-insensitively", async () => {
      tableRows.set(tables.engineers, [
        { id: "eng-1", upn: "engineer@example.com", displayName: "Engineer", role: "admin", status: "active", theme: "light" },
      ]);
      const req = fakeRequest("Engineer@Example.com");
      const reply = fakeReply();
      await resolveCurrentUser(req, reply);
      expect(req.currentUser).toMatchObject({ upn: "engineer@example.com" });
      expect(reply.code).not.toHaveBeenCalled();
    });
  });
});
