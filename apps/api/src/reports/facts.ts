/**
 * Everything a report says, gathered once — here, at enqueue time.
 *
 * The worker never re-derives a number. That isn't a performance choice: the
 * narration fact-check (`factCheckSection`) only means something if the numerals
 * the model is shown and the numerals it is checked against are literally the
 * same object. A worker that re-queried would be checking prose against a
 * second, later reading of the estate.
 *
 * ## Why this file has its own rollup
 *
 * `routes/dashboard.ts:50-69` documents a deliberate asymmetry: in all-tenants
 * mode its `tiles`, `severity`, `slaBuckets` and `topSoftware` are exception-
 * UNaware, because exceptions are tenant-scoped and the list pages those tiles
 * link to are unaware in that mode too. A tile that disagreed with the page it
 * deep-links to would be the worse bug on screen.
 *
 * A printed report has no deep links and no way to explain itself. "142 open
 * findings" on one page with a per-tenant table summing to 128 on the facing
 * page is not something you hand a customer. So every headline count here comes
 * from `rollupTenantPostures` — `loadTenantPosture` once per tenant, folded
 * together — which is exception- and exclusion-aware in both scopes and matches
 * the single-tenant shape exactly. `buildDashboardSummary` is still used
 * verbatim for the blocks it is already correct on in both scopes (scope strip,
 * trend, CVE trend, remediation throughput, time-to-remediate).
 *
 * The cost is one extra posture pass per tenant, since `buildDashboardSummary`
 * runs its own for `perTenant[]`. That is paid once per generated report, on a
 * path that is already going to launch a browser and render a PDF, and it buys
 * a document whose pages agree with each other.
 *
 * ## Everything here is bounded
 *
 * These facts become JSON in a Redis payload. Any array that grows with the
 * size of the estate is capped before it leaves this file — `coverage.rows` in
 * particular is unbounded upstream and carries `match`, `altSources` and a full
 * `cveIds[]` that no report prints.
 */
import type { DeviceRow, TenantRow } from "@patchpilot/db";
import {
  resolveDisplaySoftwareName,
  type ComplianceSlaFacts,
  type CoverageRowFact,
  type DeviceCompliance,
  type ExceptionFact,
  type ExclusionFact,
  type ExecutiveSummaryFacts,
  type FindingFact,
  type PerTenantFact,
  type ReportMeta,
  type ReportType,
  type Severity,
  type SlaThresholds,
  type SlaTone,
} from "@patchpilot/shared";
import {
  loadTenantPosture,
  severityCounts,
  slaCounts,
  complianceCounts,
  type PostureFinding,
} from "../posture/findings.js";
import {
  buildDashboardSummary,
  bucketFindings,
  complianceRows,
  osBreakdownRows,
  severityRows,
  topSoftwareRows,
} from "../routes/dashboard.js";
import { computeCoverage } from "../catalog/coverage.js";
import { gatherRemediationHistoryFacts } from "../ai/summarize.js";
import { loadActiveExceptions } from "../routes/recommendations.js";
import { loadActiveExclusions, exclusionReason } from "../routes/device-exclusions.js";

/** How many rows of each unbounded list survive into the payload. Print caps,
 * not query limits — the totals printed alongside them are the full counts. */
const MAX_COVERAGE_ROWS = 10;
const MAX_BREACHED_ROWS = 50;
const MAX_DUE_SOON_ROWS = 25;
const MAX_EXCEPTION_ROWS = 50;
const MAX_EXCLUSION_ROWS = 50;
const MAX_URGENT_ROWS = 8;
const MAX_ATTENTION_ROWS = 8;

/** A finding with the tenant it belongs to attached — `PostureFinding` is
 * always loaded per tenant and so doesn't carry one. */
interface RollupFinding extends PostureFinding {
  tenantId: string;
  tenantName: string;
}

export interface PostureRollup {
  /** The tenants actually folded in — one when scoped, every reachable tenant
   * otherwise. `tenants.length` is the report's `tenantCount`. */
  tenants: TenantRow[];
  findings: RollupFinding[];
  devices: DeviceRow[];
  severity: Record<Severity, number>;
  sla: Record<SlaTone, number>;
  compliance: Record<DeviceCompliance, number>;
  exceptedFindings: number;
  excludedDevices: number;
  activeExceptions: number;
  perTenant: PerTenantFact[];
}

