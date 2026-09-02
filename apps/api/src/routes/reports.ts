import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { audit } from "@patchpilot/graph";
import { db, tables, type TenantRow } from "@patchpilot/db";
import {
  can,
  sanitizeReportBranding,
  slugifyFilename,
  REPORT_TYPES,
  REPORT_TYPE_DEFS,
  type ReportType,
} from "@patchpilot/shared";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import { loadReachableTenants } from "../ai/context.js";
import { loadSlaThresholds } from "./recommendations.js";
import { loadTrend, timeToRemediateBlock } from "./dashboard.js";
import { computeCoverage } from "../catalog/coverage.js";
import { buildReportFacts, rollupTenantPostures } from "../reports/facts.js";
import {
  capRows,
  deviceComplianceTable,
  postureTrendTable,
  renderCsv,
  slaComplianceTable,
  softwareExposureTable,
  timeToRemediateTable,
  REPORT_CSV_MAX_ROWS,
  type CsvTable,
} from "../reports/csv.js";
import { deleteReport, getReport, insertReport, listReports, loadReportPdf } from "../reports/store.js";
import { reportQueue } from "../queue.js";

/**
 * Generated reports: branded PDFs rendered by the worker, stored, re-downloadable.
 *
 * Gated on `operations:read`, not `ai:use`. A report is the product's output for
 * the role whose entire job is reading it, and it is a complete document with AI
 * switched off — charts, tables, deterministic captions and all. Narration is an
 * opt-in extra on top, and only that extra needs `ai:use`.
 *
 * Two failure modes are deliberately different, and the split is the whole point:
 *
 *   - Asking for narration without `ai:use` is **refused** here, 403. An explicit
 *     request is never silently downgraded into something the engineer didn't ask
 *     for and can't tell apart from what they did.
 *   - Asking for narration with `ai:use` when Ollama is down **degrades** in the
 *     worker: captions instead of prose, `narrated=false`, a reason on the row and
 *     on the cover. A capability problem must not deny a reader their PDF.
 *
 * Facts are gathered HERE, before enqueue (see `../reports/facts.ts`), so the
 * worker never re-derives a number and the narration fact-check has a fixed
 * source to check against. The client then polls the `reports` ROW id — not a
 * BullMQ job id: a row survives a Redis restart, a job eviction and a
 * `removeOnComplete`, none of which the report path this replaced survived.
 */

const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;
/** Matches the Dashboard's own default window, so an export taken alongside a
 * report describes the same period without the caller having to say so. */
const DEFAULT_METRIC_WINDOW_DAYS = 30;

/**
 * DEMO_MODE has no database at all (`packages/db/src/client.ts` throws without
 * `DATABASE_URL`), so there is nowhere to store a report and nothing to render
 * one from. Refused explicitly rather than left to explode on a Postgres
 * connect. The CSV metric exports added alongside these routes deliberately do
 * NOT carry this guard — they read through the same demo-aware helpers the list
 * pages use and work fine.
 */
async function rejectInDemoMode(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (config.DEMO_MODE) {
    await reply.code(503).send({
      error: "demo_unsupported",
      detail: "Report generation needs a database. Set DEMO_MODE=false.",
    });
  }
}

/** The `branding` setting, reduced to values a browser may safely be handed:
 * `#rrggbb` colours only, and a logo only if it's a self-contained data URI.
 * Resolved once here so the worker never reads settings. */
async function loadReportBranding() {
  const rows = await db.select().from(tables.settings).where(eq(tables.settings.key, "branding"));
  return sanitizeReportBranding(rows[0]?.value);
}

