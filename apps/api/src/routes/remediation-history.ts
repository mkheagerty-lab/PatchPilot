import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tables } from "@patchpilot/db";
import { Severity, csvRow } from "@patchpilot/shared";
import {
  listRemediationHistory,
  listRemediationHistoryForExport,
  REMEDIATION_HISTORY_DEFAULT_LIMIT,
  REMEDIATION_HISTORY_MAX_LIMIT,
  REMEDIATION_HISTORY_MAX_EXPORT_ROWS,
  type RemediationHistoryQuery,
  type RemediationHistoryRecord,
  type RemediationAttributionKind,
} from "../history/remediation-history.js";
import { summarizeTimeToRemediate, type TimeToRemediateSummary } from "../posture/time-to-remediate.js";
import { requirePermission } from "../auth/rbac.js";

/**
 * Remediation History: the attributed ledger of every closed finding, plus
 * the exposure/work clock aggregates for the page's own stat tiles.
 *
 * Same `preHandler` guard and query-parsing idiom as routes/audit.ts — the
 * filter predicate itself lives in history/remediation-history.ts (shared
 * with DEMO_MODE), not here.
 */

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
  tenantId: optionalText,
  cveId: optionalText,
  software: optionalText,
  deviceId: optionalText,
  engineer: optionalText,
  severity: Severity.optional(),
  kind: z.enum(tables.remediationKindEnum.enumValues).optional(),
  attribution: z.enum(tables.remediationAttributionEnum.enumValues).optional(),
  // Reclassified rows (the winget-matcher-correction false positive) are
  // excluded by default — this is the dashboard-equivalent view. Pass
  // ?closure=all to see them too, tagged, same as the page's own filter chip.
  closure: z.enum([...tables.remediationClosureEnum.enumValues, "all"]).default("cleared"),
  q: optionalText,
  from: isoDate,
  to: isoDate,
});

const listQuerySchema = baseQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(REMEDIATION_HISTORY_MAX_LIMIT).default(REMEDIATION_HISTORY_DEFAULT_LIMIT),
  cursor: optionalText,
});

type ParsedQuery = z.infer<typeof baseQuerySchema> & { limit?: number; cursor?: string };

function toHistoryQuery(parsed: ParsedQuery): RemediationHistoryQuery {
  return {
    tenantId: parsed.tenantId,
    cveId: parsed.cveId,
    software: parsed.software,
    deviceId: parsed.deviceId,
    engineer: parsed.engineer,
    severity: parsed.severity,
    kind: parsed.kind,
    attribution: parsed.attribution,
    closure: parsed.closure,
    q: parsed.q,
    from: parsed.from,
    to: parsed.to,
    limit: parsed.limit,
    cursor: parsed.cursor,
  };
}

/** Informational only — summarizeTimeToRemediate stores this in its result
 * for the caller to label a chart with, it doesn't filter anything. */
function windowDaysFor(from: string | undefined, to: string | undefined): number {
  if (!from || !to) return 0;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

const ATTRIBUTION_KINDS = tables.remediationAttributionEnum.enumValues;

interface RemediationHistoryStats {
  matchedRows: number;
  truncated: boolean;
  /** detectedAt -> remediatedAt, in hours: how long the tenant was exposed. */
  exposure: TimeToRemediateSummary;
  /** fixStartedAt -> fixFinishedAt, in hours, over attributed rows only: how
   * long the fix itself took once someone acted. Unattributed rows (no job
   * or manual record matched) have no work clock and are excluded. */
  work: TimeToRemediateSummary;
  byAttribution: Record<RemediationAttributionKind, number>;
}

function summarizeStats(rows: RemediationHistoryRecord[], windowDays: number): RemediationHistoryStats {
  const exposureRows = rows.map((r) => ({
    severity: r.severity,
    detectedAt: new Date(r.detectedAt),
    remediatedAt: new Date(r.remediatedAt),
  }));

  const workRows = rows
    .filter((r): r is RemediationHistoryRecord & { fixStartedAt: string; fixFinishedAt: string } =>
      r.fixStartedAt !== null && r.fixFinishedAt !== null,
    )
    .map((r) => ({ severity: r.severity, detectedAt: new Date(r.fixStartedAt), remediatedAt: new Date(r.fixFinishedAt) }));

  const byAttribution = Object.fromEntries(ATTRIBUTION_KINDS.map((k) => [k, 0])) as Record<
    RemediationAttributionKind,
    number
  >;
  for (const r of rows) byAttribution[r.attribution] += 1;

  return {
    matchedRows: rows.length,
    truncated: false,
    exposure: summarizeTimeToRemediate(exposureRows, windowDays),
    work: summarizeTimeToRemediate(workRows, windowDays),
    byAttribution,
  };
}

const CSV_HEADERS = [
  "Cleared (UTC)",
  "First detected (UTC)",
  "CVE",
  "Recommendation ID",
  "Software",
  "Severity",
  "Kind",
  "Tenant",
  "Device",
  "Device ID",
  "Technician",
  "Attribution",
  "Channel",
  "Job ID",
  "Fix started (UTC)",
  "Fix finished (UTC)",
  "Contributing jobs",
  "Closure",
];

function toCsvRow(record: RemediationHistoryRecord): string {
  return csvRow([
    record.remediatedAt,
    record.detectedAt,
    record.cveId,
    record.recommendationId,
    record.software,
    record.severity,
    record.kind,
    record.tenantId,
    record.deviceHostname,
    record.deviceId,
    record.engineer,
    record.attribution,
    record.channel,
    record.jobId,
    record.fixStartedAt,
    record.fixFinishedAt,
    record.contributingJobs,
    record.closure,
  ]);
}

export async function remediationHistoryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("operations:read"));

  app.get("/api/remediation-history", async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid query" });
    }
    return listRemediationHistory(toHistoryQuery(parsed.data));
  });

  /**
   * Unpaged, same hard cap as the export — summarising only the loaded page
   * would understate a larger matching set exactly like a truncated export
   * would, so this shares listRemediationHistoryForExport rather than
   * listRemediationHistory.
   */
  app.get("/api/remediation-history/stats", async (req, reply) => {
    const parsed = baseQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid query" });
    }
    const query = toHistoryQuery(parsed.data);
    const { rows, truncated } = await listRemediationHistoryForExport(query);
    const stats = summarizeStats(rows, windowDaysFor(query.from, query.to));
    return { ...stats, truncated };
  });

  /**
   * Every matching row up to a hard cap, not just the loaded page — same
   * contract as /api/audit/export.csv.
   */
  app.get("/api/remediation-history/export.csv", async (req, reply) => {
    const parsed = baseQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid query" });
    }

    const { rows, truncated } = await listRemediationHistoryForExport(toHistoryQuery(parsed.data));

    let body = "﻿" + csvRow(CSV_HEADERS);
    for (const record of rows) body += toCsvRow(record);

    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="patchpilot-remediation-history-${stamp}.csv"`)
      .header("x-patchpilot-truncated", truncated ? "true" : "false")
      .header("x-patchpilot-row-limit", String(REMEDIATION_HISTORY_MAX_EXPORT_ROWS))
      .send(body);
  });
}
