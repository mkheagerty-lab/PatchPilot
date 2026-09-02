/**
 * One tenant's current posture — the findings and devices, filtered exactly the
 * way the pages that display them filter, and nothing else.
 *
 * Both new consumers read from here: `posture/snapshot.ts` (which freezes these
 * numbers into `posture_snapshots` once a day) and `routes/dashboard.ts` (which
 * serves the KPI tiles). That matters because the Dashboard's contract is that
 * clicking "17 critical" lands on a list showing 17 rows — if this file derived
 * its counts independently of /api/vulnerabilities and /api/devices, the tile and
 * the list would drift apart the first time an exception or exclusion was added.
 *
 * So the pipeline below is deliberately the same one, minus only the presentation
 * work the counts don't depend on (winget matching, display names, disk-path
 * evidence, manual-remediation annotations):
 *
 *   findings = tenant vulnerabilities
 *              → exposure recomputed from device_vulnerabilities when the tenant
 *                excludes any device, dropping findings whose entire exposure was
 *                excluded            (data.ts, /api/vulnerabilities)
 *              → rows covered by an active recommendation exception removed
 *                                    (loadActiveExceptions + isExcepted)
 *   devices  = tenant devices
 *              → excluded devices removed          (loadExcludedDeviceIndex)
 *              → vulnerabilityCount/compliance recomputed post-exception
 *                                    (adjustForExceptions, shared with /api/devices)
 *
 * Always tenant-scoped. Exceptions are tenant-scoped and unresolvable without a
 * tenantId, which is why /api/vulnerabilities and /api/recommendations skip
 * exception filtering in all-tenants mode; the all-tenants Dashboard gets its
 * numbers by running this per tenant and summing, so it stays exception-aware
 * where those list pages can't be.
 */
import { eq } from "drizzle-orm";
import {
  db,
  tables,
  demoDevices,
  demoDeviceVulnerabilities,
  demoVulnerabilities,
  demoRecommendations,
  type DeviceRow,
  type VulnerabilityRow,
} from "@patchpilot/db";
import {
  computeSla,
  slaTone,
  type Severity,
  type SlaStatus,
  type SlaThresholds,
  type SlaTone,
} from "@patchpilot/shared";
import { config } from "../config.js";
import { loadExcludedDeviceIndex, type ExcludedDeviceIndex } from "../routes/device-exclusions.js";
import { loadActiveExceptions, isExcepted } from "../routes/recommendations.js";
import { adjustForExceptions, relatedRecommendationIdFor } from "../routes/data.js";
import { exposureByFinding, findingKey } from "./exposure.js";

/** A finding that survived exclusion and exception filtering, with its SLA clock. */
export interface PostureFinding {
  /** The underlying vulnerability row's id — lets a caller (e.g. the Dashboard's
   * "urgent vulns" table) locate the full record for a detail drawer without
   * this file having to carry any other presentation fields. */
  id: string;
  cveId: string;
  title: string;
  software: string;
  severity: Severity;
  detectedAt: Date;
  /** Live count of exposed, non-excluded devices. */
  affectedDeviceCount: number;
  /** Whether Defender has confirmed active exploitation for this CVE. */
  exploitVerified: boolean;
  sla: SlaStatus;
  tone: SlaTone;
}

/** A device that survived exclusion filtering, with post-exception counts. */
export type PostureDevice = DeviceRow;

export interface TenantPosture {
  tenantId: string;
  /** The thresholds these SLA clocks were computed against — frozen into snapshots. */
  thresholds: SlaThresholds;
  findings: PostureFinding[];
  devices: PostureDevice[];
  /** How many findings the exception filter removed — surfaced as a tile, not inferred. */
  exceptedFindings: number;
  /** How many devices the exclusion filter removed. */
  excludedDevices: number;
}

async function loadVulnerabilities(tenantId: string): Promise<VulnerabilityRow[]> {
  if (config.DEMO_MODE) return demoVulnerabilities.filter((v) => v.tenantId === tenantId);
  return db.select().from(tables.vulnerabilities).where(eq(tables.vulnerabilities.tenantId, tenantId));
}

async function loadDevices(tenantId: string): Promise<DeviceRow[]> {
  if (config.DEMO_MODE) return demoDevices.filter((d) => d.tenantId === tenantId);
  return db.select().from(tables.devices).where(eq(tables.devices.tenantId, tenantId));
}

async function loadRecommendations(tenantId: string): Promise<typeof demoRecommendations> {
  if (config.DEMO_MODE) return demoRecommendations.filter((r) => r.tenantId === tenantId);
  return db.select().from(tables.recommendations).where(eq(tables.recommendations.tenantId, tenantId));
}

