import { sql } from "drizzle-orm";
import { and, eq, inArray, isNull, lt, notInArray, or } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import {
  matchWinget,
  prettifySoftwareTitle,
  friendlyProductName,
  normalizeTitle,
  formatOs,
  parseBuild,
  deviceSlaCompliance,
  normalizeSlaThresholds,
  detectInstallScope,
  matchChocolatey,
  isOsFinding,
  type WingetCatalogEntry,
  type WingetOverride,
  type Severity,
  type DeviceFinding,
  type InstallScope,
  type ChocolateyCatalogEntry,
  type ChocolateyOverride,
} from "@patchpilot/shared";
import {
  graphGet,
  listFeatureUpdateProfiles,
  listQualityUpdateProfiles,
  listQualityUpdatePolicies,
  listUpdateRingProfiles,
  listDriverUpdateProfiles,
  type GraphCallOptions,
  type GraphHost,
  type GraphResult,
} from "@patchpilot/graph";
import { isBundledLibrary } from "../catalog/matching.js";
import { attributeClears, detectReclassifiedCves, type DoomedFinding } from "./attribution.js";

/**
 * Live data ingestion (Phase 4) — the layer that writes real tenant data into
 * Postgres so the read-only data routes have something to serve after a real
 * Microsoft login.
 *
 * These functions are call-site agnostic: they take an `Engineer{upn,
 * homeTenantId}` and issue `graphGet`, which resolves either a live OBO token
 * (MSP home tenant — needs a live login-token in the token-store) or a Secure
 * Application Model token redeemed from the engineer's persisted MSAL
 * refresh-token cache (GDAP customer tenants — no live request or session
 * required, see packages/graph/src/msal.ts). Two call sites use this module
 * today: the request-bound manual "Sync Data" route (routes/sync.ts) and the
 * headless background loop (graph/auto-sync.ts), which synthesizes an
 * `Engineer` from a cached UPN with no live request behind it — both audited
 * identically via `graphGet`.
 *
 * Read-only-first (non-negotiable #6) is preserved: this module only ever GETs.
 * Nothing here mutates the customer tenant — it mirrors what we can read into
 * our own database. Whether *write* remediation is allowed stays governed by
 * `tenants.readOnly`, which sync never flips.
 *
 * DEMO_MODE safety (non-negotiable #9): these functions issue real Microsoft
 * reads and must never run in demo. The callers (routes/sync.ts) hard-gate on
 * `config.DEMO_MODE` before invoking anything here.
 */

/** A logged-in engineer identity, as carried on the Fastify session. */
export interface Engineer {
  upn: string;
  homeTenantId: string;
}

export interface SyncSummary {
  tenantId: string;
  count: number;
}

// Mirror of the client's host bases, used only to turn an absolute `@odata.nextLink`
// back into the relative path `graphGet` expects. Kept in sync with client.ts HOSTS.
const HOST_BASE: Record<GraphHost, string> = {
  graph: "https://graph.microsoft.com/v1.0",
  beta: "https://graph.microsoft.com/beta",
  defender: "https://api.securitycenter.microsoft.com/api",
};

interface OdataPage<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

/** Guard against a pathological/looping `@odata.nextLink`. */
const MAX_PAGES = 100;

/** A collected OData collection, plus whether the page guard cut the walk short. */
interface PagedResult<T> {
  rows: T[];
  /**
   * True when {@link MAX_PAGES} stopped the walk before the feed ran out, so
   * `rows` is a *prefix* of the collection rather than the whole of it. Callers
   * that treat a read as an authoritative snapshot — anything that deletes local
   * rows the read didn't mention — must not do so while this is set, or a large
   * tenant would lose everything past the cap on every sync.
   */
  truncated: boolean;
}

/**
 * Reads every page of an OData collection via the audited `graphGet`, following
 * `@odata.nextLink`. Each page is a separate audited read (honest trail). A bad
 * page (non-2xx) throws so a partial sync never silently truncates a snapshot;
 * hitting the page guard is reported as `truncated` rather than thrown, so a
 * tenant past the cap keeps the partial data it has always had.
 *
 * Uses {@link graphGetRetrying} per page (not the bare `graphGet`) so a 429/503/504
 * hit anywhere in a large fan-out (e.g. `backfillOsRecommendationVulnerabilities`
 * firing one `/recommendations/{id}/vulnerabilities` read per candidate recommendation)
 * backs off and retries instead of throwing and having the caller's best-effort
 * `catch` silently drop that recommendation's CVEs for the sync — live-observed
 * against BLACK IRON's tenant, where the OS recommendation's own read landed on a
 * 429 and `osVulnerabilityBackfill` came back 0 even though the recommendation
 * genuinely had 999 CVEs.
 */
async function collectPaged<T>(
  engineer: Engineer,
  tenantId: string,
  host: GraphHost,
  firstPath: string,
): Promise<PagedResult<T>> {
  const out: T[] = [];
  let path: string | null = firstPath;
  let pages = 0;

  while (path && pages < MAX_PAGES) {
    const res: GraphResult<OdataPage<T>> = await graphGetRetrying<OdataPage<T>>({
      engineer: engineer.upn,
      homeTenantId: engineer.homeTenantId,
      tenantId,
      host,
      path,
    });
    if (!res.ok || !res.data) {
      throw new Error(`Read failed for ${host}:${path} (HTTP ${res.status})`);
    }
    out.push(...res.data.value);

    const next: string | undefined = res.data["@odata.nextLink"];
    path = next ? next.replace(HOST_BASE[host], "") : null;
    pages++;
  }

  // A non-null `path` here means the loop exited on the page guard, not on the
  // feed running out — there are more pages we deliberately didn't read.
  return { rows: out, truncated: path !== null };
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once. Used to bound
 * the per-CVE Defender metadata fan-out so a tenant with hundreds of distinct
 * CVEs doesn't open hundreds of simultaneous Graph reads. `fn` is expected to
 * swallow its own errors (best-effort enrichment); a rejection here aborts.
 */
async function forEachLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index]!);
    }
  });
  await Promise.all(workers);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `graphGet` with bounded retry on throttling. Defender's per-CVE vulnerability
 * endpoint caps at ~100 reads/min, so a tenant exposed to more than that many
 * CVEs would 429 on the tail of the metadata fan-out and silently lose CVSS /
 * description / EPSS for "most" CVEs. We retry 429 (and transient 503/504) with
 * exponential backoff + jitter so the enrichment recovers instead of dropping.
 * `graphGet` doesn't surface Retry-After, so we back off on a fixed schedule.
 * Non-throttle failures (401/403/404) return immediately — no point retrying.
 */
async function graphGetRetrying<T>(
  opts: GraphCallOptions,
  maxRetries = 4,
): Promise<GraphResult<T>> {
  let res = await graphGet<T>(opts);
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (res.ok || (res.status !== 429 && res.status !== 503 && res.status !== 504)) {
      return res;
    }
    // 1s, 2s, 4s, 8s (cap 10s) plus up to 500ms jitter to de-sync the workers.
    const backoff = Math.min(1000 * 2 ** attempt, 10_000) + Math.floor(Math.random() * 500);
    await sleep(backoff);
    res = await graphGet<T>(opts);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

interface OrgRow {
  id: string;
  displayName: string;
}

interface DelegatedAdminRelationship {
  id: string;
  displayName?: string;
  status?: string;
  customer?: { tenantId: string; displayName?: string };
}

/**
 * Maps a GDAP relationship lifecycle status to our consent state. Only an
 * `active` relationship can actually be read through, so anything else is
 * surfaced as pending/expired rather than implying we have access.
 */
export function mapRelationshipStatus(status?: string): "consented" | "pending" | "expired" {
  switch ((status ?? "").toLowerCase()) {
    case "active":
      return "consented";
    case "terminated":
    case "expired":
    case "terminationrequested":
      return "expired";
    default:
      // created, approvalPending, terminating, etc.
      return "pending";
  }
}

/**
 * Discovers tenants the engineer can act on and upserts them:
 *  - the MSP home tenant (from `/organization`), flagged `isMspTenant`, consented;
 *  - every GDAP customer relationship (from `/tenantRelationships/delegatedAdminRelationships`).
 *
 * Upsert preserves engineer-governed columns: `readOnly` (the write opt-in) and
 * `licenses` (set by licensing detection) are never reset by a tenant resync.
 */
export async function syncTenants(engineer: Engineer): Promise<{ count: number }> {
  const { rows: home } = await collectPaged<OrgRow>(
    engineer,
    engineer.homeTenantId,
    "graph",
    "/organization?$select=id,displayName",
  );

  const { rows: relationships } = await collectPaged<DelegatedAdminRelationship>(
    engineer,
    engineer.homeTenantId,
    "graph",
    "/tenantRelationships/delegatedAdminRelationships?$select=id,displayName,status,customer",
  );

  // Build the desired tenant rows keyed by Entra tenantId (string), de-duped.
  const rows = new Map<
    string,
    { tenantId: string; displayName: string; consentStatus: "consented" | "pending" | "expired"; isMspTenant: boolean }
  >();

  for (const org of home) {
    rows.set(org.id, {
      tenantId: org.id,
      displayName: org.displayName,
      consentStatus: "consented",
      isMspTenant: true,
    });
  }

  for (const rel of relationships) {
    const tid = rel.customer?.tenantId;
    if (!tid) continue;
    // Don't let a customer relationship clobber the home-tenant flag.
    if (rows.has(tid)) continue;
    rows.set(tid, {
      tenantId: tid,
      displayName: rel.customer?.displayName ?? rel.displayName ?? tid,
      consentStatus: mapRelationshipStatus(rel.status),
      isMspTenant: false,
    });
  }

  for (const row of rows.values()) {
    await db
      .insert(tables.tenants)
      .values(row)
      .onConflictDoUpdate({
        target: tables.tenants.tenantId,
        // Refresh display/consent/flag only — preserve readOnly + licenses.
        set: {
          displayName: row.displayName,
          consentStatus: row.consentStatus,
          isMspTenant: row.isMspTenant,
        },
      });
  }

  return { count: rows.size };
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

interface ManagedDevice {
  id: string;
  deviceName?: string;
  operatingSystem?: string;
  osVersion?: string;
  /** Edition family ("Enterprise", "Professional", …) used for friendly OS names. */
  skuFamily?: string;
  lastSyncDateTime?: string;
  userPrincipalName?: string;
  // Intune hardware inventory — Defender exposes none of these reliably.
  model?: string;
  manufacturer?: string;
  serialNumber?: string;
}

interface DefenderMachine {
  id: string;
  computerDnsName?: string;
  /**
   * Defender's OS platform, e.g. "Windows11", "WindowsServer2019". The
   * authoritative server-vs-client signal: Intune reports a bare "Windows" for
   * servers, so we thread this into `formatOs` to name servers correctly.
   */
  osPlatform?: string;
  /** Defender machine group (RBAC device group), used to scope exceptions. */
  rbacGroupId?: string;
  rbacGroupName?: string;
}

/** What we resolve about a device from Defender, keyed by hostname. */
interface DefenderMatch {
  machineId: string;
  osPlatform?: string;
  rbacGroupId?: string;
  rbacGroupName?: string;
}

/** Builds a device row from an Intune managed device + Defender hostname map. */
export function mapDevice(
  d: ManagedDevice,
  tenantId: string,
  defenderByHost: Map<string, DefenderMatch>,
): typeof tables.devices.$inferInsert {
  const hostname = d.deviceName?.trim() || "(unnamed)";
  const defender = defenderByHost.get(hostname.toLowerCase());
  const os = formatOs({
    operatingSystem: d.operatingSystem,
    osVersion: d.osVersion,
    skuFamily: d.skuFamily,
    // Defender's osPlatform disambiguates servers that Intune labels "Windows".
    osPlatform: defender?.osPlatform,
  });
  return {
    tenantId,
    managedDeviceId: d.id,
    defenderMachineId: defender?.machineId ?? null,
    hostname,
    os,
    osBuild: parseBuild(d.osVersion) ?? null,
    lastSeen: d.lastSyncDateTime ? new Date(d.lastSyncDateTime) : null,
    // Compliance here is SLA-based, not Intune's complianceState. It can only be
    // judged once Defender exposure is known, so devices land as "unknown" and
    // syncVulnerabilities stamps compliant/noncompliant against the SLA clock.
    compliance: "unknown",
    // Filled in by syncVulnerabilities once Defender exposure is known.
    vulnerabilityCount: 0,
    owner: d.userPrincipalName ?? null,
    model: d.model?.trim() || null,
    manufacturer: d.manufacturer?.trim() || null,
    serialNumber: d.serialNumber?.trim() || null,
    deviceGroupId: defender?.rbacGroupId ?? null,
    deviceGroupName: defender?.rbacGroupName ?? null,
  };
}

/**
 * Full-refresh snapshot of a tenant's Intune-managed devices, enriched with the
 * Defender machine id (matched by hostname) so vulnerability exposure can later
 * be attributed back to a device.
 *
 * This upserts on (tenantId, managedDeviceId) rather than delete+insert: `id`
 * must stay fixed across syncs because jobs, remediation verifications, and
 * in-flight browser state all reference a device by row id. A delete+insert
 * regenerates `id` (defaultRandom) on every run, which orphans anything
 * referencing the old id mid-session — e.g. a "device not found" 404 on Fix
 * All if a background sync lands between page load and the click. Devices no
 * longer reported by Intune are removed in the same transaction so stale rows
 * don't linger.
 *
 * Defender enrichment is best-effort: if the tenant isn't MDE-licensed or the
 * read fails, devices still sync with a null `defenderMachineId`.
 */
export async function syncDevices(engineer: Engineer, tenantId: string): Promise<{ count: number }> {
  // `skuFamily` (the OS edition — "Pro"/"Enterprise") is a beta-only property of
  // `managedDevice`; selecting it on v1.0 returns HTTP 400 and would fail the whole
  // device sync. So we read it from the beta surface, but the edition is pure
  // enrichment — never let it break the sync. If beta is unavailable for the tenant
  // (or errors for any reason) we fall back to the v1.0 select without `skuFamily`,
  // and `formatOs` degrades to an edition-less name ("Windows 11 24H2").
  const FIELDS_BETA =
    "id,deviceName,operatingSystem,osVersion,skuFamily,lastSyncDateTime,userPrincipalName,model,manufacturer,serialNumber";
  const FIELDS_V1 =
    "id,deviceName,operatingSystem,osVersion,lastSyncDateTime,userPrincipalName,model,manufacturer,serialNumber";

  let managed: ManagedDevice[];
  try {
    ({ rows: managed } = await collectPaged<ManagedDevice>(
      engineer,
      tenantId,
      "beta",
      `/deviceManagement/managedDevices?$select=${FIELDS_BETA}`,
    ));
  } catch {
    ({ rows: managed } = await collectPaged<ManagedDevice>(
      engineer,
      tenantId,
      "graph",
      `/deviceManagement/managedDevices?$select=${FIELDS_V1}`,
    ));
  }

  // Best-effort Defender machine list to resolve hostname -> {machineId, osPlatform}.
  const defenderByHost = new Map<string, DefenderMatch>();
  try {
    const { rows: machines } = await collectPaged<DefenderMachine>(engineer, tenantId, "defender", "/machines");
    for (const m of machines) {
      if (m.computerDnsName) {
        defenderByHost.set(m.computerDnsName.toLowerCase(), {
          machineId: m.id,
          osPlatform: m.osPlatform,
          rbacGroupId: m.rbacGroupId,
          rbacGroupName: m.rbacGroupName,
        });
      }
    }
  } catch {
    // MDE not licensed / not reachable for this tenant — proceed without it.
  }

  const rows = managed.map((d) => mapDevice(d, tenantId, defenderByHost));

  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx
        .insert(tables.devices)
        .values(rows)
        .onConflictDoUpdate({
          target: [tables.devices.tenantId, tables.devices.managedDeviceId],
          set: {
            defenderMachineId: sql`excluded."defender_machine_id"`,
            hostname: sql`excluded."hostname"`,
            os: sql`excluded."os"`,
            osBuild: sql`excluded."os_build"`,
            lastSeen: sql`excluded."last_seen"`,
            compliance: sql`excluded."compliance"`,
            vulnerabilityCount: sql`excluded."vulnerability_count"`,
            owner: sql`excluded."owner"`,
            model: sql`excluded."model"`,
            manufacturer: sql`excluded."manufacturer"`,
            serialNumber: sql`excluded."serial_number"`,
            deviceGroupId: sql`excluded."device_group_id"`,
            deviceGroupName: sql`excluded."device_group_name"`,
          },
        });
      await tx.delete(tables.devices).where(
        and(
          eq(tables.devices.tenantId, tenantId),
          notInArray(
            tables.devices.managedDeviceId,
            rows.map((r) => r.managedDeviceId),
          ),
        ),
      );
    } else {
      await tx.delete(tables.devices).where(eq(tables.devices.tenantId, tenantId));
    }
  });

  return { count: rows.length };
}

