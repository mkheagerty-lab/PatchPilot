import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { Session } from "fastify";
import { redisSessionStore, pingSessionRedis } from "./session-store.js";

/**
 * Runs against a real Redis (logical DB 15 — see
 * vitest.integration.config.ts), not a mock. Exercises the exact
 * get/set/destroy contract @fastify/session calls on every request, so a
 * change to the JSON shape stored here (e.g. adding a field that doesn't
 * serialize the way we assume) shows up here instead of in production.
 */
function set(sessionId: string, session: Session): Promise<void> {
  return new Promise((resolve, reject) => {
    redisSessionStore.set(sessionId, session, (err) => (err ? reject(err) : resolve()));
  });
}

function get(sessionId: string): Promise<Session | null | undefined> {
  return new Promise((resolve, reject) => {
    redisSessionStore.get(sessionId, (err, session) => (err ? reject(err) : resolve(session)));
  });
}

function destroy(sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    redisSessionStore.destroy(sessionId, (err) => (err ? reject(err) : resolve()));
  });
}

describe("redisSessionStore (real Redis)", () => {
  it("is reachable", async () => {
    expect(await pingSessionRedis()).toBe(true);
  });

  it("round-trips a session through set -> get -> destroy", async () => {
    const sessionId = `test-session-${randomUUID()}`;
    const fakeSession = {
      engineer: { upn: "integration-test@example.com", displayName: "Integration Test", homeTenantId: "test-tenant" },
      csrfToken: "test-token",
    } as unknown as Session;

    try {
      await set(sessionId, fakeSession);
      const loaded = await get(sessionId);
      expect(loaded?.engineer?.upn).toBe("integration-test@example.com");
      expect(loaded?.csrfToken).toBe("test-token");
    } finally {
      await destroy(sessionId);
    }

    expect(await get(sessionId)).toBeNull();
  });
});
