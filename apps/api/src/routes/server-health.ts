import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { audit } from "@patchpilot/graph";
import {
  CONTAINER_STATS_STALE_MS,
  HOST_STATUS_STALE_MS,
  isRestartableContainer,
  MISSED_FIRE_GRACE_MS,
  RESTARTABLE_CONTAINERS,
  STALE_TIMEOUT_MS,
} from "@patchpilot/shared";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import { remediationQueue, reportQueue, scheduleQueue } from "../queue.js";
import { pingSessionRedisTimed } from "../session-store.js";
import { sampleCpuPercent, sampleDisk, sampleMemory } from "../host-metrics.js";

/**
 * Settings > Server Health: live host resource graphs, DB/Redis/queue/scheduler
 * status tiles, and confirmed restart actions for individual infra containers
 * and the whole compose stack (see restart-container/restart-stack below).
 *
 * These mutations don't restart anything themselves: they only have
 * `settings:write`, not the Docker socket, so they insert a row into
 * `server_control_requests` and reply 202. The `updater` sidecar (the only
 * container with both Docker socket access and a full repo checkout — see
 * infra/updater/run.sh) polls that table the same way it already polls
 * `update_runs`, and actually runs `docker compose restart`.
 *
 * Every GET here is `settings:read` (every role, including reader — this is a
 * status page). Every POST is `settings:write` (admin only), matching every
 * other risky action in Settings (Updates run-now/rollback, demo-mode enable).
 *
 * DEMO_MODE never touches real Postgres/Redis/BullMQ connections (they're
 * lazily-connected placeholders — see config.ts) so every GET here returns a
 * clearly-labelled simulated reading instead of hanging or throwing, same
 * spirit as routes/status.ts's `/api/health`. Every restart action 503s in
 * DEMO_MODE — there is no real process/container/updater for it to act on.
 *
 * This used to also have synchronous restart-api/restart-worker actions
 * (self-`process.exit()`, relying on Docker's restart policy) — removed as
 * a duplicate of restart-container's "api"/"worker" targets, which do the
 * same job via one consistent, tracked, queued path instead of two.
 */

/** Terminal-history control requests to return to the client — same
 *  convention as update-settings.ts's HISTORY_LIMIT. */
const CONTROL_HISTORY_LIMIT = 20;

async function findPendingControlRequest() {
  if (config.DEMO_MODE) return null;
  const [row] = await db
    .select()
    .from(tables.serverControlRequests)
    .where(inArray(tables.serverControlRequests.status, ["queued", "running"]))
    .orderBy(tables.serverControlRequests.createdAt)
    .limit(1);
  return row ?? null;
}

async function loadControlHistory() {
  if (config.DEMO_MODE) return [];
  return db
    .select()
    .from(tables.serverControlRequests)
    .where(inArray(tables.serverControlRequests.status, ["succeeded", "failed"]))
    .orderBy(desc(tables.serverControlRequests.createdAt))
    .limit(CONTROL_HISTORY_LIMIT);
}

/** Terminal-history host reboot requests to return to the client — same
 *  convention as CONTROL_HISTORY_LIMIT above. */
const HOST_REBOOT_HISTORY_LIMIT = 20;

async function findPendingHostReboot() {
  if (config.DEMO_MODE) return null;
  const [row] = await db
    .select()
    .from(tables.hostRebootRequests)
    .where(inArray(tables.hostRebootRequests.status, ["queued", "issuing", "issued"]))
    .orderBy(tables.hostRebootRequests.createdAt)
    .limit(1);
  return row ?? null;
}

async function loadHostRebootHistory() {
  if (config.DEMO_MODE) return [];
  return db
    .select()
    .from(tables.hostRebootRequests)
    .where(inArray(tables.hostRebootRequests.status, ["confirmed", "failed"]))
    .orderBy(desc(tables.hostRebootRequests.createdAt))
    .limit(HOST_REBOOT_HISTORY_LIMIT);
}

