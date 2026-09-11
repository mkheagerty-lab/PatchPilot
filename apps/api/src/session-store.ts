import { Redis } from "ioredis";
import type { Session } from "fastify";
import { config } from "./config.js";

/**
 * Redis-backed store for @fastify/session, replacing the plugin's default
 * in-memory Map (which drops every session on process restart and can't be
 * shared across processes). Implements the plugin's plain callback
 * SessionStore interface directly against ioredis rather than pulling in
 * connect-redis, which targets express-session's Store base class — this
 * app only needs get/set/destroy.
 *
 * A dedicated connection (not the one in queue.ts) so a BullMQ outage can't
 * take auth down with it, and vice versa.
 */
const SESSION_KEY_PREFIX = "patchpilot:session:";
// Matches the session cookie's maxAge in server.ts — a Redis key should
// never outlive the cookie that points at it.
const SESSION_TTL_SECONDS = 8 * 60 * 60;

const connection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});
connection.on("error", (err) => console.error("[api] session store redis error:", err.message));

/** Readiness probe for GET /api/health — proves the Redis server backing
 * sessions is actually reachable, not just configured. */
export async function pingSessionRedis(): Promise<boolean> {
  try {
    await connection.ping();
    return true;
  } catch {
    return false;
  }
}

/** Same probe as pingSessionRedis(), but returns latency for the Server
 *  Health "Services" tab — that page wants a millisecond number to show
 *  alongside the pass/fail pill, which the plain boolean above doesn't carry.
 *  /api/health stays on pingSessionRedis() unchanged; this is additive. */
export async function pingSessionRedisTimed(): Promise<{ ok: boolean; latencyMs: number | null }> {
  const startedAt = Date.now();
  try {
    await connection.ping();
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch {
    return { ok: false, latencyMs: null };
  }
}

export const redisSessionStore = {
  set(sessionId: string, session: Session, callback: (err?: unknown) => void) {
    connection
      .set(SESSION_KEY_PREFIX + sessionId, JSON.stringify(session), "EX", SESSION_TTL_SECONDS)
      .then(() => callback())
      .catch(callback);
  },
  get(sessionId: string, callback: (err: unknown, session?: Session | null) => void) {
    connection
      .get(SESSION_KEY_PREFIX + sessionId)
      .then((raw) => callback(null, raw ? (JSON.parse(raw) as Session) : null))
      .catch((err) => callback(err));
  },
  destroy(sessionId: string, callback: (err?: unknown) => void) {
    connection
      .del(SESSION_KEY_PREFIX + sessionId)
      .then(() => callback())
      .catch(callback);
  },
};
