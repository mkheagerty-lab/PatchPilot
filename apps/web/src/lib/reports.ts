// Client for the report generator (apps/api/src/routes/reports.ts). Mirrors
// lib/ai.ts's conventions — thin typed wrappers over the shared `api` fetch
// client, no state of its own.
//
// Downloads and CSV exports are deliberately NOT wrapped here: they're plain
// `<a href>` links built by `downloadUrl`/`csvMetricUrl` below, the same
// pattern as RemediationHistory.tsx's Export CSV link and AuditLog.tsx's —
// the session cookie rides along on a normal navigation and the server's
// `content-disposition` header does the rest. Fetching the bytes through
// this client and re-triggering a save with a Blob URL would just be more
// code for the same outcome.

import type { ReportType } from "@patchpilot/shared";
import { api } from "./api";

export type ReportStatus = "pending" | "rendering" | "ready" | "failed";

/** Mirrors ReportSummary in apps/api/src/reports/store.ts — the list/get
 * projection, which never carries the `pdf` blob. */
export interface ReportSummary {
  id: string;
  reportType: string;
  factsVersion: number;
  tenantId: string | null;
  tenantName: string | null;
  windowDays: number;
  title: string;
  engineer: string;
  status: ReportStatus;
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

export interface ReportListResponse {
  rows: ReportSummary[];
  nextCursor: string | null;
}

export interface ReportListQuery {
  reportType?: ReportType;
  tenantId?: string;
  limit?: number;
  cursor?: string;
}

export interface CreateReportInput {
  reportType: ReportType;
  /** null = every tenant this engineer can currently reach. */
  tenantId: string | null;
  windowDays: number;
  narrate: boolean;
}

export interface CreateReportResult {
  id: string;
  status: ReportStatus;
}

function toQueryString(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") qs.set(key, String(value));
  }
  const str = qs.toString();
  return str ? `?${str}` : "";
}

export const reportsApi = {
  create: (input: CreateReportInput) => api.post<CreateReportResult>("/api/reports", input),
  list: (query: ReportListQuery = {}) =>
    api.get<ReportListResponse>(
      `/api/reports${toQueryString({
        reportType: query.reportType,
        tenantId: query.tenantId,
        limit: query.limit,
        cursor: query.cursor,
      })}`,
    ),
  get: (id: string) => api.get<ReportSummary>(`/api/reports/${id}`),
  remove: (id: string) => api.del<void>(`/api/reports/${id}`),
};

/** `<a href>` target for downloading a ready report's PDF. */
export function reportDownloadUrl(id: string): string {
  return `/api/reports/${id}/download`;
}

/** `<a href>` target for one of the `REPORT_CSV_METRICS` exports. `tenantId`
 * of `undefined`/omitted means every reachable tenant — the web app's
 * `ALL_TENANTS` sentinel is client-only and never reaches the wire. */
export function reportCsvMetricUrl(
  path: string,
  opts: { tenantId?: string; windowDays?: number } = {},
): string {
  return `${path}${toQueryString({ tenantId: opts.tenantId, windowDays: opts.windowDays })}`;
}
