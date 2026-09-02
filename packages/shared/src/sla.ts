import { z } from "zod";

/** Vulnerability severity, ordered most-to-least urgent. */
export const Severity = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof Severity>;

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

/**
 * Numeric weight for "which of these two severities is worse" comparisons —
 * higher is worse. Sorting and worst-of reductions want a number, not an index
 * into SEVERITY_ORDER that has to be inverted at every call site.
 */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Per-severity SLA thresholds in days, plus a `verifiedExploit` override.
 * Editable in Settings -> Compliance SLA.
 */
export const SlaThresholds = z.object({
  critical: z.number().int().positive(),
  high: z.number().int().positive(),
  medium: z.number().int().positive(),
  low: z.number().int().positive(),
  /**
   * Deadline (days) for a finding where Defender has confirmed active
   * exploitation, applied on top of the severity threshold — see
   * `computeSla`'s `exploitVerified` param.
   */
  verifiedExploit: z.number().int().positive(),
});
export type SlaThresholds = z.infer<typeof SlaThresholds>;

/** Defaults carried over 1:1 from the prototype. */
export const DEFAULT_SLA: SlaThresholds = {
  critical: 7,
  high: 14,
  medium: 30,
  low: 90,
  verifiedExploit: 3,
};

/**
 * Merges a raw settings value with `DEFAULT_SLA` field-by-field rather than
 * casting it, so a settings row saved before a new threshold field existed
 * (e.g. `verifiedExploit`) fills in the default for that field instead of
 * silently producing `undefined` and corrupting downstream `Math.min` calls.
 */
export function normalizeSlaThresholds(value: unknown): SlaThresholds {
  const parsed = SlaThresholds.partial().safeParse(value);
  const partial = parsed.success ? parsed.data : {};
  return { ...DEFAULT_SLA, ...partial };
}

export interface SlaStatus {
  /** Whole days remaining before the SLA is breached (negative when overdue). */
  daysRemaining: number;
  overdue: boolean;
  /** Day the SLA is breached. */
  dueDate: Date;
  severity: Severity;
}

const MS_PER_DAY = 86_400_000;

/**
 * Computes SLA status for a finding, given when it was detected and the
 * configured thresholds. `now` is injectable for deterministic tests.
 *
 * `exploitVerified` tightens (never loosens) the deadline: when true, the
 * allowed window is the stricter of the severity threshold and
 * `thresholds.verifiedExploit`.
 */
export function computeSla(
  severity: Severity,
  detectedAt: Date,
  thresholds: SlaThresholds = DEFAULT_SLA,
  now: Date = new Date(),
  exploitVerified = false,
): SlaStatus {
  const allowedDays = exploitVerified
    ? Math.min(thresholds[severity], thresholds.verifiedExploit)
    : thresholds[severity];
  const dueDate = new Date(detectedAt.getTime() + allowedDays * MS_PER_DAY);
  const daysRemaining = Math.ceil((dueDate.getTime() - now.getTime()) / MS_PER_DAY);
  return {
    daysRemaining,
    overdue: daysRemaining < 0,
    dueDate,
    severity,
  };
}

/** Short label for the SLA chip shown on the Vulnerabilities table. */
export function slaChipLabel(status: SlaStatus): string {
  if (status.overdue) {
    const overdueBy = Math.abs(status.daysRemaining);
    return `Overdue ${overdueBy}d`;
  }
  return `${status.daysRemaining}d left`;
}

/** Days-remaining threshold below which a finding is flagged "due soon". */
export const DUE_SOON_DAYS = 3;

export type SlaTone = "ok" | "due-soon" | "breached";

/**
 * Buckets an SLA clock into the three states the whole product filters on:
 * the `?sla=` URL vocabulary, the SlaChip colours, and the Dashboard's
 * "SLA breached" / "Due soon" tiles.
 *
 * This lives in shared rather than in the web app because the server now
 * computes those tile counts too (`/api/dashboard/summary`). If the threshold
 * existed in two places, a tile would disagree with the very list page it
 * deep-links to — the count and the rows would come from different rules.
 *
 * Takes a structural subset so both the API's `SlaStatus` (dueDate: Date) and
 * the web client's serialised `Sla` (dueDate: string) satisfy it.
 */
export function slaTone(sla: Pick<SlaStatus, "overdue" | "daysRemaining">): SlaTone {
  if (sla.overdue) return "breached";
  if (sla.daysRemaining <= DUE_SOON_DAYS) return "due-soon";
  return "ok";
}

/** Device compliance measured against vulnerability SLAs (not Intune state). */
export type DeviceCompliance = "compliant" | "noncompliant" | "unknown";

/** One open finding on a device: just what's needed to judge its SLA clock. */
export interface DeviceFinding {
  severity: Severity;
  detectedAt: Date;
  exploitVerified?: boolean;
}

/**
 * Whether a device meets its remediation SLAs, replacing the old Intune
 * `complianceState` basis. A device is:
 *  - `unknown`     when `findings` is null — we have no Defender vulnerability
 *                  coverage for it, so SLA compliance is unmeasurable (distinct
 *                  from a covered device that simply has zero findings).
 *  - `noncompliant` when ANY open finding is past its SLA due date.
 *  - `compliant`   when it's covered and no finding is overdue (including the
 *                  clean, zero-findings case).
 *
 * Pure and `now`-injectable to mirror `computeSla`. Note this is evaluated at
 * sync time against the thresholds in force then; unlike the live Vulnerabilities
 * view it does not re-react to later Settings changes until the next sync.
 */
export function deviceSlaCompliance(
  findings: DeviceFinding[] | null,
  thresholds: SlaThresholds = DEFAULT_SLA,
  now: Date = new Date(),
): DeviceCompliance {
  if (findings === null) return "unknown";
  const breached = findings.some(
    (f) => computeSla(f.severity, f.detectedAt, thresholds, now, f.exploitVerified).overdue,
  );
  return breached ? "noncompliant" : "compliant";
}