// ---------------------------------------------------------------------------
// Vulnerabilities
// ---------------------------------------------------------------------------

interface MachineVulnerability {
  cveId: string;
  machineId: string;
  productName?: string;
  productVendor?: string;
  severity?: string;
  // When Defender first observed this CVE on this machine. The earliest value
  // across a CVE's machines is the org-wide "First detected" shown in the portal,
  // and anchors our SLA clock. Optional: not every Defender source carries it.
  firstSeenTimestamp?: string;
  // Per-finding exploit signal from the export-assessment surface
  // ("NoExploit" | "ExploitIsPublic" | "ExploitIsVerified" | "ExploitIsInKit").
  // Used as a fallback exploit indicator when per-CVE metadata is unavailable.
  exploitabilityLevel?: string;
  // Per-machine detection evidence (export-assessment only): installed version
  // and the disk/registry path(s) where the vulnerable product was found.
  // Optional — the fallback list surface carries none of these.
  softwareVersion?: string;
  diskPaths?: string[];
  // Registry evidence of install location (e.g.
  // "HKEY_LOCAL_MACHINE\...\Uninstall\..." vs "HKEY_USERS\<sid>\...\Uninstall\...").
  // Alongside diskPaths, this is the signal used to tell a per-user install from
  // a machine-wide one — the case winget running as SYSTEM can't correlate.
  registryPaths?: string[];
}

interface DefenderVulnerability {
  id: string; // the CVE id
  name?: string;
  description?: string;
  severity?: string;
  cvssV3?: number;
  // Richer per-CVE metadata from `/vulnerabilities/{id}`, surfaced in the detail
  // panel to approach Defender-portal parity. All optional — best-effort.
  // NB: Defender names the vector field `cvssVector` (not `cvssV3Vector`).
  cvssVector?: string;
  publishedOn?: string;
  updatedOn?: string;
  epss?: number;
  publicExploit?: boolean;
  exploitVerified?: boolean;
  exploitInKit?: boolean;
}

// How long a cached CVE-catalog row is trusted before a sync re-fetches it.
// CVE facts (CVSS/description) are effectively immutable; EPSS/exploit flags
// drift slowly, so a fortnight keeps the catalog current without re-paying
// Defender's read cap. Throttle-dropped CVEs are retried next sync regardless.
const CVE_CATALOG_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Most uncached CVEs a single sync will fetch live from Defender. The catalog
// is shared across tenants and persists, so it fills *progressively*: each sync
// pays for at most this many new CVEs, the rest fall back to their per-machine
// product/severity this run and get picked up by a later sync. This is the lever
// that keeps a first sync (empty catalog, possibly thousands of exposed CVEs)
// from blocking for the whole of Defender's ~100-reads/min cap — kept well under
// that cap so the fetch finishes in well under a minute and rarely even 429s.
// Everything the sync writes downstream (vuln rows, device counts, SLA
// compliance) degrades gracefully on a CVE we haven't enriched yet, so a small
// budget costs detail-panel richness for not-yet-cached CVEs, never correctness.
const CVE_FETCH_BUDGET_PER_SYNC = 60;

/** Reconstructs the `/vulnerabilities/{id}` shape from a cached catalog row. */
function catalogRowToMeta(row: typeof tables.cveCatalog.$inferSelect): DefenderVulnerability {
  return {
    id: row.cveId,
    name: row.name ?? undefined,
    description: row.description ?? undefined,
    severity: row.severity ?? undefined,
    cvssV3: row.cvssV3 ?? undefined,
    cvssVector: row.cvssVector ?? undefined,
    publishedOn: row.publishedOn ? row.publishedOn.toISOString() : undefined,
    updatedOn: row.updatedOn ? row.updatedOn.toISOString() : undefined,
    epss: row.epss ?? undefined,
    publicExploit: row.publicExploit,
    exploitVerified: row.exploitVerified,
    exploitInKit: row.exploitInKit,
  };
}

/** Persists freshly-fetched per-CVE detail into the shared catalog (one batched
 * upsert) so other tenants and later syncs reuse it instead of re-fetching. */
async function upsertCveCatalog(metas: DefenderVulnerability[]): Promise<void> {
  const now = new Date();
  // Dedupe by id: two rows sharing a conflict key in one bulk onConflictDoUpdate
  // statement makes Postgres reject the whole batch, so this guards the (single
  // primary-key-column) conflict target regardless of what callers pass in.
  const deduped = [...new Map(metas.filter((m) => m.id).map((m) => [m.id, m])).values()];
  const values = deduped
    .map((m) => ({
      cveId: m.id,
      name: m.name?.trim() || null,
      description: m.description?.trim() || null,
      severity: m.severity ?? null,
      cvssV3: typeof m.cvssV3 === "number" ? m.cvssV3 : null,
      cvssVector: m.cvssVector?.trim() || null,
      publishedOn: parseDate(m.publishedOn),
      updatedOn: parseDate(m.updatedOn),
      epss: typeof m.epss === "number" ? m.epss : null,
      publicExploit: Boolean(m.publicExploit),
      exploitVerified: Boolean(m.exploitVerified),
      exploitInKit: Boolean(m.exploitInKit),
      fetchedAt: now,
    }));
  if (values.length === 0) return;
  await db
    .insert(tables.cveCatalog)
    .values(values)
    .onConflictDoUpdate({
      target: tables.cveCatalog.cveId,
      set: {
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        severity: sql`excluded.severity`,
        cvssV3: sql`excluded.cvss_v3`,
        cvssVector: sql`excluded.cvss_vector`,
        publishedOn: sql`excluded.published_on`,
        updatedOn: sql`excluded.updated_on`,
        epss: sql`excluded.epss`,
        publicExploit: sql`excluded.public_exploit`,
        exploitVerified: sql`excluded.exploit_verified`,
        exploitInKit: sql`excluded.exploit_in_kit`,
        fetchedAt: sql`excluded.fetched_at`,
      },
    });
}

/**
 * Resolves per-CVE metadata (title/CVSS/description/threat flags) for a tenant's
 * exposed CVEs, backed by the shared `cve_catalog` so the work scales across an
 * MSP's many tenants instead of re-fetching the same global facts per tenant.
 *
 * Per sync: read what's already cached for these CVEs, fetch ONLY the ones we
 * don't have fresh (concurrency-limited + 429-aware), then write the new detail
 * back to the catalog. The first tenant exposed to a CVE pays the Defender read;
 * every later tenant — and the next sync — reuses it. Total reads scale with the
 * unique-CVE universe (a few thousand), not tenants × CVEs, so a 150-tenant MSP
 * stops slamming Defender's ~100-reads/min vulnerability cap. Best-effort: a CVE
 * we still can't read just falls back to its per-machine product/severity.
 *
 * The live fetch is additionally capped at `CVE_FETCH_BUDGET_PER_SYNC` so a sync
 * never blocks on enriching the whole exposure at once — critically, a *first*
 * sync against an empty catalog. CVEs beyond the budget keep their per-machine
 * fallback this run and are enriched by later syncs (their cached neighbours drop
 * out of `toFetch`, so the cursor naturally advances and the catalog fills in).
 * This keeps the sync — and everything downstream of it (device counts, SLA
 * compliance, `lastSyncedAt`) — fast and responsive while detail accrues.
 */
async function loadCveMetadata(
  engineer: Engineer,
  tenantId: string,
  cveIdsIn: string[],
): Promise<Map<string, DefenderVulnerability>> {
  const meta = new Map<string, DefenderVulnerability>();
  if (cveIdsIn.length === 0) return meta;
  // The caller aggregates per (cveId, software) pair, so the same CVE can
  // appear once per affected product — dedupe here, otherwise a CVE fetched
  // twice writes two same-id rows into one `upsertCveCatalog` bulk statement,
  // which Postgres rejects ("ON CONFLICT DO UPDATE command cannot affect row
  // a second time").
  const cveIds = [...new Set(cveIdsIn)];

  // Seed from the shared catalog, tracking which rows are still within TTL.
  const freshCutoff = new Date(Date.now() - CVE_CATALOG_TTL_MS);
  const fresh = new Set<string>();
  // Chunk the IN list so a tenant exposed to thousands of CVEs stays well under
  // Postgres' bind-parameter ceiling.
  for (let i = 0; i < cveIds.length; i += 500) {
    const chunk = cveIds.slice(i, i + 500);
    const cached = await db
      .select()
      .from(tables.cveCatalog)
      .where(inArray(tables.cveCatalog.cveId, chunk));
    for (const row of cached) {
      meta.set(row.cveId, catalogRowToMeta(row));
      if (row.fetchedAt >= freshCutoff) fresh.add(row.cveId);
    }
  }

  // Fetch only what we don't already have fresh, and only up to this sync's
  // budget — the rest ride their per-machine fallback and a later sync's budget.
  const pending = cveIds.filter((id) => !fresh.has(id));
  const toFetch = pending.slice(0, CVE_FETCH_BUDGET_PER_SYNC);
  const deferred = pending.length - toFetch.length;
  if (toFetch.length === 0) return meta;

  const fetched: DefenderVulnerability[] = [];
  let dropped = 0;
  await forEachLimit(toFetch, 4, async (cveId) => {
    try {
      const res = await graphGetRetrying<DefenderVulnerability>({
        engineer: engineer.upn,
        homeTenantId: engineer.homeTenantId,
        tenantId,
        host: "defender",
        path: `/vulnerabilities/${encodeURIComponent(cveId)}`,
      });
      if (res.ok && res.data?.id) {
        meta.set(res.data.id, res.data);
        fetched.push(res.data);
      } else {
        dropped++;
      }
    } catch {
      // best-effort: leave this CVE to its per-machine fallback metadata.
      dropped++;
    }
  });

  // Cache the new detail for every other tenant + the next sync.
  if (fetched.length > 0) await upsertCveCatalog(fetched);
  if (dropped > 0) {
    // Only the *uncached* misses matter now — a large count still means we're
    // being throttled and the catalog will fill in on subsequent syncs.
    console.warn(
      `[sync] tenant ${tenantId}: per-CVE metadata unavailable for ${dropped}/${toFetch.length} uncached CVEs (throttled or not in catalog)`,
    );
  }
  if (deferred > 0) {
    // Expected on early syncs of a large exposure: enrichment is intentionally
    // spread across syncs so no single one blocks on Defender's read cap.
    console.info(
      `[sync] tenant ${tenantId}: enriched ${fetched.length} CVEs this sync, ${deferred} deferred to later syncs (budget ${CVE_FETCH_BUDGET_PER_SYNC})`,
    );
  }
  return meta;
}

/**
 * Per-machine vulnerability row from Defender's "export software vulnerabilities
 * assessment" surface (`/machines/SoftwareVulnerabilitiesByMachine`). Unlike the
 * lighter `/vulnerabilities/machinesVulnerabilities` list, this one reliably
 * carries `firstSeenTimestamp` — Defender's true per-finding first-detected, which
 * anchors an accurate SLA clock instead of falling back to sync time. Same
 * `Vulnerability.Read` scope, so no additional consent.
 */
interface SoftwareVulnerabilityByMachine {
  cveId: string;
  deviceId: string;
  // Export-assessment names the software fields `softwareName`/`softwareVendor`
  // (the lighter `machinesVulnerabilities` list uses `productName`/`productVendor`).
  // Getting these wrong is why every row showed "Unknown software".
  softwareName?: string;
  softwareVendor?: string;
  vulnerabilitySeverityLevel?: string;
  firstSeenTimestamp?: string;
  // "NoExploit" | "ExploitIsPublic" | "ExploitIsVerified" | "ExploitIsInKit".
  exploitabilityLevel?: string;
  // Detection evidence: the installed version and the disk/registry path(s)
  // where Defender found the vulnerable product on this machine — surfaced as
  // the "how it was detected" in the device drill-down. Only the
  // export-assessment surface carries these; the lighter machinesVulnerabilities
  // fallback omits them.
  softwareVersion?: string;
  diskPaths?: string[];
  registryPaths?: string[];
}