/**
 * One exception- and exclusion-aware aggregate over any number of tenants.
 *
 * `now` is threaded through to `loadTenantPosture` for the same reason that
 * function takes it: two tenants loaded either side of midnight would otherwise
 * date the same finding's SLA clock differently, and a report that shows both a
 * total and a per-tenant breakdown would then fail to add up.
 */
export async function rollupTenantPostures(
  tenants: readonly TenantRow[],
  thresholds: SlaThresholds,
  now: Date,
): Promise<PostureRollup> {
  const loaded = await Promise.all(
    tenants.map(async (tenant) => {
      const [posture, exceptions] = await Promise.all([
        loadTenantPosture(tenant.tenantId, thresholds, now),
        loadActiveExceptions(tenant.tenantId),
      ]);
      return { tenant, posture, exceptions };
    }),
  );

  const findings: RollupFinding[] = [];
  const devices: DeviceRow[] = [];
  const perTenant: PerTenantFact[] = [];
  let exceptedFindings = 0;
  let excludedDevices = 0;
  let activeExceptions = 0;

  for (const { tenant, posture, exceptions } of loaded) {
    for (const f of posture.findings) {
      findings.push({ ...f, tenantId: tenant.tenantId, tenantName: tenant.displayName });
    }
    devices.push(...posture.devices);
    exceptedFindings += posture.exceptedFindings;
    excludedDevices += posture.excludedDevices;
    activeExceptions += exceptions.length;

    const sev = severityCounts(posture.findings);
    const sla = slaCounts(posture.findings);
    const compliance = complianceCounts(posture.devices);
    perTenant.push({
      tenantId: tenant.tenantId,
      displayName: tenant.displayName,
      reachability: tenant.reachability,
      readOnly: tenant.readOnly,
      lastSyncedAt: tenant.lastSyncedAt ? tenant.lastSyncedAt.toISOString() : null,
      devices: posture.devices.length,
      critical: sev.critical,
      slaBreached: sla.breached,
      noncompliantDevices: compliance.noncompliant,
    });
  }

  perTenant.sort((a, b) => b.slaBreached - a.slaBreached || a.displayName.localeCompare(b.displayName));

  return {
    tenants: [...tenants],
    findings,
    devices,
    // Counted over the folded findings/devices rather than summed from the
    // per-tenant records above, so the headline and the table can only ever
    // differ if this loop itself is wrong.
    severity: severityCounts(findings),
    sla: slaCounts(findings),
    compliance: complianceCounts(devices),
    exceptedFindings,
    excludedDevices,
    activeExceptions,
    perTenant,
  };
}

// ---------------------------------------------------------------------------
// Shared projections
// ---------------------------------------------------------------------------

function toFindingFact(f: RollupFinding): FindingFact {
  return {
    tenantId: f.tenantId,
    tenantName: f.tenantName,
    cveId: f.cveId,
    title: f.title,
    software: f.software,
    displayName: resolveDisplaySoftwareName(f.software),
    severity: f.severity,
    detectedAt: f.detectedAt.toISOString(),
    dueDate: f.sla.dueDate.toISOString(),
    daysRemaining: f.sla.daysRemaining,
    overdue: f.sla.overdue,
    affectedDeviceCount: f.affectedDeviceCount,
  };
}

/** Breached first, then soonest due — the same ordering the Dashboard's "most
 * urgent" table uses, so the two rank findings identically. */
function bySlaUrgency(a: RollupFinding, b: RollupFinding): number {
  if (a.sla.overdue !== b.sla.overdue) return a.sla.overdue ? -1 : 1;
  return a.sla.daysRemaining - b.sla.daysRemaining;
}

function attentionDevices(devices: readonly DeviceRow[]) {
  return devices
    .filter((d) => d.compliance === "noncompliant")
    .sort((a, b) => b.vulnerabilityCount - a.vulnerabilityCount)
    .slice(0, MAX_ATTENTION_ROWS)
    .map((d) => ({
      tenantId: d.tenantId,
      hostname: d.hostname,
      os: d.os,
      compliance: d.compliance,
      vulnerabilityCount: d.vulnerabilityCount,
    }));
}

/** "third-party-control" reads badly in a document an auditor keeps. The web
 * app has its own label list for the exception form; duplicating it here rather
 * than importing across apps is deliberate — `apps/api` never imports from
 * `apps/web`, and the slug itself is the durable value. */
