/**
 * Row builders for the metric CSV exports.
 *
 * Every function here is pure: it takes rows that have already been fetched and
 * gives back a `{ headers, rows }` table. Same split `computeCveTrend` and
 * `summarizeTimeToRemediate` already make between "fetch" and "aggregate", and
 * for the same reason — the shape of an export is the part worth testing, and
 * testing it should not need a database.
 *
 * The serialisation itself goes through `csvRow`/`csvCell` from
 * `@patchpilot/shared`, which carry the RFC-4180 quoting and the Excel
 * formula-injection guard. A software title from Graph really can begin with
 * `=`, and these files are opened in Excel by definition; nothing here builds a
 * cell by hand.
 *
 * ## These exports are exception- and exclusion-aware in every scope
 *
 * `sla-compliance.csv` and `device-compliance.csv` are built from
 * `rollupTenantPostures` — `loadTenantPosture` per tenant — so an accepted-risk
 * finding or an excluded device is absent from the file no matter which tenant
 * scope was asked for. `/api/vulnerabilities` in all-tenants mode deliberately
 * is not (see `routes/dashboard.ts:50-69`), which means these exports can report
 * FEWER rows than the Vulnerabilities page shows. That is the correct behaviour
 * for a compliance artefact and it is worth saying out loud, because "the CSV
 * has fewer rows than the screen" otherwise reads as a bug.
 */
import { csvRow, type Severity, type SlaThresholds, type SlaTone } from "@patchpilot/shared";
import type { CoverageRow } from "../catalog/coverage.js";
import type { TrendPointRow } from "../routes/dashboard.js";
import type { TimeToRemediateSummary } from "../posture/time-to-remediate.js";

/** Hard ceiling on any one export, matching the other export routes in this
 * app. Reached only by an estate far larger than these tables are meant for;
 * the response says so in `x-patchpilot-truncated` rather than silently
 * handing back a short file. */
export const REPORT_CSV_MAX_ROWS = 50_000;

export interface CsvTable {
  headers: readonly string[];
  rows: readonly (readonly unknown[])[];
}

/** Serialises a table, BOM first. Excel reads a UTF-8 CSV as the local ANSI
 * codepage without it, which turns every non-ASCII hostname into mojibake. */
export function renderCsv(table: CsvTable): string {
  let body = "﻿" + csvRow(table.headers);
  for (const row of table.rows) body += csvRow(row);
  return body;
}

/** Applies the row cap and reports whether it bit. */
export function capRows<T>(rows: readonly T[]): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, REPORT_CSV_MAX_ROWS), truncated: rows.length > REPORT_CSV_MAX_ROWS };
}

/** ISO-8601 with the seconds, matching `remediation-history/export.csv`. Its
 * headers name the zone rather than the cell carrying an offset, so a column
 * sorts lexicographically in a spreadsheet. */
function iso(value: Date | null | undefined): string {
  return value ? value.toISOString() : "";
}

/** One decimal place. `null` (no remediations in the window) stays an empty
 * cell rather than becoming a `0` nobody can distinguish from a real zero. */
