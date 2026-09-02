import type { FastifyInstance } from "fastify";
import { requirePermission } from "../auth/rbac.js";

/**
 * Microsoft Store package search, backing the "Microsoft Store app (new)"
 * channel's catalog picker (`MicrosoftStorePicker.tsx`).
 *
 * `manifestSearch` is Microsoft's own Store-package lookup — the same one
 * `winget` itself calls under the hood for the `msstore` source (see the
 * live `winget list` proof that found Firefox as `9NZVDKPMR9RD`/msstore in
 * the original bug report). It's a raw, unauthenticated public endpoint, not
 * Graph or Defender, so it isn't reachable through `graphWrite`/`graphGet`
 * (`storeedgefd.dsx.mp.microsoft.com` isn't in client.ts's closed `HOSTS`
 * map) — same raw-`fetch()` precedent as `win32-app.ts`'s blob-upload steps.
 *
 * Live-verified in the Phase A spike (task #49): a Store-resolved id from
 * this endpoint publishes successfully as a `winGetApp`, unlike community
 * winget-repo ids (root-caused in task #20) — this is the entire reason the
 * channel exists as a separate catalog from the Winget/Chocolatey pickers.
 *
 * Query-driven, not bulk-listable — confirmed in the spike that an empty
 * query returns `{"Data":[]}`, so there is no "top 25" zero-state to seed a
 * cache with. Instead this caches by normalized query string, short-TTL,
 * in-memory only (not a DB table — `winget_catalog`'s full-mirror-ingestion
 * pattern doesn't apply to a query-driven upstream).
 */

const MANIFEST_SEARCH_URL = "https://storeedgefd.dsx.mp.microsoft.com/v9.0/manifestSearch";
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface StoreAppResult {
  packageIdentifier: string;
  name: string;
  publisher: string;
  version: string;
}

interface ManifestSearchResponse {
  Data?: Array<{
    PackageIdentifier: string;
    PackageName: string;
    Publisher: string;
    Versions?: Array<{ PackageVersion: string }>;
  }>;
}

const searchCache = new Map<string, { at: number; results: StoreAppResult[] }>();

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

async function manifestSearch(query: string): Promise<StoreAppResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(MANIFEST_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Query: { KeyWord: query, Match: "Substring" } }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`manifestSearch HTTP ${res.status}`);
    }
    const body = (await res.json()) as ManifestSearchResponse;
    return (body.Data ?? []).map((d) => ({
      packageIdentifier: d.PackageIdentifier,
      name: d.PackageName,
      publisher: d.Publisher,
      version: d.Versions?.[0]?.PackageVersion ?? "",
    }));
  } finally {
    clearTimeout(timeout);
  }
}

export async function searchStoreApps(query: string, limit: number): Promise<StoreAppResult[]> {
  const key = normalizeQuery(query);
  if (!key) return [];

  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.results.slice(0, limit);
  }

  const results = await manifestSearch(key);
  searchCache.set(key, { at: Date.now(), results });
  return results.slice(0, limit);
}

export async function storeAppsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("catalog:read"));

  /**
   * Lightweight package search for the Run Now dialog's Microsoft Store
   * picker — mirrors `/api/catalog/search`'s shape (debounced client-side,
   * short server-side page) but proxies a live external lookup instead of
   * querying a mirrored Postgres table.
   */
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    "/api/store-apps/search",
    async (req, reply) => {
      const q = (req.query?.q ?? "").trim();
      const limit = Math.min(Math.max(Number(req.query?.limit) || 20, 1), 50);
      if (!q) return [];

      try {
        return await searchStoreApps(q, limit);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: `Microsoft Store search failed: ${message}` });
      }
    },
  );
}