async function loadLinks(tenantId: string): Promise<typeof demoDeviceVulnerabilities> {
  if (config.DEMO_MODE) return demoDeviceVulnerabilities.filter((dv) => dv.tenantId === tenantId);
  return db
    .select()
    .from(tables.deviceVulnerabilities)
    .where(eq(tables.deviceVulnerabilities.tenantId, tenantId));
}

/**
 * Live exposure per finding, or null when the tenant excludes nothing.
 *
 * Null is not "zero exclusions so the answer is the same" — it means *don't
 * recompute at all*. `device_vulnerabilities` is sparser than Defender's own
 * `affectedDeviceCount` for tenants on the lighter machinesVulnerabilities
 * fallback, so recomputing unconditionally would silently drop real findings.
 * /api/vulnerabilities guards it the same way, and the two must agree.
 */
async function liveExposure(
  tenantId: string,
  excluded: ExcludedDeviceIndex,
): Promise<Map<string, number> | null> {
  if (excluded.isEmpty) return null;
  const all = await loadLinks(tenantId);
  const rows = all.filter((r) => !excluded.byMachineId.has(r.defenderMachineId));
  return exposureByFinding(rows);
}

/**
 * Load one tenant's post-filter posture.
 *
 * `now` is threaded through rather than read from the clock inside, so a caller
 * capturing several tenants in one cycle dates every SLA clock identically —
 * otherwise two tenants snapshotted either side of midnight could land on
 * different days with different "days remaining" on the same finding.
 */
export async function loadTenantPosture(
  tenantId: string,
  thresholds: SlaThresholds,
  now: Date = new Date(),
): Promise<TenantPosture> {
  const excluded = await loadExcludedDeviceIndex(tenantId);
  const activeExceptions = await loadActiveExceptions(tenantId);

  const [vulnRows, deviceRows, recRows, exposure] = await Promise.all([
    loadVulnerabilities(tenantId),
    loadDevices(tenantId),
    loadRecommendations(tenantId),
    liveExposure(tenantId, excluded),
  ]);

  let exceptedFindings = 0;
  const findings: PostureFinding[] = [];
  for (const v of vulnRows) {
    const affectedDeviceCount = exposure
      ? (exposure.get(findingKey(v.cveId, v.software)) ?? 0)
      : v.affectedDeviceCount;
    // Every exposed device excluded ⇒ the finding is gone from the list page too.
    if (exposure && affectedDeviceCount === 0) continue;

    const relatedRecommendationId = relatedRecommendationIdFor(tenantId, v.software, recRows);
    if (
      isExcepted(activeExceptions, null, {
        cveId: v.cveId,
        recommendationIds: relatedRecommendationId ? [relatedRecommendationId] : [],
      })
    ) {
      exceptedFindings += 1;
      continue;
    }

    const sla = computeSla(v.severity as Severity, v.detectedAt, thresholds, now, v.exploitVerified);
    findings.push({
      id: v.id,
      cveId: v.cveId,
      title: v.title,
      software: v.software,
      severity: v.severity as Severity,
      detectedAt: v.detectedAt,
      affectedDeviceCount,
      exploitVerified: v.exploitVerified,
      sla,
      tone: slaTone(sla),
    });
  }

  const visibleDevices = excluded.isEmpty
    ? deviceRows
    : deviceRows.filter((d) => {
        const e = excluded.byManagedDeviceId.get(d.managedDeviceId);
        return !(e && e.tenantId === d.tenantId);
      });
  const devices = await adjustForExceptions(tenantId, visibleDevices);

  return {
    tenantId,
    thresholds,
    findings,
    devices,
    exceptedFindings,
    excludedDevices: deviceRows.length - visibleDevices.length,
  };
}

/** Findings per severity — always all four keys, so a zero renders as 0, not a gap. */
export function severityCounts(findings: readonly PostureFinding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/** Findings per SLA state — the same three buckets the SLA filter chips use. */
export function slaCounts(findings: readonly PostureFinding[]): Record<SlaTone, number> {
  const counts: Record<SlaTone, number> = { breached: 0, "due-soon": 0, ok: 0 };
  for (const f of findings) counts[f.tone] += 1;
  return counts;
}

/** Devices per compliance state — all three keys, same reason as above. */
export function complianceCounts(
  devices: readonly PostureDevice[],
): Record<"compliant" | "noncompliant" | "unknown", number> {
  const counts = { compliant: 0, noncompliant: 0, unknown: 0 };
  for (const d of devices) counts[d.compliance] += 1;
  return counts;
}