/** Parses an ISO timestamp to a Date, or null when absent/unparseable. */
function parseDate(value?: string): Date | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Loads a tenant's per-machine CVE exposure, preferring the export-assessment
 * surface (which carries real first-detected timestamps) and falling back to the
 * lighter `machinesVulnerabilities` list when it's unavailable for the tenant.
 * Both normalise to `MachineVulnerability`. Throws only if BOTH reads fail, so the
 * caller's best-effort 403 handling (zero vulns, not a failed sync) still applies.
 * `truncated` is passed through from the underlying read so the caller knows
 * whether the exposure set is complete enough to prune against.
 */
async function collectMachineVulns(
  engineer: Engineer,
  tenantId: string,
): Promise<PagedResult<MachineVulnerability>> {
  try {
    const { rows, truncated } = await collectPaged<SoftwareVulnerabilityByMachine>(
      engineer,
      tenantId,
      "defender",
      "/machines/SoftwareVulnerabilitiesByMachine",
    );
    return {
      truncated,
      rows: rows.map((r) => ({
        cveId: r.cveId,
        machineId: r.deviceId,
        productName: r.softwareName,
        productVendor: r.softwareVendor,
        severity: r.vulnerabilitySeverityLevel,
        firstSeenTimestamp: r.firstSeenTimestamp,
        exploitabilityLevel: r.exploitabilityLevel,
        softwareVersion: r.softwareVersion,
        diskPaths: r.diskPaths,
        registryPaths: r.registryPaths,
      })),
    };
  } catch {
    // Export assessment not available (older MDE tier / endpoint disabled) — fall
    // back to the lighter list. It lacks first-seen, so detectedAt degrades to
    // sync time, exactly as before this source switch.
    return collectPaged<MachineVulnerability>(
      engineer,
      tenantId,
      "defender",
      "/vulnerabilities/machinesVulnerabilities",
    );
  }
}

/** Maps a Defender severity label onto our 4-level severity enum. */
export function mapSeverity(severity?: string): "critical" | "high" | "medium" | "low" {
  switch ((severity ?? "").toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    default:
      return "low";
  }
}

export interface AggregatedVuln {
  cveId: string;
  software: string;
  /** Most frequently reported product vendor, or null if Defender gave none. */
  publisher: string | null;
  severity: "critical" | "high" | "medium" | "low";
  affectedMachineIds: string[];
  /**
   * Earliest first-seen across the CVE's machines — Defender's org-wide "First
   * detected". Null when no machine row carried a parseable timestamp.
   */
  firstDetectedAt: Date | null;
  /**
   * Whether any affected machine reported a non-"NoExploit" exploitability level.
   * A best-effort fallback exploit signal when per-CVE metadata is unavailable.
   */
  exploitObserved: boolean;
  /** Whether any affected machine reported the "ExploitIsVerified" level specifically. */
  exploitVerifiedObserved: boolean;
}

/** True for an export-assessment exploitability level that indicates a real exploit. */
function hasExploit(level?: string): boolean {
  // Values: "NoExploit" | "ExploitIsPublic" | "ExploitIsVerified" | "ExploitIsInKit".
  return (level ?? "").toLowerCase().startsWith("exploit");
}

/** True specifically for the "ExploitIsVerified" export-assessment level. */
function hasVerifiedExploit(level?: string): boolean {
  return (level ?? "").toLowerCase() === "exploitisverified";
}

/** Returns the most frequently counted key in a count map, or null if empty. */
function topByCount(counts: Map<string, number>): string | null {
  let top: string | null = null;
  let topCount = 0;
  for (const [key, count] of counts) {
    if (count > topCount) {
      top = key;
      topCount = count;
    }
  }
  return top;
}

/** Field separator for the composite (cveId, software) grouping key — a unit
 *  separator that can't appear in a CVE id or product name. */
const KEY_SEP = "\x1f";

/**
 * Aggregates per-machine Defender findings into one row per (CVE, software) — the
 * grain Defender itself reports at. One CVE can affect several products (a
 * Chromium use-after-free lands on Edge, Chrome, and any CEF-bundling app), and
 * Defender attributes each finding to a specific product; mirroring that grain
 * keeps PatchPilot's attribution exactly aligned with the source of truth instead
 * of collapsing to a single heuristically-picked product. Each row carries the
 * affected software, its publisher (most frequent product vendor for that CVE ×
 * software pairing) and the distinct set of machines exposed. Pure so it's
 * unit-testable against captured Defender output.
 *
 * Product name and vendor are tracked separately (not concatenated) so the UI
 * can show a friendly product title with the vendor as a subtitle, and so winget
 * matching runs against the bare title rather than a "Vendor Product" string.
 */
export function aggregateVulnerabilities(rows: MachineVulnerability[]): AggregatedVuln[] {
  const byPair = new Map<
    string,
    {
      cveId: string;
      software: string;
      machines: Set<string>;
      vendors: Map<string, number>;
      severity?: string;
      /** Earliest parseable first-seen across machines (epoch ms), or null. */
      firstSeen: number | null;
      /** Any machine reported an exploitable level for this pairing. */
      exploited: boolean;
      /** Any machine reported the "ExploitIsVerified" level for this pairing. */
      verifiedExploited: boolean;
    }
  >();

  for (const r of rows) {
    if (!r.cveId) continue;
    const software = r.productName?.trim() || "Unknown software";
    const key = `${r.cveId}${KEY_SEP}${software}`;
    let agg = byPair.get(key);
    if (!agg) {
      agg = {
        cveId: r.cveId,
        software,
        machines: new Set(),
        vendors: new Map(),
        severity: r.severity,
        firstSeen: null,
        exploited: false,
        verifiedExploited: false,
      };
      byPair.set(key, agg);
    }
    if (hasExploit(r.exploitabilityLevel)) agg.exploited = true;
    if (hasVerifiedExploit(r.exploitabilityLevel)) agg.verifiedExploited = true;
    if (r.machineId) agg.machines.add(r.machineId);
    const vendor = r.productVendor?.trim();
    if (vendor) agg.vendors.set(vendor, (agg.vendors.get(vendor) ?? 0) + 1);
    // Keep the highest-severity label seen for the pairing.
    if (rankSeverity(r.severity) > rankSeverity(agg.severity)) agg.severity = r.severity;
    // Track the earliest first-seen — that's the org-wide first detection.
    const seen = r.firstSeenTimestamp ? Date.parse(r.firstSeenTimestamp) : NaN;
    if (!Number.isNaN(seen)) {
      agg.firstSeen = agg.firstSeen === null ? seen : Math.min(agg.firstSeen, seen);
    }
  }

  return [...byPair.values()].map((agg) => ({
    cveId: agg.cveId,
    software: agg.software,
    publisher: topByCount(agg.vendors),
    severity: mapSeverity(agg.severity),
    affectedMachineIds: [...agg.machines],
    firstDetectedAt: agg.firstSeen === null ? null : new Date(agg.firstSeen),
    exploitObserved: agg.exploited,
    exploitVerifiedObserved: agg.verifiedExploited,
  }));
}

