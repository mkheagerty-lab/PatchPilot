/**
 * Maps software-inventory titles to Chocolatey package ids.
 *
 * User-context counterpart to winget.ts's `matchWinget`: SYSTEM-context Live
 * Response can only reach machine-wide installs (see `detectInstallScope`'s doc
 * comment in winget.ts), so a per-user install is instead resolved against the
 * Chocolatey community catalog. The matching engine mirrors `matchWinget`
 * exactly — same tiers, same tie-breaking, same caching — reusing
 * `normalizeTitle` and `compareWingetVersions` from winget.ts rather than
 * duplicating title normalisation and version comparison, since both are
 * generic string operations with no winget-specific behavior.
 */

import { normalizeTitle, compareWingetVersions, resolveMatchingTitle } from "./winget.js";

/** A catalog entry — mirrors the `chocolatey_catalog` table / demo fixtures. */
export interface ChocolateyCatalogEntry {
  packageId: string;
  name: string;
  publisher: string;
  latestVersion?: string | null;
  /** The canonical software-inventory title this package maps to, if known. */
  softwareTitle?: string | null;
}

export interface ChocolateyMatch {
  packageId: string;
  name: string;
  /** 0..1 — 1 is an exact normalized-title match (or a manual override). */
  confidence: number;
  method: "manual" | "exact" | "contains" | "token-overlap";
}

/**
 * An engineer-authored pin from a software title to a Chocolatey package,
 * mirrors the `chocolatey_catalog_override` table. Callers resolve scope
 * (tenant-specific beats global) before passing these to `matchChocolatey` —
 * earlier entries win, so order tenant-scoped overrides ahead of global ones.
 */
export interface ChocolateyOverride {
  softwareTitle: string;
  packageId: string;
}

/** Re-exported for callers that need a version gate against a Chocolatey catalog's latest version. */
export { compareWingetVersions as compareChocolateyVersions };

/**
 * Whether the Chocolatey catalog's `latest` version satisfies a `target`
 * version — same contract as winget.ts's `wingetVersionGate`.
 */
export type ChocolateyVersionGate = "ready" | "behind" | "unknown";

export function chocolateyVersionGate(
  latest: string | null | undefined,
  target: string | null | undefined,
): ChocolateyVersionGate {
  const l = latest?.trim();
  const t = target?.trim();
  if (!l || !t) return "unknown";
  return compareWingetVersions(l, t) >= 0 ? "ready" : "behind";
}

