import { and, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db, tables, demoRemediationEvents, type RemediationEventRow } from "@patchpilot/db";
import { encodeKeysetCursor, decodeKeysetCursor } from "@patchpilot/graph";
import type { Severity } from "@patchpilot/shared";
import { config } from "../config.js";

/**
 * Remediation History: one durable, filterable, exportable row per closed
 * finding, attributed to the device/engineer/job that closed it where one
 * could be identified (graph/attribution.ts, called at sync-prune time).
 *
 * Reads the same `remediation_events` table the Dashboard's time-to-remediate
 * card and CVE trend chart read (posture/time-to-remediate.ts) — this module
 * adds no new source of truth, only filtering, paging and export over the
 * existing one, so the page and the card can never disagree.
 *
 * DEMO_MODE forks inside `fetchRemediationHistory` (one fork, not per-route),
 * mirroring listAudits in packages/graph/src/audit.ts.
 */

export type RemediationEventKind = (typeof tables.remediationKindEnum.enumValues)[number];
export type RemediationAttributionKind = (typeof tables.remediationAttributionEnum.enumValues)[number];
export type RemediationClosure = (typeof tables.remediationClosureEnum.enumValues)[number];
export type RemediationChannel = (typeof tables.channelEnum.enumValues)[number];

export interface RemediationHistoryRecord {
  id: string;
  tenantId: string;
  kind: RemediationEventKind;
  cveId: string | null;
  recommendationId: string | null;
  software: string | null;
  severity: Severity;
  detectedAt: string;
  remediatedAt: string;
  deviceId: string | null;
  deviceHostname: string | null;
  engineer: string | null;
  jobId: string | null;
  channel: RemediationChannel | null;
  attribution: RemediationAttributionKind;
  fixStartedAt: string | null;
  fixFinishedAt: string | null;
  contributingJobs: number;
  closure: RemediationClosure;
}

export interface RemediationHistoryQuery {
  tenantId?: string;
  /** Query-level "any of these tenants" constraint, for the all-tenants case
   * (no single tenantId) that still needs to stay within an engineer's
   * reachable set. Ignored when tenantId is set. */
  tenantIds?: string[];
  cveId?: string;
  software?: string;
  deviceId?: string;
  engineer?: string;
  severity?: Severity;
  kind?: RemediationEventKind;
  attribution?: RemediationAttributionKind;
  /** Defaults to "cleared" at the call site (dashboard-equivalent view);
   * pass "all" explicitly to include reclassified rows too. */
  closure?: RemediationClosure | "all";
  /** Free text over cveId / software / deviceHostname / engineer. */
  q?: string;
  /** Half-open [from, to) on `remediatedAt`, ISO-8601. */
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface RemediationHistoryPage {
  rows: RemediationHistoryRecord[];
  nextCursor: string | null;
}

export const REMEDIATION_HISTORY_DEFAULT_LIMIT = 100;
export const REMEDIATION_HISTORY_MAX_LIMIT = 500;
/** Ceiling for CSV export and for the (unpaged) stats aggregation. */
export const REMEDIATION_HISTORY_MAX_EXPORT_ROWS = 10_000;

function rowToRecord(row: RemediationEventRow): RemediationHistoryRecord {
  const iso = (d: Date | null) => (d ? (d instanceof Date ? d : new Date(d)).toISOString() : null);
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    cveId: row.cveId,
    recommendationId: row.recommendationId,
    software: row.software,
    severity: row.severity as Severity,
    detectedAt: iso(row.detectedAt)!,
    remediatedAt: iso(row.remediatedAt)!,
    deviceId: row.deviceId,
    deviceHostname: row.deviceHostname,
    engineer: row.engineer,
    jobId: row.jobId,
    channel: row.channel,
    attribution: row.attribution,
    fixStartedAt: iso(row.fixStartedAt),
    fixFinishedAt: iso(row.fixFinishedAt),
    contributingJobs: row.contributingJobs,
    closure: row.closure,
  };
}

/** Keyset cursor over (remediatedAt, id) — see keyset-cursor.ts for why the
 * id tiebreak is load-bearing, not defensive: many findings clear in the
 * same sync run and so share a `remediatedAt` to the millisecond. */
export function encodeRemediationHistoryCursor(record: Pick<RemediationHistoryRecord, "remediatedAt" | "id">): string {
  return encodeKeysetCursor({ sortValue: record.remediatedAt, id: record.id });
}

function decodeCursor(cursor: string): { at: string; id: string } | null {
  const decoded = decodeKeysetCursor(cursor);
  return decoded ? { at: decoded.sortValue, id: decoded.id } : null;
}

/** The filter predicate, in memory — must behave identically to the SQL
 * branch below, since DEMO_MODE is what most people see this page in. */
