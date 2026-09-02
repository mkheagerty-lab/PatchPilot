/**
 * The hex half of the product's colour vocabulary.
 *
 * This used to live entirely in `apps/web/src/lib/palette.ts` — see that file's
 * header for why severity/SLA/compliance colours are centralised at all (they
 * had drifted into four copies before it existed). The hexes moved here when
 * report PDFs started needing them: `apps/worker` writes SVG charts into a
 * printed document and cannot import from `apps/web`, so a chart in a customer
 * PDF would otherwise be a fifth copy — and the one nobody would notice drifting,
 * because it's only visible after a download.
 *
 * What deliberately did NOT move: the Tailwind `chip`/`dot` class strings. The
 * Tailwind 4 scanner only walks `apps/web`, so a class name written in this
 * package emits no CSS at all. `apps/web/src/lib/palette.ts` still owns those
 * and composes them with the tokens below, keeping its "two representations,
 * two consumers" contract intact — it just no longer decides the hex.
 */
import type { DeviceCompliance, Severity, SlaTone } from "./sla.js";

export interface ChartColor {
  /** Human label for legends, axis ticks and tooltips. */
  label: string;
  /** Solid areas, bars, donut segments. */
  fill: string;
  /** One step darker than `fill` — lines and outlines. */
  stroke: string;
}

/** critical rose · high orange · medium amber · low slate. */
export const SEVERITY_COLORS: Record<Severity, ChartColor> = {
  critical: { label: "Critical", fill: "#f43f5e", stroke: "#e11d48" },
  high: { label: "High", fill: "#f97316", stroke: "#ea580c" },
  medium: { label: "Medium", fill: "#f59e0b", stroke: "#d97706" },
  low: { label: "Low", fill: "#94a3b8", stroke: "#64748b" },
};

/** breached rose · due-soon amber · ok emerald. */
export const SLA_COLORS: Record<SlaTone, ChartColor> = {
  breached: { label: "Breached", fill: "#f43f5e", stroke: "#e11d48" },
  "due-soon": { label: "Due soon", fill: "#f59e0b", stroke: "#d97706" },
  ok: { label: "Within SLA", fill: "#10b981", stroke: "#059669" },
};

/** Compliance here is SLA-derived, not Intune state — see `deviceSlaCompliance`. */
export const COMPLIANCE_COLORS: Record<DeviceCompliance, ChartColor> = {
  compliant: { label: "Compliant", fill: "#10b981", stroke: "#059669" },
  noncompliant: { label: "Non-compliant", fill: "#f43f5e", stroke: "#e11d48" },
  unknown: { label: "Unmonitored", fill: "#cbd5e1", stroke: "#94a3b8" },
};

export type CoverageKey = "covered" | "uncovered" | "os";

/**
 * Catalog coverage. Uses indigo (the brand/active colour) for "covered" rather
 * than emerald, so this donut doesn't read as a compliance verdict — coverage
 * is about whether a remediation package exists, not whether posture is good.
 */
export const COVERAGE_COLORS: Record<CoverageKey, ChartColor> = {
  covered: { label: "Covered", fill: "#6366f1", stroke: "#4f46e5" },
  uncovered: { label: "Not supported", fill: "#f59e0b", stroke: "#d97706" },
  os: { label: "OS update", fill: "#94a3b8", stroke: "#64748b" },
};

/**
 * Neutral chart chrome — axes, grid, labels. Tailwind slate hexes, since both
 * consumers (Recharts on screen, hand-written SVG in the PDF) set these as SVG
 * attributes and can't take a class.
 */
export const CHART_NEUTRALS = {
  grid: "#e2e8f0", // slate-200
  axis: "#94a3b8", // slate-400
  label: "#64748b", // slate-500
  strong: "#0f172a", // slate-900
  /** Hover band behind the active category. */
  cursor: "#f1f5f9", // slate-100
} as const;
