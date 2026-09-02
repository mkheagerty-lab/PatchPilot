import type { FastifyInstance } from "fastify";
import { and, asc, eq, gte } from "drizzle-orm";
import { requirePermission } from "../auth/rbac.js";
import {
  db,
  tables,
  demoTenants,
  demoVulnerabilities,
  demoDevices,
  demoRecommendations,
  demoPostureSnapshots,
  demoRemediationEvents,
  type TenantRow,
  type VulnerabilityRow,
  type DeviceRow,
  type RecommendationRow,
  type PostureSnapshotRow,
  type RemediationEventRow,
} from "@patchpilot/db";
import {
  computeSla,
  slaTone,
  slaChipLabel,
  resolveDisplaySoftwareName,
  isDeviceBehindFeatureUpdate,
  resolveTargetBuild,
  SEVERITY_ORDER,
  SEVERITY_RANK,
  DUE_SOON_DAYS,
  type Severity,
  type SlaStatus,
  type SlaTone,
  type DeviceCompliance,
} from "@patchpilot/shared";
import { config } from "../config.js";
import {
  loadSlaThresholds,
  loadActiveExceptions,
  isExcepted,
  recommendationKind,
  isDefenderActive,
} from "./recommendations.js";
import { loadExcludedDeviceIndex, loadActiveExclusions } from "./device-exclusions.js";
import { loadTenantPosture, severityCounts, slaCounts, complianceCounts } from "../posture/findings.js";
import {
  summarizeTimeToRemediate,
  type TimeToRemediateSummary,
} from "../posture/time-to-remediate.js";
import { listJobs } from "../jobs.js";

/**
 * GET /api/dashboard/summary — the one aggregate call the Dashboard makes
 * instead of downloading the full /api/vulnerabilities + /api/devices arrays
 * and counting them client-side.
 *
 * Single-tenant scope (`?tenantId=`) is built entirely from `loadTenantPosture`
 * (posture/findings.ts) — the same exception- and exclusion-aware pipeline that
 * backs /api/vulnerabilities and /api/devices for that tenant, so a tile here
 * and the list page it deep-links to can never disagree.
 *
 * All-tenants scope (`tenantId` omitted) deliberately mirrors what
 * /api/vulnerabilities and /api/recommendations do in that mode: exceptions are
 * tenant-scoped and unresolvable without a tenantId, so the top-level `tiles`
 * are exception-UNaware there, exactly like the list pages they link to.
 * Exclusions are still applied to devices (list pages do the same), but never
 * recompute vulnerability exposure — that recompute only ever fires with a
 * tenantId (see routes/data.ts's `fleet` guard). `perTenant[]` is the one place
 * that stays fully exception-aware in all-tenants mode, because it runs the
 * per-tenant pipeline once per tenant rather than a tenant-agnostic query.
 */

const STALE_HOURS = 24;
const MS_PER_HOUR = 3_600_000;
const REMEDIATION_DAYS = 14;
const CVE_TREND_DAYS = 30;
const DEFAULT_WINDOW_DAYS = 30;
const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 365;

type SlaBucketName = "breached" | "0-3d" | "4-7d" | "8-14d" | "15-30d" | "30d+";
const SLA_BUCKET_NAMES: SlaBucketName[] = ["breached", "0-3d", "4-7d", "8-14d", "15-30d", "30d+"];

function slaBucketFor(daysRemaining: number, overdue: boolean): SlaBucketName {
  if (overdue) return "breached";
  if (daysRemaining <= DUE_SOON_DAYS) return "0-3d";
  if (daysRemaining <= 7) return "4-7d";
  if (daysRemaining <= 14) return "8-14d";
  if (daysRemaining <= 30) return "15-30d";
  return "30d+";
}