function hours(value: number | null): string {
  return value === null ? "" : value.toFixed(1);
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

// ---------------------------------------------------------------------------
// SLA compliance
// ---------------------------------------------------------------------------

/** Structural, not an import of `PostureFinding` + its tenant fields, so the
 * tests can build one by hand. `rollupTenantPostures`'s findings satisfy it. */
export interface SlaComplianceInput {
  tenantId: string;
  tenantName: string;
  cveId: string;
  software: string;
  severity: Severity;
  detectedAt: Date;
  sla: { dueDate: Date; daysRemaining: number; overdue: boolean };
  tone: SlaTone;
  affectedDeviceCount: number;
}

const SLA_TONE_LABELS: Record<SlaTone, string> = {
  breached: "Breached",
  "due-soon": "Due soon",
  ok: "Within SLA",
};

export const SLA_COMPLIANCE_HEADERS = [
  "Tenant",
  "Tenant ID",
  "CVE",
  "Software",
  "Severity",
  "First detected (UTC)",
  "SLA due (UTC)",
  "Days remaining",
  "Overdue",
  "SLA state",
  "Affected devices",
] as const;

export function slaComplianceTable(findings: readonly SlaComplianceInput[]): CsvTable {
  // Most overdue first: the row an auditor reads first should be the row the
  // file opens on, and it's the one a truncated export must never lose.
  const sorted = [...findings].sort(
    (a, b) =>
      a.sla.daysRemaining - b.sla.daysRemaining || a.tenantName.localeCompare(b.tenantName),
  );
  return {
    headers: SLA_COMPLIANCE_HEADERS,
    rows: sorted.map((f) => [
      f.tenantName,
      f.tenantId,
      f.cveId,
      f.software,
      f.severity,
      iso(f.detectedAt),
      iso(f.sla.dueDate),
      f.sla.daysRemaining,
      yesNo(f.sla.overdue),
      SLA_TONE_LABELS[f.tone],
      f.affectedDeviceCount,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Device compliance
// ---------------------------------------------------------------------------

export interface DeviceComplianceInput {
  id: string;
  tenantId: string;
  managedDeviceId: string;
  hostname: string;
  os: string;
  compliance: string;
  vulnerabilityCount: number;
  lastSeen: Date | null;
}

export const DEVICE_COMPLIANCE_HEADERS = [
  "Tenant",
  "Tenant ID",
  "Device ID",
  "Managed device ID",
  "Hostname",
  "OS",
  "Compliance",
  "Open vulnerabilities",
  "Last seen (UTC)",
] as const;

export function deviceComplianceTable(
  devices: readonly DeviceComplianceInput[],
  tenantNames: ReadonlyMap<string, string>,
): CsvTable {
  const sorted = [...devices].sort(
    (a, b) => b.vulnerabilityCount - a.vulnerabilityCount || a.hostname.localeCompare(b.hostname),
  );
  return {
    headers: DEVICE_COMPLIANCE_HEADERS,
    rows: sorted.map((d) => [
      tenantNames.get(d.tenantId) ?? d.tenantId,
      d.tenantId,
      d.id,
      d.managedDeviceId,
      d.hostname,
      d.os,
      d.compliance,
      d.vulnerabilityCount,
      iso(d.lastSeen),
    ]),
  };
}

// ---------------------------------------------------------------------------
// Software exposure
// ---------------------------------------------------------------------------

const COVERAGE_STATUS_LABELS: Record<CoverageRow["status"], string> = {
  covered: "Patchable by PatchPilot",
  "not-supported": "No package available",
  os: "OS update",
};

export const SOFTWARE_EXPOSURE_HEADERS = [
  "Tenant",
  "Tenant ID",
  "Software",
  "Publisher",
  "Highest severity",
  "CVE count",
  "Affected devices",
  "Patch type",
  "Coverage status",
  "Package ID",
  "Latest catalog version",
] as const;

export function softwareExposureTable(
  rows: readonly CoverageRow[],
  tenantNames: ReadonlyMap<string, string>,
): CsvTable {
  return {
    headers: SOFTWARE_EXPOSURE_HEADERS,
    rows: rows.map((r) => [
      tenantNames.get(r.tenantId) ?? r.tenantId,
      r.tenantId,
      r.displayName,
      r.publisher,
      r.severity,
      r.cveCount,
      r.affectedDeviceCount,
      r.patchType === "os" ? "OS" : "Application",
      COVERAGE_STATUS_LABELS[r.status],
      r.match?.packageId ?? null,
      r.latestVersion,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Time to remediate
// ---------------------------------------------------------------------------

export const TIME_TO_REMEDIATE_HEADERS = [
  "Scope",
  "Window (days)",
  "Severity",
  "Remediated",
  "Avg hours",
  "P90 hours",
  "SLA threshold (days)",
  "Avg within SLA",
] as const;

const TTR_SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];

/**
 * One row per severity plus an "All" row. The SLA comparison is against the
 * AVERAGE, not the p90 — it answers "is this estate typically inside its
 * deadline", which is the question the column header asks. With nothing
 * remediated in the window the cell is blank, because "no" would assert a
 * failure that never happened.
 */
export function timeToRemediateTable(
  summary: TimeToRemediateSummary,
  thresholds: SlaThresholds,
  scopeLabel: string,
): CsvTable {
  const rows: unknown[][] = TTR_SEVERITIES.map((severity) => {
    const bucket = summary.bySeverity[severity];
    const thresholdDays = thresholds[severity];
    return [
      scopeLabel,
      summary.windowDays,
      severity,
      bucket.count,
      hours(bucket.avgHours),
      hours(bucket.p90Hours),
      thresholdDays,
      bucket.avgHours === null ? "" : yesNo(bucket.avgHours / 24 <= thresholdDays),
    ];
  });
  rows.push([
    scopeLabel,
    summary.windowDays,
    "all",
    summary.count,
    hours(summary.avgHours),
    hours(summary.p90Hours),
    // No single threshold spans every severity, so the mixed row deliberately
    // asserts nothing rather than picking one and implying it applies.
    "",
    "",
  ]);
  return { headers: TIME_TO_REMEDIATE_HEADERS, rows };
}

// ---------------------------------------------------------------------------
// Posture trend
// ---------------------------------------------------------------------------

export const POSTURE_TREND_HEADERS = [
  "Day",
  "Tenant",
  "Tenant ID",
  "Devices",
  "Compliant",
  "Non-compliant",
  "Unmonitored",
  "Open findings",
  "Critical",
  "High",
  "Medium",
  "Low",
  "SLA breached",
  "SLA due soon",
  "SLA within",
] as const;

export interface TrendSeries {
  tenantId: string;
  tenantName: string;
  points: readonly TrendPointRow[];
}

/**
 * One row per (day, tenant). `loadTrend` sums every tenant into one point when
 * called without a tenant id — right for a chart, wrong for an export whose
 * whole value is being able to pivot by tenant — so the route calls it once per
 * tenant and hands the series here.
 */
export function postureTrendTable(series: readonly TrendSeries[]): CsvTable {
  const rows: unknown[][] = [];
  for (const s of series) {
    for (const p of s.points) {
      rows.push([
        p.day,
        s.tenantName,
        s.tenantId,
        p.devices,
        p.devicesCompliant,
        p.devicesNoncompliant,
        p.devicesUnknown,
        p.openFindings,
        p.critical,
        p.high,
        p.medium,
        p.low,
        p.slaBreached,
        p.slaDueSoon,
        p.slaOk,
      ]);
    }
  }
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
  return { headers: POSTURE_TREND_HEADERS, rows };
}
