import type { FastifyInstance } from "fastify";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { audit } from "@patchpilot/graph";
import { MISSED_FIRE_GRACE_MS, STALE_TIMEOUT_MS, WORKER_RESTART_CHANNEL } from "@patchpilot/shared";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import { connection, remediationQueue, reportQueue, scheduleQueue } from "../queue.js";
import { pingSessionRedisTimed } from "../session-store.js";
import { exitAfterReply } from "../restart-after-reply.js";
import { sampleCpuPercent, sampleDisk, sampleMemory } from "../host-metrics.js";

/**
 * Settings > Server Health: live host resource graphs, DB/Redis/queue/scheduler
 * status tiles, and confirmed restart actions for the api and worker processes.
 *
 * Phase 1 only (see the Server Health plan) — restarting individual infra
 * containers or the whole compose stack needs the `updater` sidecar's Docker
 * socket access and is a deliberate fast-follow, not built here.
 *
 * Every GET here is `settings:read` (every role, including reader — this is a
 * status page). Both restart POSTs are `settings:write` (admin only), matching
 * every other risky action in Settings (Updates run-now/rollback, demo-mode
 * enable).
 *
 * DEMO_MODE never touches real Postgres/Redis/BullMQ connections (they're
 * lazily-connected placeholders — see config.ts) so every GET here returns a
 * clearly-labelled simulated reading instead of hanging or throwing, same
 * spirit as routes/status.ts's `/api/health`. Both restart actions 503 in
 * DEMO_MODE — there is no real process for them to restart.
 */

export async function serverHealthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("settings:read"));

  app.get("/api/server-health/resources", async () => {
    if (config.DEMO_MODE) {
      return {
        demoMode: true,
        sampledAt: new Date().toISOString(),
        cpu: { percent: null, cores: 1 },
        memory: { totalBytes: 0, freeBytes: 0, usedBytes: 0, percent: 0 },
        disk: null,
      };
    }
    return {
      demoMode: false,
      sampledAt: new Date().toISOString(),
      cpu: sampleCpuPercent(),
      memory: sampleMemory(),
      disk: sampleDisk(),
    };
  });

  app.get("/api/server-health/services", async () => {
    if (config.DEMO_MODE) {
      return { demoMode: true, database: { ok: true, latencyMs: null }, redis: { ok: true, latencyMs: null } };
    }
    const startedAt = Date.now();
    const [dbOk, redis] = await Promise.all([
      db
        .execute(sql`select 1`)
        .then(() => true)
        .catch(() => false),
      pingSessionRedisTimed(),
    ]);
    return {
      demoMode: false,
      database: { ok: dbOk, latencyMs: dbOk ? Date.now() - startedAt : null },
      redis,
    };
  });

  app.get("/api/server-health/queues", async () => {
    if (config.DEMO_MODE) {
      return {
        demoMode: true,
        queues: [
          { name: "remediation", counts: {}, workers: 0 },
          { name: "schedules", counts: {}, workers: 0 },
          { name: "reports", counts: {}, workers: null },
        ],
      };
    }
    const [remediationCounts, scheduleCounts, reportCounts, remediationWorkers, scheduleWorkers] =
      await Promise.all([
        remediationQueue.getJobCounts(),
        scheduleQueue.getJobCounts(),
        reportQueue.getJobCounts(),
        remediationQueue.getWorkersCount(),
        scheduleQueue.getWorkersCount(),
      ]);
    return {
      demoMode: false,
      queues: [
        { name: "remediation", counts: remediationCounts, workers: remediationWorkers },
        { name: "schedules", counts: scheduleCounts, workers: scheduleWorkers },
        // No dedicated BullMQ Worker process for reports — apps/worker's
        // reports/worker.ts runs it inline inside the same process as the
        // remediation/schedule workers, so a separate liveness count here
        // would just duplicate remediationWorkers.
        { name: "reports", counts: reportCounts, workers: null },
      ],
    };
  });

  app.get("/api/server-health/schedulers", async () => {
    if (config.DEMO_MODE) {
      return { demoMode: true, schedulers: [] };
    }
    const [jobSchedulers, scheduleRows] = await Promise.all([
      scheduleQueue.getJobSchedulers(0, -1, true),
      db.select().from(tables.schedules).where(eq(tables.schedules.enabled, true)),
    ]);
    const scheduleById = new Map(scheduleRows.map((s) => [s.id, s] as const));
    const now = Date.now();

    return {
      demoMode: false,
      schedulers: jobSchedulers.map((s) => {
        const schedule = scheduleById.get(s.key);
        const nextFire = typeof s.next === "number" ? s.next : null;
        const stuck = nextFire === null || nextFire < now - MISSED_FIRE_GRACE_MS;
        return {
          scheduleId: s.key,
          name: schedule?.name ?? "(deleted schedule)",
          cron: s.pattern ?? null,
          timezone: s.tz ?? null,
          nextFireAt: nextFire ? new Date(nextFire).toISOString() : null,
          stuck,
        };
      }),
    };
  });

  app.get("/api/server-health/jobs-summary", async () => {
    if (config.DEMO_MODE) {
      return { demoMode: true, stuckCount: 0 };
    }
    const cutoff = new Date(Date.now() - STALE_TIMEOUT_MS);
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tables.jobs)
      .where(
        or(
          and(eq(tables.jobs.status, "running"), lt(tables.jobs.startedAt, cutoff)),
          and(
            eq(tables.jobs.status, "queued"),
            or(
              and(isNull(tables.jobs.scheduleAt), lt(tables.jobs.queuedAt, cutoff)),
              lt(tables.jobs.scheduleAt, cutoff),
            ),
          ),
        ),
      );
    return { demoMode: false, stuckCount: rows[0]?.count ?? 0 };
  });

  app.post(
    "/api/server-health/restart-api",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(503).send({
          error: "demo_unsupported",
          detail: "Restarting the api needs a real process manager. Set DEMO_MODE=false.",
        });
      }
      await audit({
        engineer: req.currentUser!.upn,
        endpoint: "/api/server-health/restart-api",
        method: "POST",
        action: "server:restart-api",
        resourceType: "server-process",
        resourceId: "api",
        resourceLabel: "api",
        summary: "Restarted the api process",
        outcome: "success",
        responseStatus: 202,
      });
      reply.code(202).send({ restarting: true });
      exitAfterReply(reply);
    },
  );

  app.post(
    "/api/server-health/restart-worker",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(503).send({
          error: "demo_unsupported",
          detail: "Restarting the worker needs a real process manager. Set DEMO_MODE=false.",
        });
      }
      await connection.publish(WORKER_RESTART_CHANNEL, "restart").catch(() => undefined);
      await audit({
        engineer: req.currentUser!.upn,
        endpoint: "/api/server-health/restart-worker",
        method: "POST",
        action: "server:restart-worker",
        resourceType: "server-process",
        resourceId: "worker",
        resourceLabel: "worker",
        summary: "Restarted the worker process",
        outcome: "success",
        responseStatus: 202,
      });
      return reply.code(202).send({ restarting: true });
    },
  );
}
