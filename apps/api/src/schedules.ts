import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db, tables, demoSchedules, type ScheduleRow } from "@patchpilot/db";
import type { RemediationChannel } from "@patchpilot/shared";
import { config } from "./config.js";

/**
 * Recurring remediation schedules (Phase 3 / Phase 5).
 *
 * DEMO_MODE keeps schedules in memory (seeded from fixtures); production reads
 * and writes Postgres. CRUD here is pure bookkeeping and performs no Microsoft
 * call. In production the worker owns the firing: it reconciles enabled
 * schedules into BullMQ job-schedulers (cron) and, when one fires, fans out a
 * remediation job per matching (device, vuln) under the schedule's `engineer`
 * identity (see apps/worker/src/scheduler.ts). The api never fires a schedule —
 * it is request-driven and may run multiple replicas, so a single long-lived
 * worker is the right owner of the cron clock.
 */
export interface ScheduleRecord {
  id: string;
  tenantId: string;
  name: string;
  cron: string;
  channel: RemediationChannel;
  target: Record<string, unknown>;
  enabled: boolean;
  /** UPN the recurring run is attributed to; null for pre-attribution rows. */
  engineer: string | null;
  createdAt: string;
}

export interface NewSchedule {
  tenantId: string;
  name: string;
  cron: string;
  channel: RemediationChannel;
  target?: Record<string, unknown>;
  /** UPN of the creating engineer — recurring fires run under this identity. */
  engineer: string;
}

export interface SchedulePatch {
  name?: string;
  cron?: string;
  channel?: RemediationChannel;
  target?: Record<string, unknown>;
  enabled?: boolean;
}

function rowToRecord(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    cron: row.cron,
    channel: row.channel as RemediationChannel,
    target: row.target,
    enabled: row.enabled,
    engineer: row.engineer,
    createdAt: (row.createdAt as Date).toISOString(),
  };
}

const demoScheduleStore: ScheduleRecord[] = demoSchedules.map(rowToRecord);

export async function listSchedules(
  tenantId?: string,
): Promise<ScheduleRecord[]> {
  if (config.DEMO_MODE) {
    return tenantId
      ? demoScheduleStore.filter((s) => s.tenantId === tenantId)
      : demoScheduleStore.slice();
  }
  const rows = tenantId
    ? await db
        .select()
        .from(tables.schedules)
        .where(eq(tables.schedules.tenantId, tenantId))
        .orderBy(desc(tables.schedules.createdAt))
    : await db
        .select()
        .from(tables.schedules)
        .orderBy(desc(tables.schedules.createdAt));
  return rows.map(rowToRecord);
}

export async function getSchedule(id: string): Promise<ScheduleRecord | null> {
  if (config.DEMO_MODE) {
    return demoScheduleStore.find((s) => s.id === id) ?? null;
  }
  const [row] = await db
    .select()
    .from(tables.schedules)
    .where(eq(tables.schedules.id, id))
    .limit(1);
  return row ? rowToRecord(row) : null;
}

export async function createSchedule(
  input: NewSchedule,
): Promise<ScheduleRecord> {
  const record: ScheduleRecord = {
    id: randomUUID(),
    tenantId: input.tenantId,
    name: input.name,
    cron: input.cron,
    channel: input.channel,
    target: input.target ?? {},
    enabled: true,
    engineer: input.engineer,
    createdAt: new Date().toISOString(),
  };

  if (config.DEMO_MODE) {
    demoScheduleStore.unshift(record);
    return record;
  }

  const [row] = await db
    .insert(tables.schedules)
    .values({
      id: record.id,
      tenantId: record.tenantId,
      name: record.name,
      cron: record.cron,
      channel: record.channel,
      target: record.target,
      enabled: record.enabled,
      engineer: record.engineer,
    })
    .returning();
  return rowToRecord(row!);
}

export async function updateSchedule(
  id: string,
  patch: SchedulePatch,
): Promise<ScheduleRecord | null> {
  if (config.DEMO_MODE) {
    const schedule = demoScheduleStore.find((s) => s.id === id);
    if (!schedule) return null;
    if (patch.name !== undefined) schedule.name = patch.name;
    if (patch.cron !== undefined) schedule.cron = patch.cron;
    if (patch.channel !== undefined) schedule.channel = patch.channel;
    if (patch.target !== undefined) schedule.target = patch.target;
    if (patch.enabled !== undefined) schedule.enabled = patch.enabled;
    return schedule;
  }

  const [row] = await db
    .update(tables.schedules)
    .set(patch)
    .where(eq(tables.schedules.id, id))
    .returning();
  return row ? rowToRecord(row) : null;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  if (config.DEMO_MODE) {
    const idx = demoScheduleStore.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    demoScheduleStore.splice(idx, 1);
    return true;
  }

  const rows = await db
    .delete(tables.schedules)
    .where(eq(tables.schedules.id, id))
    .returning();
  return rows.length > 0;
}
