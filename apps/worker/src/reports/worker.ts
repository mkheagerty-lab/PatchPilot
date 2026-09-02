/**
 * The report queue consumer.
 *
 * Unlike the retired `ai-report-worker.ts`, this starts UNCONDITIONALLY —
 * NOT behind `AI_FEATURES_ENABLED`. That flag used to gate the whole worker
 * (a deploy with AI off never generated reports at all), which is exactly
 * the trap decision #4 in the reports plan exists to close: a reader who
 * only has `operations:read` must still get charts, tables and CSVs with no
 * AI involved. Only the narration attempt below checks `AI_FEATURES_ENABLED`
 * — rendering itself is gated by `REPORT_PDF_ENABLED` instead (see env.ts),
 * a deliberately separate kill switch.
 *
 * Persistence lives in the `reports` row, not the BullMQ return value — see
 * `REPORT_QUEUE`'s doc comment in packages/shared/src/queue.ts for why. Every
 * write here goes straight through Drizzle rather than through
 * `apps/api/src/reports/store.ts`: that module lives in a different app with
 * no importable package boundary between them (the same constraint
 * `ai-report-worker.ts` and `scheduler.ts` already document), so the few
 * columns this file touches are written directly, mirroring how `index.ts`
 * writes `tables.jobs` directly rather than importing an api-side store.
 */
import { createHash } from "node:crypto";
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { auditSafe } from "@patchpilot/graph";
import {
  factCheckSection,
  pickSectionFacts,
  REPORT_QUEUE,
  REPORT_TYPE_DEFS,
  ReportJob,
  type AnyReportFacts,
  type AuditOutcome,
} from "@patchpilot/shared";
import { sendAlertEmail } from "@patchpilot/shared/alerting";
import { connection } from "../queue.js";
import { reportEnv } from "./env.js";
import { assertStillAuthorized, canNarrate, type AuthorizedEngineer } from "./authorize.js";
import { narrateSection } from "./narrate.js";
import { renderPdf } from "./render.js";
import type { ReportRenderInput } from "./template.js";
import { enforcePerEngineerCap } from "./retention.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "reports" });

/** Distinguishes the outer `REPORT_JOB_TIMEOUT_MS` backstop firing from
 * `runReport` failing on its own — only the backstop needs its own
 * terminal-status write, since every other path through `runReport` already
 * writes one before it rethrows. */
class ReportJobTimeoutError extends Error {}

function scopeLabelFor(payload: ReportJob): string {
  return payload.tenantName ? ` for ${payload.tenantName}` : " (all tenants)";
}

/**
 * Attempts narration for every section of the report type, all-or-nothing:
 * if any section fails partway, the partial results are discarded rather
 * than mixing AI prose with captions in one document — `ReportRenderInput.narrated`
 * is a single cover-page claim ("AI-written" vs "Data only"), and a report
 * that's half one and half the other would make that claim false either way.
 *
 * Never throws — every reason narration didn't happen (missing permission,
 * AI disabled, or an Ollama failure) comes back as `narrationSkippedReason`
 * so the caller can degrade to captions instead of failing the report.
 */
async function attemptNarration(
  payload: ReportJob,
  engineer: AuthorizedEngineer,
  facts: AnyReportFacts,
): Promise<{
  narration: Readonly<Record<string, string>>;
  narrated: boolean;
  narrationSkippedReason: string | null;
  factCheckWarnings: string[];
}> {
  if (!payload.narrate) {
    return { narration: {}, narrated: false, narrationSkippedReason: null, factCheckWarnings: [] };
  }
  if (!canNarrate(engineer)) {
    return {
      narration: {},
      narrated: false,
      narrationSkippedReason: "the requesting engineer's role no longer includes ai:use",
      factCheckWarnings: [],
    };
  }
  if (!reportEnv.AI_FEATURES_ENABLED) {
    return {
      narration: {},
      narrated: false,
      narrationSkippedReason: "AI features are disabled on this deployment",
      factCheckWarnings: [],
    };
  }

  const def = REPORT_TYPE_DEFS[payload.reportType];
  try {
    const narration: Record<string, string> = {};
    const factCheckWarnings: string[] = [];
    for (const section of def.sections) {
      const subset = pickSectionFacts(facts, section.factsKeys);
      const body = await narrateSection(section.title, subset);
      narration[section.id] = body;
      factCheckWarnings.push(...factCheckSection(section.title, body, subset));
    }
    return { narration, narrated: true, narrationSkippedReason: null, factCheckWarnings };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { narration: {}, narrated: false, narrationSkippedReason: message, factCheckWarnings: [] };
  }
}

/**
 * Runs one report end to end: re-authorize, narrate (optional, degrades
 * rather than fails), render, persist. The single try/catch around the body
 * guarantees that anything thrown after the `rendering` write below still
 * lands the row on a terminal status with an audit row — see the comment on
 * that catch block.
 */