function rankSeverity(severity?: string): number {
  switch ((severity ?? "").toLowerCase()) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

/**
 * Upserts a tenant's CVE exposure from Defender.
 *
 * Source: the export-assessment surface `/machines/SoftwareVulnerabilitiesByMachine`
 * (preferred — it carries a real per-finding `firstSeenTimestamp`), falling back to
 * `/vulnerabilities/machinesVulnerabilities` when unavailable. Either carries cveId +
 * product + machineId together (the plain `/vulnerabilities` list has no software
 * title), enriched with per-CVE title/CVSS/threat metadata from `/vulnerabilities/{id}`.
 * Software titles are resolved to winget packages via the catalog (and prettified for
 * display when unmatched) so the remediation UI can offer upgrades.
 *
 * Deliberately does NOT enumerate the org-wide `/vulnerabilities` collection: that
 * returns Defender's entire catalog (hundreds of thousands of rows) regardless of
 * tenant, so paging it pegged the sync at the page cap and effectively never
 * finished ("stuck Syncing"). Metadata is fetched only for the CVEs actually
 * present on this tenant's machines — bounded by real exposure, best-effort.
 *
 * Defender access is best-effort overall: a tenant without an MDE license (403)
 * yields zero vulnerabilities rather than failing the whole sync.
 *
 * Upsert (not full-refresh) on (tenantId, cveId): `detectedAt` is the SLA clock
 * and `status` is engineer-set triage state — both must survive a resync.
 * `status` is written on insert only and preserved on conflict. `detectedAt` is
 * sourced from Defender's earliest per-machine first-seen (its org-wide "First
 * detected") — a stable fact, so it's refreshed on conflict when available, and
 * only falls back to sync time when Defender gave us no timestamp (in which case
 * any existing value is preserved rather than reset to now).
 *
 * Upsert, then prune: rows Defender no longer reports are deleted at the end of
 * the ingestion loop (see the comment there), so the tenant's finding set tracks
 * Defender exactly instead of only ever growing. The upsert is what preserves
 * per-row state across syncs; the prune is what bounds the set.
 */
export async function syncVulnerabilities(engineer: Engineer, tenantId: string): Promise<{ count: number }> {
  let machineVulns: MachineVulnerability[];
  // Set when the page guard cut the exposure read short — the snapshot is then a
  // prefix, not the whole truth, and must not be used to prune (see below).
  let exposureTruncated: boolean;
  try {
    ({ rows: machineVulns, truncated: exposureTruncated } = await collectMachineVulns(engineer, tenantId));
  } catch {
    // MDE not licensed / not reachable for this tenant — nothing to ingest.
    return { count: 0 };
  }

  const aggregated = aggregateVulnerabilities(machineVulns);

  // Title + CVSS: resolve per-CVE detail for the CVEs this tenant is exposed to
  // (never the global catalog), served from the shared `cve_catalog` cache so an
  // MSP's many tenants don't each re-fetch the same global facts. Best-effort — a
  // CVE whose detail can't be read falls back to the per-machine product/severity.
  const cveMeta = await loadCveMetadata(
    engineer,
    tenantId,
    aggregated.map((a) => a.cveId),
  );

  // Winget catalog for software -> package resolution.
  const wingetRows = await db.select().from(tables.wingetCatalog);
  const wingetCatalog: WingetCatalogEntry[] = wingetRows.map((w) => ({
    packageId: w.packageId,
    name: w.name,
    publisher: w.publisher,
    latestVersion: w.latestVersion,
    softwareTitle: w.softwareTitle,
  }));
  // packageId -> curated catalog publisher, used to prefer the catalog vendor
  // over Defender's productVendor for winget-matched findings.
  const catalogPublisher = new Map(wingetCatalog.map((w) => [w.packageId, w.publisher]));

  // Engineer-authored title->package pins for this tenant, ahead of the global
  // defaults, so a human mapping always beats the fuzzy matcher during sync.
  const overrideRows = await db
    .select()
    .from(tables.wingetCatalogOverride)
    .where(
      or(
        eq(tables.wingetCatalogOverride.tenantId, tenantId),
        isNull(tables.wingetCatalogOverride.tenantId),
      ),
    );
  const wingetOverrides: WingetOverride[] = [
    ...overrideRows.filter((o) => o.tenantId === tenantId),
    ...overrideRows.filter((o) => o.tenantId === null),
  ].map((o) => ({ softwareTitle: o.softwareTitle, packageId: o.packageId }));

  const now = new Date();
  let count = 0;

  // Raw (cveId, Defender product token) -> the stored (prettified/winget-matched)
  // software name we persisted. The device⇄CVE linkage below is built from raw
  // per-machine rows, so it needs this to record the same software string that
  // landed in `vulnerabilities` — otherwise the read-time join wouldn't match.
  const softwareByRawPair = new Map<string, string>();

  for (const agg of aggregated) {
    const meta = cveMeta.get(agg.cveId);
    // Prefer the catalog publisher (curated) when winget-matched; fall back to
    // the Defender-reported vendor so OS/non-winget rows still show a publisher.
    const match = matchWinget(agg.software, wingetCatalog, wingetOverrides);
    // Friendly product name: the curated catalog name when matched, otherwise a
    // prettified form of Defender's raw machine-readable product name
    // ("visual_studio_code" -> "Visual Studio Code") rather than the raw token.
    const software = match ? match.name : prettifySoftwareTitle(agg.software);
    softwareByRawPair.set(`${agg.cveId}${KEY_SEP}${agg.software}`, software);
    const title = meta?.name?.trim() || `${software} — ${agg.cveId}`;
    const severity = meta ? mapSeverity(meta.severity) : agg.severity;
    const publisher =
      (match ? catalogPublisher.get(match.packageId) : null) ?? agg.publisher;
    const description = meta?.description?.trim() || null;
    const cvssVector = meta?.cvssVector?.trim() || null;
    const epss = typeof meta?.epss === "number" ? meta.epss : null;
    const publishedOn = parseDate(meta?.publishedOn);
    const updatedOn = parseDate(meta?.updatedOn);
    // Prefer the per-CVE threat metadata; fall back to the per-machine
    // exploitability level when the detail fetch was unavailable.
    const exploitAvailable = Boolean(
      meta?.publicExploit || meta?.exploitVerified || meta?.exploitInKit || agg.exploitObserved,
    );
    // Stricter subset: confirmed active exploitation specifically, not just a
    // public PoC or kit — drives the verified-exploit Compliance SLA override.
    const exploitVerified = Boolean(meta?.exploitVerified || agg.exploitVerifiedObserved);

    await db
      .insert(tables.vulnerabilities)
      .values({
        tenantId,
        cveId: agg.cveId,
        title,
        severity,
        cvss: meta?.cvssV3 ?? null,
        affectedDeviceCount: agg.affectedMachineIds.length,
        software,
        publisher,
        description,
        cvssVector,
        epss,
        publishedOn,
        updatedOn,
        exploitAvailable,
        exploitVerified,
        // Defender's first-detected when known; else sync time as a best effort.
        detectedAt: agg.firstDetectedAt ?? now,
        lastSeenAt: now,
        wingetRemediable: Boolean(match),
        wingetPackageId: match?.packageId ?? null,
        status: "open",
      })
      .onConflictDoUpdate({
        target: [
          tables.vulnerabilities.tenantId,
          tables.vulnerabilities.cveId,
          tables.vulnerabilities.software,
        ],
        // Refresh facts from Defender; preserve status (triage). detectedAt is
        // refreshed only when Defender gave a first-detected — otherwise the
        // existing value is kept so the SLA clock never resets to sync time.
        set: {
          title,
          severity,
          cvss: meta?.cvssV3 ?? null,
          affectedDeviceCount: agg.affectedMachineIds.length,
          software,
          publisher,
          description,
          cvssVector,
          epss,
          publishedOn,
          updatedOn,
          exploitAvailable,
          exploitVerified,
          ...(agg.firstDetectedAt ? { detectedAt: agg.firstDetectedAt } : {}),
          lastSeenAt: now,
          wingetRemediable: Boolean(match),
          wingetPackageId: match?.packageId ?? null,
        },
      });
    count++;
  }

  // Drop findings Defender no longer reports. Every row the loop above touched
  // carries this run's `now`; anything older (or never stamped, i.e. written
  // before lastSeenAt existed) was absent from Defender's current answer.
  //
  // Deleting — rather than moving the row to a "resolved" state — is deliberate.
  // Defender is the source of truth for what exists, nothing in the app writes
  // vulnerability `status` except this sync (always "open") and the demo seed, so
  // there is no engineer triage state to preserve. It also makes corrections
  // self-heal: the upsert conflict key includes `software`, which is derived from
  // the winget match, so a matcher fix INSERTS a corrected row beside the stale
  // one instead of replacing it — the prune is what clears the stale one.
  // Tradeoff: a finding that disappears and returns loses any per-row history,
  // and would re-enter as a fresh row.
  //
  // Skipped when the exposure read was truncated by the page guard: pruning
  // against a partial snapshot would delete real findings past the cap.
  if (!exposureTruncated) {
    const pruneWhere = and(
      eq(tables.vulnerabilities.tenantId, tenantId),
      or(isNull(tables.vulnerabilities.lastSeenAt), lt(tables.vulnerabilities.lastSeenAt, now)),
    );
    await db.transaction(async (tx) => {
      // Record a remediation event for each row about to be pruned — this is
      // the only moment `detectedAt` can still be paired with a "remediated"
      // timestamp, since the delete below throws the row away. The matcher-fix
      // case described above also prunes the stale row it corrects; that's
      // detected below (closure: "reclassified") rather than counted as a fix.
      const doomed = await tx
        .select({
          cveId: tables.vulnerabilities.cveId,
          software: tables.vulnerabilities.software,
          severity: tables.vulnerabilities.severity,
          detectedAt: tables.vulnerabilities.detectedAt,
          wingetPackageId: tables.vulnerabilities.wingetPackageId,
        })
        .from(tables.vulnerabilities)
        .where(pruneWhere);
      if (doomed.length > 0) {
        const findings: DoomedFinding[] = doomed.map((d) => ({
          kind: "vulnerability",
          cveId: d.cveId,
          recommendationId: null,
          software: d.software,
          detectedAt: d.detectedAt,
          wingetPackageId: d.wingetPackageId,
        }));
        const [attributions, reclassifiedCves] = await Promise.all([
          attributeClears(tx, tenantId, findings, now),
          detectReclassifiedCves(
            tx,
            tenantId,
            [...new Set(doomed.map((d) => d.cveId).filter((v): v is string => !!v))],
            now,
          ),
        ]);
        await tx.insert(tables.remediationEvents).values(
          doomed.map((d) => {
            const attr = attributions.get(`${d.cveId ?? ""}|${d.software ?? ""}`);
            return {
              tenantId,
              kind: "vulnerability" as const,
              cveId: d.cveId,
              software: d.software,
              severity: d.severity,
              detectedAt: d.detectedAt,
              remediatedAt: now,
              closure: (d.cveId && reclassifiedCves.has(d.cveId) ? "reclassified" : "cleared") as
                | "cleared"
                | "reclassified",
              ...(attr
                ? {
                    attribution: attr.attribution,
                    deviceId: attr.deviceId,
                    deviceHostname: attr.deviceHostname,
                    engineer: attr.engineer,
                    jobId: attr.jobId,
                    channel: attr.channel,
                    fixStartedAt: attr.fixStartedAt,
                    fixFinishedAt: attr.fixFinishedAt,
                    contributingJobs: attr.contributingJobs,
                  }
                : {}),
            };
          }),
        );
      }
      await tx.delete(tables.vulnerabilities).where(pruneWhere);
    });
  }

  // Persist the device⇄CVE linkage so the device detail panel can filter CVEs to
  // one machine. Defender only hands us this transiently (affectedMachineIds), so
  // we materialise it here as a full-refresh (delete + insert) per tenant — the
  // exposure set is a fresh snapshot each sync, with no per-row state to preserve.
  // Built from the raw per-machine findings (not the aggregate) so each link
  // carries that machine's detection evidence — installed version + disk/registry
  // paths — deduped to one row per (machine, CVE) with the paths unioned. Only
  // CVEs that survived aggregation (i.e. made it into `vulnerabilities`) are linked.
  // (grain is per (CVE, software); linkage keys on stored software below)
  const linkByKey = new Map<
    string,
    {
      defenderMachineId: string;
      cveId: string;
      software: string;
      softwareVersion: string | null;
      diskPaths: Set<string>;
      registryPaths: Set<string>;
    }
  >();
  for (const r of machineVulns) {
    if (!r.cveId || !r.machineId) continue;
    const rawSoftware = r.productName?.trim() || "Unknown software";
    const software = softwareByRawPair.get(`${r.cveId}${KEY_SEP}${rawSoftware}`);
    if (!software) continue;
    const key = `${r.machineId}${KEY_SEP}${r.cveId}${KEY_SEP}${software}`;
    let link = linkByKey.get(key);
    if (!link) {
      link = {
        defenderMachineId: r.machineId,
        cveId: r.cveId,
        software,
        softwareVersion: r.softwareVersion?.trim() || null,
        diskPaths: new Set(),
        registryPaths: new Set(),
      };
      linkByKey.set(key, link);
    } else if (!link.softwareVersion && r.softwareVersion?.trim()) {
      link.softwareVersion = r.softwareVersion.trim();
    }
    for (const p of r.diskPaths ?? []) {
      const path = p?.trim();
      if (path) link.diskPaths.add(path);
    }
    for (const p of r.registryPaths ?? []) {
      const path = p?.trim();
      if (path) link.registryPaths.add(path);
    }
  }
  const linkRows = [...linkByKey.values()].map((l) => ({
    tenantId,
    defenderMachineId: l.defenderMachineId,
    cveId: l.cveId,
    software: l.software,
    softwareVersion: l.softwareVersion,
    diskPaths: l.diskPaths.size > 0 ? [...l.diskPaths] : null,
    registryPaths: l.registryPaths.size > 0 ? [...l.registryPaths] : null,
  }));
  await db.transaction(async (tx) => {
    await tx
      .delete(tables.deviceVulnerabilities)
      .where(eq(tables.deviceVulnerabilities.tenantId, tenantId));
    if (linkRows.length > 0) {
      // onConflictDoUpdate (not a plain insert) because this tenant's own
      // delete above can't exclude a concurrent sync for the same tenant
      // (auto-sync cycle racing a manual resync, or two manual resyncs) — its
      // insert can land between our delete and insert, or its delete can run
      // after ours, leaving both transactions inserting the same
      // (tenantId, defenderMachineId, cveId, software) tuple and hitting
      // device_vulns_unique_idx. linkByKey already dedupes within this run,
      // so this only ever resolves a genuine cross-transaction race, not an
      // in-batch duplicate — mirrors the vulnerabilities upsert above.
      await tx
        .insert(tables.deviceVulnerabilities)
        .values(linkRows)
        .onConflictDoUpdate({
          target: [
            tables.deviceVulnerabilities.tenantId,
            tables.deviceVulnerabilities.defenderMachineId,
            tables.deviceVulnerabilities.cveId,
            tables.deviceVulnerabilities.software,
          ],
          set: {
            softwareVersion: sql`excluded.software_version`,
            diskPaths: sql`excluded.disk_paths`,
            registryPaths: sql`excluded.registry_paths`,
          },
        });
    }
  });

  // Auto-confirm pending "manually remediated" records: once a device's fresh
  // Defender snapshot (linkRows, just written above) no longer reports a
  // pending record's (device, CVE) pair, Defender has independently verified
  // the fix — stamp confirmedAt so the "waiting on Defender" badge clears.
  // Gated by !exposureTruncated for the same reason the vulnerabilities prune
  // above is: a partial snapshot must never be read as "this CVE is gone."
  if (!exposureTruncated) {
    const pending = await db
      .select({
        id: tables.manualRemediations.id,
        deviceId: tables.manualRemediations.deviceId,
        cveId: tables.manualRemediations.cveId,
      })
      .from(tables.manualRemediations)
      .where(
        and(
          eq(tables.manualRemediations.tenantId, tenantId),
          isNull(tables.manualRemediations.confirmedAt),
        ),
      );
    if (pending.length > 0) {
      const deviceIds = [...new Set(pending.map((p) => p.deviceId))];
      const devices = await db
        .select({ id: tables.devices.id, defenderMachineId: tables.devices.defenderMachineId })
        .from(tables.devices)
        .where(inArray(tables.devices.id, deviceIds));
      const machineIdByDevice = new Map(devices.map((d) => [d.id, d.defenderMachineId]));
      const openKeys = new Set(linkRows.map((r) => `${r.defenderMachineId}${KEY_SEP}${r.cveId}`));
      const toConfirm = pending
        .filter((p) => {
          const machineId = machineIdByDevice.get(p.deviceId);
          if (!machineId || !p.cveId) return false;
          return !openKeys.has(`${machineId}${KEY_SEP}${p.cveId}`);
        })
        .map((p) => p.id);
      if (toConfirm.length > 0) {
        await db
          .update(tables.manualRemediations)
          .set({ confirmedAt: now })
          .where(inArray(tables.manualRemediations.id, toConfirm));
      }
    }
  }

  // Attribute exposure back to devices: count each machine's (CVE, software)
  // findings — the same grain as its device-detail list — then update the
  // matching device row (joined earlier on defenderMachineId).
  const cveCountByMachine = new Map<string, number>();
  for (const agg of aggregated) {
    for (const machineId of agg.affectedMachineIds) {
      cveCountByMachine.set(machineId, (cveCountByMachine.get(machineId) ?? 0) + 1);
    }
  }

  // Reset counts for this tenant, then set the ones we know.
  await db
    .update(tables.devices)
    .set({ vulnerabilityCount: 0 })
    .where(eq(tables.devices.tenantId, tenantId));

  for (const [machineId, vulnCount] of cveCountByMachine) {
    await db
      .update(tables.devices)
      .set({ vulnerabilityCount: vulnCount })
      .where(
        sql`${tables.devices.tenantId} = ${tenantId} AND ${tables.devices.defenderMachineId} = ${machineId}`,
      );
  }

  // ---- SLA compliance ----------------------------------------------------
  // Device compliance is measured against the remediation SLAs, NOT Intune's
  // complianceState. This is the only place we can compute it: the device↔CVE
  // linkage exists transiently here (aggregated.affectedMachineIds), and the
  // schema stores only a vulnerability *count* per device, not which CVEs hit it.
  //
  // Tradeoff: compliance is therefore frozen at sync time against the thresholds
  // in force now. Unlike the live Vulnerabilities view, it won't re-react to a
  // later Settings SLA change until the next sync — acceptable, and re-synced
  // often enough by auto-sync.
  const slaRow = await db
    .select()
    .from(tables.settings)
    .where(eq(tables.settings.key, "sla"));
  const thresholds = normalizeSlaThresholds(slaRow[0]?.value);

  // Authoritative severity + detectedAt (the SLA clock) come from the just-written
  // vuln rows, since detectedAt is preserved-on-conflict and may predate this run.
  const tenantVulns = await db
    .select({
      cveId: tables.vulnerabilities.cveId,
      software: tables.vulnerabilities.software,
      severity: tables.vulnerabilities.severity,
      detectedAt: tables.vulnerabilities.detectedAt,
      exploitVerified: tables.vulnerabilities.exploitVerified,
    })
    .from(tables.vulnerabilities)
    .where(eq(tables.vulnerabilities.tenantId, tenantId));
  // Vulns are now stored at (CVE, software) grain, so key findings by the same
  // composite — a single CVE affecting two products is two independent findings.
  const findingByPair = new Map<string, DeviceFinding>();
  for (const v of tenantVulns) {
    findingByPair.set(`${v.cveId}${KEY_SEP}${v.software}`, {
      severity: v.severity as Severity,
      detectedAt: v.detectedAt,
      exploitVerified: v.exploitVerified,
    });
  }

  // Group findings back onto each Defender machine via the transient linkage.
  const findingsByMachine = new Map<string, DeviceFinding[]>();
  for (const agg of aggregated) {
    // Translate the raw Defender product token to the stored software name so
    // the composite key matches what we wrote into `vulnerabilities`.
    const software = softwareByRawPair.get(`${agg.cveId}${KEY_SEP}${agg.software}`);
    if (!software) continue;
    const finding = findingByPair.get(`${agg.cveId}${KEY_SEP}${software}`);
    if (!finding) continue;
    for (const machineId of agg.affectedMachineIds) {
      const list = findingsByMachine.get(machineId) ?? [];
      list.push(finding);
      findingsByMachine.set(machineId, list);
    }
  }

  // Reaching here means Defender was readable (the 403/unreachable case returned
  // early), so absence of findings is real coverage, not missing data. Default
  // Defender-covered devices to compliant and uncovered ones to unknown, then
  // demote any covered device whose findings breach the SLA.
  await db
    .update(tables.devices)
    .set({ compliance: "unknown" })
    .where(
      sql`${tables.devices.tenantId} = ${tenantId} AND ${tables.devices.defenderMachineId} IS NULL`,
    );
  await db
    .update(tables.devices)
    .set({ compliance: "compliant" })
    .where(
      sql`${tables.devices.tenantId} = ${tenantId} AND ${tables.devices.defenderMachineId} IS NOT NULL`,
    );
  for (const [machineId, findings] of findingsByMachine) {
    if (deviceSlaCompliance(findings, thresholds, now) === "noncompliant") {
      await db
        .update(tables.devices)
        .set({ compliance: "noncompliant" })
        .where(
          sql`${tables.devices.tenantId} = ${tenantId} AND ${tables.devices.defenderMachineId} = ${machineId}`,
        );
    }
  }

  return { count };
}

// ---------------------------------------------------------------------------
// Software inventory (Phase 5, Ask 3 — Software Inventory page)
// ---------------------------------------------------------------------------

interface SoftwareInventoryByMachineRow {
  deviceId: string;
  softwareVendor?: string;
  softwareName?: string;
  softwareVersion?: string;
  diskPaths?: string[];
  registryPaths?: string[];
  softwareFirstSeenTimestamp?: string;
}

interface SoftwareCatalogRow {
  id: string;
  weaknesses?: number;
  exposedMachines?: number;
  publicExploit?: boolean;
}

type SoftwareContext = "user" | "machine" | "mixed" | "unknown";

/**
 * Ingests Defender's software inventory: every (device, software) pair
 * Defender's device inventory sees, regardless of whether it carries a CVE.
 * This is what backs the Software Inventory page — the Nvidia App / OpenSSL
 * component case that motivated it is software Defender enumerates but
 * doesn't emit a CVE finding for, so syncVulnerabilities's per-CVE rows
 * can't cover it.
 *
 * Two Defender reads, joined on the `{vendor}-_-{name}` id format Microsoft
 * documents for both: the per-device export (SoftwareInventoryByMachine,
 * the source of truth for what's installed where) and the per-software
 * rollup (/Software, best-effort enrichment for weakness/exposure counts —
 * its absence never blocks ingestion of the per-device facts).
 */
export async function syncSoftwareInventory(
  engineer: Engineer,
  tenantId: string,
): Promise<{ count: number }> {
  let deviceRows: SoftwareInventoryByMachineRow[];
  let truncated: boolean;
  try {
    ({ rows: deviceRows, truncated } = await collectPaged<SoftwareInventoryByMachineRow>(
      engineer,
      tenantId,
      "defender",
      "/machines/SoftwareInventoryByMachine",
    ));
  } catch {
    // MDE not licensed / not reachable for this tenant — nothing to ingest.
    return { count: 0 };
  }

  let catalogRows: SoftwareCatalogRow[];
  try {
    ({ rows: catalogRows } = await collectPaged<SoftwareCatalogRow>(
      engineer,
      tenantId,
      "defender",
      "/Software",
    ));
  } catch {
    catalogRows = [];
  }
  const catalogById = new Map(catalogRows.map((c) => [c.id, c]));

  const wingetRows = await db.select().from(tables.wingetCatalog);
  const wingetCatalog: WingetCatalogEntry[] = wingetRows.map((w) => ({
    packageId: w.packageId,
    name: w.name,
    publisher: w.publisher,
    latestVersion: w.latestVersion,
    softwareTitle: w.softwareTitle,
  }));
  const wingetLatestVersion = new Map(wingetCatalog.map((w) => [w.packageId, w.latestVersion]));
  const wingetOverrideRows = await db
    .select()
    .from(tables.wingetCatalogOverride)
    .where(
      or(
        eq(tables.wingetCatalogOverride.tenantId, tenantId),
        isNull(tables.wingetCatalogOverride.tenantId),
      ),
    );
  const wingetOverrides: WingetOverride[] = [
    ...wingetOverrideRows.filter((o) => o.tenantId === tenantId),
    ...wingetOverrideRows.filter((o) => o.tenantId === null),
  ].map((o) => ({ softwareTitle: o.softwareTitle, packageId: o.packageId }));

  const chocolateyRows = await db.select().from(tables.chocolateyCatalog);
  const chocolateyCatalog: ChocolateyCatalogEntry[] = chocolateyRows.map((c) => ({
    packageId: c.packageId,
    name: c.name,
    publisher: c.publisher,
    latestVersion: c.latestVersion,
    softwareTitle: c.softwareTitle,
  }));
  const chocolateyLatestVersion = new Map(
    chocolateyCatalog.map((c) => [c.packageId, c.latestVersion]),
  );
  const chocolateyOverrideRows = await db
    .select()
    .from(tables.chocolateyCatalogOverride)
    .where(
      or(
        eq(tables.chocolateyCatalogOverride.tenantId, tenantId),
        isNull(tables.chocolateyCatalogOverride.tenantId),
      ),
    );
  const chocolateyOverrides: ChocolateyOverride[] = [
    ...chocolateyOverrideRows.filter((o) => o.tenantId === tenantId),
    ...chocolateyOverrideRows.filter((o) => o.tenantId === null),
  ].map((o) => ({ softwareTitle: o.softwareTitle, packageId: o.packageId }));

  interface Aggregate {
    softwareId: string;
    rawName: string;
    vendor: string | null;
    scopes: Set<InstallScope>;
    deviceIds: Set<string>;
    firstSeen: Date | null;
  }
  const bySoftwareId = new Map<string, Aggregate>();
  interface DeviceSoftwareRow {
    tenantId: string;
    defenderMachineId: string;
    softwareId: string;
    name: string;
    vendor: string | null;
    version: string | null;
    diskPaths: string[] | null;
    registryPaths: string[] | null;
  }
  // Defender's SoftwareInventoryByMachine table can report the same
  // (device, vendor+name) software more than once — e.g. distinct install
  // paths or side-by-side versions — but device_software's unique index is
  // (tenant, machine, software) with no version component, so those raw rows
  // must collapse into one before insert. Keyed on device+software; paths are
  // unioned across the raw entries and the last-seen version wins, matching
  // this table's existing "snapshot replace, no independent identity"
  // semantics used for the tenant-wide delete-then-insert below.
  const deviceSoftwareByKey = new Map<string, DeviceSoftwareRow>();
  const mergePaths = (a: string[] | null, b: string[]): string[] | null => {
    if (b.length === 0) return a;
    const merged = new Set(a ?? []);
    for (const p of b) merged.add(p);
    return merged.size > 0 ? [...merged] : null;
  };

  for (const r of deviceRows) {
    const vendorRaw = r.softwareVendor?.trim();
    const nameRaw = r.softwareName?.trim();
    if (!r.deviceId || !nameRaw) continue;
    const softwareId = `${vendorRaw || "unknown"}-_-${nameRaw}`;
    const friendly = friendlyProductName(nameRaw, vendorRaw ?? null);
    const diskPaths = (r.diskPaths ?? []).map((p) => p?.trim()).filter((p): p is string => !!p);
    const registryPaths = (r.registryPaths ?? [])
      .map((p) => p?.trim())
      .filter((p): p is string => !!p);
    const scope = detectInstallScope(diskPaths, registryPaths);
    const firstSeen = parseDate(r.softwareFirstSeenTimestamp);
    const version = r.softwareVersion?.trim() || null;

    const key = `${r.deviceId}\u0000${softwareId}`;
    const existing = deviceSoftwareByKey.get(key);
    if (existing) {
      existing.diskPaths = mergePaths(existing.diskPaths, diskPaths);
      existing.registryPaths = mergePaths(existing.registryPaths, registryPaths);
      existing.version = version ?? existing.version;
    } else {
      deviceSoftwareByKey.set(key, {
        tenantId,
        defenderMachineId: r.deviceId,
        softwareId,
        name: friendly,
        vendor: vendorRaw || null,
        version,
        diskPaths: diskPaths.length > 0 ? diskPaths : null,
        registryPaths: registryPaths.length > 0 ? registryPaths : null,
      });
    }

    let agg = bySoftwareId.get(softwareId);
    if (!agg) {
      agg = {
        softwareId,
        rawName: nameRaw,
        vendor: vendorRaw || null,
        scopes: new Set(),
        deviceIds: new Set(),
        firstSeen: null,
      };
      bySoftwareId.set(softwareId, agg);
    }
    agg.scopes.add(scope);
    agg.deviceIds.add(r.deviceId);
    if (firstSeen && (!agg.firstSeen || firstSeen < agg.firstSeen)) agg.firstSeen = firstSeen;
  }
  const deviceSoftwareRows = [...deviceSoftwareByKey.values()];

  const now = new Date();
  const inventoryRows = [...bySoftwareId.values()].map((agg) => {
    const context: SoftwareContext = agg.scopes.has("machine")
      ? agg.scopes.has("user")
        ? "mixed"
        : "machine"
      : agg.scopes.has("user")
        ? "user"
        : "unknown";

    // Matching runs against the raw Defender product token, matching
    // syncVulnerabilities's idiom — the catalogs' own title-matching logic
    // (exact/contains/token-overlap) expects that raw shape, not a
    // pre-friendlified display name. Gated the same way buildWingetMatcher/
    // buildChocolateyMatcher are — OS/security-platform findings and known
    // bundled-library titles (e.g. XZ Utils's liblzma.dll, vendored inside
    // unrelated apps) must never resolve to a package match here either, or
    // this synced row disagrees with what the live matcher-backed routes say.
    const excluded = isOsFinding(agg.rawName) || isBundledLibrary(agg.rawName);
    const winget =
      !excluded && context !== "user" ? matchWinget(agg.rawName, wingetCatalog, wingetOverrides) : null;
    const choco =
      !excluded && !winget && context !== "machine"
        ? matchChocolatey(agg.rawName, chocolateyCatalog, chocolateyOverrides)
        : null;

    const name = winget
      ? winget.name
      : choco
        ? choco.name
        : friendlyProductName(agg.rawName, agg.vendor);

    const catalogEntry = catalogById.get(agg.softwareId);

    return {
      tenantId,
      softwareId: agg.softwareId,
      name,
      vendor: agg.vendor,
      weaknessCount: typeof catalogEntry?.weaknesses === "number" ? catalogEntry.weaknesses : 0,
      exposedMachinesCount:
        typeof catalogEntry?.exposedMachines === "number" ? catalogEntry.exposedMachines : 0,
      installedMachinesCount: agg.deviceIds.size,
      publicExploit: Boolean(catalogEntry?.publicExploit),
      context,
      matchedPackageId: winget?.packageId ?? choco?.packageId ?? null,
      matchedPackageSource: winget ? "winget" : choco ? "chocolatey" : null,
      matchedLatestVersion: winget
        ? (wingetLatestVersion.get(winget.packageId) ?? null)
        : choco
          ? (chocolateyLatestVersion.get(choco.packageId) ?? null)
          : null,
      detectedAt: agg.firstSeen ?? now,
      lastSeenAt: now,
    };
  });

  await db.transaction(async (tx) => {
    if (inventoryRows.length > 0) {
      await tx
        .insert(tables.softwareInventory)
        .values(inventoryRows)
        .onConflictDoUpdate({
          target: [tables.softwareInventory.tenantId, tables.softwareInventory.softwareId],
          set: {
            name: sql`excluded."name"`,
            vendor: sql`excluded."vendor"`,
            weaknessCount: sql`excluded."weakness_count"`,
            exposedMachinesCount: sql`excluded."exposed_machines_count"`,
            installedMachinesCount: sql`excluded."installed_machines_count"`,
            publicExploit: sql`excluded."public_exploit"`,
            context: sql`excluded."context"`,
            matchedPackageId: sql`excluded."matched_package_id"`,
            matchedPackageSource: sql`excluded."matched_package_source"`,
            matchedLatestVersion: sql`excluded."matched_latest_version"`,
            lastSeenAt: sql`excluded."last_seen_at"`,
          },
        });
      if (!truncated) {
        await tx.delete(tables.softwareInventory).where(
          and(
            eq(tables.softwareInventory.tenantId, tenantId),
            notInArray(
              tables.softwareInventory.softwareId,
              inventoryRows.map((r) => r.softwareId),
            ),
          ),
        );
      }
    } else if (!truncated) {
      await tx.delete(tables.softwareInventory).where(eq(tables.softwareInventory.tenantId, tenantId));
    }

    // deviceSoftware carries no independent identity worth preserving across
    // syncs (no triage status, unlike vulnerabilities) — straight snapshot
    // replace, mirroring syncVulnerabilities's device<->CVE linkage refresh.
    await tx.delete(tables.deviceSoftware).where(eq(tables.deviceSoftware.tenantId, tenantId));
    if (deviceSoftwareRows.length > 0) {
      await tx.insert(tables.deviceSoftware).values(deviceSoftwareRows);
    }
  });

  return { count: inventoryRows.length };
}

// ---------------------------------------------------------------------------
// Missing KBs (Defender per-device getmissingkbs — "By OS" / Missing KBs)
// ---------------------------------------------------------------------------

interface GetMissingKbsRow {
  id: string;
  name?: string;
  productsNames?: string[];
  url?: string;
  // Defender's real getmissingkbs responses have been observed returning this
  // as a bare count (number) instead of an array of CVE ids for some KBs —
  // normalize both shapes when reading it below.
  cveAddressed?: string[] | number;
}

/**
 * Normalizes getmissingkbs's `cveAddressed` field, which Defender has been
 * observed returning as a bare count instead of a CVE-id array for some KBs
 * (live-verified against BLACK IRON — see missing-kbs.ts's matching
 * Array.isArray guard on the read side).
 */
export function normalizeCveAddressed(
  cveAddressed: string[] | number | undefined,
): { cveIds: string[]; cveCount: number } {
  if (Array.isArray(cveAddressed)) {
    return { cveIds: cveAddressed, cveCount: cveAddressed.length };
  }
  return { cveIds: [], cveCount: cveAddressed ?? 0 };
}

/**
 * Ingests Defender's per-device missing-KB list (`getmissingkbs`) — the "By OS" /
 * Missing KBs surface, and the source of the `kbId` the Expedited Quality Update
 * and Live Response OS-remediation channels dispatch against.
 *
 * Unlike every other sync in this file, Defender exposes no bulk export for this
 * — it's a per-device endpoint (`/machines/{id}/getmissingkbs`), so this issues
 * one call per Defender-onboarded device, bounded by `forEachLimit` (same
 * throttle-mitigation idiom as loadCveMetadata's per-CVE fan-out).
 *
 * Best-effort like the other Ask-3 syncs, but a 401/403 means the tenant lacks
 * `Software.Read` for every device identically, so the first such response
 * aborts the rest of the fan-out rather than burning one failed call per device.
 */
export async function syncMissingKbs(
  engineer: Engineer,
  tenantId: string,
): Promise<{ count: number }> {
  const deviceRows = await db
    .select({ id: tables.devices.id, defenderMachineId: tables.devices.defenderMachineId })
    .from(tables.devices)
    .where(eq(tables.devices.tenantId, tenantId));
  const targets = deviceRows.filter(
    (d): d is { id: string; defenderMachineId: string } => !!d.defenderMachineId,
  );
  if (targets.length === 0) return { count: 0 };

  const collected: { deviceId: string; kb: GetMissingKbsRow }[] = [];
  let licensingFailure = false;

  await forEachLimit(targets, 5, async (device) => {
    if (licensingFailure) return;
    try {
      const res = await graphGetRetrying<{ value: GetMissingKbsRow[] }>({
        engineer: engineer.upn,
        homeTenantId: engineer.homeTenantId,
        tenantId,
        host: "defender",
        path: `/machines/${encodeURIComponent(device.defenderMachineId)}/getmissingkbs`,
      });
      if (!res.ok || !res.data) {
        if (res.status === 401 || res.status === 403) licensingFailure = true;
        return;
      }
      for (const kb of res.data.value) {
        if (!kb.id) continue;
        collected.push({ deviceId: device.id, kb });
      }
    } catch {
      // Best-effort per device — one throttled/unreachable device shouldn't
      // drop the rest of the fleet's results.
    }
  });

  // Mirrors syncSoftwareInventory's catch-and-return-zero: an unlicensed tenant
  // must not wipe missing-KB rows a previous, successful sync already wrote.
  if (licensingFailure) return { count: 0 };

  const now = new Date();
  const rows = collected.map(({ deviceId, kb }) => {
    const { cveIds, cveCount } = normalizeCveAddressed(kb.cveAddressed);
    return {
      tenantId,
      deviceId,
      kbId: kb.id,
      title: kb.name?.trim() || kb.id,
      products: kb.productsNames ?? [],
      cveCount,
      cveIds,
      url: kb.url ?? null,
      syncedAt: now,
    };
  });

  // No independent identity worth preserving across syncs (no triage status,
  // unlike vulnerabilities) — straight snapshot replace, same as deviceSoftware.
  await db.transaction(async (tx) => {
    await tx.delete(tables.missingKbs).where(eq(tables.missingKbs.tenantId, tenantId));
    if (rows.length > 0) {
      await tx.insert(tables.missingKbs).values(rows);
    }
  });

  return { count: rows.length };
}

// ---------------------------------------------------------------------------
// Recommendations (Defender TVM security recommendations)
// ---------------------------------------------------------------------------

/**
 * A Defender security recommendation from `/recommendations`. Defender already
 * consolidates the many CVEs reported for a product into one actionable row
 * ("Update Google Chrome"), which is exactly the noise reduction PatchPilot
 * needs — the per-CVE `vulnerabilities` table stays the drill-down detail.
 * All fields beyond id are optional/best-effort across MDE tiers.
 */
interface DefenderRecommendation {
  id: string;
  recommendationName?: string;
  productName?: string;
  vendor?: string;
  recommendedVersion?: string;
  // Defender's 0..10 exposure-weighted severity score (no critical/high label).
  severityScore?: number;
  // Number of distinct weaknesses (CVEs) this recommendation collapses.
  weaknesses?: number;
  // Whether any collapsed CVE has a known public exploit.
  publicExploit?: boolean;
  exposedMachinesCount?: number;
  totalMachineCount?: number;
  // "Update" | "Uninstall" | "ConfigurationChange" | "Attention required" | …
  remediationType?: string;
  // "Software" | "OS" | "SecurityControls" | "Accounts" | "Network".
  recommendationCategory?: string;
  // "Active" | "Exception" | "Resolved" — all ingested; the API filters at read
  // time so a portal-side exception is visible here instead of silently missing.
  status?: string;
  // ---- Defender portal parity fields (see schema.ts's matching columns) ----
  osPlatform?: string;
  subCategory?: string;
  relatedComponent?: string;
  // Exposure-score delta if remediated (the portal's "Impact").
  exposureImpact?: number;
  // Secure-score delta if remediated (the portal's "Devices Score impact").
  configScoreImpact?: number;
  activeAlert?: boolean;
  associatedThreats?: string[];
}

/**
 * Maps Defender's numeric recommendation score onto our 4-level severity enum.
 * Defender's portal buckets the 0..10 score similarly (the recommendation list
 * has no discrete severity label of its own, unlike per-CVE findings).
 */
export function mapRecommendationSeverity(score?: number): "critical" | "high" | "medium" | "low" {
  if (typeof score !== "number") return "low";
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

/** Builds a recommendation insert row from a Defender recommendation object. */
export function mapRecommendation(
  r: DefenderRecommendation,
  tenantId: string,
  now: Date,
): typeof tables.recommendations.$inferInsert {
  return {
    tenantId,
    recommendationId: r.id,
    recommendationName: r.recommendationName?.trim() || r.productName?.trim() || r.id,
    productName: r.productName?.trim() || r.recommendationName?.trim() || r.id,
    vendor: r.vendor?.trim() || null,
    recommendedVersion: r.recommendedVersion?.trim() || null,
    severity: mapRecommendationSeverity(r.severityScore),
    severityScore: typeof r.severityScore === "number" ? r.severityScore : null,
    weaknessCount: typeof r.weaknesses === "number" ? r.weaknesses : 0,
    exposedMachinesCount: typeof r.exposedMachinesCount === "number" ? r.exposedMachinesCount : 0,
    totalMachineCount: typeof r.totalMachineCount === "number" ? r.totalMachineCount : 0,
    publicExploit: Boolean(r.publicExploit),
    remediationType: r.remediationType?.trim() || null,
    category: r.recommendationCategory?.trim() || null,
    recommendationStatus: r.status?.trim() || null,
    osPlatform: r.osPlatform?.trim() || null,
    subCategory: r.subCategory?.trim() || null,
    relatedComponent: r.relatedComponent?.trim() || null,
    exposureImpact: typeof r.exposureImpact === "number" ? r.exposureImpact : null,
    configScoreImpact: typeof r.configScoreImpact === "number" ? r.configScoreImpact : null,
    activeAlert: Boolean(r.activeAlert),
    associatedThreats: Array.isArray(r.associatedThreats) ? r.associatedThreats : [],
    detectedAt: now,
    status: "open",
  };
}

/**
 * Upserts a tenant's Defender security recommendations from `/recommendations`.
 *
 * This is the consolidated surface that mirrors the Defender portal's
 * Recommendations page — one "Update <product>" row per software, collapsing the
 * hundreds of reopened historical CVEs Defender reports per product. The per-CVE
 * `vulnerabilities` table remains as the drill-down detail.
 *
 * Best-effort, like the vulnerability sync: a tenant without the
 * `SecurityRecommendation.Read` scope (or no MDE license) yields zero
 * recommendations (403 → empty) rather than failing the whole sync.
 *
 * Upsert on (tenantId, recommendationId): `status` (engineer-set triage) is
 * written on insert only and preserved on conflict. `detectedAt` (SLA clock) is
 * anchored to the earliest first-detected of the underlying CVEs (the
 * `/recommendations` feed carries no first-detected of its own); when that can't
 * be derived it stays at insert-time `now` and is preserved on conflict so the
 * clock never resets. A resync refreshes Defender's facts without losing triage.
 *
 * Every recommendation is ingested regardless of Defender's own `status`
 * ("Active" / "Exception" / "Resolved") — that value rides along in
 * `recommendationStatus` and the read side filters on it, so an exception the
 * engineer created in the Defender portal shows up in PatchPilot as excepted
 * rather than silently vanishing.
 *
 * Upsert, then prune, like every other synced table: recommendations Defender no
 * longer reports at all are deleted at the end of the loop, so the tenant's set
 * tracks Defender exactly instead of only ever growing (the drift that made
 * PatchPilot show far more rows than the portal).
 */
export async function syncRecommendations(
  engineer: Engineer,
  tenantId: string,
): Promise<{ count: number }> {
  let recs: DefenderRecommendation[];
  try {
    ({ rows: recs } = await collectPaged<DefenderRecommendation>(
      engineer,
      tenantId,
      "defender",
      "/recommendations",
    ));
  } catch {
    // No SecurityRecommendation.Read / MDE not licensed — nothing to ingest.
    return { count: 0 };
  }

  const now = new Date();
  let count = 0;

  // First-detected date for each recommendation. The `/recommendations` feed
  // carries NO first-detected timestamp, so — like the per-CVE sync — we anchor
  // the SLA clock to a real Defender fact: the earliest first-seen of the
  // underlying CVEs. Those already live in this tenant's `vulnerabilities` table
  // (syncVulnerabilities always runs first), keyed by friendly software name.
  const tenantVulns = await db
    .select({
      software: tables.vulnerabilities.software,
      detectedAt: tables.vulnerabilities.detectedAt,
    })
    .from(tables.vulnerabilities)
    .where(eq(tables.vulnerabilities.tenantId, tenantId));
  const earliestCveDetect = (productName: string, vendor: string | null): Date | null => {
    const target = normalizeTitle(friendlyProductName(productName, vendor));
    if (!target) return null;
    let earliest: Date | null = null;
    for (const v of tenantVulns) {
      const sw = normalizeTitle(v.software);
      // Mirror the UI's recommendation↔CVE match: exact or either-contains.
      if (!sw || (sw !== target && !sw.includes(target) && !target.includes(sw))) continue;
      if (!earliest || v.detectedAt < earliest) earliest = v.detectedAt;
    }
    return earliest;
  };

  // Every recommendation id Defender reported this run — the prune keeps set.
  const seen: string[] = [];

  for (const r of recs) {
    if (!r.id) continue;
    seen.push(r.id);

    const row = mapRecommendation(r, tenantId, now);
    // Replace the sync-time placeholder with the real first-detected when we can
    // derive it from the underlying CVEs (otherwise leave `now` as best effort).
    const firstDetected = earliestCveDetect(row.productName, row.vendor ?? null);
    if (firstDetected) row.detectedAt = firstDetected;
    await db
      .insert(tables.recommendations)
      .values(row)
      .onConflictDoUpdate({
        target: [tables.recommendations.tenantId, tables.recommendations.recommendationId],
        // Refresh Defender's facts; preserve status (triage). detectedAt (SLA
        // clock) is refreshed only when we derived a real first-detected —
        // otherwise the existing value is kept so the clock never resets to now.
        set: {
          recommendationName: row.recommendationName,
          productName: row.productName,
          vendor: row.vendor,
          recommendedVersion: row.recommendedVersion,
          severity: row.severity,
          severityScore: row.severityScore,
          weaknessCount: row.weaknessCount,
          exposedMachinesCount: row.exposedMachinesCount,
          totalMachineCount: row.totalMachineCount,
          publicExploit: row.publicExploit,
          remediationType: row.remediationType,
          category: row.category,
          recommendationStatus: row.recommendationStatus,
          osPlatform: row.osPlatform,
          subCategory: row.subCategory,
          relatedComponent: row.relatedComponent,
          exposureImpact: row.exposureImpact,
          configScoreImpact: row.configScoreImpact,
          activeAlert: row.activeAlert,
          associatedThreats: row.associatedThreats,
          ...(firstDetected ? { detectedAt: firstDetected } : {}),
        },
      });
    count++;
  }

  // Prune: anything this tenant still has that Defender didn't report is gone.
  // Safe to run on an empty `seen` — the fetch above returns early (count 0) when
  // Defender is unreachable/unlicensed, so reaching here with nothing means
  // Defender genuinely reports no recommendations for the tenant.
  const pruneWhere = seen.length
    ? and(
        eq(tables.recommendations.tenantId, tenantId),
        notInArray(tables.recommendations.recommendationId, seen),
      )
    : eq(tables.recommendations.tenantId, tenantId);
  await db.transaction(async (tx) => {
    // Record a remediation event per pruned recommendation before it's gone —
    // see the equivalent comment on the vulnerabilities prune above for the
    // rationale. No reclassification check here: recommendations key their
    // upsert on Defender's own recommendationId, not a matcher-derived value,
    // so the matcher-correction false positive doesn't apply.
    const doomed = await tx
      .select({
        recommendationId: tables.recommendations.recommendationId,
        productName: tables.recommendations.productName,
        severity: tables.recommendations.severity,
        detectedAt: tables.recommendations.detectedAt,
      })
      .from(tables.recommendations)
      .where(pruneWhere);
    if (doomed.length > 0) {
      const findings: DoomedFinding[] = doomed.map((d) => ({
        kind: "recommendation",
        cveId: null,
        recommendationId: d.recommendationId,
        software: d.productName,
        detectedAt: d.detectedAt,
      }));
      const attributions = await attributeClears(tx, tenantId, findings, now);
      await tx.insert(tables.remediationEvents).values(
        doomed.map((d) => {
          const attr = attributions.get(`${d.recommendationId ?? ""}|${d.productName ?? ""}`);
          return {
            tenantId,
            kind: "recommendation" as const,
            recommendationId: d.recommendationId,
            software: d.productName,
            severity: d.severity,
            detectedAt: d.detectedAt,
            remediatedAt: now,
            ...(attr
              ? {
                  attribution: attr.attribution,
                  deviceId: attr.deviceId,
                  deviceHostname: attr.deviceHostname,
                  engineer: attr.engineer,
                  jobId: attr.jobId,
                  channel: attr.channel,
                  fixStartedAt: attr.fixStartedAt,
                  fixFinishedAt: attr.fixFinishedAt,
                  contributingJobs: attr.contributingJobs,
                }
              : {}),
          };
        }),
      );
    }
    await tx.delete(tables.recommendations).where(pruneWhere);
  });

  return { count };
}

// ---------------------------------------------------------------------------
// Feature update campaigns (live sync)
// ---------------------------------------------------------------------------

/**
 * Mirrors the tenant's `windowsFeatureUpdateProfiles` into
 * `feature_update_campaigns` — not just a creation-time snapshot of what
 * PatchPilot's own campaign flow made, but every profile Graph currently
 * reports, whether PatchPilot created it, an engineer created it directly in
 * the Intune admin center, or it pre-dates the tenant's onboarding. Upserts
 * on (tenantId, intuneProfileId); `source`, `createdBy`, and `createdAt` are
 * deliberately excluded from the `set` clause so a row PatchPilot created
 * keeps its provenance and creation facts across every later sync, even
 * though every other column is refreshed from Graph's current state. A brand
 * new row (no prior conflict) gets `source`'s column default of `"intune"`,
 * correct for a profile this sync is the first to discover.
 *
 * Profiles Graph no longer reports are pruned — same convention as
 * `syncDevices` — since the creation audit event survives permanently in
 * `audit_log` regardless of whether the live row is later pruned.
 */
export async function syncFeatureUpdateProfiles(
  engineer: Engineer,
  tenantId: string,
): Promise<{ count: number }> {
  const profiles = await listFeatureUpdateProfiles({
    engineer: engineer.upn,
    homeTenantId: engineer.homeTenantId,
    tenantId,
  });

  const rows = profiles.map((p) => ({
    tenantId,
    displayName: p.displayName,
    targetVersion: p.targetVersion,
    targetBuild: p.targetBuild,
    assignments: p.assignments,
    intuneProfileId: p.intuneProfileId,
    offerStartDateTimeInUTC: p.offerStartDateTimeInUTC ? new Date(p.offerStartDateTimeInUTC) : null,
    offerEndDateTimeInUTC: p.offerEndDateTimeInUTC ? new Date(p.offerEndDateTimeInUTC) : null,
    offerIntervalInDays: p.offerIntervalInDays,
    installFeatureUpdatesOptional: p.installFeatureUpdatesOptional,
  }));

  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx
        .insert(tables.featureUpdateCampaigns)
        .values(rows)
        .onConflictDoUpdate({
          target: [tables.featureUpdateCampaigns.tenantId, tables.featureUpdateCampaigns.intuneProfileId],
          set: {
            displayName: sql`excluded."display_name"`,
            targetVersion: sql`excluded."target_version"`,
            targetBuild: sql`excluded."target_build"`,
            assignments: sql`excluded."assignments"`,
            offerStartDateTimeInUTC: sql`excluded."offer_start_date_time_in_utc"`,
            offerEndDateTimeInUTC: sql`excluded."offer_end_date_time_in_utc"`,
            offerIntervalInDays: sql`excluded."offer_interval_in_days"`,
            installFeatureUpdatesOptional: sql`excluded."install_feature_updates_optional"`,
          },
        });
      await tx.delete(tables.featureUpdateCampaigns).where(
        and(
          eq(tables.featureUpdateCampaigns.tenantId, tenantId),
          notInArray(
            tables.featureUpdateCampaigns.intuneProfileId,
            rows.map((r) => r.intuneProfileId),
          ),
        ),
      );
    } else {
      await tx.delete(tables.featureUpdateCampaigns).where(eq(tables.featureUpdateCampaigns.tenantId, tenantId));
    }
  });

  return { count: rows.length };
}

