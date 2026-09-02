// The one place a severity / SLA / compliance / job-status / coverage colour is
// decided *for the web app*.
//
// Two representations per token, because they have two consumers that cannot
// share one. Chips need Tailwind utility classes, and those must appear as
// complete literal strings for the Tailwind scanner to emit them — a computed
// `bg-${colour}-100` produces no CSS. Charts need hex, because Recharts writes
// SVG `fill`/`stroke` attributes and cannot read a class.
//
// Keeping both adjacent in one record is the point: severity colours had
// already drifted into four separate copies (ui.tsx, cve.tsx, Catalog.tsx,
// ChocolateyCatalog.tsx) before this file existed.
//
// The hex half now comes from `@patchpilot/shared`'s palette, because
// `apps/worker` renders the same charts as SVG into report PDFs and can't
// import from `apps/web`. The Tailwind classes stay here and CANNOT move — the
// Tailwind 4 scanner only walks this app, so a class string written in a
// package emits no CSS.
//
// Deliberately lives in lib/ rather than components/charts/ so ui.tsx can
// import it with no risk of a component import cycle.
import {
  COMPLIANCE_COLORS,
  COVERAGE_COLORS,
  SEVERITY_COLORS,
  SLA_COLORS,
  type ChartColor,
  type CoverageKey,
  type DeviceCompliance,
  type Severity,
  type SlaTone,
} from "@patchpilot/shared";
import type { JobStatus } from "./api";

export { CHART_NEUTRALS } from "@patchpilot/shared";
export type { CoverageKey };

export interface Token extends ChartColor {
  /** Human label for legends and tooltips. */
  label: string;
  /** Tailwind classes for a chip/pill background + text. */
  chip: string;
  /** Chart fill (solid areas, bars, donut segments). */
  fill: string;
  /** Chart stroke — one step darker than `fill`, for lines and outlines. */
  stroke: string;
  /** Tailwind class for a small solid legend/status dot. */
  dot: string;
}

/** Chip + dot classes, keyed the same way as the shared colour record. */
type ClassPair = Pick<Token, "chip" | "dot">;

function withClasses<K extends string>(
  colors: Record<K, ChartColor>,
  classes: Record<K, ClassPair>,
): Record<K, Token> {
  return Object.fromEntries(
    (Object.entries(colors) as [K, ChartColor][]).map(([k, c]) => [k, { ...c, ...classes[k] }]),
  ) as Record<K, Token>;
}

/** critical rose · high orange · medium amber · low slate. */
export const SEVERITY_TOKENS: Record<Severity, Token> = withClasses(SEVERITY_COLORS, {
  critical: { chip: "bg-rose-100 text-rose-700", dot: "bg-rose-500" },
  high: { chip: "bg-orange-100 text-orange-700", dot: "bg-orange-500" },
  medium: { chip: "bg-amber-100 text-amber-700", dot: "bg-amber-500" },
  low: { chip: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
});

/** breached rose · due-soon amber · ok emerald. */
export const SLA_TOKENS: Record<SlaTone, Token> = withClasses(SLA_COLORS, {
  breached: { chip: "bg-rose-100 text-rose-700", dot: "bg-rose-500" },
  "due-soon": { chip: "bg-amber-100 text-amber-700", dot: "bg-amber-500" },
  ok: { chip: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-500" },
});

/** Compliance here is SLA-derived, not Intune state — see ComplianceChip. */
export const COMPLIANCE_TOKENS: Record<DeviceCompliance, Token> = withClasses(COMPLIANCE_COLORS, {
  compliant: { chip: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-500" },
  noncompliant: { chip: "bg-rose-100 text-rose-700", dot: "bg-rose-500" },
  unknown: { chip: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
});

/**
 * Catalog coverage. Uses indigo (the brand/active colour) for "covered" rather
 * than emerald, so this donut doesn't read as a compliance verdict — coverage
 * is about whether a remediation package exists, not whether posture is good.
 */
export const COVERAGE_TOKENS: Record<CoverageKey, Token> = withClasses(COVERAGE_COLORS, {
  covered: { chip: "bg-indigo-100 text-indigo-700", dot: "bg-indigo-500" },
  uncovered: { chip: "bg-amber-100 text-amber-700", dot: "bg-amber-500" },
  os: { chip: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
});

/**
 * Matches the status colours the Jobs page already uses. Stays fully local:
 * `JobStatus` is a web-side type (lib/api) and no report renders job chips.
 */
export const JOB_STATUS_TOKENS: Record<JobStatus, Token> = {
  queued: {
    label: "Queued",
    chip: "bg-slate-100 text-slate-600",
    fill: "#cbd5e1",
    stroke: "#94a3b8",
    dot: "bg-slate-400",
  },
  running: {
    label: "Running",
    chip: "bg-sky-100 text-sky-700",
    fill: "#0ea5e9",
    stroke: "#0284c7",
    dot: "bg-sky-500",
  },
  succeeded: {
    label: "Succeeded",
    chip: "bg-emerald-100 text-emerald-700",
    fill: "#10b981",
    stroke: "#059669",
    dot: "bg-emerald-500",
  },
  failed: {
    label: "Failed",
    chip: "bg-rose-100 text-rose-700",
    fill: "#f43f5e",
    stroke: "#e11d48",
    dot: "bg-rose-500",
  },
};

/** `{ critical: "bg-rose-100 text-rose-700", ... }` for chip components. */
export function chipClasses<K extends string>(
  tokens: Record<K, Token>,
): Record<K, string> {
  return Object.fromEntries(
    (Object.entries(tokens) as [K, Token][]).map(([k, t]) => [k, t.chip]),
  ) as Record<K, string>;
}
