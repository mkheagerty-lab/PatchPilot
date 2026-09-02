import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { unzipSync } from "fflate";
import { sql } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { compareWingetVersions } from "@patchpilot/shared";

/**
 * Live winget catalog ingestion (Phase 5, Workstream A1).
 *
 * Microsoft publishes the winget community source as a single pre-indexed
 * artifact — `source.msix` (an MSIX, i.e. a ZIP) on the winget CDN — containing
 * a SQLite database `Public/index.db` with every package id, display name, and
 * the full version history. We mirror it wholesale rather than scraping the REST
 * API per package: one ~17 MB download yields all ~13k packages and their latest
 * versions, which we upsert into `winget_catalog`.
 *
 * Why this is safe under the non-negotiables:
 *  - It is a *read* from a public CDN — no Microsoft tenant, no auth, no token,
 *    no per-customer data. The only writes are to our own `winget_catalog`.
 *  - The MSIX is ZIP64 (its central-directory offset is the 0xFFFFFFFF sentinel),
 *    so we extract with `fflate` (pure-JS, zip64-aware) rather than a hand-rolled
 *    parser. `node:sqlite` (built into Node 24) reads the index with zero native
 *    deps, keeping the deploy fully self-hosted.
 *  - It never runs in DEMO_MODE (the route + scheduler gate on it); demo serves
 *    the curated fixtures.
 */

/** Pre-indexed winget community source. An MSIX (ZIP) holding Public/index.db. */
const WINGET_SOURCE_URL = "https://cdn.winget.microsoft.com/cache/source.msix";

/** The SQLite database packaged inside the MSIX. */
const INDEX_DB_ENTRY = "Public/index.db";

/** Provenance stamp written on rows ingested from the mirror. */
export const MIRROR_SOURCE = "winget-mirror";

/** Rows are upserted in batches to stay well under Postgres' parameter cap. */
const UPSERT_CHUNK = 1000;

export interface MirrorPackage {
  packageId: string;
  name: string;
  publisher: string;
  latestVersion: string;
}

export interface RefreshResult {
  packages: number;
  refreshedAt: Date;
  durationMs: number;
}

/**
 * Derives a display publisher from a package id. winget's index has no usable
 * publisher table (only normalised lowercase tokens), but the id is
 * `Publisher.Product` by convention, so the prefix is the best display name
 * (Mozilla.Firefox -> "Mozilla"). Ids without a dot fall back to the whole id.
 */
function publisherFromPackageId(packageId: string): string {
  const dot = packageId.indexOf(".");
  return dot > 0 ? packageId.slice(0, dot) : packageId;
}

/** Downloads the MSIX and extracts the raw `Public/index.db` bytes from it. */
async function fetchIndexDb(): Promise<Buffer> {
  // fetch follows the CDN's redirects automatically. The body is a ~17 MB MSIX,
  // so we guard with an AbortController timeout rather than blocking forever.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let res: Response;
  try {
    res = await fetch(WINGET_SOURCE_URL, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new Error(`winget source download failed: HTTP ${res.status}`);
  }
  const msix = Buffer.from(await res.arrayBuffer());
  const extracted = unzipSync(new Uint8Array(msix), {
    filter: (file) => file.name === INDEX_DB_ENTRY,
  });
  const indexDb = extracted[INDEX_DB_ENTRY];
  if (!indexDb) {
    throw new Error(`${INDEX_DB_ENTRY} not found in winget source.msix`);
  }
  return Buffer.from(indexDb);
}

/**
 * Reads every package's latest version from the winget index db.
 *
 * The index is interned: the central `manifest` table stores rowid references
 * into `ids`/`names`/`versions`. We pull the flattened (id, name, version) rows,
 * then reduce to one entry per package id keeping the highest version per
 * `compareWingetVersions`. node:sqlite needs a file path, so the buffer is
 * written to a temp file that is always cleaned up.
 */
async function parsePackages(indexDb: Buffer): Promise<MirrorPackage[]> {
  const tmpPath = join(tmpdir(), `winget-index-${randomUUID()}.db`);
  await writeFile(tmpPath, indexDb);
  try {
    const sqlite = new DatabaseSync(tmpPath, { readOnly: true });
    let flat: Array<{ packageId: string; name: string; version: string }>;
    try {
      flat = sqlite
        .prepare(
          `SELECT i.id AS packageId, n.name AS name, v.version AS version
             FROM manifest m
             JOIN ids i ON i.rowid = m.id
             JOIN names n ON n.rowid = m.name
             JOIN versions v ON v.rowid = m.version`,
        )
        .all() as unknown as Array<{ packageId: string; name: string; version: string }>;
    } finally {
      sqlite.close();
    }

    const latest = new Map<string, MirrorPackage>();
    for (const row of flat) {
      if (!row.packageId || !row.version) continue;
      const existing = latest.get(row.packageId);
      if (!existing || compareWingetVersions(row.version, existing.latestVersion) > 0) {
        latest.set(row.packageId, {
          packageId: row.packageId,
          name: row.name || row.packageId,
          publisher: publisherFromPackageId(row.packageId),
          latestVersion: row.version,
        });
      }
    }
    return [...latest.values()];
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

/**
 * Upserts mirror packages into `winget_catalog`, refreshing each package's
 * name/publisher/latestVersion and stamping `lastRefreshedAt`. Curated columns —
 * `softwareTitle` (the MDVM mapping) and `source` — are deliberately omitted from
 * the conflict update so a hand-authored mapping is never clobbered by a refresh.
 */
async function upsertPackages(packages: MirrorPackage[], refreshedAt: Date): Promise<void> {
  for (let i = 0; i < packages.length; i += UPSERT_CHUNK) {
    const chunk = packages.slice(i, i + UPSERT_CHUNK);
    await db
      .insert(tables.wingetCatalog)
      .values(
        chunk.map((p) => ({
          packageId: p.packageId,
          name: p.name,
          publisher: p.publisher,
          latestVersion: p.latestVersion,
          softwareTitle: null,
          source: MIRROR_SOURCE,
          lastRefreshedAt: refreshedAt,
        })),
      )
      .onConflictDoUpdate({
        target: tables.wingetCatalog.packageId,
        set: {
          name: sql`excluded."name"`,
          publisher: sql`excluded."publisher"`,
          latestVersion: sql`excluded."latest_version"`,
          lastRefreshedAt: sql`excluded."last_refreshed_at"`,
        },
      });
  }
}

async function runRefresh(): Promise<RefreshResult> {
  const start = Date.now();
  const indexDb = await fetchIndexDb();
  const packages = await parsePackages(indexDb);
  const refreshedAt = new Date();
  await upsertPackages(packages, refreshedAt);
  return { packages: packages.length, refreshedAt, durationMs: Date.now() - start };
}

/** Single-flight guard so a manual refresh and the scheduler can't overlap. */
let inFlight: Promise<RefreshResult> | null = null;

/** True while a refresh is running — surfaced so the route can 409 cleanly. */
export function isRefreshInProgress(): boolean {
  return inFlight !== null;
}

/**
 * Full refresh: download the winget source, parse every package's latest
 * version, and upsert into `winget_catalog`. Returns a small summary for the
 * caller to surface / audit. Throws on any failure so callers can record it.
 * Concurrent calls coalesce onto the in-flight run rather than re-downloading.
 */
export async function refreshWingetCatalogFromMirror(): Promise<RefreshResult> {
  if (inFlight) return inFlight;
  inFlight = runRefresh();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