// ---------------------------------------------------------------------------
// Quality update campaigns (live sync — both policyTypes)
// ---------------------------------------------------------------------------

/**
 * Mirrors the tenant's `windowsQualityUpdateProfiles` ("expedite" policyType)
 * into `quality_update_campaigns` — same rationale as
 * `syncFeatureUpdateProfiles` above. Upserts on
 * (tenantId, policyType, intuneProfileId); `source` and `createdBy` are
 * excluded from the `set` clause so a PatchPilot-created row keeps its
 * provenance. Pruning is scoped to `policyType: "expedite"` so this never
 * touches `syncQualityUpdatePolicies`'s rows.
 */
export async function syncQualityUpdateProfiles(
  engineer: Engineer,
  tenantId: string,
): Promise<{ count: number }> {
  const profiles = await listQualityUpdateProfiles({
    engineer: engineer.upn,
    homeTenantId: engineer.homeTenantId,
    tenantId,
  });

  const rows = profiles.map((p) => ({
    tenantId,
    policyType: "expedite" as const,
    displayName: p.displayName,
    releaseLabel: p.releaseLabel,
    daysUntilForcedReboot: p.daysUntilForcedReboot,
    assignments: p.assignments,
    intuneProfileId: p.intuneProfileId,
  }));

  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx
        .insert(tables.qualityUpdateCampaigns)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            tables.qualityUpdateCampaigns.tenantId,
            tables.qualityUpdateCampaigns.policyType,
            tables.qualityUpdateCampaigns.intuneProfileId,
          ],
          set: {
            displayName: sql`excluded."display_name"`,
            releaseLabel: sql`excluded."release_label"`,
            daysUntilForcedReboot: sql`excluded."days_until_forced_reboot"`,
            assignments: sql`excluded."assignments"`,
          },
        });
    }
    await tx.delete(tables.qualityUpdateCampaigns).where(
      and(
        eq(tables.qualityUpdateCampaigns.tenantId, tenantId),
        eq(tables.qualityUpdateCampaigns.policyType, "expedite"),
        rows.length > 0
          ? notInArray(
              tables.qualityUpdateCampaigns.intuneProfileId,
              rows.map((r) => r.intuneProfileId),
            )
          : sql`true`,
      ),
    );
  });

  return { count: rows.length };
}

