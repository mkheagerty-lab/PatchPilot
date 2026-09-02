import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, lt, lte, or, ilike, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db, tables, demoAuditLog } from "@patchpilot/db";
import {
  deriveAuditOutcome,
  sanitizeDbTextBounded,
  type AuditAction,
  type AuditActorType,
  type AuditCategory,
  type AuditOutcome,
  type AuditResourceType,
} from "@patchpilot/shared";
import { env } from "./env.js";
import { payloadHash } from "./crypto.js";
import { encodeKeysetCursor, decodeKeysetCursor } from "./keyset-cursor.js";

/**
 * Records everything that happens in PatchPilot: every outbound Microsoft API
 * call, and every action an engineer or a background process takes.
 *
 * Non-negotiable #3: engineer, tenant, endpoint, payload hash, response status,
 * timestamp. Payloads are hashed, never stored raw — that applies to `detail`
 * and `summary` too, which carry short human text and never serialized bodies.
 *
 * Two tiers, see AuditCategory in @patchpilot/shared: `api_call` is the raw
 * Microsoft traffic auto-recorded by the three client.ts call sites (hundreds of
 * rows per sync), `action` is a decision somebody made. The read API defaults to
 * `action` so the log stays legible.
 *
 * DEMO_MODE keeps a bounded in-memory ring buffer instead of touching Postgres,
 * so probes/auditing work with zero dependencies and the placeholder
 * DATABASE_URL is never dialled. Production writes straight to the audit_log.
 */
export interface AuditEntry {
  /** Engineer UPN, or a `system:<component>` sentinel from SYSTEM_ACTORS. */
  engineer: string;
  tenantId?: string | null;
  endpoint: string;
  method: string;
  payload?: unknown;
  responseStatus?: number;
  latencyMs?: number;

  // ---- domain-event fields, all optional ----
  // Optional so the ~24 pre-existing call sites keep compiling untouched and can
  // be enriched incrementally; `inferCategory` below means they land in the
  // right tier regardless.
  /** Omit to infer from `action`/`endpoint`. */
  category?: AuditCategory;
  /** Defaults to "user". */
  actorType?: AuditActorType;
  action?: AuditAction;
  resourceType?: AuditResourceType;
  resourceId?: string | null;
  /** Display name for the resource, denormalised so reads need no joins. */
  resourceLabel?: string | null;
  /** One human sentence. Capped at 500 chars by the writer. */
  summary?: string | null;
  /** Omit to derive from `responseStatus`. */
  outcome?: AuditOutcome;
  /** Short reason/error. Bounded by the writer — never pass a payload here. */
  detail?: string | null;
}

export interface AuditRecord {
  id: string;
  engineer: string;
  actorType: AuditActorType;
  tenantId: string | null;
  category: AuditCategory;
  action: string | null;
  endpoint: string;
  method: string;
  resourceType: string | null;
  resourceId: string | null;
  resourceLabel: string | null;
  summary: string | null;
  outcome: AuditOutcome | null;
  detail: string | null;
  payloadHash: string | null;
  responseStatus: number | null;
  latencyMs: number | null;
  at: string;
}

/**
 * Every GraphHost, as an endpoint prefix. Only graphGet/graphWrite/graphUpload
 * build an endpoint as `${host}:${path}`, so this cleanly separates
 * auto-instrumented traffic from every hand-written pseudo-endpoint
 * ("catalog:override", "sync:data") and from the literal Graph paths in
 * CHANNEL_SPECS ("POST /api/machines/...").
 *
 * `client.ts` asserts at compile time that this covers all of GraphHost —
 * omitting one (`beta` was missed originally) silently files raw API traffic
 * into the Actions view, which is the one thing this split exists to prevent.
 *
 * Keep in lockstep with the category backfill in drizzle/0026_*.sql.
 */
export const API_CALL_HOSTS = ["graph", "beta", "defender"] as const;

const API_CALL_ENDPOINT = new RegExp(`^(${API_CALL_HOSTS.join("|")}):`);

