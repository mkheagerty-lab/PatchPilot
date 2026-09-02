import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/rbac.js";
import {
  listAudits,
  listAuditsForExport,
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  AUDIT_MAX_EXPORT_ROWS,
  type AuditQuery,
  type AuditRecord,
} from "@patchpilot/graph";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_CATEGORIES,
  AUDIT_OUTCOMES,
  csvRow,
  systemActorLabel,
} from "@patchpilot/shared";

/**
 * Reading the audit log.
 *
 * The table is write-heavy and unbounded — every Graph GET during a sync writes
 * a row — so both endpoints are server-filtered and hard-capped. Unlike most
 * routes here there is no DEMO_MODE fork: `listAudits` handles that internally
 * against the same predicate, so the demo and production views can't diverge.
 */

/** Fastify gives `?action=a&action=b` as an array, a single one as a string. */
const repeatable = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const list = (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter(Boolean);
    return list.length ? list : undefined;
  });

const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined);

const isoDate = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined)
  .refine((value) => value === undefined || !Number.isNaN(Date.parse(value)), {
    message: "must be an ISO-8601 date-time",
  });

const baseQuerySchema = z.object({
  // Defaulting to "action" is what keeps the page legible: raw Microsoft API
  // traffic outnumbers real decisions by orders of magnitude.
  category: z.enum([...AUDIT_CATEGORIES, "all"]).default("action"),
  tenantId: optionalText,
  actor: optionalText,
  actorType: z.enum(AUDIT_ACTOR_TYPES).optional(),
  action: repeatable,
  resourceType: optionalText,
  resourceId: optionalText,
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  q: optionalText,
  from: isoDate,
  to: isoDate,
});

const listQuerySchema = baseQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(AUDIT_MAX_LIMIT).default(AUDIT_DEFAULT_LIMIT),
  cursor: optionalText,
});

type ParsedQuery = z.infer<typeof baseQuerySchema> & { limit?: number; cursor?: string };

function toAuditQuery(parsed: ParsedQuery): AuditQuery {
  return {
    category: parsed.category,
    tenantId: parsed.tenantId,
    actor: parsed.actor,
    actorType: parsed.actorType,
    actions: parsed.action,
    resourceType: parsed.resourceType,
    resourceId: parsed.resourceId,
    outcome: parsed.outcome,
    q: parsed.q,
    from: parsed.from,
    to: parsed.to,
    limit: parsed.limit,
    cursor: parsed.cursor,
  };
}

const CSV_HEADERS = [
  "Timestamp (UTC)",
  "Actor",
  "Actor type",
  "Tenant",
  "Category",
  "Action",
  "Resource type",
  "Resource",
  "Resource ID",
  "Summary",
  "Outcome",
  "Detail",
  "Endpoint",
  "Method",
  "Status",
  "Latency (ms)",
  "Payload SHA-256",
];

function toCsvRow(record: AuditRecord): string {
  return csvRow([
    record.at,
    systemActorLabel(record.engineer),
    record.actorType,
    record.tenantId,
    record.category,
    record.action,
    record.resourceType,
    record.resourceLabel,
    record.resourceId,
    record.summary,
    record.outcome,
    record.detail,
    record.endpoint,
    record.method,
    record.responseStatus,
    record.latencyMs,
    record.payloadHash,
  ]);
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("audit:read"));

  app.get("/api/audit", async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid query" });
    }
    return listAudits(toAuditQuery(parsed.data));
  });

  /**
   * Exports every matching row, not just the page the client happens to have
   * loaded — a 100-of-4,000 export would be a silent correctness bug, and an
   * audit trail is the worst place to have one. Capped, with a header flag when
   * the cap actually bites (a comment row would corrupt the CSV for consumers).
   */
  app.get("/api/audit/export.csv", async (req, reply) => {
    const parsed = baseQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid query" });
    }

    const { rows, truncated } = await listAuditsForExport(toAuditQuery(parsed.data));

    // BOM so Excel on Windows reads it as UTF-8 — without it the em-dashes that
    // run through this codebase's generated summaries render as mojibake.
    let body = "﻿" + csvRow(CSV_HEADERS);
    for (const record of rows) body += toCsvRow(record);

    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="patchpilot-audit-${stamp}.csv"`)
      .header("x-patchpilot-truncated", truncated ? "true" : "false")
      .header("x-patchpilot-row-limit", String(AUDIT_MAX_EXPORT_ROWS))
      .send(body);
  });
}
