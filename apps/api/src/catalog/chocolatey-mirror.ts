import { sql } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { db, tables } from "@patchpilot/db";

/**
 * Live Chocolatey catalog ingestion (Phase 5, Ask 3 — Software Inventory).
 *
 * User-context counterpart to winget-mirror.ts: per-user installs are matched
 * against the Chocolatey community repository instead of winget (see
 * chocolatey.ts's doc comment for why). Unlike winget, Microsoft doesn't
 * publish a single pre-indexed database for Chocolatey — the only public
 * ingestion path is the community repository's OData v2 API
 * (community.chocolatey.org/api/v2), paged with a server-enforced 40-item
 * page size, followed via each page's `$skiptoken` `rel="next"` link.
 *
 * Two constraints, confirmed against Chocolatey's own docs
 * (blog.chocolatey.org/2024/03/ccr-api-changes), shape this module and make
 * it fundamentally different from winget's mirror:
 *  - Raw OData queries against this endpoint are explicitly unsupported by
 *    the Chocolatey team ("may break in the future" without notice) — there
 *    is no first-party alternative for unauthenticated bulk ingestion, so we
 *    accept that risk rather than skip Chocolatey coverage entirely.
 *  - The repository hard-caps retrieval at 10,000 items *including paging*;
 *    requesting past that returns HTTP 406. So — unlike winget, where one
 *    download yields the complete catalog — this mirror is best-effort: it
 *    stops cleanly (keeping everything fetched so far) on 406, on a 429 that
 *    survives retries, or on its own safety cap just under the documented
 *    limit, and reports that in `RefreshResult.truncated` rather than
 *    failing the whole refresh. Packages missed by truncation can still be
 *    resolved via `chocolatey_catalog_override`.
 *
 * It never runs in DEMO_MODE (the route + scheduler gate on it); demo serves
 * the curated fixtures.
 */

// $select is honored only for Version/Title — Id and Authors are silently
// ignored by this endpoint (confirmed by direct testing): the package id
// instead comes from the entry's own Atom <title>, and the publisher from
// the Atom <author>, neither of which is a selectable OData property here.
const FEED_URL =
  "https://community.chocolatey.org/api/v2/Packages()?$filter=IsLatestVersion&$select=Version,Title";
const USER_AGENT = "Mozilla/5.0 (compatible; PatchPilot-ChocolateyMirror/1.0)";
export const MIRROR_SOURCE = "chocolatey-mirror";
const UPSERT_CHUNK = 1000;
/** Chocolatey's documented hard limit is 10,000 items across all paging; we stop
 * comfortably before it (a whole number of 40-item pages short of the limit) so
 * we never actually draw the 406. */
const SAFETY_CAP = 9_960;
const PAGE_TIMEOUT_MS = 30_000;
const PAGE_DELAY_MS = 150;
const MAX_RATE_LIMIT_RETRIES = 3;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (name) => name === "entry" || name === "link",
  // Without this, fast-xml-parser auto-coerces numeric-looking tag text (e.g.
  // a two-segment Version like "3.2") into a JS number, which then breaks
  // .trim() and silently mangles multi-segment version strings elsewhere.
  parseTagValue: false,
});

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
  /** True if ingestion stopped before exhausting the catalog (safety cap, 406, or 429). */
  truncated: boolean;
  truncationReason?: string;
}

interface FeedEntry {
  title?: { "#text"?: string } | string;
  author?: { name?: string } | Array<{ name?: string }>;
  properties?: { Version?: string; Title?: string };
}

interface FeedLink {
  "@_rel"?: string;
  "@_href"?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publisherOf(entry: FeedEntry, packageId: string): string {
  const author = Array.isArray(entry.author) ? entry.author[0] : entry.author;
  const name = author?.name?.trim();
  return name || packageId;
}

// The package id isn't a selectable OData property on this endpoint (see
// FEED_URL's comment) — it's the Atom <title> element instead, which
// fast-xml-parser gives us either as a bare string or as { "#text": ... }
// depending on whether the element carries attributes (it does here: type="text").
function packageIdOf(entry: FeedEntry): string | undefined {
  const title = entry.title;
  const text = typeof title === "string" ? title : title?.["#text"];
  return text?.trim() || undefined;
}

async function fetchPage(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/atom+xml" },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPageWithRetry(
  url: string,
): Promise<{ status: "ok"; res: Response } | { status: "limit" } | { status: "rate-limited" }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchPage(url);
    if (res.ok) return { status: "ok", res };
    if (res.status === 406) return { status: "limit" };
    if (res.status === 429) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES) return { status: "rate-limited" };
      await delay(2 ** attempt * 1000);
      continue;
    }
    throw new Error(`chocolatey feed request failed: HTTP ${res.status}`);
  }
}

async function runRefresh(): Promise<RefreshResult> {
  const start = Date.now();
  const packages = new Map<string, MirrorPackage>();
  let truncated = false;
  let truncationReason: string | undefined;
  let url: string | null = FEED_URL;

  while (url) {
    if (packages.size >= SAFETY_CAP) {
      truncated = true;
      truncationReason = "reached safety cap short of Chocolatey's documented 10,000-item paging limit";
      break;
    }

    const result = await fetchPageWithRetry(url);
    if (result.status === "limit") {
      truncated = true;
      truncationReason = "Chocolatey repository returned HTTP 406 (exceeded its 10,000-item paging limit)";
      break;
    }
    if (result.status === "rate-limited") {
      truncated = true;
      truncationReason = "Chocolatey repository rate-limited the mirror (HTTP 429) past retry limit";
      break;
    }

    const xml = await result.res.text();
    const parsed = parser.parse(xml) as { feed?: { entry?: FeedEntry[]; link?: FeedLink[] } };
    const entries = parsed.feed?.entry ?? [];
    for (const entry of entries) {
      const packageId = packageIdOf(entry);
      const version = entry.properties?.Version?.trim();
      if (!packageId || !version) continue;
      packages.set(packageId, {
        packageId,
        name: entry.properties?.Title?.trim() || packageId,
        publisher: publisherOf(entry, packageId),
        latestVersion: version,
      });
    }

    const links = parsed.feed?.link ?? [];
    const next = links.find((l) => l["@_rel"] === "next");
    url = next?.["@_href"] ? next["@_href"].replace(/^http:/, "https:") : null;
    if (url) await delay(PAGE_DELAY_MS);
  }

  const refreshedAt = new Date();
  await upsertPackages([...packages.values()], refreshedAt);
  return { packages: packages.size, refreshedAt, durationMs: Date.now() - start, truncated, truncationReason };
}

async function upsertPackages(packages: MirrorPackage[], refreshedAt: Date): Promise<void> {
  for (let i = 0; i < packages.length; i += UPSERT_CHUNK) {
    const chunk = packages.slice(i, i + UPSERT_CHUNK);
    await db
      .insert(tables.chocolateyCatalog)
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
        target: tables.chocolateyCatalog.packageId,
        set: {
          name: sql`excluded."name"`,
          publisher: sql`excluded."publisher"`,
          latestVersion: sql`excluded."latest_version"`,
          lastRefreshedAt: sql`excluded."last_refreshed_at"`,
        },
      });
  }
}

let inFlight: Promise<RefreshResult> | null = null;

export function isRefreshInProgress(): boolean {
  return inFlight !== null;
}

export async function refreshChocolateyCatalogFromMirror(): Promise<RefreshResult> {
  if (inFlight) return inFlight;
  inFlight = runRefresh();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