export async function reportsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("operations:read"));

  const CreateReportBody = z.object({
    reportType: z.enum(REPORT_TYPES),
    /** null/omitted = every tenant this engineer can currently reach. */
    tenantId: z.string().min(1).nullable().optional(),
    windowDays: z.number().int().min(1).max(365).optional(),
    narrate: z.boolean().optional(),
  });

  app.post<{ Body: z.infer<typeof CreateReportBody> }>(
    "/api/reports",
    { preHandler: rejectInDemoMode },
    async (req, reply) => {
      const parsed = CreateReportBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const reportType: ReportType = parsed.data.reportType;
      const def = REPORT_TYPE_DEFS[reportType];
      const narrate = parsed.data.narrate ?? false;

      // Permission, not capability: refuse rather than quietly produce a
      // data-only report the engineer would have no way to distinguish.
      if (narrate && !can(req.currentUser!.role, "ai:use")) {
        return reply.code(403).send({ error: "forbidden", required: "ai:use" });
      }

      const tenantId = parsed.data.tenantId ?? null;
      const reachableTenants = await loadReachableTenants();
      if (tenantId && !reachableTenants.some((t) => t.tenantId === tenantId)) {
        return reply.code(403).send({ error: "tenant_unreachable" });
      }
      if (!tenantId && def.requiresTenant) {
        return reply.code(400).send({ error: "tenant_required" });
      }

      // The tenants the numbers will cover. Resolved here, from the engineer's
      // own reachable set, so `facts.ts` never decides what anyone may see.
      const tenants: TenantRow[] = tenantId
        ? reachableTenants.filter((t) => t.tenantId === tenantId)
        : reachableTenants;
      const tenantName = tenantId ? (tenants[0]?.displayName ?? null) : null;
      const windowDays = parsed.data.windowDays ?? def.defaultWindowDays;

      const now = new Date();
      // Branding first, not in parallel: the facts envelope prints
      // `productName` on the cover, so it has to be the sanitized value the
      // renderer will use, not a second read of the same setting.
      const branding = await loadReportBranding();
      const thresholds = await loadSlaThresholds();
      const facts = await buildReportFacts({
        reportType,
        factsVersion: def.factsVersion,
        tenantId,
        tenants,
        windowDays,
        engineer: req.currentUser!.upn,
        narrationRequested: narrate,
        productName: branding.productName,
        thresholds,
        now,
      });

      const scopeLabel = tenantName ?? "All Tenants";
      const row = await insertReport({
        reportType,
        factsVersion: def.factsVersion,
        tenantId,
        tenantName,
        windowDays,
        title: `${def.label} — ${scopeLabel}`,
        engineer: req.currentUser!.upn,
        // Stored, not derived at download time, so the name in the history list
        // and the name in `content-disposition` can never disagree — and so a
        // tenant called "Müller GmbH" produces a header that doesn't throw.
        filename: slugifyFilename(
          [scopeLabel, def.label, now.toISOString().slice(0, 10)],
          "pdf",
        ),
        expiresAt: new Date(now.getTime() + config.REPORT_RETENTION_DAYS * 86_400_000),
      });

      try {
        await reportQueue.add("generate", {
          reportId: row.id,
          reportType,
          engineer: req.currentUser!.upn,
          tenantId,
          tenantName,
          windowDays,
          title: row.title,
          narrate,
          branding,
          facts,
        });
      } catch (err) {
        // The row exists only to be rendered. A queue that refused the job
        // leaves nothing to render it, so drop the row rather than leave a
        // `pending` report the client polls forever.
        await deleteReport(row.id, req.currentUser!.upn);
        req.log.error({ err }, "[reports] enqueue failed");
        return reply.code(502).send({ error: "enqueue_failed" });
      }

      // No audit row here on purpose: the worker writes exactly one terminal
      // `report:generate` row per run, so the log holds one entry per report
      // rather than an enqueue and a completion to reconcile.
      return reply.code(202).send({ id: row.id, status: row.status });
    },
  );

  const ListQuery = z.object({
    reportType: z.enum(REPORT_TYPES).optional(),
    tenantId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
    cursor: z.string().optional(),
  });

  app.get<{ Querystring: z.infer<typeof ListQuery> }>(
    "/api/reports",
    { preHandler: rejectInDemoMode },
    async (req, reply) => {
      const parsed = ListQuery.safeParse(req.query ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });

      return listReports({
        engineer: req.currentUser!.upn,
        reportType: parsed.data.reportType,
        tenantId: parsed.data.tenantId,
        limit: parsed.data.limit ?? DEFAULT_PAGE,
        cursor: parsed.data.cursor,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/reports/:id",
    { preHandler: rejectInDemoMode },
    async (req, reply) => {
      const row = await getReport(req.params.id, req.currentUser!.upn);
      // 404, not 403: someone else's report id and an id that never existed
      // must be indistinguishable from out here.
      if (!row) return reply.code(404).send({ error: "not_found" });
      return row;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/reports/:id/download",
    { preHandler: rejectInDemoMode },
    async (req, reply) => {
      const row = await loadReportPdf(req.params.id, req.currentUser!.upn);
      if (!row) return reply.code(404).send({ error: "not_found" });
      if (row.status !== "ready" || !row.pdf) {
        return reply.code(409).send({ error: "not_ready", status: row.status });
      }

      await audit({
        engineer: req.currentUser!.upn,
        tenantId: row.tenantId ?? undefined,
        endpoint: `/api/reports/${req.params.id}/download`,
        method: "GET",
        action: "report:download",
        resourceType: "report",
        resourceId: req.params.id,
        resourceLabel: row.title,
        summary: `Downloaded the report "${row.title}"`,
        outcome: "success",
        responseStatus: 200,
      });

      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `attachment; filename="${row.filename}"`)
        .header("content-length", String(row.pdfBytes ?? row.pdf.length))
        // A customer-branded document with named hosts and open CVEs in it —
        // no shared cache should ever hold a copy.
        .header("cache-control", "no-store, private")
        .header("x-content-type-options", "nosniff")
        .send(row.pdf);
    },
  );

  // -------------------------------------------------------------------------
  // Metric CSV exports
  // -------------------------------------------------------------------------
  //
  // No `rejectInDemoMode` on these, deliberately: they read through the same
  // demo-aware helpers the list pages use (`loadTenantPosture`,
  // `computeCoverage`, `loadTrend` all fork on DEMO_MODE internally), so they
  // work in both modes. Only the PDF path needs a database.
  //
  // Same response contract as `/api/remediation-history/export.csv`: BOM,
  // `text/csv; charset=utf-8`, an attachment filename, and the two truncation
  // headers so a client can tell a complete export from a capped one.

  const MetricQuery = z.object({
    tenantId: z.string().min(1).optional(),
    windowDays: z.coerce.number().int().min(1).max(365).optional(),
  });

  interface MetricScope {
    tenants: TenantRow[];
    tenantId: string | undefined;
    scopeLabel: string;
    tenantNames: Map<string, string>;
    windowDays: number;
  }

  /** Resolves `?tenantId`/`?windowDays` against what this engineer can reach.
   * Returns null after sending the error response. */
  async function resolveScope(
    req: FastifyRequest<{ Querystring: z.infer<typeof MetricQuery> }>,
    reply: FastifyReply,
  ): Promise<MetricScope | null> {
    const parsed = MetricQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      await reply.code(400).send({ error: "invalid_query" });
      return null;
    }
    // An absent `tenantId` means all tenants. The web app's `ALL_TENANTS`
    // sentinel is client-only and never reaches the wire — `useDashboardData`
    // does that translation for every endpoint, and `lib/reports.ts` does it
    // for these.
    const requested = parsed.data.tenantId;

    const reachable = await loadReachableTenants();
    if (requested && !reachable.some((t) => t.tenantId === requested)) {
      await reply.code(403).send({ error: "tenant_unreachable" });
      return null;
    }
    const tenants = requested ? reachable.filter((t) => t.tenantId === requested) : reachable;
    return {
      tenants,
      tenantId: requested,
      scopeLabel: requested ? (tenants[0]?.displayName ?? requested) : "All tenants",
      tenantNames: new Map(tenants.map((t) => [t.tenantId, t.displayName])),
      windowDays: parsed.data.windowDays ?? DEFAULT_METRIC_WINDOW_DAYS,
    };
  }

  function sendCsv(reply: FastifyReply, metricId: string, table: CsvTable, truncated: boolean) {
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="patchpilot-${metricId}-${stamp}.csv"`)
      .header("x-patchpilot-truncated", truncated ? "true" : "false")
      .header("x-patchpilot-row-limit", String(REPORT_CSV_MAX_ROWS))
      .send(renderCsv(table));
  }

  app.get<{ Querystring: z.infer<typeof MetricQuery> }>(
    "/api/reports/metrics/sla-compliance.csv",
    async (req, reply) => {
      const scope = await resolveScope(req, reply);
      if (!scope) return reply;

      const rollup = await rollupTenantPostures(scope.tenants, await loadSlaThresholds(), new Date());
      const { rows, truncated } = capRows(rollup.findings);
      return sendCsv(reply, "sla-compliance", slaComplianceTable(rows), truncated);
    },
  );

  app.get<{ Querystring: z.infer<typeof MetricQuery> }>(
    "/api/reports/metrics/device-compliance.csv",
    async (req, reply) => {
      const scope = await resolveScope(req, reply);
      if (!scope) return reply;

      const rollup = await rollupTenantPostures(scope.tenants, await loadSlaThresholds(), new Date());
      const { rows, truncated } = capRows(rollup.devices);
      return sendCsv(
        reply,
        "device-compliance",
        deviceComplianceTable(rows, scope.tenantNames),
        truncated,
      );
    },
  );

  app.get<{ Querystring: z.infer<typeof MetricQuery> }>(
    "/api/reports/metrics/software-exposure.csv",
    async (req, reply) => {
      const scope = await resolveScope(req, reply);
      if (!scope) return reply;

      const coverage = await computeCoverage(scope.tenantId);
      const { rows, truncated } = capRows(coverage.rows);
      return sendCsv(
        reply,
        "software-exposure",
        softwareExposureTable(rows, scope.tenantNames),
        truncated,
      );
    },
  );

  app.get<{ Querystring: z.infer<typeof MetricQuery> }>(
    "/api/reports/metrics/time-to-remediate.csv",
    async (req, reply) => {
      const scope = await resolveScope(req, reply);
      if (!scope) return reply;

      const [summary, thresholds] = await Promise.all([
        timeToRemediateBlock(scope.tenantId, new Date(), scope.windowDays),
        loadSlaThresholds(),
      ]);
      // Fixed at five rows regardless of estate size — nothing to truncate.
      return sendCsv(
        reply,
        "time-to-remediate",
        timeToRemediateTable(summary, thresholds, scope.scopeLabel),
        false,
      );
    },
  );

  app.get<{ Querystring: z.infer<typeof MetricQuery> }>(
    "/api/reports/metrics/posture-trend.csv",
    async (req, reply) => {
      const scope = await resolveScope(req, reply);
      if (!scope) return reply;

      const now = new Date();
      // Once per tenant, never the all-tenants call: that variant sums the
      // day's snapshots across tenants, which is right for the Dashboard chart
      // and wrong for an export whose point is being able to pivot by tenant.
      const series = await Promise.all(
        scope.tenants.map(async (t) => ({
          tenantId: t.tenantId,
          tenantName: t.displayName,
          points: await loadTrend(t.tenantId, scope.windowDays, now),
        })),
      );
      const table = postureTrendTable(series);
      const { rows, truncated } = capRows(table.rows);
      return sendCsv(reply, "posture-trend", { headers: table.headers, rows }, truncated);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/reports/:id",
    { preHandler: rejectInDemoMode },
    async (req, reply) => {
      const row = await deleteReport(req.params.id, req.currentUser!.upn);
      if (!row) return reply.code(404).send({ error: "not_found" });

      await audit({
        engineer: req.currentUser!.upn,
        tenantId: row.tenantId ?? undefined,
        endpoint: `/api/reports/${req.params.id}`,
        method: "DELETE",
        action: "report:delete",
        resourceType: "report",
        resourceId: row.id,
        resourceLabel: row.title,
        summary: `Deleted the report "${row.title}"`,
        outcome: "success",
        responseStatus: 204,
      });

      return reply.code(204).send();
    },
  );
}
