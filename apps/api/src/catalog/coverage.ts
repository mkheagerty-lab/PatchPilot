import {
  db,
  tables,
  demoVulnerabilities,
  type VulnerabilityRow,
} from "@patchpilot/db";
import {
  matchWinget,
  isOsFinding,
  resolveDisplaySoftwareName,
  SEVERITY_RANK,
  type Severity,
  type WingetCatalogEntry,
  type WingetMatch,
} from "@patchpilot/shared";
import { config } from "../config.js";
import {
  loadWingetCatalog,
  loadWingetOverrides,
  indexWingetOverrides,
  toWingetEntries,
  buildChocolateyMatcher,
  resolveAltSources,
} from "./matching.js";
import {
  loadExcludedDeviceIndex,
  loadExcludedExposureBySoftware,
  excludedExposureKey,
} from "../routes/device-exclusions.js";

/**
 * Catalog coverage: which of a tenant's vulnerable software titles PatchPilot
 * can actually drive a fix for via winget.
 *
 * Lifted out of `GET /api/catalog/coverage` (which is now a one-line caller) so
 * the posture snapshotter can record the same covered/uncovered/os counts the
 * Catalog page shows. Re-deriving them in the snapshotter would have meant two
 * implementations of the grouping rules below, and the whole point of a snapshot
 * is that it's the history of what the product actually displayed.
 */

async function loadVulns(): Promise<VulnerabilityRow[]> {
  if (config.DEMO_MODE) return demoVulnerabilities;
  return db.select().from(tables.vulnerabilities);
}

/** One (tenant, software) coverage row. */
export interface CoverageRow {
  tenantId: string;
  software: string;
  displayName: string;
  publisher: string | null;
  severity: Severity;
  patchType: "app" | "os";
  applicable: boolean;
  status: "covered" | "not-supported" | "os";
  match: WingetMatch | null;
  latestVersion: string | null;
  altSources: ReturnType<typeof resolveAltSources>;
  cveCount: number;
  cveIds: string[];
  affectedDeviceCount: number;
  vulnId: string;
}

export interface Coverage {
  tenantId: string | null;
  findingCount: number;
  total: number;
  applicable: number;
  covered: number;
  uncovered: number;
  os: number;
  rows: CoverageRow[];
}