/** Exported for the classification tests — not part of the writer's API. */
export function inferCategory(entry: AuditEntry): AuditCategory {
  if (entry.category) return entry.category;
  if (entry.action) return "action";
  return API_CALL_ENDPOINT.test(entry.endpoint) ? "api_call" : "action";
}

/** Hard ceilings, enforced here rather than at ~40 call sites. */
const MAX_SUMMARY_CHARS = 500;
const MAX_DETAIL_CHARS = 2_000;

/** Newest-first in-memory audit log used only in DEMO_MODE. */
const MAX_DEMO_AUDITS = 500;

function rowToRecord(row: typeof tables.auditLog.$inferSelect): AuditRecord {
  return {
    id: row.id,
    engineer: row.engineer,
    actorType: row.actorType,
    tenantId: row.tenantId,
    category: row.category,
    action: row.action,
    endpoint: row.endpoint,
    method: row.method,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    resourceLabel: row.resourceLabel,
    summary: row.summary,
    // Filled in on read so the client never re-implements the rule, and so rows
    // written before this column existed still report an outcome.
    outcome: deriveAuditOutcome(row.outcome, row.responseStatus),
    detail: row.detail,
    payloadHash: row.payloadHash,
    responseStatus: row.responseStatus,
    latencyMs: row.latencyMs,
    at: (row.at instanceof Date ? row.at : new Date(row.at)).toISOString(),
  };
}

// Seeded so the Audit Log page has a story on first load rather than looking
// broken; a demo session's own traffic then accumulates on top. Mirrors how
// apps/api/src/jobs.ts primes demoJobLog from demoJobs.
const demoAudits: AuditRecord[] = demoAuditLog
  .map(rowToRecord)
  .sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)));

function toRecord(entry: AuditEntry): AuditRecord {
  const summary = entry.summary ? entry.summary.slice(0, MAX_SUMMARY_CHARS) : null;
  const detail = entry.detail ? sanitizeDbTextBounded(entry.detail, MAX_DETAIL_CHARS) : null;
  return {
    id: randomUUID(),
    engineer: entry.engineer,
    actorType: entry.actorType ?? "user",
    tenantId: entry.tenantId ?? null,
    category: inferCategory(entry),
    action: entry.action ?? null,
    endpoint: entry.endpoint,
    method: entry.method,
    resourceType: entry.resourceType ?? null,
    resourceId: entry.resourceId ?? null,
    resourceLabel: entry.resourceLabel ?? null,
    summary,
    outcome: entry.outcome ?? null,
    detail,
    payloadHash: entry.payload === undefined ? null : payloadHash(entry.payload),
    responseStatus: entry.responseStatus ?? null,
    latencyMs: entry.latencyMs ?? null,
    at: new Date().toISOString(),
  };
}

export async function audit(entry: AuditEntry): Promise<void> {
  const record = toRecord(entry);

  if (env.DEMO_MODE) {
    demoAudits.unshift(record);
    if (demoAudits.length > MAX_DEMO_AUDITS) demoAudits.length = MAX_DEMO_AUDITS;
    return;
  }

  await db.insert(tables.auditLog).values({
    id: record.id,
    engineer: record.engineer,
    actorType: record.actorType,
    tenantId: record.tenantId,
    category: record.category,
    action: record.action,
    endpoint: record.endpoint,
    method: record.method,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    resourceLabel: record.resourceLabel,
    summary: record.summary,
    outcome: record.outcome,
    detail: record.detail,
    payloadHash: record.payloadHash,
    responseStatus: record.responseStatus,
    latencyMs: record.latencyMs,
  });
}

/**
 * `audit()` that swallows its own failure.
 *
 * Use this from background jobs, sweeps and auth handlers: a failed audit
 * INSERT must never abort a sync cycle or break a sign-in. Request handlers
 * that already have error handling can keep using plain `audit()`.
 */