function humanizeJustification(slug: string): string {
  const words = slug.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function toExceptionFact(
  row: {
    tenantId: string;
    recommendationId: string | null;
    cveId: string | null;
    scope: string;
    justification: string;
    notes: string | null;
    expiresAt: Date;
    createdBy: string;
    createdAt: Date;
  },
  tenantName: string,
): ExceptionFact {
  const label = humanizeJustification(row.justification);
  return {
    tenantId: row.tenantId,
    tenantName,
    recommendationId: row.recommendationId,
    cveId: row.cveId,
    scope: row.scope,
    justification: row.notes ? `${label} — ${row.notes}` : label,
    expiresAt: row.expiresAt.toISOString(),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Projects `computeCoverage().rows` down to what prints. The full row carries
 * a winget `match` object, resolved alternate sources and every CVE id behind
 * the group — none of which a report shows, all of which would ride the queue. */
function toCoverageRowFacts(
  rows: Awaited<ReturnType<typeof computeCoverage>>["rows"],
): CoverageRowFact[] {
  return rows.slice(0, MAX_COVERAGE_ROWS).map((r) => ({
    tenantId: r.tenantId,
    displayName: r.displayName,
    severity: r.severity,
    status: r.status,
    cveCount: r.cveCount,
    affectedDeviceCount: r.affectedDeviceCount,
    packageId: r.match?.packageId ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export interface BuildFactsArgs {
  reportType: ReportType;
  factsVersion: number;
  /** null = every tenant in `tenants`. */
  tenantId: string | null;
  /** The tenants in scope: exactly one when `tenantId` is set, otherwise every
   * tenant the requesting engineer can currently reach. Resolved by the route,
   * so this file never decides what an engineer may see. */
  tenants: readonly TenantRow[];
  windowDays: number;
  engineer: string;
  narrationRequested: boolean;
  productName: string;
  thresholds: SlaThresholds;
  now: Date;
}

function buildMeta(args: BuildFactsArgs, tenantName: string | null): ReportMeta {
  return {
    reportType: args.reportType,
    factsVersion: args.factsVersion,
    tenantId: args.tenantId,
    tenantName,
    tenantCount: args.tenants.length,
    windowDays: args.windowDays,
    generatedAt: args.now.toISOString(),
    engineer: args.engineer,
    narrationRequested: args.narrationRequested,
    productName: args.productName,
  };
}

function tenantNameFor(args: BuildFactsArgs): string | null {
  if (!args.tenantId) return null;
  return args.tenants.find((t) => t.tenantId === args.tenantId)?.displayName ?? null;
}

export async function buildExecutiveSummaryFacts(
  args: BuildFactsArgs,
): Promise<ExecutiveSummaryFacts> {
  const scopeId = args.tenantId ?? undefined;
  const [summary, rollup, coverage, remediationActivity] = await Promise.all([
    buildDashboardSummary(scopeId, args.windowDays),
    rollupTenantPostures(args.tenants, args.thresholds, args.now),
    computeCoverage(scopeId),
    gatherRemediationHistoryFacts({
      page: "remediation-history",
      tenantId: args.tenantId,
      windowDays: args.windowDays,
      reachableTenantIds: new Set(args.tenants.map((t) => t.tenantId)),
    }),
  ]);

  const findings = rollup.findings;

  return {
    meta: buildMeta(args, tenantNameFor(args)),
    thresholds: args.thresholds,
    scope: summary.scope,
    tiles: {
      critical: rollup.severity.critical,
      high: rollup.severity.high,
      breached: rollup.sla.breached,
      dueSoon: rollup.sla["due-soon"],
      openFindings: findings.length,
      devices: rollup.devices.length,
      noncompliantDevices: rollup.compliance.noncompliant,
      compliantDevices: rollup.compliance.compliant,
      unmonitoredDevices: rollup.compliance.unknown,
      // Misconfigurations are recommendation rows, not findings, so the
      // posture rollup has no view of them — and the Dashboard's count is
      // already scope-correct in both modes.
      misconfigurations: summary.tiles.misconfigurations ?? 0,
      activeExceptions: rollup.activeExceptions,
      excludedDevices: rollup.excludedDevices,
    },
    severity: severityRows(rollup.severity),
    complianceCounts: complianceRows(rollup.compliance),
    slaBuckets: bucketFindings(
      findings.map((f) => ({
        severity: f.severity,
        daysRemaining: f.sla.daysRemaining,
        overdue: f.sla.overdue,
      })),
    ),
    topSoftware: topSoftwareRows(findings),
    osBreakdown: osBreakdownRows(rollup.devices),
    trend: summary.trend,
    trendCoverage: summary.trendCoverage,
    cveTrend: summary.cveTrend,
    remediation: summary.remediation,
    remediationActivity: {
      windowDays: remediationActivity.windowDays,
      totalRemediated: remediationActivity.totalRemediated,
      bySeverity: remediationActivity.bySeverity,
      byAttribution: remediationActivity.byAttribution,
    },
    timeToRemediate: summary.timeToRemediate,
    coverage: {
      findingCount: coverage.findingCount,
      total: coverage.total,
      applicable: coverage.applicable,
      covered: coverage.covered,
      uncovered: coverage.uncovered,
      os: coverage.os,
      rows: toCoverageRowFacts(coverage.rows),
    },
    urgentFindings: [...findings].sort(bySlaUrgency).slice(0, MAX_URGENT_ROWS).map(toFindingFact),
    attentionDevices: attentionDevices(rollup.devices),
    perTenant: rollup.perTenant,
    exceptedFindings: rollup.exceptedFindings,
    excludedDevices: rollup.excludedDevices,
  };
}

export async function buildComplianceSlaFacts(args: BuildFactsArgs): Promise<ComplianceSlaFacts> {
  const scopeId = args.tenantId ?? undefined;
  const [summary, rollup, exclusions] = await Promise.all([
    buildDashboardSummary(scopeId, args.windowDays),
    rollupTenantPostures(args.tenants, args.thresholds, args.now),
    loadActiveExclusions(scopeId),
  ]);

  const nameByTenantId = new Map(args.tenants.map((t) => [t.tenantId, t.displayName]));
  const exceptionRows = await Promise.all(
    args.tenants.map(async (t) => {
      const rows = await loadActiveExceptions(t.tenantId);
      return rows.map((r) => toExceptionFact(r, t.displayName));
    }),
  );
  const exceptions = exceptionRows.flat();

  // Sorted worst-first: the most overdue finding is the one an auditor reads
  // first, and it's the one the print cap must never truncate away.
  const breached = rollup.findings
    .filter((f) => f.tone === "breached")
    .sort((a, b) => a.sla.daysRemaining - b.sla.daysRemaining);
  const dueSoon = rollup.findings
    .filter((f) => f.tone === "due-soon")
    .sort((a, b) => a.sla.daysRemaining - b.sla.daysRemaining);

  return {
    meta: buildMeta(args, tenantNameFor(args)),
    thresholds: args.thresholds,
    scope: summary.scope,
    slaCounts: rollup.sla,
    severity: severityRows(rollup.severity),
    complianceCounts: complianceRows(rollup.compliance),
    slaBuckets: bucketFindings(
      rollup.findings.map((f) => ({
        severity: f.severity,
        daysRemaining: f.sla.daysRemaining,
        overdue: f.sla.overdue,
      })),
    ),
    breachedFindings: breached.slice(0, MAX_BREACHED_ROWS).map(toFindingFact),
    dueSoonFindings: dueSoon.slice(0, MAX_DUE_SOON_ROWS).map(toFindingFact),
    breachedTotal: breached.length,
    dueSoonTotal: dueSoon.length,
    timeToRemediate: summary.timeToRemediate,
    exceptions: {
      count: exceptions.length,
      rows: exceptions.slice(0, MAX_EXCEPTION_ROWS),
    },
    exclusions: {
      count: exclusions.length,
      rows: exclusions.slice(0, MAX_EXCLUSION_ROWS).map(
        (e): ExclusionFact => ({
          tenantId: e.tenantId,
          tenantName: nameByTenantId.get(e.tenantId) ?? e.tenantId,
          managedDeviceId: e.managedDeviceId,
          deviceHostname: e.deviceHostname,
          justification: exclusionReason(e),
          expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
          createdBy: e.createdBy,
          createdAt: e.createdAt.toISOString(),
        }),
      ),
    },
    exceptedFindings: rollup.exceptedFindings,
    excludedDevices: rollup.excludedDevices,
    trend: summary.trend,
    trendCoverage: summary.trendCoverage,
    perTenant: rollup.perTenant,
    attentionDevices: attentionDevices(rollup.devices),
  };
}

/**
 * Dispatch for the route: one call, the right fact shape. Adding a report type
 * lands here as one more arm, next to one registry entry and one template arm.
 */
export async function buildReportFacts(args: BuildFactsArgs): Promise<unknown> {
  switch (args.reportType) {
    case "executive-summary":
      return buildExecutiveSummaryFacts(args);
    case "compliance-sla":
      return buildComplianceSlaFacts(args);
  }
}