/**
 * Mirrors the tenant's `windowsQualityUpdatePolicies` ("quality-update"
 * policyType — the newer, separate, read-only resource) into
 * `quality_update_campaigns`. Every row is Intune-origin (`source: "intune"`
 * default, `createdBy: null`) — PatchPilot has no create path for this
 * resource. Pruning is scoped to `policyType: "quality-update"` so this
 * never touches `syncQualityUpdateProfiles`'s rows.
 */
export async function syncQualityUpdatePolicies(
  engineer: Engineer,
  tenantId: string,
): Promise<{ count: number }> {
  const policies = await listQualityUpdatePolicies({
    engineer: engineer.upn,
    homeTenantId: engineer.homeTenantId,
    tenantId,
  });

  const rows = policies.map((p) => ({
    tenantId,
    policyType: "quality-update" as const,
    displayName: p.displayName,
    releaseLabel: p.releaseLabel,
    daysUntilForcedReboot: p.daysUntilForcedReboot,
    assignments: p.assignments,
    intuneProfileId: p.intuneProfileId,
  }));

  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx
        .insert(tables.qualityUpdateCampaigns)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            tables.qualityUpdateCampaigns.tenantId,
            tables.qualityUpdateCampaigns.policyType,
            tables.qualityUpdateCampaigns.intuneProfileId,
          ],
          set: {
            displayName: sql`excluded."display_name"`,
            releaseLabel: sql`excluded."release_label"`,
            daysUntilForcedReboot: sql`excluded."days_until_forced_reboot"`,
            assignments: sql`excluded."assignments"`,
          },
        });
    }
    await tx.delete(tables.qualityUpdateCampaigns).where(
      and(
        eq(tables.qualityUpdateCampaigns.tenantId, tenantId),
        eq(tables.qualityUpdateCampaigns.policyType, "quality-update"),
        rows.length > 0
          ? notInArray(
              tables.qualityUpdateCampaigns.intuneProfileId,
              rows.map((r) => r.intuneProfileId),
            )
          : sql`true`,
      ),
    );
  });

  return { count: rows.length };
}

