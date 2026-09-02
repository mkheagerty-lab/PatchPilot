/**
 * Time-to-remediate: how long a finding stayed exposed, from Defender's first
 * detection to Defender confirming it gone (`remediation_events.detectedAt`
 * → `.remediatedAt`) — the "exposure clock", as opposed to the "work clock"
 * (job dispatch → job finish) that Remediation History reports per row.
 *
 * Pulled out of routes/dashboard.ts so the Dashboard's time-to-remediate card
 * and CVE trend chart, and the Remediation History page's stats endpoint, all
 * aggregate the same rows the same way — same reasoning as posture/findings.ts:
 * if this logic lived twice, the card and the page could silently disagree.
 *
 * Callers are responsible for filtering to `closure = 'cleared'` before
 * calling `summarizeTimeToRemediate` — rows the sync flagged `'reclassified'`
 * (the winget-matcher-correction false positive; see `remediationEvents` in
 * schema.ts and `detectReclassifiedCves` in graph/attribution.ts) were never
 * actually fixed and would inflate every number here.
 */
import { SEVERITY_ORDER, type Severity } from "@patchpilot/shared";

const MS_PER_HOUR = 3_600_000;

export interface TimeToRemediateSeverityBucket {
  count: number;
  avgHours: number | null;
  p90Hours: number | null;
}

export interface TimeToRemediateSummary {
  windowDays: number;
  count: number;
  avgHours: number | null;
  p90Hours: number | null;
  bySeverity: Record<Severity, TimeToRemediateSeverityBucket>;
}

function percentile(sortedAsc: number[], p: number): number {
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(idx, 0)]!;
}

function summarizeHours(hours: number[]): TimeToRemediateSeverityBucket {
  if (hours.length === 0) return { count: 0, avgHours: null, p90Hours: null };
  const sorted = [...hours].sort((a, b) => a - b);
  const avgHours = hours.reduce((sum, h) => sum + h, 0) / hours.length;
  return { count: hours.length, avgHours, p90Hours: percentile(sorted, 90) };
}

/** Pure aggregation — no DB/demo fetch here, so it's unit-testable with
 * fabricated rows. Callers (dashboard's `timeToRemediateBlock`, the
 * remediation-history stats route) do their own fetch + `closure='cleared'`
 * filter and pass the result straight in. */
export function summarizeTimeToRemediate(
  rows: Array<{ severity: Severity; detectedAt: Date; remediatedAt: Date }>,
  windowDays: number,
): TimeToRemediateSummary {
  const hoursBySeverity: Record<Severity, number[]> = { critical: [], high: [], medium: [], low: [] };
  const allHours: number[] = [];
  for (const r of rows) {
    const hours = (r.remediatedAt.getTime() - r.detectedAt.getTime()) / MS_PER_HOUR;
    allHours.push(hours);
    hoursBySeverity[r.severity].push(hours);
  }
  const overall = summarizeHours(allHours);
  const bySeverity = Object.fromEntries(
    SEVERITY_ORDER.map((s) => [s, summarizeHours(hoursBySeverity[s])]),
  ) as Record<Severity, TimeToRemediateSeverityBucket>;
  return { windowDays, count: overall.count, avgHours: overall.avgHours, p90Hours: overall.p90Hours, bySeverity };
}
