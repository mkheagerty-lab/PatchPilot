/**
 * Persistence for generated reports.
 *
 * ## Never `SELECT *` on this table
 *
 * `reports.pdf` is a `bytea` holding the whole rendered document. A plain
 * `db.select().from(tables.reports)` pulls every blob in the result set into
 * Node's heap — a 50-row history page becomes tens of megabytes of `Buffer` per
 * request, for a list that displays none of it. `REPORT_LIST_COLUMNS` below is
 * the explicit projection of everything *except* the blob, and it is the only
 * thing every route here reads through. The one place the bytes are loaded is
 * `loadReportPdf`, which fetches a single row by id.
 *
 * ## Ownership lives in the query, not in the caller
 *
 * Every read and write below takes the requesting engineer's UPN and filters on
 * it. A report is a customer-branded document; it is visible to the engineer who
 * generated it and to nobody else, and putting that in the WHERE clause rather
 * than in an `if` after the fetch means a route cannot forget it. Routes turn a
 * miss into 404, never 403 — a wrong-owner id and a nonexistent id are
 * indistinguishable from outside, which is the point.
 *
 * DEMO_MODE never reaches this file: `packages/db/src/client.ts` has no database
 * to connect to there, so `routes/reports.ts` refuses the whole surface with
 * `503 demo_unsupported` before anything here runs.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import type { ReportType } from "@patchpilot/shared";

/**
 * Every column except `pdf`. Spelled out rather than derived, so adding a
 * column is a deliberate decision about whether the history list needs it —
 * and so a future blob column can't quietly join the projection.
 */
export const REPORT_LIST_COLUMNS = {
  id: tables.reports.id,
  reportType: tables.reports.reportType,
  factsVersion: tables.reports.factsVersion,
  tenantId: tables.reports.tenantId,
  tenantName: tables.reports.tenantName,
  windowDays: tables.reports.windowDays,
  title: tables.reports.title,
  engineer: tables.reports.engineer,
  status: tables.reports.status,
  narrated: tables.reports.narrated,
  narrationSkippedReason: tables.reports.narrationSkippedReason,
  factCheckWarnings: tables.reports.factCheckWarnings,
  pdfBytes: tables.reports.pdfBytes,
  pdfSha256: tables.reports.pdfSha256,
  filename: tables.reports.filename,
  error: tables.reports.error,
  requestedAt: tables.reports.requestedAt,
  startedAt: tables.reports.startedAt,
  completedAt: tables.reports.completedAt,
  expiresAt: tables.reports.expiresAt,
} as const;

type ReportListRow = {
  [K in keyof typeof REPORT_LIST_COLUMNS]: (typeof tables.reports.$inferSelect)[K];
};

/** The wire shape: same fields, every timestamp an ISO string. */
export interface ReportSummary {
  id: string;
  reportType: string;
  factsVersion: number;
  tenantId: string | null;
  tenantName: string | null;
  windowDays: number;
  title: string;
  engineer: string;
  status: "pending" | "rendering" | "ready" | "failed";
  narrated: boolean;
  narrationSkippedReason: string | null;
  factCheckWarnings: string[];
  pdfBytes: number | null;
  pdfSha256: string | null;
  filename: string;
  error: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
}

function toSummary(row: ReportListRow): ReportSummary {
  return {
    ...row,
    requestedAt: row.requestedAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export interface InsertReportInput {
  reportType: ReportType;
  factsVersion: number;
  tenantId: string | null;
  tenantName: string | null;
  windowDays: number;
  title: string;
  engineer: string;
  filename: string;
  /** Absolute, stamped once at insert from `REPORT_RETENTION_DAYS` — never
   * recomputed by the retention sweep, or lowering that setting would
   * retroactively delete reports an engineer was told would be kept. */
  expiresAt: Date;
}

/** Inserts the `pending` row the client will poll. The BullMQ job is enqueued
 * only after this succeeds, so there is never a job pointing at no row. */
export async function insertReport(input: InsertReportInput): Promise<ReportSummary> {
  const [row] = await db.insert(tables.reports).values(input).returning(REPORT_LIST_COLUMNS);
  return toSummary(row!);
}

export interface ListReportsQuery {
  engineer: string;
  reportType?: ReportType;
  tenantId?: string;
  limit: number;
  /** `requestedAt` of the last row on the previous page, as an ISO string.
   * Timestamp-only rather than a (timestamp, id) tuple: these rows are keyed
   * `(engineer, requestedAt)` and one engineer cannot enqueue two reports in
   * the same microsecond. */
  cursor?: string;
}

export async function listReports(
  query: ListReportsQuery,
): Promise<{ rows: ReportSummary[]; nextCursor: string | null }> {
  const cursorAt = query.cursor ? new Date(query.cursor) : null;
  const rows = await db
    .select(REPORT_LIST_COLUMNS)
    .from(tables.reports)
    .where(
      and(
        eq(tables.reports.engineer, query.engineer),
        query.reportType ? eq(tables.reports.reportType, query.reportType) : undefined,
        query.tenantId ? eq(tables.reports.tenantId, query.tenantId) : undefined,
        cursorAt && !Number.isNaN(cursorAt.getTime())
          ? lt(tables.reports.requestedAt, cursorAt)
          : undefined,
      ),
    )
    .orderBy(desc(tables.reports.requestedAt))
    // One extra row is the "is there a next page" probe — cheaper and more
    // honest than a COUNT over a table whose rows carry a blob.
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit).map(toSummary);
  const nextCursor = rows.length > query.limit ? (page[page.length - 1]?.requestedAt ?? null) : null;
  return { rows: page, nextCursor };
}

export async function getReport(id: string, engineer: string): Promise<ReportSummary | null> {
  const rows = await db
    .select(REPORT_LIST_COLUMNS)
    .from(tables.reports)
    .where(and(eq(tables.reports.id, id), eq(tables.reports.engineer, engineer)))
    .limit(1);
  return rows[0] ? toSummary(rows[0]) : null;
}

export interface ReportDownload {
  status: ReportSummary["status"];
  filename: string;
  pdf: Buffer | null;
  pdfBytes: number | null;
  tenantId: string | null;
  title: string;
}

/** The one query in this file that loads the blob — always a single row, always
 * ownership-filtered. */
export async function loadReportPdf(id: string, engineer: string): Promise<ReportDownload | null> {
  const rows = await db
    .select({
      status: tables.reports.status,
      filename: tables.reports.filename,
      pdf: tables.reports.pdf,
      pdfBytes: tables.reports.pdfBytes,
      tenantId: tables.reports.tenantId,
      title: tables.reports.title,
    })
    .from(tables.reports)
    .where(and(eq(tables.reports.id, id), eq(tables.reports.engineer, engineer)))
    .limit(1);
  return rows[0] ?? null;
}

/** Returns the deleted row's identity for the audit entry, or null when the id
 * didn't exist or wasn't this engineer's. */
export async function deleteReport(
  id: string,
  engineer: string,
): Promise<{ id: string; title: string; tenantId: string | null } | null> {
  const rows = await db
    .delete(tables.reports)
    .where(and(eq(tables.reports.id, id), eq(tables.reports.engineer, engineer)))
    .returning({
      id: tables.reports.id,
      title: tables.reports.title,
      tenantId: tables.reports.tenantId,
    });
  return rows[0] ?? null;
}