// ---------------------------------------------------------------------------
// Update rings (live sync, read-only)
// ---------------------------------------------------------------------------

/** Mirrors the tenant's `windowsUpdateForBusinessConfigurations` into `update_ring_profiles` — read-only, no provenance split needed. */
export async function syncUpdateRingProfiles(
  engineer: Engineer,
  tenantId: string,
): Promise<{ count: number }> {
  const profiles = await listUpdateRingProfiles({
    engineer: engineer.upn,
    homeTenantId: engineer.homeTenantId,
    tenantId,
  });

  const rows = profiles.map((p) => ({
    tenantId,
    displayName: p.displayName,
    assignments: p.assignments,
    intuneProfileId: p.intuneProfileId,
    qualityUpdatesDeferralPeriodInDays: p.qualityUpdatesDeferralPeriodInDays,
    featureUpdatesDeferralPeriodInDays: p.featureUpdatesDeferralPeriodInDays,
    allowWindows11Upgrade: p.allowWindows11Upgrade,
    automaticUpdateMode: p.automaticUpdateMode,
    businessReadyUpdatesOnly: p.businessReadyUpdatesOnly,
  }));

  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx
        .insert(tables.updateRingProfiles)
        .values(rows)
        .onConflictDoUpdate({
          target: [tables.updateRingProfiles.tenantId, tables.updateRingProfiles.intuneProfileId],
          set: {
            displayName: sql`excluded."display_name"`,
            assignments: sql`excluded."assignments"`,
            qualityUpdatesDeferralPeriodInDays: sql`excluded."quality_updates_deferral_period_in_days"`,
            featureUpdatesDeferralPeriodInDays: sql`excluded."feature_updates_deferral_period_in_days"`,
            allowWindows11Upgrade: sql`excluded."allow_windows_11_upgrade"`,
            automaticUpdateMode: sql`excluded."automatic_update_mode"`,
            businessReadyUpdatesOnly: sql`excluded."business_ready_updates_only"`,
          },
        });
      await tx.delete(tables.updateRingProfiles).where(
        and(
          eq(tables.updateRingProfiles.tenantId, tenantId),
          notInArray(
            tables.updateRingProfiles.intuneProfileId,
            rows.map((r) => r.intuneProfileId),
          ),
        ),
      );
    } else {
      await tx.delete(tables.updateRingProfiles).where(eq(tables.updateRingProfiles.tenantId, tenantId));
    }
  });

  return { count: rows.length };
}

// ---------------------------------------------------------------------------
// Driver updates (live sync, read-only)
// ---------------------------------------------------------------------------

/** Mirrors the tenant's `windowsDriverUpdateProfiles` into `driver_update_profiles` — read-only, no provenance split needed. */
export async function syncDriverUpdateProfiles(
  engineer: Engineer,
  tenantId: string,
): Promise<{ count: number }> {
  const profiles = await listDriverUpdateProfiles({
    engineer: engineer.upn,
    homeTenantId: engineer.homeTenantId,
    tenantId,
  });

  const rows = profiles.map((p) => ({
    tenantId,
    displayName: p.displayName,
    assignments: p.assignments,
    intuneProfileId: p.intuneProfileId,
    approvalType: p.approvalType,
    deploymentDeferralInDays: p.deploymentDeferralInDays,
  }));

  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx
        .insert(tables.driverUpdateProfiles)
        .values(rows)
        .onConflictDoUpdate({
          target: [tables.driverUpdateProfiles.tenantId, tables.driverUpdateProfiles.intuneProfileId],
          set: {
            displayName: sql`excluded."display_name"`,
            assignments: sql`excluded."assignments"`,
            approvalType: sql`excluded."approval_type"`,
            deploymentDeferralInDays: sql`excluded."deployment_deferral_in_days"`,
          },
        });
      await tx.delete(tables.driverUpdateProfiles).where(
        and(
          eq(tables.driverUpdateProfiles.tenantId, tenantId),
          notInArray(
            tables.driverUpdateProfiles.intuneProfileId,
            rows.map((r) => r.intuneProfileId),
          ),
        ),
      );
    } else {
      await tx.delete(tables.driverUpdateProfiles).where(eq(tables.driverUpdateProfiles.tenantId, tenantId));
    }
  });

  return { count: rows.length };
}

// ---------------------------------------------------------------------------
// Exposed devices (on-demand drill-down for a recommendation)
// ---------------------------------------------------------------------------

/** A machine exposed to a recommendation, from `/recommendations/{id}/machineReferences`. */
interface DefenderMachineReference {
  id?: string;
  computerDnsName?: string;
  osPlatform?: string;
}

/** One exposed device, enriched from our inventory, for the UI's side popout. */
export interface ExposedDevice {
  defenderMachineId: string | null;
  deviceName: string;
  owner: string | null;
  lastSeen: string | null;
  /** Defender exposes no pending-reboot signal for recommendations — always null. */
  pendingReboot: boolean | null;
  /** Raw detection evidence for this device, scoped to the requested software
   *  targets. Null/empty when no matching evidence was found (e.g. a
   *  misconfiguration recommendation, which has no software to match). */
  installedVersion: string | null;
  diskPaths: string[];
  registryPaths: string[];
}

/** Per-machine detection evidence, aggregated across every raw software title
 *  that either-contains matches one of `targets` (normalized friendly product
 *  names) — the same match rule used elsewhere to join CVEs to recommendations. */
export function buildMachineEvidence(
  rows: {
    defenderMachineId: string;
    software: string;
    softwareVersion: string | null;
    diskPaths: string[] | null;
    registryPaths: string[] | null;
  }[],
  targets: string[],
): Map<string, { installedVersion: string | null; diskPaths: string[]; registryPaths: string[] }> {
  const building = new Map<
    string,
    { versions: Set<string>; diskPaths: Set<string>; registryPaths: Set<string> }
  >();
  for (const r of rows) {
    const sw = normalizeTitle(r.software);
    if (!sw || !targets.some((t) => sw === t || sw.includes(t) || t.includes(sw))) continue;
    let ev = building.get(r.defenderMachineId);
    if (!ev) {
      ev = { versions: new Set(), diskPaths: new Set(), registryPaths: new Set() };
      building.set(r.defenderMachineId, ev);
    }
    if (r.softwareVersion) ev.versions.add(r.softwareVersion);
    for (const p of r.diskPaths ?? []) ev.diskPaths.add(p);
    for (const p of r.registryPaths ?? []) ev.registryPaths.add(p);
  }
  const out = new Map<
    string,
    { installedVersion: string | null; diskPaths: string[]; registryPaths: string[] }
  >();
  for (const [machineId, ev] of building) {
    out.set(machineId, {
      installedVersion: ev.versions.size ? [...ev.versions].join(", ") : null,
      diskPaths: [...ev.diskPaths],
      registryPaths: [...ev.registryPaths],
    });
  }
  return out;
}

/**
 * Fetches the devices exposed to one or more (consolidated) recommendations and
 * enriches them with our device inventory (owner / last seen) via the
 * defenderMachineId join. On-demand only — never synced, since 100s of
 * machineReferences calls per tenant would dwarf the rest of the sync.
 *
 * Best-effort: a recommendation whose machineReferences can't be read (scope /
 * licensing) simply contributes nothing rather than failing the request.
 *
 * `targets` (normalized friendly product names) scope the attached "how it was
 * detected" evidence to the recommendation(s) this popout was opened for —
 * empty for misconfigurations, which have no software to match.
 */
