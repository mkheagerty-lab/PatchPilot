import {
  db,
  tables,
  demoWingetCatalog,
  demoWingetCatalogOverrides,
  demoChocolateyCatalog,
  demoChocolateyCatalogOverrides,
  demoVulnerabilities,
  type WingetCatalogRow,
  type WingetCatalogOverrideRow,
  type ChocolateyCatalogRow,
  type ChocolateyCatalogOverrideRow,
  type VulnerabilityRow,
} from "@patchpilot/db";
import { eq } from "drizzle-orm";
import {
  matchWinget,
  isOsFinding,
  type WingetCatalogEntry,
  type WingetMatch,
  type WingetOverride,
  matchChocolatey,
  type ChocolateyCatalogEntry,
  type ChocolateyMatch,
  type ChocolateyOverride,
  altSourcesFor,
  type AltSource,
  type PackageSource,
} from "@patchpilot/shared";
import { config } from "../config.js";

/**
 * Live winget-catalog matching, shared between /api/catalog/coverage and any
 * other route that needs to know — right now, not at sync time — whether a
 * finding is winget-remediable. `wingetRemediable`/`wingetPackageId` on the
 * `vulnerabilities` row are frozen at sync time and over-report "out of
 * winget scope" as the catalog/overrides evolve, so routes that show that
 * status to an engineer should recompute it live via `buildWingetMatcher`
 * rather than trust the stored columns.
 */

/**
 * Titles Defender reports as installed software that are actually a bundled
 * library file embedded inside other applications' install directories, not
 * something a user installed or a package manager can independently manage.
 * Winget/Chocolatey both carry a standalone package for these (the upstream
 * project ships one), so the fuzzy matcher confidently resolves them — but
 * "fixing" here would upgrade a package that was never installed as such,
 * while the real (vendored) copies inside their host apps stay untouched.
 * "XZ Utils" was disabled after surfacing on this tenant as liblzma.dll
 * bundled inside OneDrive/Wireshark/Power BI/etc. across 6 devices, none of
 * which had it as a standalone install.
 *
 * Two forms are listed because Defender's software-inventory and
 * vulnerability-evidence surfaces name the same product differently: the
 * vendor-prefixed display name callers build from device_software.name
 * ("Tukaani Xz Utils", used by buildWingetMatcher/buildChocolateyMatcher and
 * the vulnerability-evidence path) vs. the raw, un-prefixed
 * DeviceTvmSoftwareInventory slug syncSoftwareInventory matches against
 * directly ("xz_utils" — underscores normalized to spaces below, "xz
 * utils"). Missing either form leaves one matching path un-gated even though
 * the other correctly excludes it.
 */
const BUNDLED_LIBRARY_TITLES = new Set(["tukaani xz utils", "xz utils"]);

