import type { FastifyInstance } from "fastify";
import { RemediationChannel } from "@patchpilot/shared";
import { audit } from "@patchpilot/graph";
import { config } from "../config.js";
import { scheduleQueue } from "../queue.js";
import {
  listSchedules,
  getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
} from "../schedules.js";
import { requirePermission } from "../auth/rbac.js";

/**
 * Recurring schedule routes (Phase 3).
 *
 * CRUD over remediation schedules. Creating or changing a schedule is config,
 * not a Microsoft write, so there is no pre-flight gate here — the gate runs
 * each time the schedule *fires* a remediation, in the worker's fan-out (which
 * re-runs preflight per device and re-checks read-only posture). A schedule is
 * attributed to the engineer who creates it (`engineer`), so its recurring fires
 * run under that engineer's delegated identity. Mutations are still audited (#3)
 * so the schedule history is traceable. DEMO_MODE uses the in-memory store;
 * production reads/writes Postgres.
 */
interface CreateScheduleBody {
  tenantId?: string;
  name?: string;
  cron?: string;
  channel?: string;
  target?: Record<string, unknown>;
}

interface UpdateScheduleBody {
  name?: string;
  cron?: string;
  channel?: string;
  target?: Record<string, unknown>;
  enabled?: boolean;
}

export async function schedulesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("operations:read"));

  app.get<{ Querystring: { tenantId?: string } }>(
    "/api/schedules",
    async (req) => {
      return listSchedules(req.query?.tenantId);
    },
  );

  app.post<{ Body: CreateScheduleBody }>(
    "/api/schedules",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      const { tenantId, name, cron, channel, target } = req.body ?? {};

      if (!tenantId || !name || !cron || !channel) {
        return reply
          .code(400)
          .send({ error: "tenantId, name, cron and channel are required" });
      }

      const parsedChannel = RemediationChannel.safeParse(channel);
      if (!parsedChannel.success) {
        return reply.code(400).send({ error: `unknown channel: ${channel}` });
      }

      const schedule = await createSchedule({
        tenantId,
        name,
        cron,
        channel: parsedChannel.data,
        target,
        engineer: req.session.engineer!.upn,
      });

      await audit({
        engineer: req.session.engineer!.upn,
        tenantId,
        endpoint: "/api/schedules",
        method: "POST",
        action: "schedule:create",
        resourceType: "schedule",
        resourceId: schedule.id,
        resourceLabel: schedule.name,
        summary: `Created the "${schedule.name}" schedule (${cron}, ${parsedChannel.data})`,
        outcome: "success",
        payload: schedule,
        responseStatus: 201,
      });

      return reply.code(201).send(schedule);
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateScheduleBody }>(
    "/api/schedules/:id",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      const { name, cron, channel, target, enabled } = req.body ?? {};

      let parsedChannel: RemediationChannel | undefined;
      if (channel !== undefined) {
        const result = RemediationChannel.safeParse(channel);
        if (!result.success) {
          return reply.code(400).send({ error: `unknown channel: ${channel}` });
        }
        parsedChannel = result.data;
      }

      const schedule = await updateSchedule(req.params.id, {
        name,
        cron,
        channel: parsedChannel,
        target,
        enabled,
      });
      if (!schedule) {
        return reply.code(404).send({ error: "schedule not found" });
      }

      await audit({
        engineer: req.session.engineer!.upn,
        tenantId: schedule.tenantId,
        endpoint: `/api/schedules/${req.params.id}`,
        method: "PUT",
        action: "schedule:update",
        resourceType: "schedule",
        resourceId: schedule.id,
        resourceLabel: schedule.name,
        // Enabling/disabling is the change most worth spotting at a glance —
        // a disabled schedule silently stops remediating.
        summary:
          enabled === undefined
            ? `Updated the "${schedule.name}" schedule`
            : `${enabled ? "Enabled" : "Disabled"} the "${schedule.name}" schedule`,
        outcome: "success",
        payload: req.body,
        responseStatus: 200,
      });

      return schedule;
    },
  );

  // Run a recurring schedule now, on demand — enqueue a single "fire" onto the
  // schedule queue instead of waiting for its next cron tick. This is a producer
  // action only: the worker's fan-out does all the gating (re-checks the schedule
  // is enabled, re-checks read-only posture, filters by target, pre-flights each
  // device), so "Run now" is never a shortcut around the same safety checks a cron
  // fire runs. In DEMO_MODE the worker is inert, so there is nothing to enqueue.
  app.post<{ Params: { id: string } }>(
    "/api/schedules/:id/run",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      const schedule = await getSchedule(req.params.id);
      if (!schedule) {
        return reply.code(404).send({ error: "schedule not found" });
      }

      if (config.DEMO_MODE) {
        return reply.code(202).send({
          queued: false,
          demo: true,
          message: "DEMO_MODE — recurring schedules are inert; nothing was dispatched.",
        });
      }

      await scheduleQueue.add("fire", { scheduleId: schedule.id });

      await audit({
        engineer: req.session.engineer!.upn,
        tenantId: schedule.tenantId,
        endpoint: `/api/schedules/${req.params.id}/run`,
        method: "POST",
        // The engineer's on-demand enqueue. The worker's fan-out writes its own
        // schedule:fire row when the work actually runs.
        action: "schedule:fire",
        resourceType: "schedule",
        resourceId: schedule.id,
        resourceLabel: schedule.name,
        summary: `Ran the "${schedule.name}" schedule on demand`,
        outcome: "success",
        payload: { scheduleId: schedule.id },
        responseStatus: 202,
      });

      return reply.code(202).send({ queued: true });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/schedules/:id",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      // Read before the delete so the audit row can name what was removed —
      // afterwards there is no schedule left to describe.
      const existing = await getSchedule(req.params.id);
      const removed = await deleteSchedule(req.params.id);
      if (!removed) {
        return reply.code(404).send({ error: "schedule not found" });
      }

      await audit({
        engineer: req.session.engineer!.upn,
        tenantId: existing?.tenantId ?? null,
        endpoint: `/api/schedules/${req.params.id}`,
        method: "DELETE",
        action: "schedule:delete",
        resourceType: "schedule",
        resourceId: req.params.id,
        resourceLabel: existing?.name ?? null,
        summary: existing
          ? `Deleted the "${existing.name}" schedule (${existing.cron})`
          : `Deleted schedule ${req.params.id}`,
        outcome: "success",
        responseStatus: 204,
      });

      return reply.code(204).send();
    },
  );
}
