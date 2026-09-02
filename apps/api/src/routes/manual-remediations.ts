import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import type { ManualRemediation } from "@patchpilot/shared";
import { config } from "../config.js";
import { audit } from "@patchpilot/graph";
import { requirePermission } from "../auth/rbac.js";

/**
 * Manual remediation records (Remediation Options "Manual -> record" sub-flow).
 *
 * An engineer's free-text note that a finding was fixed by hand, outside any
 * PatchPilot channel — no script, no Graph call, no job row. Tracked as
 * "waiting on Defender" (confirmedAt null) until the next sync stops
 * reporting the CVE on that device (see the auto-confirmation logic in
 * graph/sync.ts's syncVulnerabilities), mirroring the existing
 * remediationVerifications "fixed on device, awaiting Defender" pattern.
 *
 * DEMO_MODE never queries Postgres (see config.ts), so this keeps its own
 * mutable in-memory list, same pattern as jobs.ts's demoJobLog — read by both
 * this route's GET and routes/data.ts's per-device vulnerabilities join.
 */
export const demoManualRemediations: ManualRemediation[] = [];

type ManualRemediationRow = InferSelectModel<typeof tables.manualRemediations>;

function rowToRecord(row: ManualRemediationRow): ManualRemediation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    deviceId: row.deviceId,
    cveId: row.cveId,
    software: row.software,
    notes: row.notes,
    engineer: row.engineer,
    markedAt: row.markedAt.toISOString(),
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
  };
}

interface CreateBody {
  tenantId?: string;
  deviceId?: string;
  cveId?: string | null;
  software?: string;
  notes?: string;
}

export async function manualRemediationsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("operations:read"));

  /** Badge lookups: has this device (optionally this CVE) already been marked? */
  app.get<{ Querystring: { tenantId?: string; deviceId?: string } }>(
    "/api/manual-remediations",
    async (req, reply) => {
      const { tenantId, deviceId } = req.query ?? {};
      if (!tenantId) {
        return reply.code(400).send({ error: "tenantId is required" });
      }

      if (config.DEMO_MODE) {
        return demoManualRemediations
          .filter((r) => r.tenantId === tenantId && (!deviceId || r.deviceId === deviceId))
          .sort((a, b) => b.markedAt.localeCompare(a.markedAt));
      }

      const conditions = [eq(tables.manualRemediations.tenantId, tenantId)];
      if (deviceId) conditions.push(eq(tables.manualRemediations.deviceId, deviceId));
      const rows = await db
        .select()
        .from(tables.manualRemediations)
        .where(and(...conditions))
        .orderBy(desc(tables.manualRemediations.markedAt));
      return rows.map(rowToRecord);
    },
  );

  app.post<{ Body: CreateBody }>(
    "/api/manual-remediations",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
    const { tenantId, deviceId, cveId, software, notes } = req.body ?? {};
    if (!tenantId || !deviceId || !software?.trim() || !notes?.trim()) {
      return reply
        .code(400)
        .send({ error: "tenantId, deviceId, software and notes are required" });
    }

    const engineer = req.session.engineer!.upn;
    const record: ManualRemediation = {
      id: randomUUID(),
      tenantId,
      deviceId,
      cveId: cveId?.trim() || null,
      software: software.trim(),
      notes: notes.trim(),
      engineer,
      markedAt: new Date().toISOString(),
      confirmedAt: null,
    };

    if (config.DEMO_MODE) {
      demoManualRemediations.unshift(record);
    } else {
      await db.insert(tables.manualRemediations).values({
        id: record.id,
        tenantId: record.tenantId,
        deviceId: record.deviceId,
        cveId: record.cveId,
        software: record.software,
        notes: record.notes,
        engineer: record.engineer,
      });
    }

    // Synthetic, non-Graph audit entry — no Microsoft API is called for a
    // manually-recorded fix.
    await audit({
      engineer,
      tenantId,
      endpoint: "manual-remediation:record",
      method: "POST",
      action: "remediation:manual-record",
      resourceType: "manual-remediation",
      resourceId: record.id,
      resourceLabel: record.software,
      summary: `Recorded a manual fix for ${record.software}${record.cveId ? ` (${record.cveId})` : ""} on ${deviceId}`,
      outcome: "success",
      payload: { deviceId, cveId: record.cveId, software: record.software },
      responseStatus: 201,
    });

    return reply.code(201).send(record);
    },
  );
}