export function isBundledLibrary(software: string | null | undefined): boolean {
  const normalized = (software ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ");
  return BUNDLED_LIBRARY_TITLES.has(normalized);
}

/**
 * Process-lifetime, TTL-based cache for the four loaders below.
 *
 * matchWinget()/matchChocolatey() (winget.ts/chocolatey.ts) memoize their
 * ~13k-entry token index and match results in a WeakMap keyed on the
 * *object identity* of the catalog array they're given. That's cheap across
 * repeated calls only if callers keep reusing the same array reference — but
 * every loader here used to run a fresh `db.select()` on every call, handing
 * back a brand-new array each time. So the WeakMap keyed on it never hit
 * across requests: every Catalog-page load, coverage refresh, or tenant
 * switch was rebuilding the full token index and re-scanning the whole
 * catalog for every distinct software title, from zero, every time.
 *
 * Caching the array itself — same reference until it expires or a write
 * invalidates it — re-enables that existing memoization for free, and the
 * in-flight `pending` de-dupe also collapses the burst of concurrent
 * requests a tenant switch fans out into a single DB round-trip.
 */
const CATALOG_CACHE_TTL_MS = 60_000;

function ttlCached<T>(loader: () => Promise<T>) {
  let cached: { value: T; expiresAt: number } | null = null;
  let pending: Promise<T> | null = null;
  return {
    get(): Promise<T> {
      if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
      if (pending) return pending;
      pending = loader()
        .then((value) => {
          cached = { value, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS };
          return value;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    /** Drop the cached value so the next `get()` re-reads the DB — call after any write. */
    invalidate(): void {
      cached = null;
    },
  };
}

const wingetCatalogCache = ttlCached<WingetCatalogRow[]>(async () => {
  if (config.DEMO_MODE) return demoWingetCatalog;
  return db.select().from(tables.wingetCatalog);
});
const wingetOverridesCache = ttlCached<WingetCatalogOverrideRow[]>(async () => {
  if (config.DEMO_MODE) return demoWingetCatalogOverrides;
  return db.select().from(tables.wingetCatalogOverride);
});

export async function loadWingetCatalog(): Promise<WingetCatalogRow[]> {
  return wingetCatalogCache.get();
}

export async function loadWingetOverrides(): Promise<WingetCatalogOverrideRow[]> {
  return wingetOverridesCache.get();
}

/** Call after a winget-mirror refresh completes so the next read picks up the new rows. */
export function invalidateWingetCatalogCache(): void {
  wingetCatalogCache.invalidate();
}

/** Call after a winget override is created or deleted so the next read reflects it. */
export function invalidateWingetOverridesCache(): void {
  wingetOverridesCache.invalidate();
}

export function toWingetEntries(catalog: readonly WingetCatalogRow[]): WingetCatalogEntry[] {
  return catalog.map((c) => ({
    packageId: c.packageId,
    name: c.name,
    publisher: c.publisher,
    latestVersion: c.latestVersion,
    softwareTitle: c.softwareTitle,
  }));
}

/**
 * Splits overrides into a global list (tenant-agnostic) and a per-tenant map so
 * a coverage pass can resolve, for each vulnerability, the precedence-ordered
 * override list its tenant should see (tenant-scoped pins ahead of global ones).
 */
export function indexWingetOverrides(rows: readonly WingetCatalogOverrideRow[]): {
  global: WingetOverride[];
  byTenant: Map<string, WingetOverride[]>;
} {
  const global: WingetOverride[] = [];
  const byTenant = new Map<string, WingetOverride[]>();
  for (const r of rows) {
    const o: WingetOverride = { softwareTitle: r.softwareTitle, packageId: r.packageId };
    if (r.tenantId === null) {
      global.push(o);
    } else {
      const list = byTenant.get(r.tenantId) ?? [];
      list.push(o);
      byTenant.set(r.tenantId, list);
    }
  }
  return { global, byTenant };
}

/**
 * Loads the catalog + overrides once and returns a resolver that live-matches
 * a (tenantId, software) pair the same way /api/catalog/coverage does. OS
 * findings are out of winget scope by nature (patched via Windows Update) and
 * always resolve to no match.
 */
export async function buildWingetMatcher(): Promise<
  (tenantId: string, software: string) => WingetMatch | null
> {
  const [catalog, overrideRows] = await Promise.all([loadWingetCatalog(), loadWingetOverrides()]);
  const entries = toWingetEntries(catalog);
  const { global, byTenant } = indexWingetOverrides(overrideRows);
  return (tenantId: string, software: string): WingetMatch | null => {
    if (isOsFinding(software) || isBundledLibrary(software)) return null;
    const overrides = [...(byTenant.get(tenantId) ?? []), ...global];
    return matchWinget(software, entries, overrides);
  };
}

const chocolateyCatalogCache = ttlCached<ChocolateyCatalogRow[]>(async () => {
  if (config.DEMO_MODE) return demoChocolateyCatalog;
  return db.select().from(tables.chocolateyCatalog);
});
const chocolateyOverridesCache = ttlCached<ChocolateyCatalogOverrideRow[]>(async () => {
  if (config.DEMO_MODE) return demoChocolateyCatalogOverrides;
  return db.select().from(tables.chocolateyCatalogOverride);
});

export async function loadChocolateyCatalog(): Promise<ChocolateyCatalogRow[]> {
  return chocolateyCatalogCache.get();
}

export async function loadChocolateyOverrides(): Promise<ChocolateyCatalogOverrideRow[]> {
  return chocolateyOverridesCache.get();
}

/** Call after a Chocolatey-mirror refresh completes so the next read picks up the new rows. */
export function invalidateChocolateyCatalogCache(): void {
  chocolateyCatalogCache.invalidate();
}

/** Call after a Chocolatey override is created or deleted so the next read reflects it. */
export function invalidateChocolateyOverridesCache(): void {
  chocolateyOverridesCache.invalidate();
}

export function toChocolateyEntries(catalog: readonly ChocolateyCatalogRow[]): ChocolateyCatalogEntry[] {
  return catalog.map((c) => ({
    packageId: c.packageId,
    name: c.name,
    publisher: c.publisher,
    latestVersion: c.latestVersion,
    softwareTitle: c.softwareTitle,
  }));
}

/**
 * Splits overrides into a global list (tenant-agnostic) and a per-tenant map,
 * mirroring indexWingetOverrides.
 */
export function indexChocolateyOverrides(rows: readonly ChocolateyCatalogOverrideRow[]): {
  global: ChocolateyOverride[];
  byTenant: Map<string, ChocolateyOverride[]>;
} {
  const global: ChocolateyOverride[] = [];
  const byTenant = new Map<string, ChocolateyOverride[]>();
  for (const r of rows) {
    const o: ChocolateyOverride = { softwareTitle: r.softwareTitle, packageId: r.packageId };
    if (r.tenantId === null) {
      global.push(o);
    } else {
      const list = byTenant.get(r.tenantId) ?? [];
      list.push(o);
      byTenant.set(r.tenantId, list);
    }
  }
  return { global, byTenant };
}

/**
 * Loads the catalog + overrides once and returns a resolver that live-matches
 * a (tenantId, software) pair for user-context (Chocolatey) software. Gated on
 * `isOsFinding` for the same reason `buildWingetMatcher` is: OS/security-platform
 * titles ("Microsoft Windows Defender", "Microsoft Defender For Endpoint", …)
 * aren't Chocolatey-installable, and the fuzzy matcher can confidently resolve
 * them to an unrelated package (e.g. a third-party "disable Defender" utility)
 * if left ungated.
 */
export async function buildChocolateyMatcher(): Promise<
  (tenantId: string, software: string) => ChocolateyMatch | null
> {
  const [catalog, overrideRows] = await Promise.all([
    loadChocolateyCatalog(),
    loadChocolateyOverrides(),
  ]);
  const entries = toChocolateyEntries(catalog);
  const { global, byTenant } = indexChocolateyOverrides(overrideRows);
  return (tenantId: string, software: string): ChocolateyMatch | null => {
    if (isOsFinding(software)) return null;
    const overrides = [...(byTenant.get(tenantId) ?? []), ...global];
    return matchChocolatey(software, entries, overrides);
  };
}

/**
 * Cached, tenant-filtered vulnerabilities loader shared by /api/catalog/coverage
 * and /api/chocolatey-catalog/coverage (previously two separate, unfiltered
 * `db.select().from(tables.vulnerabilities)` copies, each pulling every
 * tenant's findings on every request and filtering down to one tenant in JS
 * afterward). Pushing `tenantId` into the SQL `WHERE` clause hits the existing
 * `vulns_tenant_idx` index instead of scanning the whole table, and caching the
 * per-tenant result for a short TTL means a tenant's own repeated coverage
 * requests (winget + Chocolatey, catalog + posture snapshot) share one read.
 *
 * Keyed by tenantId, with a separate `ALL_TENANTS_KEY` slot for the
 * no-tenant-filter case (posture snapshotter / "all tenants" reports) — an
 * unfiltered read is a distinct query from any single tenant's, so it can't
 * share a cache entry with one.
 */
const ALL_TENANTS_KEY = "__all__";
const vulnsCache = new Map<string, { value: VulnerabilityRow[]; expiresAt: number }>();
const vulnsPending = new Map<string, Promise<VulnerabilityRow[]>>();

async function loadVulnsUncached(tenantId?: string): Promise<VulnerabilityRow[]> {
  if (config.DEMO_MODE) {
    return tenantId ? demoVulnerabilities.filter((v) => v.tenantId === tenantId) : demoVulnerabilities;
  }
  return tenantId
    ? db.select().from(tables.vulnerabilities).where(eq(tables.vulnerabilities.tenantId, tenantId))
    : db.select().from(tables.vulnerabilities);
}

/** Tenant's vulnerabilities (or the whole estate when `tenantId` is omitted), SQL-filtered and cached. */
export async function loadVulns(tenantId?: string): Promise<VulnerabilityRow[]> {
  const key = tenantId ?? ALL_TENANTS_KEY;
  const cached = vulnsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const existingPending = vulnsPending.get(key);
  if (existingPending) return existingPending;
  const pending = loadVulnsUncached(tenantId)
    .then((value) => {
      vulnsCache.set(key, { value, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS });
      return value;
    })
    .finally(() => {
      vulnsPending.delete(key);
    });
  vulnsPending.set(key, pending);
  return pending;
}

/**
 * Call after a sync writes to `vulnerabilities` for a tenant so the next read
 * reflects it. Also drops the all-tenants slot — its aggregate is now stale
 * too — since a targeted sync only ever touches one tenant's rows.
 */
export function invalidateVulnsCache(tenantId?: string): void {
  if (tenantId) {
    vulnsCache.delete(tenantId);
    vulnsCache.delete(ALL_TENANTS_KEY);
  } else {
    vulnsCache.clear();
  }
}

export type ChocolateyMatcher = (tenantId: string, software: string) => ChocolateyMatch | null;

/**
 * Resolves the alternate-repo suggestions for a not-supported app, preferring
 * a live `buildChocolateyMatcher()` hit over the small hand-curated
 * `ALT_SOURCE_MAP` in sources.ts (Greenshot/WhatsApp) — the live mirror covers
 * far more of the real Chocolatey catalog than the curated fixture ever will,
 * so it should win whenever it has an answer. The curated list stays the
 * fallback for a live miss, and is still the only source of Microsoft Store
 * suggestions (no live Store index exists).
 */
export function resolveAltSources(
  chocolateyMatcher: ChocolateyMatcher | null,
  tenantId: string,
  software: string | null | undefined,
): AltSource[] {
  const curated = altSourcesFor(software);
  const liveMatch = software && chocolateyMatcher ? chocolateyMatcher(tenantId, software) : null;
  const chocoSource: AltSource | null = liveMatch
    ? { source: "chocolatey", packageId: liveMatch.packageId, name: liveMatch.name }
    : (curated.find((a) => a.source === "chocolatey") ?? null);
  const others = curated.filter((a) => a.source !== "chocolatey");
  return chocoSource ? [chocoSource, ...others] : others;
}

/** Resolve a specific source's alternate for a software title, live-preferring. */
export function resolveAltSource(
  chocolateyMatcher: ChocolateyMatcher | null,
  tenantId: string,
  software: string | null | undefined,
  source: PackageSource,
): AltSource | null {
  return resolveAltSources(chocolateyMatcher, tenantId, software).find((a) => a.source === source) ?? null;
}
