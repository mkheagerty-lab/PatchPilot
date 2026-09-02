/**
 * The report catalog — one declaration of what a report type IS, imported
 * directly by all three apps.
 *
 * `apps/api` reads it to know which facts to gather and how to title a row,
 * `apps/worker` loops its sections to narrate and render, and `apps/web` maps it
 * into the type picker. There is deliberately no `GET /api/reports/types` route:
 * a served copy would be a second place for the catalog to drift, and the web
 * app already imports `ROLE_LABELS` / `PERMISSION_AREAS` from this package the
 * same way.
 *
 * Adding a report type is: one entry below, one fact-builder in
 * `apps/api/src/reports/facts.ts`, one arm in the worker's template switch. No
 * migration — `reports.report_type` is a `text` column, not a pg enum, for
 * exactly this reason.
 *
 * Everything here is pure and JSON-shaped. The facts cross a BullMQ payload
 * (i.e. `JSON.stringify` through Redis), so every date is an ISO string and
 * every field is something `JSON.parse` can hand back unchanged — a `Date` in
 * these types would typecheck at the producer and arrive at the consumer as a
 * string.
 */
import type { DeviceCompliance, Severity, SlaThresholds, SlaTone } from "./sla.js";

export const REPORT_TYPES = ["executive-summary", "compliance-sla"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export function isReportType(value: string): value is ReportType {
  return (REPORT_TYPES as readonly string[]).includes(value);
}

/** Chart generators the worker knows how to draw. Referenced by id so the
 * registry stays data, and `apps/api` can import it without pulling in SVG. */
export const REPORT_CHART_IDS = [
  "severity-donut",
  "compliance-donut",
  "sla-buckets",
  "posture-trend",
  "sla-trend",
  "top-software",
  "remediation-bars",
  "ttr-severity",
] as const;
export type ReportChartId = (typeof REPORT_CHART_IDS)[number];

// ---------------------------------------------------------------------------
// Fact shapes
// ---------------------------------------------------------------------------

/** Cover-page provenance. Carried on the facts (rather than assembled in the
 * worker) so the printed document states the same scope the api resolved. */
export interface ReportMeta {
  reportType: ReportType;
  factsVersion: number;
  /** Entra tenant GUID, or null for an all-tenants report. */
  tenantId: string | null;
  tenantName: string | null;
  /** How many tenants the numbers cover — 1 when scoped, N in all-tenants mode. */
  tenantCount: number;
  windowDays: number;
  generatedAt: string;
  engineer: string;
  /** What the engineer ASKED for. Whether narration actually happened is the
   * worker's outcome, not a fact — see `ReportRenderInput.narrated`. */
  narrationRequested: boolean;
  productName: string;
}

export interface ScopeFacts {
  tenants: number;
  reachable: number;
  stale: number;
  neverSynced: number;
  readOnly: number;
  oldestSyncAt: string | null;
  newestSyncAt: string | null;
}

export interface TileFacts {
  critical: number;
  high: number;
  breached: number;
  dueSoon: number;
  openFindings: number;
  devices: number;
  noncompliantDevices: number;
  compliantDevices: number;
  unmonitoredDevices: number;
  misconfigurations: number;
  activeExceptions: number;
  excludedDevices: number;
}

export interface SeverityCountFact {
  severity: Severity;
  count: number;
}

export interface ComplianceCountFact {
  compliance: DeviceCompliance;
  count: number;
}

/** The six fixed SLA burn-down buckets — always all six, even when empty. */
export interface SlaBucketFact {
  bucket: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}

export interface TopSoftwareFact {
  software: string;
  displayName: string;
  severity: Severity;
  affectedDeviceCount: number;
  cveCount: number;
}

export interface OsBreakdownFact {
  os: string;
  total: number;
  compliant: number;
  noncompliant: number;
  unknown: number;
}

export interface TrendPointFact {
  day: string;
  devices: number;
  devicesCompliant: number;
  devicesNoncompliant: number;
  devicesUnknown: number;
  openFindings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  slaBreached: number;
  slaDueSoon: number;
  slaOk: number;
}

/** How much of the requested window the snapshot table actually holds. Printed
 * in the appendix — a 30-day chart built from 4 days of history is a claim the
 * document has to disclose rather than quietly draw. */
export interface TrendCoverageFact {
  requestedDays: number;
  capturedDays: number;
  firstDay: string | null;
  complete: boolean;
}

export interface CveTrendDayFact {
  day: string;
  detected: number;
  remediated: number;
}

export interface RemediationDayFact {
  day: string;
  succeeded: number;
  failed: number;
}

export interface RemediationFacts {
  days: RemediationDayFact[];
  succeeded: number;
  failed: number;
  successRate: number | null;
  failedLast24h: number;
}

export interface TimeToRemediateBucketFact {
  count: number;
  avgHours: number | null;
  p90Hours: number | null;
}

export interface TimeToRemediateFacts {
  windowDays: number;
  count: number;
  avgHours: number | null;
  p90Hours: number | null;
  bySeverity: Record<Severity, TimeToRemediateBucketFact>;
}

export interface RemediationActivityFacts {
  windowDays: number;
  totalRemediated: number;
  bySeverity: Record<Severity, number>;
  byAttribution: Record<string, number>;
}

export interface PerTenantFact {
  tenantId: string;
  displayName: string;
  reachability: string;
  readOnly: boolean;
  lastSyncedAt: string | null;
  devices: number;
  critical: number;
  slaBreached: number;
  noncompliantDevices: number;
}

export interface AttentionDeviceFact {
  tenantId: string;
  hostname: string;
  os: string;
  compliance: DeviceCompliance;
  vulnerabilityCount: number;
}

/** One finding row, flattened for print. `daysRemaining`/`overdue` are lifted
 * out of the nested SLA clock so a table cell is one field lookup. */
export interface FindingFact {
  tenantId: string;
  tenantName: string;
  cveId: string;
  title: string;
  software: string;
  displayName: string;
  severity: Severity;
  detectedAt: string;
  dueDate: string;
  daysRemaining: number;
  overdue: boolean;
  affectedDeviceCount: number;
}

/** A coverage row projected down to what prints. The full `CoverageRow` carries
 * `match`, `altSources` and an unbounded `cveIds[]` — none of which a report
 * shows, all of which would ride the BullMQ payload. */
export interface CoverageRowFact {
  tenantId: string;
  displayName: string;
  severity: Severity;
  status: "covered" | "not-supported" | "os";
  cveCount: number;
  affectedDeviceCount: number;
  packageId: string | null;
}

export interface CoverageFacts {
  findingCount: number;
  total: number;
  applicable: number;
  covered: number;
  uncovered: number;
  os: number;
  rows: CoverageRowFact[];
}

export interface ExceptionFact {
  tenantId: string;
  tenantName: string;
  recommendationId: string | null;
  cveId: string | null;
  scope: string;
  justification: string;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
}

export interface ExclusionFact {
  tenantId: string;
  tenantName: string;
  managedDeviceId: string;
  deviceHostname: string;
  justification: string;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** Board-level: where the estate stands, how remediation is going, what it costs. */
export interface ExecutiveSummaryFacts {
  meta: ReportMeta;
  thresholds: SlaThresholds;
  scope: ScopeFacts;
  tiles: TileFacts;
  severity: SeverityCountFact[];
  complianceCounts: ComplianceCountFact[];
  slaBuckets: SlaBucketFact[];
  topSoftware: TopSoftwareFact[];
  osBreakdown: OsBreakdownFact[];
  trend: TrendPointFact[];
  trendCoverage: TrendCoverageFact;
  cveTrend: CveTrendDayFact[];
  remediation: RemediationFacts;
  remediationActivity: RemediationActivityFacts;
  timeToRemediate: TimeToRemediateFacts;
  coverage: CoverageFacts;
  urgentFindings: FindingFact[];
  attentionDevices: AttentionDeviceFact[];
  perTenant: PerTenantFact[];
  exceptedFindings: number;
  excludedDevices: number;
}

/** Auditor-level: are we inside our own SLAs, and what have we formally excused. */
export interface ComplianceSlaFacts {
  meta: ReportMeta;
  thresholds: SlaThresholds;
  scope: ScopeFacts;
  slaCounts: Record<SlaTone, number>;
  severity: SeverityCountFact[];
  complianceCounts: ComplianceCountFact[];
  slaBuckets: SlaBucketFact[];
  breachedFindings: FindingFact[];
  dueSoonFindings: FindingFact[];
  /** Total breached/due-soon, before the print caps above were applied. */
  breachedTotal: number;
  dueSoonTotal: number;
  timeToRemediate: TimeToRemediateFacts;
  exceptions: { count: number; rows: ExceptionFact[] };
  exclusions: { count: number; rows: ExclusionFact[] };
  exceptedFindings: number;
  excludedDevices: number;
  trend: TrendPointFact[];
  trendCoverage: TrendCoverageFact;
  perTenant: PerTenantFact[];
  attentionDevices: AttentionDeviceFact[];
}

export type AnyReportFacts = ExecutiveSummaryFacts | ComplianceSlaFacts;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ReportSectionDef<F> {
  id: string;
  /** Feeds the AI prompt's `Section:` line and the printed `<h2>`. */
  title: string;
  /**
   * The EXACT subset of the facts this section covers.
   *
   * Used twice, and it has to be the same subset both times: it's what the
   * model is shown, and it's what `factCheckSection` checks the model's
   * numerals against. Checking against the whole facts blob instead would find
   * "30" in `meta.windowDays` and wave through a hallucinated "30 critical
   * findings".
   */
  factsKeys: readonly (keyof F)[];
  /** Charts printed under this section, in order. */
  charts: readonly ReportChartId[];
  /** Deterministic prose for when narration is off or unavailable. Never a
   * placeholder — a report with AI off is a complete document, not a gapped one. */
  caption: (facts: F) => string;
}

export interface ReportTypeDef<F> {
  id: ReportType;
  label: string;
  description: string;
  /** True when the type is meaningless across tenants (none today; the field
   * exists so a future per-device type doesn't need a registry redesign). */
  requiresTenant: boolean;
  defaultWindowDays: number;
  windowOptions: readonly number[];
  /** Bumped when a fact shape changes incompatibly. Stamped on the stored row
   * so an old PDF is never reinterpreted against a newer shape. */
  factsVersion: number;
  sections: readonly ReportSectionDef<F>[];
}

const WINDOW_OPTIONS = [7, 30, 90] as const;

// ---- caption helpers ------------------------------------------------------

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** "3 critical, 1 high" — omits zeroes, so a caption never pads itself. */
function severityPhrase(rows: readonly SeverityCountFact[]): string {
  const parts = rows.filter((r) => r.count > 0).map((r) => `${r.count} ${r.severity}`);
  return parts.length ? parts.join(", ") : "none";
}

function hours(value: number | null): string {
  if (value === null) return "not measurable";
  return `${Math.round(value)} ${plural(Math.round(value), "hour")}`;
}

function scopeLabel(meta: ReportMeta): string {
  return meta.tenantName ?? `all ${meta.tenantCount} ${plural(meta.tenantCount, "tenant")}`;
}

function countOf(rows: readonly ComplianceCountFact[], key: DeviceCompliance): number {
  return rows.find((r) => r.compliance === key)?.count ?? 0;
}

// ---- executive summary ----------------------------------------------------

export const EXECUTIVE_SUMMARY_DEF: ReportTypeDef<ExecutiveSummaryFacts> = {
  id: "executive-summary",
  label: "Executive Summary",
  description:
    "Board-level posture: exposure by severity, fleet compliance, SLA burn-down, remediation throughput and patch coverage.",
  requiresTenant: false,
  defaultWindowDays: 30,
  windowOptions: WINDOW_OPTIONS,
  factsVersion: 1,
  sections: [
    {
      id: "posture-overview",
      title: "Posture Overview",
      factsKeys: ["scope", "tiles", "severity", "complianceCounts"],
      charts: ["severity-donut", "compliance-donut"],
      caption: (f) =>
        `Across ${scopeLabel(f.meta)}, ${f.tiles.openFindings} open ${plural(f.tiles.openFindings, "finding")} ` +
        `remain on ${f.tiles.devices} monitored ${plural(f.tiles.devices, "device")} — by severity: ${severityPhrase(f.severity)}. ` +
        `${countOf(f.complianceCounts, "noncompliant")} ${plural(countOf(f.complianceCounts, "noncompliant"), "device is", "devices are")} ` +
        `outside their remediation deadlines, ${countOf(f.complianceCounts, "compliant")} ${plural(countOf(f.complianceCounts, "compliant"), "is", "are")} within them, ` +
        `and ${countOf(f.complianceCounts, "unknown")} ${plural(countOf(f.complianceCounts, "unknown"), "has", "have")} no vulnerability coverage to measure.`,
    },
    {
      id: "sla-performance",
      title: "Deadline Performance",
      factsKeys: ["slaBuckets", "timeToRemediate", "thresholds"],
      charts: ["sla-buckets", "ttr-severity"],
      caption: (f) =>
        `${f.tiles.breached} ${plural(f.tiles.breached, "finding is", "findings are")} past the remediation deadline and ` +
        `${f.tiles.dueSoon} ${plural(f.tiles.dueSoon, "falls", "fall")} due within three days. ` +
        `Deadlines in force are ${f.thresholds.critical} days for critical, ${f.thresholds.high} for high, ` +
        `${f.thresholds.medium} for medium and ${f.thresholds.low} for low. ` +
        `Over the last ${f.timeToRemediate.windowDays} days, ${f.timeToRemediate.count} ${plural(f.timeToRemediate.count, "finding was", "findings were")} ` +
        `confirmed fixed, averaging ${hours(f.timeToRemediate.avgHours)} from detection to resolution.`,
    },
    {
      id: "remediation-activity",
      title: "Remediation Activity",
      factsKeys: ["remediation", "remediationActivity"],
      charts: ["remediation-bars", "posture-trend"],
      caption: (f) => {
        const rate =
          f.remediation.successRate === null
            ? "no remediation runs completed in this period"
            : `a ${Math.round(f.remediation.successRate * 100)}% success rate`;
        return (
          `PatchPilot completed ${f.remediation.succeeded} successful and ${f.remediation.failed} failed remediation ` +
          `${plural(f.remediation.succeeded + f.remediation.failed, "run")} over the last fourteen days — ${rate}. ` +
          `${f.remediationActivity.totalRemediated} ${plural(f.remediationActivity.totalRemediated, "finding was", "findings were")} ` +
          `confirmed closed in the last ${f.remediationActivity.windowDays} days.`
        );
      },
    },
    {
      id: "coverage",
      title: "Patch Coverage",
      factsKeys: ["coverage", "topSoftware"],
      charts: ["top-software"],
      caption: (f) =>
        `Of ${f.coverage.total} vulnerable software ${plural(f.coverage.total, "title")}, ${f.coverage.covered} can be patched ` +
        `automatically by PatchPilot, ${f.coverage.uncovered} ${plural(f.coverage.uncovered, "has", "have")} no supported package ` +
        `and ${f.coverage.os} ${plural(f.coverage.os, "is", "are")} delivered by operating-system updates rather than application patching.`,
    },
  ],
};

// ---- compliance / SLA -----------------------------------------------------

export const COMPLIANCE_SLA_DEF: ReportTypeDef<ComplianceSlaFacts> = {
  id: "compliance-sla",
  label: "Compliance / SLA",
  description:
    "Deadline compliance for an auditor: what is overdue, what is due soon, what has been formally excepted or excluded, and the trend.",
  requiresTenant: false,
  defaultWindowDays: 30,
  windowOptions: WINDOW_OPTIONS,
  factsVersion: 1,
  sections: [
    {
      id: "sla-status",
      title: "Deadline Status",
      factsKeys: ["thresholds", "slaCounts", "slaBuckets", "severity"],
      charts: ["sla-buckets", "severity-donut"],
      caption: (f) =>
        `Remediation deadlines in force are ${f.thresholds.critical} days for critical findings, ${f.thresholds.high} for high, ` +
        `${f.thresholds.medium} for medium and ${f.thresholds.low} for low. ` +
        `Measured against those, ${f.slaCounts.breached} ${plural(f.slaCounts.breached, "finding is", "findings are")} overdue, ` +
        `${f.slaCounts["due-soon"]} ${plural(f.slaCounts["due-soon"], "falls", "fall")} due within three days, and ` +
        `${f.slaCounts.ok} ${plural(f.slaCounts.ok, "remains", "remain")} comfortably inside its deadline.`,
    },
    {
      id: "breaches",
      title: "Overdue and Due Soon",
      factsKeys: ["breachedFindings", "dueSoonFindings", "breachedTotal", "dueSoonTotal"],
      charts: [],
      caption: (f) => {
        if (f.breachedTotal === 0 && f.dueSoonTotal === 0) {
          return "No finding is currently overdue or due within the next three days.";
        }
        const worst = f.breachedFindings[0];
        const lead = worst
          ? ` The longest-running is ${worst.cveId} on ${worst.displayName}, ${Math.abs(worst.daysRemaining)} ${plural(Math.abs(worst.daysRemaining), "day")} past its deadline.`
          : "";
        return (
          `${f.breachedTotal} ${plural(f.breachedTotal, "finding has", "findings have")} passed the remediation deadline and ` +
          `${f.dueSoonTotal} ${plural(f.dueSoonTotal, "is", "are")} due within three days.${lead}`
        );
      },
    },
    {
      id: "exceptions-exclusions",
      title: "Exceptions and Exclusions",
      factsKeys: ["exceptions", "exclusions", "exceptedFindings", "excludedDevices"],
      charts: [],
      caption: (f) =>
        `${f.exceptions.count} active ${plural(f.exceptions.count, "exception")} ${plural(f.exceptions.count, "is", "are")} in force, ` +
        `suppressing ${f.exceptedFindings} ${plural(f.exceptedFindings, "finding")} from the figures in this report. ` +
        `${f.exclusions.count} ${plural(f.exclusions.count, "device is", "devices are")} excluded from monitoring, ` +
        `removing ${f.excludedDevices} ${plural(f.excludedDevices, "device")} from the fleet counts. ` +
        `Every entry is listed below with its justification and review date.`,
    },
    {
      id: "trajectory",
      title: "Trajectory",
      factsKeys: ["trend", "trendCoverage", "timeToRemediate"],
      charts: ["sla-trend"],
      caption: (f) => {
        const first = f.trend[0];
        const last = f.trend[f.trend.length - 1];
        if (!first || !last || f.trend.length < 2) {
          return (
            `Not enough history has been captured to describe a trend — ${f.trendCoverage.capturedDays} of ` +
            `${f.trendCoverage.requestedDays} requested ${plural(f.trendCoverage.requestedDays, "day")} are on record. ` +
            `Over the same period, ${f.timeToRemediate.count} ${plural(f.timeToRemediate.count, "finding was", "findings were")} confirmed fixed.`
          );
        }
        const delta = last.slaBreached - first.slaBreached;
        const direction =
          delta === 0
            ? "unchanged"
            : delta > 0
              ? `up by ${delta}`
              : `down by ${Math.abs(delta)}`;
        return (
          `Overdue findings moved from ${first.slaBreached} on ${first.day} to ${last.slaBreached} on ${last.day} — ${direction}. ` +
          `Open findings over the same period went from ${first.openFindings} to ${last.openFindings}. ` +
          `Confirmed fixes averaged ${hours(f.timeToRemediate.avgHours)} from detection to resolution, ` +
          `with the slowest tenth taking ${hours(f.timeToRemediate.p90Hours)}.`
        );
      },
    },
  ],
};

/**
 * The type-erased view the worker dispatches through.
 *
 * The strongly-typed defs above are where the captions are written and where a
 * mistyped `factsKeys` entry is a compile error. This record deliberately
 * widens them: the worker holds a `reportType` string and facts it parsed off a
 * job payload, and no amount of generic plumbing turns that back into a
 * discriminated union at that boundary. The `reports.test.ts` case that
 * resolves every `factsKeys` entry against a fixture is what covers the gap.
 */
export const REPORT_TYPE_DEFS = {
  "executive-summary": EXECUTIVE_SUMMARY_DEF,
  "compliance-sla": COMPLIANCE_SLA_DEF,
} as unknown as Record<ReportType, ReportTypeDef<AnyReportFacts>>;

/** Every chart a type draws, in print order, de-duplicated. */
export function reportChartIds(type: ReportType): ReportChartId[] {
  const seen = new Set<ReportChartId>();
  for (const section of REPORT_TYPE_DEFS[type].sections) {
    for (const chart of section.charts) seen.add(chart);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Narration support
// ---------------------------------------------------------------------------

/**
 * The subset of the facts one section is allowed to talk about.
 *
 * Missing keys are simply absent rather than `undefined`, so a typo'd key
 * produces a visibly short JSON object in the prompt instead of
 * `{"tiels": undefined}` disappearing at stringify time.
 */
export function pickSectionFacts<F extends object>(
  facts: F,
  keys: readonly (keyof F)[],
): Partial<F> {
  const out: Partial<F> = {};
  for (const key of keys) {
    if (key in facts) out[key] = facts[key];
  }
  return out;
}

/**
 * Cheap hallucination tripwire: every numeral the model states in a section
 * must appear verbatim (comma-insensitive) somewhere in that section's own
 * source JSON. Not a proof of correctness — a model can still misattribute a
 * real number to the wrong fact — but it catches the failure mode observed
 * during Phase 3 verification (a stated count that traces to nothing in the
 * data at all).
 *
 * Moved here from `apps/worker/src/ai-report-worker.ts` when reports were
 * generalized: it's pure string work, and this package is the one with vitest
 * wired, so leaving it in the worker left the feature's highest-value invariant
 * untested.
 */
export function factCheckSection(title: string, body: string, facts: unknown): string[] {
  const factsText = JSON.stringify(facts) ?? "";
  const numerals = body.match(/\d[\d,]*(\.\d+)?/g) ?? [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const raw of numerals) {
    const normalized = raw.replace(/,/g, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (!factsText.includes(raw) && !factsText.includes(normalized)) {
      warnings.push(`${title}: "${raw}" does not appear in the underlying data`);
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Branding sanitation
// ---------------------------------------------------------------------------

/** Branding as it reaches the renderer: already sanitized, no free text left
 * that lands anywhere a browser would interpret. */
export interface ReportBranding {
  productName: string;
  primary: string;
  secondary: string;
  accent: string;
  logo: string | null;
}

export const DEFAULT_REPORT_BRANDING: ReportBranding = {
  productName: "PatchPilot",
  primary: "#4f46e5",
  secondary: "#0ea5e9",
  accent: "#f59e0b",
  logo: null,
};

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/**
 * A six-digit hex colour, or the fallback.
 *
 * Branding colours are free text an engineer types into Settings, and they land
 * in a `:root{--brand-primary:…}` declaration inside the report document. A
 * value of `red; } body { display:none } .x {` would otherwise close the rule
 * and inject its own — i.e. CSS injection into a customer-facing PDF. Anything
 * that isn't exactly `#rrggbb` is discarded rather than escaped, because there
 * is no legitimate branding value that needs escaping.
 */
export function safeHex(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX6.test(value.trim()) ? value.trim() : fallback;
}

/** 512 KB of base64, generously — a logo larger than this is a mistake, and
 * every byte rides the BullMQ payload. */
const MAX_LOGO_CHARS = 512 * 1024;
const LOGO_DATA_URI = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

/**
 * A logo the renderer may load, or null.
 *
 * v1 policy is data-URI only. `branding.logoUrl` is arbitrary engineer-entered
 * text, and the renderer is a real browser sitting inside the worker's Docker
 * network — an `https://` (or worse, `http://ollama:11434/…`) value handed to
 * it is a server-side request forgery primitive with the response rendered into
 * a document the engineer then downloads. A data URI carries its own bytes and
 * reaches nothing. `context.route(abort)` in the renderer backstops this.
 *
 * When no logo qualifies the cover falls back to a typographic wordmark, so
 * rejecting a value degrades the document rather than breaking it.
 */
export function safeLogoDataUri(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LOGO_CHARS) return null;
  return LOGO_DATA_URI.test(trimmed) ? trimmed : null;
}

/** Sanitizes whatever the `branding` setting holds into something printable. */
export function sanitizeReportBranding(raw: unknown): ReportBranding {
  const value = (raw ?? {}) as Record<string, unknown>;
  const productName =
    typeof value.productName === "string" && value.productName.trim()
      ? value.productName.trim().slice(0, 60)
      : DEFAULT_REPORT_BRANDING.productName;
  return {
    productName,
    primary: safeHex(value.primary, DEFAULT_REPORT_BRANDING.primary),
    secondary: safeHex(value.secondary, DEFAULT_REPORT_BRANDING.secondary),
    accent: safeHex(value.accent, DEFAULT_REPORT_BRANDING.accent),
    logo: safeLogoDataUri(value.logoUrl),
  };
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

/**
 * An ASCII, filesystem- and header-safe filename.
 *
 * Tenant display names are whatever the customer named their Entra tenant —
 * `Müller GmbH & Co. KG`, CJK, emoji. A raw one in a `content-disposition`
 * header either mangles the saved filename or throws on the header write, and
 * the stored value is what the history list displays, so both sides must agree.
 * Accented Latin folds to its base letter via NFD rather than vanishing, so
 * "Müller" reads as "muller" instead of "mller".
 */
export function slugifyFilename(parts: readonly string[], extension: string): string {
  const slug = parts
    .filter((p) => p && p.trim())
    .map((p) =>
      p
        .normalize("NFD")
        // Combining diacritical marks, written as escapes so no invisible
        // combining codepoint sits in this source file.
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase(),
    )
    .filter(Boolean)
    .join("_")
    .slice(0, 120)
    .replace(/^-+|-+$/g, "");
  return `${slug || "report"}.${extension}`;
}

// ---------------------------------------------------------------------------
// CSV metric catalog
// ---------------------------------------------------------------------------

export interface ReportCsvMetric {
  id: string;
  label: string;
  description: string;
  /** Server route, relative to the api origin. */
  path: string;
  /** Whether `?tenantId=` narrows the export. */
  scoped: boolean;
  /** Whether `?windowDays=` is meaningful for it. */
  windowed: boolean;
}

/**
 * The metric exports offered alongside the PDFs. Server-generated, never
 * derived in the browser — see the note in `apps/web/src/pages/Reports.tsx`
 * about why `lib/csv.ts` is deliberately not used for these.
 */
export const REPORT_CSV_METRICS: readonly ReportCsvMetric[] = [
  {
    id: "sla-compliance",
    label: "SLA compliance",
    description:
      "Every open finding with its deadline, days remaining and SLA state. Exception- and exclusion-aware in every scope.",
    path: "/api/reports/metrics/sla-compliance.csv",
    scoped: true,
    windowed: false,
  },
  {
    id: "device-compliance",
    label: "Device compliance",
    description: "Every monitored device with its OS, compliance state and open vulnerability count.",
    path: "/api/reports/metrics/device-compliance.csv",
    scoped: true,
    windowed: false,
  },
  {
    id: "software-exposure",
    label: "Software exposure",
    description: "Vulnerable software titles with severity, exposure and whether PatchPilot can patch them.",
    path: "/api/reports/metrics/software-exposure.csv",
    scoped: true,
    windowed: false,
  },
  {
    id: "time-to-remediate",
    label: "Time to remediate",
    description: "Average and 90th-percentile hours from detection to confirmed fix, per severity.",
    path: "/api/reports/metrics/time-to-remediate.csv",
    scoped: true,
    windowed: true,
  },
  {
    id: "posture-trend",
    label: "Posture trend",
    description: "One row per captured day: devices, compliance split, open findings by severity and SLA state.",
    path: "/api/reports/metrics/posture-trend.csv",
    scoped: true,
    windowed: true,
  },
];
