import { describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requirePermission } from "./rbac.js";

/**
 * `can()` itself (the permission matrix) belongs to @patchpilot/shared's own
 * test suite — this only exercises the route-layer guard's three outcomes.
 */

function fakeReply() {
  const send = vi.fn();
  const code = vi.fn(() => ({ send }));
  return { code, send } as unknown as FastifyReply & { code: typeof code; send: typeof send };
}

function fakeRequest(currentUser?: { role: "admin" | "technician" | "reader" }): FastifyRequest {
  return { currentUser } as unknown as FastifyRequest;
}

describe("requirePermission", () => {
  it("401s when there is no currentUser", async () => {
    const reply = fakeReply();
    await requirePermission("operations:read")(fakeRequest(undefined), reply);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "unauthenticated" });
  });

  it("403s when the role lacks the permission", async () => {
    const reply = fakeReply();
    // reader has no users:manage per packages/shared/src/rbac.ts's matrix.
    await requirePermission("users:manage")(fakeRequest({ role: "reader" }), reply);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: "forbidden", required: "users:manage" });
  });

  it("passes through (no reply) when the role has the permission", async () => {
    const reply = fakeReply();
    const result = await requirePermission("operations:write")(fakeRequest({ role: "technician" }), reply);
    expect(reply.code).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("admin passes every permission", async () => {
    const reply = fakeReply();
    await requirePermission("users:manage")(fakeRequest({ role: "admin" }), reply);
    expect(reply.code).not.toHaveBeenCalled();
  });
});