/** UTC calendar day as `YYYY-MM-DD`, `d` days before `now`. */
function dayString(now: Date, d: number): string {
  const utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(utc - d * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function loadTenants(): Promise<TenantRow[]> {
  if (config.DEMO_MODE) return demoTenants;
  return db.select().from(tables.tenants);
}

/** Raw, unfiltered vulnerabilities — the same rows /api/vulnerabilities reads
 * before its tenant-scoped exposure recompute and exception filter, both of
 * which only ever run when a tenantId is present. */
async function loadVulnerabilitiesRaw(tenantId?: string): Promise<VulnerabilityRow[]> {
  const rows = config.DEMO_MODE ? demoVulnerabilities : await db.select().from(tables.vulnerabilities);
  return tenantId ? rows.filter((v) => v.tenantId === tenantId) : rows;
}

async function loadDevicesRaw(tenantId?: string): Promise<DeviceRow[]> {
  const rows = config.DEMO_MODE ? demoDevices : await db.select().from(tables.devices);
  return tenantId ? rows.filter((d) => d.tenantId === tenantId) : rows;
}

/** Devices with any active exclusion removed — mirrors /api/devices' default
 * (includeExcluded=false) view, with no exception adjustment applied. */
async function loadVisibleDevicesRaw(tenantId: string | undefined): Promise<DeviceRow[]> {
  const [rows, excludedIndex] = await Promise.all([
    loadDevicesRaw(tenantId),
    loadExcludedDeviceIndex(tenantId),
  ]);
  if (excludedIndex.isEmpty) return rows;
  return rows.filter((d) => {
    const e = excludedIndex.byManagedDeviceId.get(d.managedDeviceId);
    return !(e && e.tenantId === d.tenantId);
  });
}

/** Active, non-excepted misconfiguration recommendations — same count
 * /api/recommendations?kind=misconfiguration returns for the same scope. */
async function loadRecommendationsRaw(tenantId?: string): Promise<RecommendationRow[]> {
  const rows = config.DEMO_MODE ? demoRecommendations : await db.select().from(tables.recommendations);
  return tenantId ? rows.filter((r) => r.tenantId === tenantId) : rows;
}

// Matches on the exception's own recommendationId (e.g. "va-_-openssl-_-openssl")
// rather than cross-referencing the current `recommendations` sync. A Defender
// recommendation can drop out of a sync (resolved, re-scanned, transiently
// absent) while the exception that references it persists — and the exception
// is what actually explains a PatchPilot/Defender count gap, so it needs to
// keep surfacing even when the underlying recommendation isn't in the latest
// sync. Broken out from the general `activeExceptions` tile — which the
// Dashboard doesn't otherwise surface at all — because OpenSSL findings can't
// be auto-remediated (the fix ships inside the owning app, see
// `requiresManualRemediation`), so engineers routinely except the whole
// recommendation, and it's likely to exist on nearly every tenant.
const isOpensslExceptionId = (recommendationId: string | null): boolean =>
  (recommendationId ?? "").toLowerCase().includes("openssl");

async function countMisconfigurations(tenantId?: string): Promise<number> {
  const scoped = await loadRecommendationsRaw(tenantId);
  const active = scoped.filter((r) => recommendationKind(r) === "misconfiguration" && isDefenderActive(r));
  if (!tenantId) return active.length;
  const exceptions = await loadActiveExceptions(tenantId);
  return active.filter(
    (r) => !isExcepted(exceptions, null, { recommendationIds: [r.recommendationId] }),
  ).length;
}

interface SeverityCountRow {
  severity: Severity;
  count: number;
}
interface SlaBucketRow {
  bucket: SlaBucketName;
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}
interface TopSoftwareRow {
  software: string;
  displayName: string;
  severity: Severity;
  affectedDeviceCount: number;
  cveCount: number;
}
interface ComplianceCountRow {
  compliance: DeviceCompliance;
  count: number;
}
interface OsBreakdownRow {
  os: string;
  total: number;
  compliant: number;
  noncompliant: number;
  unknown: number;
}
interface RemediationDayRow {
  day: string;
  succeeded: number;
  failed: number;
}
interface CveTrendDayRow {
  day: string;
  detected: number;
  remediated: number;
}
/** Exported alongside `loadTrend` for `/api/reports/metrics/posture-trend.csv`,
 * which names this shape rather than inferring it. */
export interface TrendPointRow {
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
interface PerTenantRow {
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
/** Enough to render one "Urgent vulnerabilities" table row, plus `id` to
 * locate the matching full `Vulnerability` for the detail drawer once the
 * web app lazily fetches the full list on first open. */
interface UrgentVulnRow {
  id: string;
  tenantId: string;
  cveId: string;
  title: string;
  software: string;
  displayName: string;
  severity: Severity;
  affectedDeviceCount: number;
  exploitVerified: boolean;
  sla: SlaStatus & { chip: string };
}
/** Same idea for "Devices needing attention" — `DeviceRow` already carries
 * everything a table row + drawer lookup needs, so no extra mapping. */
interface AttentionDeviceRow {
  id: string;
  tenantId: string;
  managedDeviceId: string;
  hostname: string;
  os: string;
  compliance: DeviceCompliance;
  vulnerabilityCount: number;
}

/**
 * The pure row-builders below (`severityRows` … `osBreakdownRows`) and
 * `loadTrend` are exported for `apps/api/src/reports/facts.ts`.
 *
 * A report prints the same blocks the Dashboard renders, and the one thing a
 * printed artefact must never do is disagree with the screen it was generated
 * from. Re-implementing "the six SLA buckets" or "top 8 software by exposure"
 * next door would be a second definition of each, free to drift. Same reasoning
 * that already exported `computeCveTrend` and `isCountedTowardMetrics`: these
 * take rows in and give rows back, touch no database, and are the definition.
 */
export function severityRows(counts: Record<Severity, number>): SeverityCountRow[] {
  return SEVERITY_ORDER.map((severity) => ({ severity, count: counts[severity] }));
}

export function complianceRows(counts: Record<DeviceCompliance, number>): ComplianceCountRow[] {
  return [
    { compliance: "compliant" as const, count: counts.compliant },
    { compliance: "noncompliant" as const, count: counts.noncompliant },
    { compliance: "unknown" as const, count: counts.unknown },
  ];
}

/** Buckets a set of (severity, daysRemaining, overdue) findings into the six
 * SLA burn-down buckets, always all six even when a bucket is empty. */
export function bucketFindings(
  findings: readonly { severity: Severity; daysRemaining: number; overdue: boolean }[],
): SlaBucketRow[] {
  const buckets = new Map<SlaBucketName, SlaBucketRow>(
    SLA_BUCKET_NAMES.map((bucket) => [
      bucket,
      { bucket, critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    ]),
  );
  for (const f of findings) {
    const row = buckets.get(slaBucketFor(f.daysRemaining, f.overdue))!;
    row[f.severity] += 1;
    row.total += 1;
  }
  return SLA_BUCKET_NAMES.map((b) => buckets.get(b)!);
}

/** Top 8 software by device exposure — Math.max across a product's findings,
 * never a sum, since summing double-counts devices shared across CVEs. */
export function topSoftwareRows(
  findings: readonly { software: string; severity: Severity; affectedDeviceCount: number }[],
): TopSoftwareRow[] {
  interface Group {
    software: string;
    severity: Severity;
    severityRank: number;
    affectedDeviceCount: number;
    cveCount: number;
  }
  const groups = new Map<string, Group>();
  for (const f of findings) {
    const key = f.software.trim().toLowerCase();
    const rank = SEVERITY_RANK[f.severity];
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        software: f.software,
        severity: f.severity,
        severityRank: rank,
        affectedDeviceCount: f.affectedDeviceCount,
        cveCount: 1,
      });
      continue;
    }
    existing.cveCount += 1;
    existing.affectedDeviceCount = Math.max(existing.affectedDeviceCount, f.affectedDeviceCount);
    if (rank > existing.severityRank) {
      existing.severity = f.severity;
      existing.severityRank = rank;
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.affectedDeviceCount - a.affectedDeviceCount)
    .slice(0, 8)
    .map((g) => ({
      software: g.software,
      displayName: resolveDisplaySoftwareName(g.software),
      severity: g.severity,
      affectedDeviceCount: g.affectedDeviceCount,
      cveCount: g.cveCount,
    }));
}

/** Top 8 by SLA urgency (breached first, then soonest days remaining) — the
 * "Most urgent vulnerabilities" table. */
function urgentVulnRows(
  findings: readonly {
    id: string;
    tenantId: string;
    cveId: string;
    title: string;
    software: string;
    severity: Severity;
    affectedDeviceCount: number;
    exploitVerified: boolean;
    sla: SlaStatus;
  }[],
): UrgentVulnRow[] {
  return [...findings]
    .sort((a, b) => {
      if (a.sla.overdue !== b.sla.overdue) return a.sla.overdue ? -1 : 1;
      return a.sla.daysRemaining - b.sla.daysRemaining;
    })
    .slice(0, 8)
    .map((f) => ({
      id: f.id,
      tenantId: f.tenantId,
      cveId: f.cveId,
      title: f.title,
      software: f.software,
      displayName: resolveDisplaySoftwareName(f.software),
      severity: f.severity,
      affectedDeviceCount: f.affectedDeviceCount,
      exploitVerified: f.exploitVerified,
      sla: { ...f.sla, chip: slaChipLabel(f.sla) },
    }));
}

/** Top 8 noncompliant devices by vulnerability load — "Devices needing
 * attention". */
function attentionDeviceRows(devices: readonly DeviceRow[]): AttentionDeviceRow[] {
  return devices
    .filter((d) => d.compliance === "noncompliant")
    .sort((a, b) => b.vulnerabilityCount - a.vulnerabilityCount)
    .slice(0, 8)
    .map((d) => ({
      id: d.id,
      tenantId: d.tenantId,
      managedDeviceId: d.managedDeviceId,
      hostname: d.hostname,
      os: d.os,
      compliance: d.compliance,
      vulnerabilityCount: d.vulnerabilityCount,
    }));
}

/** Top 6 OS by device count + an "Other" catch-all, each split by compliance. */
export function osBreakdownRows(devices: readonly { os: string; compliance: DeviceCompliance }[]): OsBreakdownRow[] {
  const groups = new Map<string, OsBreakdownRow>();
  for (const d of devices) {
    const key = d.os || "Unknown";
    let row = groups.get(key);
    if (!row) {
      row = { os: key, total: 0, compliant: 0, noncompliant: 0, unknown: 0 };
      groups.set(key, row);
    }
    row.total += 1;
    row[d.compliance] += 1;
  }
  const sorted = [...groups.values()].sort((a, b) => b.total - a.total);
  if (sorted.length <= 6) return sorted;
  const top = sorted.slice(0, 6);
  const rest = sorted.slice(6);
  const other: OsBreakdownRow = rest.reduce(
    (acc, r) => ({
      os: "Other",
      total: acc.total + r.total,
      compliant: acc.compliant + r.compliant,
      noncompliant: acc.noncompliant + r.noncompliant,
      unknown: acc.unknown + r.unknown,
    }),
    { os: "Other", total: 0, compliant: 0, noncompliant: 0, unknown: 0 },
  );
  return [...top, other];
}

async function remediationBlock(tenantId: string | undefined, now: Date) {
  const jobs = await listJobs(tenantId, true);
  const byDay = new Map<string, RemediationDayRow>();
  for (let d = REMEDIATION_DAYS - 1; d >= 0; d--) {
    const day = dayString(now, d);
    byDay.set(day, { day, succeeded: 0, failed: 0 });
  }
  let succeeded = 0;
  let failed = 0;
  let failedLast24h = 0;
  const cutoff = now.getTime() - 24 * MS_PER_HOUR;
  for (const j of jobs) {
    if (!j.finishedAt) continue;
    const day = j.finishedAt.slice(0, 10);
    const row = byDay.get(day);
    if (j.status === "succeeded") {
      succeeded += 1;
      if (row) row.succeeded += 1;
    } else if (j.status === "failed") {
      failed += 1;
      if (row) row.failed += 1;
      if (new Date(j.finishedAt).getTime() >= cutoff) failedLast24h += 1;
    }
  }
  const total = succeeded + failed;
  return {
    days: [...byDay.values()],
    succeeded,
    failed,
    successRate: total === 0 ? null : succeeded / total,
    failedLast24h,
  };
}

/**
 * Whether a closed finding counts toward the dashboard's remediation metrics.
 * Reclassified rows (the winget-matcher-correction false positive documented
 * on `remediationEvents` in schema.ts) never do — nothing was actually fixed.
 * Exported and unit-tested directly since the DEMO_MODE branches below apply
 * it in JS; the DB branches express the identical rule as
 * `eq(tables.remediationEvents.closure, "cleared")`, which can't be unit
 * tested without a live database, so this is the one place the rule itself
 * is checked in isolation.
 */
export function isCountedTowardMetrics(closure: RemediationEventRow["closure"]): boolean {
  return closure === "cleared";
}

/** Pure aggregation half of `cveTrendBlock` — a CVE counts as "detected" on a
 * day either because it's still open with that `detectedAt` (`openVulns`) or
 * because it was later remediated but first detected that day
 * (`events[].detectedAt`, preserved past prune); "remediated" comes from
 * `events[].remediatedAt`. Kept separate from the DB/demo fetch so it's
 * unit-testable with fabricated rows, same as `summarizeTimeToRemediate`. */
export function computeCveTrend(
  openVulns: readonly { detectedAt: Date }[],
  events: readonly { detectedAt: Date; remediatedAt: Date }[],
  now: Date,
  days: number,
): CveTrendDayRow[] {
  const byDay = new Map<string, CveTrendDayRow>();
  for (let d = days - 1; d >= 0; d--) {
    const day = dayString(now, d);
    byDay.set(day, { day, detected: 0, remediated: 0 });
  }
  const cutoff = new Date(now.getTime() - days * 24 * MS_PER_HOUR);
  for (const v of openVulns) {
    if (v.detectedAt < cutoff) continue;
    const row = byDay.get(v.detectedAt.toISOString().slice(0, 10));
    if (row) row.detected += 1;
  }
  for (const e of events) {
    if (e.detectedAt >= cutoff) {
      const row = byDay.get(e.detectedAt.toISOString().slice(0, 10));
      if (row) row.detected += 1;
    }
    const row = byDay.get(e.remediatedAt.toISOString().slice(0, 10));
    if (row) row.remediated += 1;
  }
  return [...byDay.values()];
}

async function cveTrendBlock(tenantId: string | undefined, now: Date): Promise<CveTrendDayRow[]> {
  const cutoff = new Date(now.getTime() - CVE_TREND_DAYS * 24 * MS_PER_HOUR);
  const [openVulns, events] = await Promise.all([
    loadVulnerabilitiesRaw(tenantId),
    config.DEMO_MODE
      ? demoRemediationEvents.filter(
          (e) =>
            (!tenantId || e.tenantId === tenantId) &&
            e.kind === "vulnerability" &&
            isCountedTowardMetrics(e.closure) &&
            e.remediatedAt >= cutoff,
        )
      : db
          .select({
            detectedAt: tables.remediationEvents.detectedAt,
            remediatedAt: tables.remediationEvents.remediatedAt,
          })
          .from(tables.remediationEvents)
          .where(
            and(
              tenantId ? eq(tables.remediationEvents.tenantId, tenantId) : undefined,
              eq(tables.remediationEvents.kind, "vulnerability"),
              eq(tables.remediationEvents.closure, "cleared"),
              gte(tables.remediationEvents.remediatedAt, cutoff),
            ),
          ),
  ]);
  return computeCveTrend(openVulns, events, now, CVE_TREND_DAYS);
}

/** Also feeds `/api/reports/metrics/time-to-remediate.csv`. Exported for the
 * same reason as the row-builders above: the CSV and the Dashboard tile must
 * be two renderings of one number, not two computations of it. */
export async function timeToRemediateBlock(
  tenantId: string | undefined,
  now: Date,
  windowDays: number,
): Promise<TimeToRemediateSummary> {
  const cutoff = new Date(now.getTime() - windowDays * 24 * MS_PER_HOUR);
  const rows: Array<Pick<RemediationEventRow, "severity" | "detectedAt" | "remediatedAt">> = config.DEMO_MODE
    ? demoRemediationEvents.filter(
        (e) => (!tenantId || e.tenantId === tenantId) && isCountedTowardMetrics(e.closure) && e.remediatedAt >= cutoff,
      )
    : await db
        .select({
          severity: tables.remediationEvents.severity,
          detectedAt: tables.remediationEvents.detectedAt,
          remediatedAt: tables.remediationEvents.remediatedAt,
        })
        .from(tables.remediationEvents)
        .where(
          and(
            tenantId ? eq(tables.remediationEvents.tenantId, tenantId) : undefined,
            eq(tables.remediationEvents.closure, "cleared"),
            gte(tables.remediationEvents.remediatedAt, cutoff),
          ),
        );
  return summarizeTimeToRemediate(
    rows.map((r) => ({ severity: r.severity as Severity, detectedAt: r.detectedAt, remediatedAt: r.remediatedAt })),
    windowDays,
  );
}

function snapshotToTrendPoint(s: PostureSnapshotRow): TrendPointRow {
  return {
    day: s.day,
    devices: s.devices,
    devicesCompliant: s.devicesCompliant,
    devicesNoncompliant: s.devicesNoncompliant,
    devicesUnknown: s.devicesUnknown,
    openFindings: s.openFindings,
    critical: s.critical,
    high: s.high,
    medium: s.medium,
    low: s.low,
    slaBreached: s.slaBreached,
    slaDueSoon: s.slaDueSoon,
    slaOk: s.slaOk,
  };
}

/** Also feeds `/api/reports/metrics/posture-trend.csv` — see the note above the
 * row-builders for why the report path reuses these rather than re-deriving. */
export async function loadTrend(
  tenantId: string | undefined,
  windowDays: number,
  now: Date,
): Promise<TrendPointRow[]> {
  const cutoff = dayString(now, windowDays - 1);
  const rows: PostureSnapshotRow[] = config.DEMO_MODE
    ? demoPostureSnapshots.filter((s) => (!tenantId || s.tenantId === tenantId) && s.day >= cutoff)
    : await db
        .select()
        .from(tables.postureSnapshots)
        .where(
          and(
            tenantId ? eq(tables.postureSnapshots.tenantId, tenantId) : undefined,
            gte(tables.postureSnapshots.day, cutoff),
          ),
        )
        .orderBy(asc(tables.postureSnapshots.day));

  const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  if (tenantId) return sorted.map(snapshotToTrendPoint);

  // All-tenants: sum every tenant's snapshot for the same day into one point.
  const byDay = new Map<string, TrendPointRow>();
  for (const s of sorted) {
    const point = snapshotToTrendPoint(s);
    const existing = byDay.get(s.day);
    if (!existing) {
      byDay.set(s.day, point);
      continue;
    }
    existing.devices += point.devices;
    existing.devicesCompliant += point.devicesCompliant;
    existing.devicesNoncompliant += point.devicesNoncompliant;
    existing.devicesUnknown += point.devicesUnknown;
    existing.openFindings += point.openFindings;
    existing.critical += point.critical;
    existing.high += point.high;
    existing.medium += point.medium;
    existing.low += point.low;
    existing.slaBreached += point.slaBreached;
    existing.slaDueSoon += point.slaDueSoon;
    existing.slaOk += point.slaOk;
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * The full GET /api/dashboard/summary aggregate, factored out so the AI
 * summarize route (apps/api/src/ai/summarize.ts) can narrate over exactly
 * what the Dashboard itself renders — never a separately-derived number that
 * could drift from what the engineer sees on screen. The route handler below
 * is now a thin querystring-parsing wrapper around this.
 */
export async function buildDashboardSummary(tenantId: string | undefined, windowDaysInput?: number) {
      const now = new Date();
      const windowDays = Math.min(
        Math.max(windowDaysInput || DEFAULT_WINDOW_DAYS, MIN_WINDOW_DAYS),
        MAX_WINDOW_DAYS,
      );

      const thresholds = await loadSlaThresholds();
      const allTenants = await loadTenants();

      // ---- scope: always over the engineer's full tenant list, independent
      // of which tenant is currently selected — this is the "12 reachable · 2
      // stale · 1 never synced" strip, not a per-tenant number.
      const reachable = allTenants.filter((t) => t.reachability === "reachable").length;
      const stale = allTenants.filter(
        (t) => t.lastSyncedAt && now.getTime() - t.lastSyncedAt.getTime() > STALE_HOURS * MS_PER_HOUR,
      ).length;
      const neverSynced = allTenants.filter((t) => !t.lastSyncedAt).length;
      const readOnlyCount = allTenants.filter((t) => t.readOnly).length;
      const syncedTimes = allTenants
        .map((t) => t.lastSyncedAt)
        .filter((t): t is Date => t !== null)
        .map((t) => t.getTime());
      const scope = {
        tenants: allTenants.length,
        reachable,
        stale,
        neverSynced,
        readOnly: readOnlyCount,
        oldestSyncAt: syncedTimes.length ? new Date(Math.min(...syncedTimes)).toISOString() : null,
        newestSyncAt: syncedTimes.length ? new Date(Math.max(...syncedTimes)).toISOString() : null,
      };

      let tiles: Record<string, number>;
      let severity: SeverityCountRow[];
      let slaBuckets: SlaBucketRow[];
      let topSoftware: TopSoftwareRow[];
      let fleet: { compliance: ComplianceCountRow[]; os: OsBreakdownRow[] };
      let perTenant: PerTenantRow[] | undefined;
      let urgentVulns: UrgentVulnRow[];
      let attentionDevices: AttentionDeviceRow[];
      let opensslExceptionTenantIds: string[];

      if (tenantId) {
        const posture = await loadTenantPosture(tenantId, thresholds, now);
        const sev = severityCounts(posture.findings);
        const sla = slaCounts(posture.findings);
        const compliance = complianceCounts(posture.devices);
        const [misconfigurations, activeExceptions] = await Promise.all([
          countMisconfigurations(tenantId),
          loadActiveExceptions(tenantId),
        ]);
        const featureUpdateTargetBuild = resolveTargetBuild(
          allTenants.find((t) => t.tenantId === tenantId)?.featureUpdateTargetVersion,
        );
        const devicesBehindFeatureUpdate = posture.devices.filter((d) =>
          isDeviceBehindFeatureUpdate(d.osBuild, d.os, featureUpdateTargetBuild),
        ).length;

        tiles = {
          critical: sev.critical,
          high: sev.high,
          breached: sla.breached,
          dueSoon: sla["due-soon"],
          openFindings: posture.findings.length,
          devices: posture.devices.length,
          noncompliantDevices: compliance.noncompliant,
          compliantDevices: compliance.compliant,
          unmonitoredDevices: compliance.unknown,
          misconfigurations,
          activeExceptions: activeExceptions.length,
          excludedDevices: posture.excludedDevices,
          verifiedExploitOpen: posture.findings.filter((f) => f.exploitVerified).length,
          devicesBehindFeatureUpdate,
        };
        opensslExceptionTenantIds = activeExceptions.some((e) => isOpensslExceptionId(e.recommendationId))
          ? [tenantId]
          : [];
        severity = severityRows(sev);
        slaBuckets = bucketFindings(
          posture.findings.map((f) => ({
            severity: f.severity,
            daysRemaining: f.sla.daysRemaining,
            overdue: f.sla.overdue,
          })),
        );
        topSoftware = topSoftwareRows(posture.findings);
        fleet = {
          compliance: complianceRows(compliance),
          os: osBreakdownRows(posture.devices),
        };
        urgentVulns = urgentVulnRows(posture.findings.map((f) => ({ ...f, tenantId })));
        attentionDevices = attentionDeviceRows(posture.devices);
      } else {
        const [vulns, visibleDevices, misconfigurations, exclusions] = await Promise.all([
          loadVulnerabilitiesRaw(undefined),
          loadVisibleDevicesRaw(undefined),
          countMisconfigurations(undefined),
          loadActiveExclusions(),
        ]);

        const findings = vulns.map((v) => {
          const sla = computeSla(v.severity as Severity, v.detectedAt, thresholds, now, v.exploitVerified);
          return {
            id: v.id,
            tenantId: v.tenantId,
            cveId: v.cveId,
            title: v.title,
            software: v.software,
            severity: v.severity as Severity,
            affectedDeviceCount: v.affectedDeviceCount,
            exploitVerified: v.exploitVerified,
            sla,
            daysRemaining: sla.daysRemaining,
            overdue: sla.overdue,
            tone: slaTone(sla) as SlaTone,
          };
        });
        const sev: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
        const slaCountsAll = { breached: 0, "due-soon": 0, ok: 0 };
        for (const f of findings) {
          sev[f.severity] += 1;
          slaCountsAll[f.tone] += 1;
        }
        const compliance: Record<DeviceCompliance, number> = { compliant: 0, noncompliant: 0, unknown: 0 };
        for (const d of visibleDevices) compliance[d.compliance] += 1;

        const featureUpdateTargetBuildByTenant = new Map(
          allTenants.map((t) => [t.tenantId, resolveTargetBuild(t.featureUpdateTargetVersion)]),
        );
        const devicesBehindFeatureUpdate = visibleDevices.filter((d) =>
          isDeviceBehindFeatureUpdate(
            d.osBuild,
            d.os,
            featureUpdateTargetBuildByTenant.get(d.tenantId) ?? resolveTargetBuild(null),
          ),
        ).length;

        // Active exceptions are tenant-scoped; the all-tenants tile sums the
        // per-tenant count rather than resolving anything cross-tenant.
        const exceptionCounts = await Promise.all(
          allTenants.map((t) => loadActiveExceptions(t.tenantId)),
        );
        const activeExceptions = exceptionCounts.reduce((n, e) => n + e.length, 0);
        opensslExceptionTenantIds = allTenants
          .map((t, i) => ({ tenantId: t.tenantId, exceptions: exceptionCounts[i] ?? [] }))
          .filter(({ exceptions }) => exceptions.some((e) => isOpensslExceptionId(e.recommendationId)))
          .map(({ tenantId: tid }) => tid);

        tiles = {
          critical: sev.critical,
          high: sev.high,
          breached: slaCountsAll.breached,
          dueSoon: slaCountsAll["due-soon"],
          openFindings: findings.length,
          devices: visibleDevices.length,
          noncompliantDevices: compliance.noncompliant,
          compliantDevices: compliance.compliant,
          unmonitoredDevices: compliance.unknown,
          misconfigurations,
          activeExceptions,
          excludedDevices: exclusions.length,
          verifiedExploitOpen: findings.filter((f) => f.exploitVerified).length,
          devicesBehindFeatureUpdate,
        };
        severity = severityRows(sev);
        slaBuckets = bucketFindings(findings);
        topSoftware = topSoftwareRows(findings);
        fleet = {
          compliance: complianceRows(compliance),
          os: osBreakdownRows(visibleDevices),
        };
        urgentVulns = urgentVulnRows(findings);
        attentionDevices = attentionDeviceRows(visibleDevices);

        // perTenant: one full posture pipeline per tenant — exception-aware,
        // exclusion-aware, the only block in all-tenants mode that is.
        perTenant = await Promise.all(
          allTenants.map(async (t) => {
            const p = await loadTenantPosture(t.tenantId, thresholds, now);
            const s = severityCounts(p.findings);
            const sl = slaCounts(p.findings);
            const c = complianceCounts(p.devices);
            return {
              tenantId: t.tenantId,
              displayName: t.displayName,
              reachability: t.reachability,
              readOnly: t.readOnly,
              lastSyncedAt: t.lastSyncedAt ? t.lastSyncedAt.toISOString() : null,
              devices: p.devices.length,
              critical: s.critical,
              slaBreached: sl.breached,
              noncompliantDevices: c.noncompliant,
            };
          }),
        );
        perTenant.sort((a, b) => b.slaBreached - a.slaBreached);
      }

      const remediation = await remediationBlock(tenantId, now);
      const timeToRemediate = await timeToRemediateBlock(tenantId, now, windowDays);
      const cveTrend = await cveTrendBlock(tenantId, now);
      const trend = await loadTrend(tenantId, windowDays, now);
      const trendCoverage = {
        requestedDays: windowDays,
        capturedDays: trend.length,
        firstDay: trend[0]?.day ?? null,
        complete: trend.length >= windowDays,
      };

      return {
        tenantId: tenantId ?? null,
        generatedAt: now.toISOString(),
        demo: config.DEMO_MODE,
        scope,
        tiles,
        severity,
        slaBuckets,
        topSoftware,
        fleet,
        remediation,
        timeToRemediate,
        cveTrend,
        trend,
        trendCoverage,
        perTenant,
        urgentVulns,
        attentionDevices,
        opensslExceptionTenantIds,
      };
}

export type DashboardSummary = Awaited<ReturnType<typeof buildDashboardSummary>>;

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("operations:read"));

  app.get<{ Querystring: { tenantId?: string; windowDays?: string } }>(
    "/api/dashboard/summary",
    async (req) => buildDashboardSummary(req.query.tenantId, Number(req.query.windowDays)),
  );
}
