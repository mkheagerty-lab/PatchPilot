import {
  db,
  tables,
  demoWingetCatalog,
  demoWingetCatalogOverrides,
  demoChocolateyCatalog,
  demoChocolateyCatalogOverrides,
  type WingetCatalogRow,
  type WingetCatalogOverrideRow,
  type ChocolateyCatalogRow,
  type ChocolateyCatalogOverrideRow,
} from "@patchpilot/db";
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

export async function loadWingetCatalog(): Promise<WingetCatalogRow[]> {
  if (config.DEMO_MODE) return demoWingetCatalog;
  return db.select().from(tables.wingetCatalog);
}

export async function loadWingetOverrides(): Promise<WingetCatalogOverrideRow[]> {
  if (config.DEMO_MODE) return demoWingetCatalogOverrides;
  return db.select().from(tables.wingetCatalogOverride);
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

export async function loadChocolateyCatalog(): Promise<ChocolateyCatalogRow[]> {
  if (config.DEMO_MODE) return demoChocolateyCatalog;
  return db.select().from(tables.chocolateyCatalog);
}

export async function loadChocolateyOverrides(): Promise<ChocolateyCatalogOverrideRow[]> {
  if (config.DEMO_MODE) return demoChocolateyCatalogOverrides;
  return db.select().from(tables.chocolateyCatalogOverride);
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