async function runReport(payload: ReportJob): Promise<void> {
  const startedAt = Date.now();
  const scopeLabel = scopeLabelFor(payload);
  const reportLog = log.child({ reportId: payload.reportId, engineer: payload.engineer });

  await db
    .update(tables.reports)
    .set({ status: "rendering", startedAt: new Date() })
    .where(eq(tables.reports.id, payload.reportId));

  const auditReport = (outcome: AuditOutcome, summary: string, detail?: string | null): Promise<void> =>
    auditSafe({
      engineer: payload.engineer,
      tenantId: payload.tenantId ?? undefined,
      endpoint: "reports",
      method: "WORKER",
      action: "report:generate",
      resourceType: "report",
      resourceId: payload.reportId,
      resourceLabel: payload.title,
      summary,
      outcome,
      detail: detail ?? null,
      responseStatus: outcome === "failure" ? 500 : 200,
      latencyMs: Date.now() - startedAt,
    });

  try {
    const engineer = await assertStillAuthorized(payload);

    if (!reportEnv.REPORT_PDF_ENABLED) {
      throw new Error("PDF rendering is disabled on this worker deployment");
    }

    const facts = payload.facts as AnyReportFacts;
    const { narration, narrated, narrationSkippedReason, factCheckWarnings } = await attemptNarration(
      payload,
      engineer,
      facts,
    );

    const input: ReportRenderInput = {
      reportType: payload.reportType,
      title: payload.title,
      engineer: payload.engineer,
      branding: payload.branding,
      facts,
      narration,
      narrated,
      narrationSkippedReason,
      factCheckWarnings,
    };

    const { pdf } = await renderPdf(input);
    const pdfSha256 = createHash("sha256").update(pdf).digest("hex");

    await db
      .update(tables.reports)
      .set({
        status: "ready",
        narrated,
        narrationSkippedReason,
        factCheckWarnings,
        pdf,
        pdfBytes: pdf.length,
        pdfSha256,
        completedAt: new Date(),
      })
      .where(eq(tables.reports.id, payload.reportId));

    // Best-effort: the report itself is already durably `ready` regardless
    // of whether the cap prune succeeds.
    await enforcePerEngineerCap(payload.engineer).catch((err) =>
      reportLog.error({ err }, "retention cap enforcement failed"),
    );

    // "partial" covers two distinct situations, same discipline as the
    // retired ai-report-worker.ts: numerals that didn't check out, and
    // narration that was requested but didn't happen.
    const outcome: AuditOutcome =
      factCheckWarnings.length > 0 || (payload.narrate && !narrated) ? "partial" : "success";
    await auditReport(
      outcome,
      `Generated a report${scopeLabel}`,
      factCheckWarnings.length ? factCheckWarnings.join("; ") : narrationSkippedReason,
    );
  } catch (err) {
    // Catches everything past the `rendering` write above — auth refusal,
    // rendering disabled, a Playwright failure, an oversized PDF, a DB error
    // on the ready-write itself. Whatever it is, the row must not be left at
    // `rendering` forever, which is what makes this one catch-all correct
    // rather than scattering a fail() call after every step.
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(tables.reports)
      .set({ status: "failed", error: message, completedAt: new Date() })
      .where(eq(tables.reports.id, payload.reportId))
      .catch((writeErr) => reportLog.error({ err: writeErr }, "failed to write failure status"));
    await auditReport("failure", `Report generation failed${scopeLabel}`, message).catch(() => {});
    throw err;
  }
}

/** Starts the report consumer. Always active — see the module doc for why
 * this, unlike the retired AI-report worker, is never a no-op. */
export function startReportWorker(): () => Promise<void> {
  const worker = new Worker(
    REPORT_QUEUE,
    async (job) => {
      const payload = ReportJob.parse(job.data);
      try {
        await Promise.race([
          runReport(payload),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new ReportJobTimeoutError(
                    `report generation timed out after ${reportEnv.REPORT_JOB_TIMEOUT_MS}ms`,
                  ),
                ),
              reportEnv.REPORT_JOB_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (err) {
        // Only the backstop needs handling here — every other rejection came
        // out of runReport(), which already wrote the row's terminal status
        // and its own audit row before rethrowing.
        if (err instanceof ReportJobTimeoutError) {
          const message = err.message;
          await db
            .update(tables.reports)
            .set({ status: "failed", error: message, completedAt: new Date() })
            .where(eq(tables.reports.id, payload.reportId))
            .catch((writeErr) =>
              log.error({ reportId: payload.reportId, err: writeErr }, "failed to write timeout status"),
            );
          await auditSafe({
            engineer: payload.engineer,
            tenantId: payload.tenantId ?? undefined,
            endpoint: "reports",
            method: "WORKER",
            action: "report:generate",
            resourceType: "report",
            resourceId: payload.reportId,
            resourceLabel: payload.title,
            summary: `Report generation timed out${scopeLabelFor(payload)}`,
            outcome: "failure",
            detail: message,
            responseStatus: 504,
          }).catch(() => {});
        }
        throw err;
      }
    },
    { connection, concurrency: reportEnv.REPORT_CONCURRENCY },
  );

  worker.on("ready", () => log.info("ready, listening for report jobs"));
  worker.on("failed", (job, err) => {
    log.error({ reportId: job?.id, err }, "job failed");
    void sendAlertEmail("worker", {
      key: "report-job-failed",
      subject: "A report generation job failed",
      body: `Report job ${job?.id ?? "(unknown)"} failed:\n\n${err.message}`,
    });
  });
  // Same rationale as every other Worker in this app: an unlistened "error"
  // event crashes the whole process.
  worker.on("error", (err) => {
    log.error({ err }, "worker error");
    void sendAlertEmail("worker", {
      key: "report-worker-error",
      subject: "Report worker error",
      body: `The report worker reported an error:\n\n${err.message}`,
    });
  });

  log.info("started — generating branded PDF reports");

  return async () => {
    await worker.close();
  };
}