export async function fetchExposedDevices(
  engineer: Engineer,
  tenantId: string,
  recommendationIds: string[],
  targets: string[] = [],
): Promise<ExposedDevice[]> {
  // Union exposed machines across the (possibly consolidated) recommendations.
  const refs = new Map<string, DefenderMachineReference>();
  await forEachLimit(recommendationIds, 6, async (recId) => {
    try {
      const { rows: list } = await collectPaged<DefenderMachineReference>(
        engineer,
        tenantId,
        "defender",
        `/recommendations/${encodeURIComponent(recId)}/machineReferences`,
      );
      for (const m of list) if (m.id) refs.set(m.id, m);
    } catch {
      // best-effort: skip a recommendation whose machineReferences can't be read.
    }
  });

  if (refs.size === 0) return [];

  const deviceRows = await db
    .select({
      defenderMachineId: tables.devices.defenderMachineId,
      hostname: tables.devices.hostname,
      owner: tables.devices.owner,
      lastSeen: tables.devices.lastSeen,
    })
    .from(tables.devices)
    .where(eq(tables.devices.tenantId, tenantId));
  const deviceByMachineId = new Map(
    deviceRows
      .filter((d): d is typeof d & { defenderMachineId: string } => Boolean(d.defenderMachineId))
      .map((d) => [d.defenderMachineId, d]),
  );

  let evidenceByMachine = new Map<
    string,
    { installedVersion: string | null; diskPaths: string[]; registryPaths: string[] }
  >();
  if (targets.length > 0) {
    const evidenceRows = await db
      .select({
        defenderMachineId: tables.deviceVulnerabilities.defenderMachineId,
        software: tables.deviceVulnerabilities.software,
        softwareVersion: tables.deviceVulnerabilities.softwareVersion,
        diskPaths: tables.deviceVulnerabilities.diskPaths,
        registryPaths: tables.deviceVulnerabilities.registryPaths,
      })
      .from(tables.deviceVulnerabilities)
      .where(eq(tables.deviceVulnerabilities.tenantId, tenantId));
    evidenceByMachine = buildMachineEvidence(
      evidenceRows.filter((r) => refs.has(r.defenderMachineId)),
      targets,
    );
  }

  const out: ExposedDevice[] = [];
  for (const [machineId, ref] of refs) {
    const dev = deviceByMachineId.get(machineId);
    const ev = evidenceByMachine.get(machineId);
    out.push({
      defenderMachineId: machineId,
      deviceName: dev?.hostname || ref.computerDnsName || machineId,
      owner: dev?.owner ?? null,
      lastSeen: dev?.lastSeen ? dev.lastSeen.toISOString() : null,
      pendingReboot: null,
      installedVersion: ev?.installedVersion ?? null,
      diskPaths: ev?.diskPaths ?? [],
      registryPaths: ev?.registryPaths ?? [],
    });
  }
  // Most-recently-seen first, then by name — a useful default for triage.
  out.sort((a, b) => {
    if (a.lastSeen && b.lastSeen) return b.lastSeen.localeCompare(a.lastSeen);
    if (a.lastSeen) return -1;
    if (b.lastSeen) return 1;
    return a.deviceName.localeCompare(b.deviceName);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Recommendation-only CVE backfill (OS findings the per-machine sync misses)
// ---------------------------------------------------------------------------

/** `/recommendations/{id}/vulnerabilities` row — same per-CVE shape Defender's
 *  own `/vulnerabilities/{id}` returns, plus a first-detected date. */
interface RecommendationVulnerability extends DefenderVulnerability {
  firstDetected?: string;
}

/**
 * Backfills per-CVE findings for recommendations whose CVEs never surface in
 * `syncVulnerabilities`. That sync sources per-machine exposure from
 * `SoftwareVulnerabilitiesByMachine`, which attributes CVEs to installed
 * *software* — it does not treat the OS product itself (e.g. "Microsoft
 * Windows 11", "Microsoft Windows Defender") as an attributable install the
 * way it does an app or Windows Server's roles. Those recommendations land in
 * `recommendations` with a real `weaknessCount` but zero matching rows in
 * `vulnerabilities`, which breaks the vulnId-keyed dispatch pipeline and the
 * device "By software" tab for any device only exposed to them.
 *
 * Source: `/recommendations/{id}/vulnerabilities` — the per-CVE list backing
 * a recommendation (its `@odata.count` matches `weaknessCount` exactly,
 * verified live). Only fetched for a recommendation with zero rows in
 * `vulnerabilities` already matching its product (the same either-contains
 * match the UI uses in `cvesForRecommendation`), so this never fights or
 * duplicates what `syncVulnerabilities` already wrote for products it does
 * cover.
 *
 * Device linkage has no per-CVE breakdown in this feed (Defender gives only
 * an `exposedMachines` *count*), so every device from `fetchExposedDevices`
 * is recorded as exposed to every backfilled CVE for that recommendation — a
 * product-level approximation, consistent with how the recommendation's own
 * exposure count already works.
 *
 * Must run after `syncRecommendations` (needs its freshly-upserted rows) on
 * every sync pass — rows here are upserted on the same `(tenantId, cveId,
 * software)` key `syncVulnerabilities` uses, then pruned by `lastSeenAt` the
 * same way, but scoped to the `software` values *this* function touched, so
 * a resync's prune can never touch what `syncVulnerabilities` already owns.
 * `deviceVulnerabilities` linkage is likewise scoped by `software`, since
 * `syncVulnerabilities` already did its own full delete+insert for the
 * tenant before this runs.
 */
export async function backfillOsRecommendationVulnerabilities(
  engineer: Engineer,
  tenantId: string,
): Promise<{ count: number }> {
  const allRecs = await db
    .select()
    .from(tables.recommendations)
    .where(
      and(
        eq(tables.recommendations.tenantId, tenantId),
        sql`${tables.recommendations.weaknessCount} > 0`,
      ),
    );
  // `syncRecommendations` now ingests Defender's excepted/resolved rows too (so
  // the UI can show them as excepted). Those aren't actionable, so don't
  // manufacture CVE rows for them — only Active recommendations get backfilled.
  const recs = allRecs.filter(
    (r) => !r.recommendationStatus || r.recommendationStatus.toLowerCase() === "active",
  );
  if (recs.length === 0) return { count: 0 };

  const existingVulns = await db
    .select({ software: tables.vulnerabilities.software })
    .from(tables.vulnerabilities)
    .where(eq(tables.vulnerabilities.tenantId, tenantId));
  const existingNormalized = [
    ...new Set(existingVulns.map((v) => normalizeTitle(v.software)).filter(Boolean)),
  ];
  const isCovered = (productName: string): boolean => {
    const target = normalizeTitle(productName);
    if (!target) return false;
    return existingNormalized.some(
      (sw) => sw === target || sw.includes(target) || target.includes(sw),
    );
  };

  // The table stores Defender's raw machine-readable product name ("windows_11"),
  // but the UI (and this function's own `software` writes) must key off the same
  // friendly, vendor-prefixed name `/api/recommendations` displays ("Microsoft
  // Windows 11") — otherwise the CVE rows we backfill can never match what
  // `cvesForRecommendation` compares against on the frontend. Using the friendly
  // name for the coverage check too avoids a short raw token ("windows_11") from
  // spuriously substring-matching an unrelated product's software title.
  const candidates = recs.filter((r) => !isCovered(friendlyProductName(r.productName, r.vendor)));
  if (candidates.length === 0) return { count: 0 };

  const now = new Date();
  let count = 0;
  // Software values this run actually got an answer from Defender for — the
  // prune/relink steps below are scoped to only these, so a recommendation
  // whose fetch failed (network/licensing) keeps whatever it backfilled last
  // time instead of being wiped by a failed attempt.
  const softwareTouched = new Set<string>();
  const linkByKey = new Map<string, typeof tables.deviceVulnerabilities.$inferInsert>();
  const detectedAtByRecId = new Map<string, Date>();

  await forEachLimit(candidates, 3, async (rec) => {
    const software = friendlyProductName(rec.productName, rec.vendor);
    let cves: RecommendationVulnerability[];
    try {
      ({ rows: cves } = await collectPaged<RecommendationVulnerability>(
        engineer,
        tenantId,
        "defender",
        `/recommendations/${encodeURIComponent(rec.recommendationId)}/vulnerabilities`,
      ));
    } catch {
      // best-effort: leave any previously-backfilled rows for this software alone.
      return;
    }
    softwareTouched.add(software);
    if (cves.length === 0) return;

    const exposed = await fetchExposedDevices(engineer, tenantId, [rec.recommendationId]);
    const machineIds = exposed
      .map((d) => d.defenderMachineId)
      .filter((id): id is string => Boolean(id));

    for (const v of cves) {
      if (!v.id) continue;
      const title = v.name?.trim() || `${software} — ${v.id}`;
      const severity = mapSeverity(v.severity);
      const firstDetected = parseDate(v.firstDetected);
      const detectedAt = firstDetected ?? rec.detectedAt ?? now;
      const exploitAvailable = Boolean(v.publicExploit || v.exploitVerified || v.exploitInKit);
      const exploitVerified = Boolean(v.exploitVerified);
      const cvss = typeof v.cvssV3 === "number" ? v.cvssV3 : null;
      const description = v.description?.trim() || null;
      const cvssVector = v.cvssVector?.trim() || null;
      const epss = typeof v.epss === "number" ? v.epss : null;
      const publishedOn = parseDate(v.publishedOn);
      const updatedOn = parseDate(v.updatedOn);

      if (firstDetected) {
        const prior = detectedAtByRecId.get(rec.id);
        if (!prior || firstDetected < prior) detectedAtByRecId.set(rec.id, firstDetected);
      }

      await db
        .insert(tables.vulnerabilities)
        .values({
          tenantId,
          cveId: v.id,
          title,
          severity,
          cvss,
          affectedDeviceCount: machineIds.length,
          software,
          publisher: rec.vendor,
          description,
          cvssVector,
          epss,
          publishedOn,
          updatedOn,
          exploitAvailable,
          exploitVerified,
          detectedAt,
          lastSeenAt: now,
          wingetRemediable: false,
          wingetPackageId: null,
          status: "open",
        })
        .onConflictDoUpdate({
          target: [
            tables.vulnerabilities.tenantId,
            tables.vulnerabilities.cveId,
            tables.vulnerabilities.software,
          ],
          set: {
            title,
            severity,
            cvss,
            affectedDeviceCount: machineIds.length,
            publisher: rec.vendor,
            description,
            cvssVector,
            epss,
            publishedOn,
            updatedOn,
            exploitAvailable,
            exploitVerified,
            ...(firstDetected ? { detectedAt: firstDetected } : {}),
            lastSeenAt: now,
          },
        });
      count++;

      for (const machineId of machineIds) {
        const key = `${machineId}${KEY_SEP}${v.id}${KEY_SEP}${software}`;
        linkByKey.set(key, {
          tenantId,
          defenderMachineId: machineId,
          cveId: v.id,
          software,
          softwareVersion: null,
          diskPaths: null,
          registryPaths: null,
        });
      }
    }
  });

  if (softwareTouched.size === 0) return { count: 0 };

  // Prune stale backfilled rows, scoped to the software values this run
  // actually got an answer for — never touches syncVulnerabilities' own rows.
  const backfillPruneWhere = and(
    eq(tables.vulnerabilities.tenantId, tenantId),
    inArray(tables.vulnerabilities.software, [...softwareTouched]),
    or(isNull(tables.vulnerabilities.lastSeenAt), lt(tables.vulnerabilities.lastSeenAt, now)),
  );
  await db.transaction(async (tx) => {
    // Record a remediation event per pruned row before it's gone — see the
    // equivalent comment on syncVulnerabilities' main prune for the rationale
    // and the reclassification check below for the matcher-driven false-
    // positive caveat.
    const doomed = await tx
      .select({
        cveId: tables.vulnerabilities.cveId,
        software: tables.vulnerabilities.software,
        severity: tables.vulnerabilities.severity,
        detectedAt: tables.vulnerabilities.detectedAt,
        wingetPackageId: tables.vulnerabilities.wingetPackageId,
      })
      .from(tables.vulnerabilities)
      .where(backfillPruneWhere);
    if (doomed.length > 0) {
      const findings: DoomedFinding[] = doomed.map((d) => ({
        kind: "vulnerability",
        cveId: d.cveId,
        recommendationId: null,
        software: d.software,
        detectedAt: d.detectedAt,
        wingetPackageId: d.wingetPackageId,
      }));
      const [attributions, reclassifiedCves] = await Promise.all([
        attributeClears(tx, tenantId, findings, now),
        detectReclassifiedCves(
          tx,
          tenantId,
          [...new Set(doomed.map((d) => d.cveId).filter((v): v is string => !!v))],
          now,
        ),
      ]);
      await tx.insert(tables.remediationEvents).values(
        doomed.map((d) => {
          const attr = attributions.get(`${d.cveId ?? ""}|${d.software ?? ""}`);
          return {
            tenantId,
            kind: "vulnerability" as const,
            cveId: d.cveId,
            software: d.software,
            severity: d.severity,
            detectedAt: d.detectedAt,
            remediatedAt: now,
            closure: (d.cveId && reclassifiedCves.has(d.cveId) ? "reclassified" : "cleared") as
              | "cleared"
              | "reclassified",
            ...(attr
              ? {
                  attribution: attr.attribution,
                  deviceId: attr.deviceId,
                  deviceHostname: attr.deviceHostname,
                  engineer: attr.engineer,
                  jobId: attr.jobId,
                  channel: attr.channel,
                  fixStartedAt: attr.fixStartedAt,
                  fixFinishedAt: attr.fixFinishedAt,
                  contributingJobs: attr.contributingJobs,
                }
              : {}),
          };
        }),
      );
    }
    await tx.delete(tables.vulnerabilities).where(backfillPruneWhere);
  });

  // Relink devices for the software values touched — full delete+insert scoped
  // to those, so syncVulnerabilities' own linkage (already written before this
  // function runs) is left untouched.
  await db.transaction(async (tx) => {
    await tx
      .delete(tables.deviceVulnerabilities)
      .where(
        and(
          eq(tables.deviceVulnerabilities.tenantId, tenantId),
          inArray(tables.deviceVulnerabilities.software, [...softwareTouched]),
        ),
      );
    const linkRows = [...linkByKey.values()];
    if (linkRows.length > 0) {
      await tx.insert(tables.deviceVulnerabilities).values(linkRows);
    }
  });

  // Anchor each backfilled recommendation's SLA clock to the earliest real
  // first-detected we found, same as syncRecommendations does for products it
  // can already match — otherwise these would stay pinned to sync-time `now`.
  for (const [recId, detectedAt] of detectedAtByRecId) {
    await db
      .update(tables.recommendations)
      .set({ detectedAt })
      .where(eq(tables.recommendations.id, recId));
  }

  return { count };
}
