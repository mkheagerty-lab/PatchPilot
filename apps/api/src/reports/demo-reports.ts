/**
 * DEMO_MODE's stand-in for the reports table: a couple of fixed, already-
 * `ready` rows and one real PDF (generated once via the actual render
 * pipeline against fictional demo facts — see the git history for the
 * one-off script that produced it, since removed). No queue, no worker, no
 * Chromium in demo mode — see routes/reports.ts's demo forks of the 4 PDF
 * routes, which read only from this file.
 *
 * Shaped exactly like `ReportSummary` (../reports/store.ts) so the web app's
 * Reports page needs no demo-specific branch at all.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReportSummary } from "./store.js";
import { DEMO_ENGINEER_UPN } from "../auth/demo-engineers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF_PATH = join(__dirname, "demo-sample-report.pdf");

/** Lazy + cached: this module loads at server boot in every mode, and the
 * file should only ever be read (once) by an instance that's actually in
 * DEMO_MODE. */
let cachedPdf: Buffer | null = null;
function loadSamplePdf(): Buffer {
  if (!cachedPdf) cachedPdf = readFileSync(SAMPLE_PDF_PATH);
  return cachedPdf;
}

const now = () => new Date().toISOString();

/**
 * Three canned rows, one per report type the catalog defines plus a second
 * executive summary scoped to a single tenant, so the list and the type/
 * tenant filters both have something to show. Every row is already `ready`
 * and points at the same static PDF — there is nothing here to actually
 * generate.
 */
export const DEMO_REPORTS: readonly ReportSummary[] = [
  {
    id: "demo-report-1",
    reportType: "executive-summary",
    factsVersion: 1,
    tenantId: null,
    tenantName: null,
    windowDays: 30,
    title: "Executive Summary — All Tenants",
    engineer: DEMO_ENGINEER_UPN,
    status: "ready",
    narrated: false,
    narrationSkippedReason: null,
    factCheckWarnings: [],
    pdfBytes: null,
    pdfSha256: null,
    filename: "all-tenants_executive-summary.pdf",
    error: null,
    requestedAt: now(),
    startedAt: now(),
    completedAt: now(),
    expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
  },
  {
    id: "demo-report-2",
    reportType: "compliance-sla",
    factsVersion: 1,
    tenantId: "contoso",
    tenantName: "Contoso Legal",
    windowDays: 30,
    title: "Compliance / SLA — Contoso Legal",
    engineer: DEMO_ENGINEER_UPN,
    status: "ready",
    narrated: false,
    narrationSkippedReason: null,
    factCheckWarnings: [],
    pdfBytes: null,
    pdfSha256: null,
    filename: "contoso-legal_compliance-sla.pdf",
    error: null,
    requestedAt: now(),
    startedAt: now(),
    completedAt: now(),
    expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
  },
];

/** Fixes up `pdfBytes` (the list column) against the real static file size
 * the first time it's read, so the download's `content-length` and the list
 * row's byte count never disagree. */
export function demoReportsWithPdfBytes(): ReportSummary[] {
  const size = loadSamplePdf().length;
  return DEMO_REPORTS.map((r) => ({ ...r, pdfBytes: size }));
}

export function findDemoReport(id: string): ReportSummary | undefined {
  return demoReportsWithPdfBytes().find((r) => r.id === id);
}

export { loadSamplePdf };