/** Coverage for one tenant, or the whole estate when `tenantId` is omitted. */
export async function computeCoverage(tenantId?: string): Promise<Coverage> {
  const catalog = await loadWingetCatalog();
  const entries: WingetCatalogEntry[] = toWingetEntries(catalog);

  const allVulns = await loadVulns();
  const vulns = tenantId ? allVulns.filter((v) => v.tenantId === tenantId) : allVulns;

  const { global: globalOverrides, byTenant } = indexWingetOverrides(await loadWingetOverrides());
  const chocolateyMatcher = await buildChocolateyMatcher();

  const excluded = await loadExcludedDeviceIndex(tenantId);
  const excludedExposure = await loadExcludedExposureBySoftware(excluded);

  // packageId -> the catalog's latest published version, so a covered row can
  // surface what a winget upgrade would actually install (and the UI can flag
  // when the catalog still trails the fix).
  const latestByPackageId = new Map<string, string | null>(
    catalog.map((c) => [c.packageId, c.latestVersion]),
  );

  // Group findings by (tenant, software) so the same product's many per-CVE
  // findings collapse into one coverage row — the duplication the per-CVE
  // shape produced. Coverage is derived LIVE here (winget match + app/OS
  // classification) rather than read from the stored `wingetRemediable` flag,
  // which is frozen at sync time and over-reports "out of winget scope".
  interface Group {
    tenantId: string;
    software: string;
    publisher: string | null;
    severity: string;
    severityRank: number;
    patchType: "app" | "os";
    match: WingetMatch | null;
    latestVersion: string | null;
    cveIds: string[];
    affectedDeviceCount: number;
    vulnId: string;
  }

  const groups = new Map<string, Group>();
  for (const v of vulns) {
    const key = `${v.tenantId}\u0000${v.software.trim().toLowerCase()}`;
    const isOs = isOsFinding(v.software);
    // App findings get a live winget match; OS findings are out of winget scope
    // by nature (patched via Windows Update), so they carry no package match.
    const overrides = [...(byTenant.get(v.tenantId) ?? []), ...globalOverrides];
    const match: WingetMatch | null = isOs ? null : matchWinget(v.software, entries, overrides);
    const rank = SEVERITY_RANK[v.severity as Severity] ?? 0;

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        tenantId: v.tenantId,
        software: v.software,
        publisher: v.publisher,
        severity: v.severity,
        severityRank: rank,
        patchType: isOs ? "os" : "app",
        match,
        latestVersion: match ? latestByPackageId.get(match.packageId) ?? null : null,
        cveIds: [v.cveId],
        affectedDeviceCount: v.affectedDeviceCount,
        vulnId: v.id,
      });
      continue;
    }
    existing.cveIds.push(v.cveId);
    // A software's exposure ≈ its most-exposed CVE; summing would double-count
    // the same devices across CVEs for one product.
    existing.affectedDeviceCount = Math.max(
      existing.affectedDeviceCount,
      v.affectedDeviceCount,
    );
    // Track the highest-severity finding as the group's severity + the vuln a
    // "Run now" action should seed from.
    if (rank > existing.severityRank) {
      existing.severity = v.severity;
      existing.severityRank = rank;
      existing.vulnId = v.id;
    }
  }

  // An excluded device stops contributing to coverage exposure exactly as it
  // stops contributing on Vulnerabilities. A group whose entire exposure was
  // excluded drops out — there is nothing left for the catalog to cover.
  const surviving = excluded.isEmpty
    ? [...groups.values()]
    : [...groups.values()].flatMap((g) => {
        const gone = excludedExposure.get(excludedExposureKey(g.tenantId, g.software))?.size ?? 0;
        if (gone === 0) return [g];
        const affectedDeviceCount = Math.max(0, g.affectedDeviceCount - gone);
        if (g.affectedDeviceCount > 0 && affectedDeviceCount === 0) return [];
        return [{ ...g, affectedDeviceCount }];
      });

  const rows: CoverageRow[] = surviving
    .sort(
      (a, b) =>
        b.severityRank - a.severityRank ||
        b.affectedDeviceCount - a.affectedDeviceCount ||
        a.software.localeCompare(b.software),
    )
    .map((g) => {
      const applicable = g.patchType === "app";
      const status: "covered" | "not-supported" | "os" = !applicable
        ? "os"
        : g.match
          ? "covered"
          : "not-supported";
      // For not-supported apps (winget has no package), surface the alternate
      // repos PatchPilot can still drive the fix through (Chocolatey / Store).
      // Chocolatey is live-matched against the mirrored catalog; Store stays a
      // curated fixture (no live Store index exists).
      const altSources =
        status === "not-supported" ? resolveAltSources(chocolateyMatcher, g.tenantId, g.software) : [];
      return {
        tenantId: g.tenantId,
        software: g.software,
        displayName: resolveDisplaySoftwareName(g.software),
        publisher: g.publisher,
        severity: g.severity as Severity,
        patchType: g.patchType,
        applicable,
        status,
        match: g.match,
        latestVersion: g.latestVersion,
        altSources,
        cveCount: g.cveIds.length,
        cveIds: g.cveIds,
        affectedDeviceCount: g.affectedDeviceCount,
        vulnId: g.vulnId,
      };
    });

  const appRows = rows.filter((r) => r.applicable);
  const covered = appRows.filter((r) => r.match).length;

  return {
    tenantId: tenantId ?? null,
    // Total distinct findings (CVEs) considered, for "X findings across Y apps".
    // Summed from the surviving rows rather than `vulns.length` so a group that
    // dropped out as fully-excluded takes its CVEs with it; with no exclusions
    // the two are identical (every finding contributes exactly one cveId).
    findingCount: rows.reduce((n, r) => n + r.cveCount, 0),
    // Below are software-group counts (the table is grouped, so are the KPIs).
    total: rows.length,
    applicable: appRows.length,
    covered,
    uncovered: appRows.length - covered,
    os: rows.length - appRows.length,
    rows,
  };
}