export function matchesRemediationHistoryQuery(
  record: RemediationHistoryRecord,
  query: RemediationHistoryQuery,
): boolean {
  if (query.tenantId && record.tenantId !== query.tenantId) return false;
  if (!query.tenantId && query.tenantIds && !query.tenantIds.includes(record.tenantId)) return false;
  if (query.cveId && record.cveId !== query.cveId) return false;
  if (query.software && record.software?.toLowerCase() !== query.software.toLowerCase()) return false;
  if (query.deviceId && record.deviceId !== query.deviceId) return false;
  if (query.engineer && record.engineer !== query.engineer) return false;
  if (query.severity && record.severity !== query.severity) return false;
  if (query.kind && record.kind !== query.kind) return false;
  if (query.attribution && record.attribution !== query.attribution) return false;
  if (query.closure && query.closure !== "all" && record.closure !== query.closure) return false;
  if (query.from && record.remediatedAt < query.from) return false;
  if (query.to && record.remediatedAt >= query.to) return false;
  if (query.q) {
    const needle = query.q.toLowerCase();
    const haystack = [record.cveId, record.software, record.deviceHostname, record.engineer];
    if (!haystack.some((field) => field?.toLowerCase().includes(needle))) return false;
  }
  return true;
}

/** The same predicate as SQL. */
function buildWhere(query: RemediationHistoryQuery): SQL | undefined {
  const t = tables.remediationEvents;
  const conditions: SQL[] = [];

  if (query.tenantId) conditions.push(eq(t.tenantId, query.tenantId));
  else if (query.tenantIds) conditions.push(inArray(t.tenantId, query.tenantIds));
  if (query.cveId) conditions.push(eq(t.cveId, query.cveId));
  if (query.software) conditions.push(ilike(t.software, query.software));
  if (query.deviceId) conditions.push(eq(t.deviceId, query.deviceId));
  if (query.engineer) conditions.push(eq(t.engineer, query.engineer));
  if (query.severity) conditions.push(eq(t.severity, query.severity));
  if (query.kind) conditions.push(eq(t.kind, query.kind));
  if (query.attribution) conditions.push(eq(t.attribution, query.attribution));
  if (query.closure && query.closure !== "all") conditions.push(eq(t.closure, query.closure));
  if (query.from) conditions.push(gte(t.remediatedAt, new Date(query.from)));
  if (query.to) conditions.push(lt(t.remediatedAt, new Date(query.to)));

  if (query.q) {
    const like = `%${query.q}%`;
    conditions.push(
      or(ilike(t.cveId, like), ilike(t.software, like), ilike(t.deviceHostname, like), ilike(t.engineer, like))!,
    );
  }

  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    if (decoded) {
      // Row-value comparison: (remediatedAt, id) < (cursorAt, cursorId). The
      // ISO string is bound as text and cast in SQL — a bare Date can't be
      // serialised by postgres.js, same note as buildAuditWhere in audit.ts.
      conditions.push(sql`(${t.remediatedAt}, ${t.id}) < (${decoded.at}::timestamptz, ${decoded.id}::uuid)`);
    }
  }

  return conditions.length ? and(...conditions) : undefined;
}

function clampLimit(limit: number | undefined, max = REMEDIATION_HISTORY_MAX_LIMIT): number {
  if (!limit || Number.isNaN(limit)) return REMEDIATION_HISTORY_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

/** Shared fetch for list, export and stats — `take` rows, newest-remediated first. */
export async function fetchRemediationHistory(
  query: RemediationHistoryQuery,
  take: number,
): Promise<RemediationHistoryRecord[]> {
  if (config.DEMO_MODE) {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    return demoRemediationEvents
      .map(rowToRecord)
      .filter((record) => {
        if (!matchesRemediationHistoryQuery(record, query)) return false;
        if (!cursor) return true;
        return record.remediatedAt < cursor.at || (record.remediatedAt === cursor.at && record.id < cursor.id);
      })
      .sort((a, b) => (a.remediatedAt === b.remediatedAt ? b.id.localeCompare(a.id) : b.remediatedAt.localeCompare(a.remediatedAt)))
      .slice(0, take);
  }

  const rows = await db
    .select()
    .from(tables.remediationEvents)
    .where(buildWhere(query))
    .orderBy(desc(tables.remediationEvents.remediatedAt), desc(tables.remediationEvents.id))
    .limit(take);

  return rows.map(rowToRecord);
}

/** One page, newest-remediated first. */
export async function listRemediationHistory(query: RemediationHistoryQuery = {}): Promise<RemediationHistoryPage> {
  const limit = clampLimit(query.limit);
  const rows = await fetchRemediationHistory(query, limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: page,
    nextCursor: hasMore && page.length ? encodeRemediationHistoryCursor(page[page.length - 1]!) : null,
  };
}

/**
 * Every matching row up to a hard ceiling — used for both CSV export and the
 * unpaged /stats aggregation. Deliberately not paged: exporting or
 * summarising only the loaded page would silently understate a larger
 * matching set, same reasoning as listAuditsForExport in audit.ts.
 */
export async function listRemediationHistoryForExport(
  query: RemediationHistoryQuery = {},
): Promise<{ rows: RemediationHistoryRecord[]; truncated: boolean }> {
  const rows = await fetchRemediationHistory(query, REMEDIATION_HISTORY_MAX_EXPORT_ROWS + 1);
  const truncated = rows.length > REMEDIATION_HISTORY_MAX_EXPORT_ROWS;
  return { rows: truncated ? rows.slice(0, REMEDIATION_HISTORY_MAX_EXPORT_ROWS) : rows, truncated };
}