const RestartContainerBody = z.object({ target: z.string() });

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

  app.get("/api/server-health/container-stats", async () => {
    if (config.DEMO_MODE) {
      return {
        demoMode: true,
        containers: RESTARTABLE_CONTAINERS.map((container) => ({
          container,
          cpuPercent: null,
          memUsage: "—",
          netIo: "—",
          blockIo: "—",
          sampledAt: null,
          stale: true,
          image: null,
          diskSize: null,
          health: null,
          startedAt: null,
          restartCount: null,
        })),
      };
    }
    const rows = await db.select().from(tables.containerStats);
    const byContainer = new Map(rows.map((r) => [r.container, r] as const));
    const now = Date.now();
    return {
      demoMode: false,
      containers: RESTARTABLE_CONTAINERS.map((container) => {
        const row = byContainer.get(container);
        if (!row) {
          return {
            container,
            cpuPercent: null,
            memUsage: "—",
            netIo: "—",
            blockIo: "—",
            sampledAt: null,
            stale: true,
            image: null,
            diskSize: null,
            health: null,
            startedAt: null,
            restartCount: null,
          };
        }
        return {
          container,
          cpuPercent: row.cpuPercent,
          memUsage: row.memUsage,
          netIo: row.netIo,
          blockIo: row.blockIo,
          sampledAt: row.sampledAt.toISOString(),
          stale: now - row.sampledAt.getTime() > CONTAINER_STATS_STALE_MS,
          image: row.image,
          diskSize: row.diskSize,
          health: row.health,
          startedAt: row.startedAt ? row.startedAt.toISOString() : null,
          restartCount: row.restartCount,
        };
      }),
    };
  });

  app.get("/api/server-health/control-requests", async () => {
    if (config.DEMO_MODE) {
      return { demoMode: true, pendingRequest: null, history: [] };
    }
    const [pendingRequest, history] = await Promise.all([
      findPendingControlRequest(),
      loadControlHistory(),
    ]);
    return { demoMode: false, pendingRequest, history };
  });

  app.get("/api/server-health/host-status", async () => {
    if (config.DEMO_MODE) {
      return {
        demoMode: true,
        rebootRequired: false,
        rebootRequiredPackages: null,
        lastUnattendedUpgradeAt: null,
        dockerLiveRestoreActive: false,
        sampledAt: null,
        stale: true,
      };
    }
    const [row] = await db.select().from(tables.hostStatus).where(eq(tables.hostStatus.id, "host"));
    if (!row) {
      return {
        demoMode: false,
        rebootRequired: false,
        rebootRequiredPackages: null,
        lastUnattendedUpgradeAt: null,
        dockerLiveRestoreActive: null,
        sampledAt: null,
        stale: true,
      };
    }
    return {
      demoMode: false,
      rebootRequired: row.rebootRequired,
      rebootRequiredPackages: row.rebootRequiredPackages,
      lastUnattendedUpgradeAt: row.lastUnattendedUpgradeAt ? row.lastUnattendedUpgradeAt.toISOString() : null,
      dockerLiveRestoreActive: row.dockerLiveRestoreActive,
      sampledAt: row.sampledAt.toISOString(),
      stale: Date.now() - row.sampledAt.getTime() > HOST_STATUS_STALE_MS,
    };
  });

  app.get("/api/server-health/host-reboot-requests", async () => {
    if (config.DEMO_MODE) {
      return { demoMode: true, pendingRequest: null, history: [] };
    }
    const [pendingRequest, history] = await Promise.all([
      findPendingHostReboot(),
      loadHostRebootHistory(),
    ]);
    return { demoMode: false, pendingRequest, history };
  });

  app.post(
    "/api/server-health/reboot-host",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(503).send({
          error: "demo_unsupported",
          detail: "Rebooting the server needs the updater sidecar. Set DEMO_MODE=false.",
        });
      }
      const pending = await findPendingHostReboot();
      if (pending) {
        return reply
          .code(409)
          .send({ error: "host_reboot_already_pending", pendingRequest: pending });
      }

      const [row] = await db
        .insert(tables.hostRebootRequests)
        .values({ requestedBy: req.currentUser!.upn })
        .returning();

      await audit({
        engineer: req.currentUser!.upn,
        endpoint: "/api/server-health/reboot-host",
        method: "POST",
        action: "server:os-reboot",
        resourceType: "host-reboot-request",
        resourceId: row!.id,
        resourceLabel: "host",
        summary: "Requested a full server (OS) reboot",
        outcome: "success",
        responseStatus: 202,
      });
      return reply.code(202).send(row);
    },
  );

  app.post(
    "/api/server-health/restart-container",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(503).send({
          error: "demo_unsupported",
          detail: "Restarting a container needs the updater sidecar. Set DEMO_MODE=false.",
        });
      }
      const parsed = RestartContainerBody.safeParse(req.body ?? {});
      if (!parsed.success || !isRestartableContainer(parsed.data.target)) {
        return reply.code(400).send({ error: "invalid_target" });
      }
      const { target } = parsed.data;

      const pending = await findPendingControlRequest();
      if (pending) {
        return reply
          .code(409)
          .send({ error: "control_request_already_pending", pendingRequest: pending });
      }

      const [row] = await db
        .insert(tables.serverControlRequests)
        .values({ action: "restart-container", target, requestedBy: req.currentUser!.upn })
        .returning();

      await audit({
        engineer: req.currentUser!.upn,
        endpoint: "/api/server-health/restart-container",
        method: "POST",
        action: "server:restart-container",
        resourceType: "server-control-request",
        resourceId: target,
        resourceLabel: target,
        summary: `Requested a restart of the ${target} container`,
        outcome: "success",
        responseStatus: 202,
      });
      return reply.code(202).send(row);
    },
  );

  app.post(
    "/api/server-health/restart-stack",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(503).send({
          error: "demo_unsupported",
          detail: "Restarting the stack needs the updater sidecar. Set DEMO_MODE=false.",
        });
      }
      const pending = await findPendingControlRequest();
      if (pending) {
        return reply
          .code(409)
          .send({ error: "control_request_already_pending", pendingRequest: pending });
      }

      const [row] = await db
        .insert(tables.serverControlRequests)
        .values({ action: "restart-stack", requestedBy: req.currentUser!.upn })
        .returning();

      await audit({
        engineer: req.currentUser!.upn,
        endpoint: "/api/server-health/restart-stack",
        method: "POST",
        action: "server:restart-stack",
        resourceType: "server-control-request",
        resourceId: "stack",
        resourceLabel: "stack",
        summary: "Requested a restart of the whole server stack",
        outcome: "success",
        responseStatus: 202,
      });
      return reply.code(202).send(row);
    },
  );
}