export async function auditSafe(entry: AuditEntry): Promise<void> {
  try {
    await audit(entry);
  } catch (err) {
    console.error("[audit] write failed", {
      action: entry.action ?? null,
      endpoint: entry.endpoint,
      err,
    });
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface AuditQuery {
  /** "all" means don't filter. Callers default this to "action". */
  category?: AuditCategory | "all";
  tenantId?: string;
  actor?: string;
  actorType?: AuditActorType;
  actions?: string[];
  resourceType?: string;
  resourceId?: string;
  outcome?: AuditOutcome;
  /** Free text over summary / resourceLabel / action / endpoint / engineer. */
  q?: string;
  /** Half-open [from, to) on `at`, ISO-8601. */
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface AuditPage {
  rows: AuditRecord[];
  nextCursor: string | null;
}

export const AUDIT_DEFAULT_LIMIT = 100;
export const AUDIT_MAX_LIMIT = 500;
/** Ceiling for CSV export — one query, no paging. */
export const AUDIT_MAX_EXPORT_ROWS = 10_000;

/**
 * Keyset cursor over (at, id) — a thin, audit-shaped wrapper over the generic
 * (sortValue, id) cursor in keyset-cursor.ts. The three client.ts sites fire
 * in bursts within one millisecond, so the `id` tiebreak is load-bearing, not
 * defensive; see keyset-cursor.ts for the full reasoning.
 */
export function encodeAuditCursor(record: Pick<AuditRecord, "at" | "id">): string {
  return encodeKeysetCursor({ sortValue: record.at, id: record.id });
}

export function decodeAuditCursor(cursor: string): { at: string; id: string } | null {
  const decoded = decodeKeysetCursor(cursor);
  return decoded ? { at: decoded.sortValue, id: decoded.id } : null;
}

/**
 * The filter predicate, in memory.
 *
 * DEMO_MODE is on by default, so this path is the one most people exercise —
 * it has to behave identically to the SQL branch below or the page lies in the
 * mode it's usually seen in. Same discipline apps/api/src/jobs.ts applies to
 * listJobs.
 */
export function matchesAuditQuery(record: AuditRecord, query: AuditQuery): boolean {
  if (query.category && query.category !== "all" && record.category !== query.category) {
    return false;
  }
  // Tenant-scoped views show only that tenant's rows — a catalog refresh or a
  // sign-in is not a Contoso event, so global (null-tenant) rows deliberately
  // do NOT leak in. They show up in the All Tenants view.
  if (query.tenantId && record.tenantId !== query.tenantId) return false;
  if (query.actor && record.engineer !== query.actor) return false;
  if (query.actorType && record.actorType !== query.actorType) return false;
  if (query.actions?.length && (!record.action || !query.actions.includes(record.action))) {
    return false;
  }
  if (query.resourceType && record.resourceType !== query.resourceType) return false;
  if (query.resourceId && record.resourceId !== query.resourceId) return false;
  if (query.outcome && record.outcome !== query.outcome) return false;
  if (query.from && record.at < query.from) return false;
  if (query.to && record.at >= query.to) return false;
  if (query.q) {
    const needle = query.q.toLowerCase();
    const haystack = [
      record.summary,
      record.resourceLabel,
      record.action,
      record.endpoint,
      record.engineer,
    ];
    if (!haystack.some((field) => field?.toLowerCase().includes(needle))) return false;
  }
  return true;
}

/** The same predicate as SQL. */
function buildAuditWhere(query: AuditQuery): SQL | undefined {
  const t = tables.auditLog;
  const conditions: SQL[] = [];

  if (query.category && query.category !== "all") {
    conditions.push(eq(t.category, query.category));
  }
  if (query.tenantId) conditions.push(eq(t.tenantId, query.tenantId));
  if (query.actor) conditions.push(eq(t.engineer, query.actor));
  if (query.actorType) conditions.push(eq(t.actorType, query.actorType));
  if (query.actions?.length) conditions.push(inArray(t.action, query.actions));
  if (query.resourceType) conditions.push(eq(t.resourceType, query.resourceType));
  if (query.resourceId) conditions.push(eq(t.resourceId, query.resourceId));
  if (query.from) conditions.push(gte(t.at, new Date(query.from)));
  if (query.to) conditions.push(lt(t.at, new Date(query.to)));

  // Outcome has to account for legacy rows where it was never stored, matching
  // deriveAuditOutcome: NULL outcome + a status code still counts.
  if (query.outcome) {
    const stored = eq(t.outcome, query.outcome);
    if (query.outcome === "failure") {
      conditions.push(or(stored, and(sql`${t.outcome} is null`, gte(t.responseStatus, 400)))!);
    } else if (query.outcome === "success") {
      conditions.push(or(stored, and(sql`${t.outcome} is null`, lte(t.responseStatus, 399)))!);
    } else {
      conditions.push(stored);
    }
  }

  if (query.q) {
    const like = `%${query.q}%`;
    conditions.push(
      or(
        ilike(t.summary, like),
        ilike(t.resourceLabel, like),
        ilike(t.action, like),
        ilike(t.endpoint, like),
        ilike(t.engineer, like),
      )!,
    );
  }

  if (query.cursor) {
    const decoded = decodeAuditCursor(query.cursor);
    if (decoded) {
      // Row-value comparison: (at, id) < (cursorAt, cursorId).
      //
      // Bind the timestamp as its ISO *string* and let Postgres do the cast. A
      // bare `sql` fragment carries no column type, so drizzle hands the value
      // straight to postgres.js, which cannot serialise an untyped Date and
      // throws ERR_INVALID_ARG_TYPE — every page past the first 500s.
      conditions.push(
        sql`(${t.at}, ${t.id}) < (${decoded.at}::timestamptz, ${decoded.id}::uuid)`,
      );
    }
  }

  return conditions.length ? and(...conditions) : undefined;
}

function clampLimit(limit: number | undefined, max = AUDIT_MAX_LIMIT): number {
  if (!limit || Number.isNaN(limit)) return AUDIT_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

/** One page of audit entries, newest first. */
export async function listAudits(query: AuditQuery = {}): Promise<AuditPage> {
  const limit = clampLimit(query.limit);

  const rows = await fetchAudits(query, limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    rows: page,
    nextCursor: hasMore && page.length ? encodeAuditCursor(page[page.length - 1]!) : null,
  };
}

/**
 * Every matching row up to a hard ceiling, for CSV export.
 *
 * Deliberately not paged: exporting only the page the user happens to have
 * loaded would silently produce 100 rows out of a matching 4,000, and an audit
 * export is the worst possible place for a quiet truncation. `truncated` says
 * when the ceiling actually bit.
 */
export async function listAuditsForExport(
  query: AuditQuery = {},
): Promise<{ rows: AuditRecord[]; truncated: boolean }> {
  const rows = await fetchAudits(query, AUDIT_MAX_EXPORT_ROWS + 1);
  const truncated = rows.length > AUDIT_MAX_EXPORT_ROWS;
  return { rows: truncated ? rows.slice(0, AUDIT_MAX_EXPORT_ROWS) : rows, truncated };
}

/** Shared fetch for both read paths — `take` rows, newest first. */
async function fetchAudits(query: AuditQuery, take: number): Promise<AuditRecord[]> {
  if (env.DEMO_MODE) {
    const cursor = query.cursor ? decodeAuditCursor(query.cursor) : null;
    return demoAudits
      .filter((record) => {
        if (!matchesAuditQuery(record, query)) return false;
        if (!cursor) return true;
        // Same (at, id) ordering the SQL row-value comparison applies.
        return record.at < cursor.at || (record.at === cursor.at && record.id < cursor.id);
      })
      .slice(0, take);
  }

  const rows = await db
    .select()
    .from(tables.auditLog)
    .where(buildAuditWhere(query))
    .orderBy(desc(tables.auditLog.at), desc(tables.auditLog.id))
    .limit(take);

  return rows.map(rowToRecord);
}
