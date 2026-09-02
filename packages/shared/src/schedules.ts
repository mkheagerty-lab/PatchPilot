/**
 * Recurring-schedule targeting (Phase 5, Workstream C2b).
 *
 * A recurring schedule fans out into one remediation job per matching
 * (device, vuln). Which vulnerabilities it sweeps is decided entirely by the
 * schedule's `target` descriptor. That decision is security-relevant — a wrong
 * filter remediates the wrong CVEs on someone's fleet at 2am — so it lives here
 * as a pure, unit-tested function shared by the worker fan-out, rather than
 * inline in the DB loop.
 *
 * The two facets AND together, and both are optional: an empty target matches
 * every open finding.
 */
import { Severity, SEVERITY_ORDER } from "./sla.js";
import type { PackageSource } from "./sources.js";

/** The `target` jsonb a schedule filters the tenant's open vulnerabilities by. */
export interface ScheduleTarget {
  /**
   * Minimum severity, treated as a *floor* (critical > high > medium > low). A
   * value that isn't a known severity is treated as no floor, so a malformed
   * target never silently drops findings it can't rank.
   */
  severity?: string;
  /** Restrict to app fixes (winget-remediable) or OS updates. */
  patchType?: "app" | "os";
  /**
   * Scope fan-out to a PatchPilot-native device group (see `deviceGroups` in
   * schema.ts) instead of every device in the tenant. Unset means "all
   * devices" — the accepted default. If the referenced group no longer
   * exists, the caller must skip firing rather than silently widening to all
   * devices (see `fanOutSchedule`).
   */
  deviceGroupId?: string;
  /**
   * Devices to leave out of this schedule specifically, additive to (not a
   * replacement for) the tenant-wide `deviceExclusions` list.
   */
  excludedManagedDeviceIds?: string[];
  /**
   * Restrict this schedule to exactly one software title (exact match against
   * `vulnerabilities.software` / `softwareInventory.name` — the same title
   * string every "Fix Now" dispatch and catalog-match lookup already keys on).
   * Set whenever a schedule is created from RunNowModal's Automated tab,
   * which always starts from one specific finding or inventory row — an
   * engineer who hit "Fix Now" on Chrome does not expect a recurring job that
   * later starts patching Firefox too. Unset (the general-purpose
   * Schedules.tsx create form) means "any software," the pre-existing
   * behavior.
   */
  software?: string;
  /**
   * Catalog override for the `software` target above — the same choice
   * RunNowModal's own "Catalog" step offers for a one-off run, carried
   * through to a recurring fire instead of always resolving via the
   * tenant's live auto-match. Unset/null means winget (today's default
   * behavior); `packageId` unset alongside it means "use whatever the
   * auto-match resolves at fire time," not "no package." Only consulted
   * when `software` is set — an unscoped schedule can span many different
   * software titles, so a single package/script override wouldn't mean
   * anything.
   */
  source?: PackageSource | null;
  /** Source-native package id override, paired with `source` (winget package id override when `source` is unset). */
  packageId?: string;
  /**
   * Script Catalog entry id — dispatch that engineer-uploaded script instead
   * of a package. Resolved fresh at fire time (only the id is stored, not
   * the content) so an edited or archived script is respected rather than a
   * stale copy baked in at schedule-creation time. Wins over `source`/
   * `packageId` when set.
   */
  scriptCatalogId?: string;
}

/** The vulnerability facts the target filter reads — a structural subset of a row. */
export interface ScheduleCandidate {
  severity: string;
  wingetRemediable: boolean;
  software: string;
}

/**
 * Severity as a comparable rank: critical=4, high=3, medium=2, low=1, and 0 for
 * anything unrecognised. Mirrors `SEVERITY_ORDER` (most-severe first) so the two
 * can never drift.
 */
function rankOf(severity: string): number {
  const i = SEVERITY_ORDER.indexOf(severity as Severity);
  return i === -1 ? 0 : SEVERITY_ORDER.length - i;
}

/**
 * True if a vulnerability should be swept by a schedule with this `target`.
 * `patchType` maps app→winget-remediable, os→everything else; `severity` is a
 * floor. An empty target matches everything.
 */
export function matchesScheduleTarget(
  vuln: ScheduleCandidate,
  target: ScheduleTarget,
): boolean {
  if (target.patchType === "app" && !vuln.wingetRemediable) return false;
  if (target.patchType === "os" && vuln.wingetRemediable) return false;
  if (target.software && vuln.software !== target.software) return false;
  if (target.severity && rankOf(vuln.severity) < rankOf(target.severity)) {
    return false;
  }
  return true;
}

/**
 * True if a device is in scope for this schedule's device targeting —
 * separate from `matchesScheduleTarget`, which only judges the vulnerability.
 * `groupMemberIds` is the current membership of `target.deviceGroupId`
 * (irrelevant, and safe to omit, when no group is set); when a group *is*
 * set, only its members are in scope. `excludedManagedDeviceIds` is applied
 * on top, additive to the tenant-wide device-exclusions filter the caller
 * applies separately.
 */
export function isDeviceInScheduleScope(
  managedDeviceId: string,
  target: ScheduleTarget,
  groupMemberIds: ReadonlySet<string> | null,
): boolean {
  if (target.deviceGroupId && !groupMemberIds?.has(managedDeviceId)) return false;
  if (target.excludedManagedDeviceIds?.includes(managedDeviceId)) return false;
  return true;
}