function tokens(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

interface IndexedCandidate {
  normalized: string;
  tokenSet: Set<string>;
}

interface IndexedCatalogEntry {
  entry: ChocolateyCatalogEntry;
  candidates: IndexedCandidate[];
}

/** Same rationale as winget.ts's `catalogIndexCache` — see that file's doc comment. */
const catalogIndexCache = new WeakMap<readonly ChocolateyCatalogEntry[], IndexedCatalogEntry[]>();

function getIndexedCatalog(catalog: readonly ChocolateyCatalogEntry[]): IndexedCatalogEntry[] {
  const cached = catalogIndexCache.get(catalog);
  if (cached) return cached;

  const indexed = catalog.map((entry) => ({
    entry,
    candidates: [entry.softwareTitle, entry.name]
      .filter((c): c is string => Boolean(c))
      .map(normalizeTitle)
      .filter(Boolean)
      .map((normalized) => ({ normalized, tokenSet: tokens(normalized) })),
  }));
  catalogIndexCache.set(catalog, indexed);
  return indexed;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** The minimum token-overlap score to consider a fuzzy match credible. */
export const CHOCOLATEY_MATCH_THRESHOLD = 0.5;

/** Same containment-credibility guard as winget.ts's `isCredibleContainment`. */
function isCredibleContainment(cand: string, target: string): boolean {
  if (cand.includes(target)) return tokens(target).size >= 2;
  if (target.includes(cand)) return tokens(cand).size >= 2;
  return false;
}

/** Same overlap-credibility guard as winget.ts's `isCredibleOverlap`. */
function isCredibleOverlap(targetTokens: ReadonlySet<string>, candTokens: ReadonlySet<string>): boolean {
  return targetTokens.size >= 2 && candTokens.size >= 2;
}

/** Same variant-of relationship as winget.ts's `isVariantOf`, applied to Chocolatey ids. */
function isVariantOf(variant: string, base: string): boolean {
  const v = variant.split(".");
  const b = base.split(".");
  if (b.length >= v.length) return false;
  return b.every((seg, i) => seg === v[i]);
}

/** Same tie-break rule as winget.ts's `isBetterMatch` — see that file's doc comment. */
function isBetterMatch(
  next: ChocolateyMatch,
  best: ChocolateyMatch | null,
  nextSpecificity: number,
  bestSpecificity: number,
): boolean {
  if (!best) return true;
  if (next.confidence !== best.confidence) return next.confidence > best.confidence;
  if (isVariantOf(best.packageId, next.packageId)) return true;
  if (isVariantOf(next.packageId, best.packageId)) return false;
  return nextSpecificity > bestSpecificity;
}

const matchResultCache = new WeakMap<
  readonly ChocolateyCatalogEntry[],
  Map<string, ChocolateyMatch | null>
>();

function matchCacheKey(title: string, overrides: readonly ChocolateyOverride[]): string {
  let key = title;
  for (const o of overrides) key += ` ${o.softwareTitle} ${o.packageId}`;
  return key;
}

/**
 * Resolves a software title to the best Chocolatey package in the catalog, or
 * null if nothing clears `MATCH_THRESHOLD`. Mirrors `matchWinget` exactly —
 * see that function's doc comment for the full match-tier and tie-break
 * rationale, which applies identically here.
 */
export function matchChocolatey(
  title: string,
  catalog: readonly ChocolateyCatalogEntry[],
  overrides: readonly ChocolateyOverride[] = [],
): ChocolateyMatch | null {
  let cache = matchResultCache.get(catalog);
  if (!cache) {
    cache = new Map();
    matchResultCache.set(catalog, cache);
  }
  const cacheKey = matchCacheKey(title, overrides);
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = computeChocolateyMatch(title, catalog, overrides);
  cache.set(cacheKey, result);
  return result;
}

function computeChocolateyMatch(
  title: string,
  catalog: readonly ChocolateyCatalogEntry[],
  overrides: readonly ChocolateyOverride[],
): ChocolateyMatch | null {
  const target = normalizeTitle(resolveMatchingTitle(title));
  if (!target) return null;
  const targetTokens = tokens(target);

  // Manual overrides win outright, in caller-supplied precedence order.
  for (const o of overrides) {
    if (normalizeTitle(resolveMatchingTitle(o.softwareTitle)) === target) {
      const entry = catalog.find((c) => c.packageId === o.packageId);
      return {
        packageId: o.packageId,
        name: entry?.name ?? o.packageId,
        confidence: 1,
        method: "manual",
      };
    }
  }

  let best: ChocolateyMatch | null = null;
  let bestSpecificity = 0;

  for (const { entry, candidates } of getIndexedCatalog(catalog)) {
    for (const { normalized: cand, tokenSet: candTokens } of candidates) {
      const specificity = jaccard(targetTokens, candTokens);
      let match: ChocolateyMatch | null = null;

      if (cand === target) {
        match = { packageId: entry.packageId, name: entry.name, confidence: 1, method: "exact" };
      } else if (isCredibleContainment(cand, target)) {
        match = { packageId: entry.packageId, name: entry.name, confidence: 0.8, method: "contains" };
      } else if (specificity >= CHOCOLATEY_MATCH_THRESHOLD && isCredibleOverlap(targetTokens, candTokens)) {
        match = {
          packageId: entry.packageId,
          name: entry.name,
          confidence: Number(specificity.toFixed(2)),
          method: "token-overlap",
        };
      }

      if (match && isBetterMatch(match, best, specificity, bestSpecificity)) {
        best = match;
        bestSpecificity = specificity;
      }
    }
  }

  return best;
}
