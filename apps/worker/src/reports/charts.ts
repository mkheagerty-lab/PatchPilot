/**
 * Hand-written SVG chart generators for the report PDF.
 *
 * Why not Recharts, which already draws every one of these on screen: it is
 * React-only, and its `ResponsiveContainer` sizes itself from a measured DOM
 * node. Server-rendering it produces a chart with width 0 — an empty `<svg>`
 * that throws nothing and looks like a layout bug in the finished PDF — and
 * injecting a UMD bundle into the page would make every chart untestable
 * without a browser. These generators are instead pure `string`-returning
 * functions: no React, no DOM, no deps, and `charts.test.ts` runs them in
 * milliseconds.
 *
 * Every output is a complete, self-contained `<svg viewBox>`:
 *
 * - **Colours are literal attributes**, never classes. The document has no
 *   stylesheet these could resolve against, and Chromium's print pipeline
 *   doesn't inherit page CSS into anything we hand it separately.
 * - **No external references at all** — no `<image href>`, no webfont, no
 *   filter or gradient pulled from elsewhere. `context.route(abort)` in
 *   `browser.ts` would turn any of those into a silently blank region.
 * - **Text is escaped.** Software titles and hostnames come from Graph; a
 *   product literally named `<script>` would otherwise close the `<text>`
 *   element and corrupt the rest of the document.
 * - **An empty state is drawn, not omitted.** A section whose chart vanished
 *   reads as a rendering failure; "No data for this period." reads as a fact.
 *
 * Hexes come from `@patchpilot/shared/palette`, the same source
 * `apps/web/src/lib/palette.ts` reads, so a chart in a customer's PDF cannot
 * drift from the same chart on the Dashboard.
 */
import {
  CHART_NEUTRALS,
  COMPLIANCE_COLORS,
  SEVERITY_COLORS,
  SLA_COLORS,
  escapeHtml,
  SEVERITY_ORDER,
  type ChartColor,
  type ComplianceCountFact,
  type RemediationDayFact,
  type ReportChartId,
  type SeverityCountFact,
  type SlaBucketFact,
  type SlaThresholds,
  type TimeToRemediateFacts,
  type TopSoftwareFact,
  type TrendPointFact,
} from "@patchpilot/shared";

/** Printed above each chart by the template, so the registry can stay data. */
export const CHART_TITLES: Record<ReportChartId, string> = {
  "severity-donut": "Open findings by severity",
  "compliance-donut": "Devices by deadline compliance",
  "sla-buckets": "Deadline burn-down",
  "posture-trend": "Open findings over time",
  "sla-trend": "Deadline status over time",
  "top-software": "Most exposed software",
  "remediation-bars": "Remediation runs, last 14 days",
  "ttr-severity": "Time to remediate by severity",
};

const FONT = '"Liberation Sans","DejaVu Sans","Noto Sans",Arial,sans-serif';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A readable axis ceiling at or above `value`.
 *
 * Always at least 1: every generator divides by this, and a fleet with nothing
 * open would otherwise produce `NaN` coordinates — which render as an `<svg>`
 * that draws nothing at all rather than as an error anyone would notice.
 */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

/** Ticks for a y-axis, including both 0 and `max`. */
function ticks(max: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, i) => (max / count) * i);
}

/** Axis labels are integers when the domain is; hour axes keep one decimal. */
function tickLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Coordinates rounded to hundredths — enough precision for a 2x device scale,
 * and it keeps the document (which is inlined, not linked) readable. */
function n(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "0";
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

interface TextOptions {
  size?: number;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  weight?: 400 | 600 | 700;
  baseline?: "auto" | "middle" | "hanging";
  /** Only ever a rotation for a y-axis title — never caller-supplied text. */
  transform?: string;
}

/** The only way this module emits text. Escaping lives here rather than at the
 * call sites so a new chart cannot forget it. */
export function svgText(x: number, y: number, text: string, options: TextOptions = {}): string {
  const { size = 10, fill = CHART_NEUTRALS.label, anchor = "start", weight = 400, baseline, transform } = options;
  const baselineAttr = baseline ? ` dominant-baseline="${baseline}"` : "";
  const transformAttr = transform ? ` transform="${transform}"` : "";
  return (
    `<text x="${n(x)}" y="${n(y)}" font-family='${FONT}' font-size="${size}" ` +
    `font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${baselineAttr}${transformAttr}>` +
    `${escapeHtml(text)}</text>`
  );
}

/**
 * No `xmlns`. These SVGs are only ever inlined into the report's HTML, where
 * the parser puts `<svg>` into the SVG namespace on its own — and leaving the
 * namespace URI out is what lets `template.test.ts` assert, with no exceptions
 * to carve out, that the whole document contains no `http://` or `https://`
 * outside a `data:` URI. That assertion is the mechanical form of the offline
 * guarantee `context.route(abort)` enforces at run time.
 */
function svg(width: number, height: number, body: string): string {
  return (
    `<svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" ` +
    `preserveAspectRatio="xMinYMin meet">${body}</svg>`
  );
}

/** Drawn instead of a chart, never in place of the whole figure — see header. */
function emptyState(width: number, height: number): string {
  return svg(
    width,
    height,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" fill="none" ` +
      `stroke="${CHART_NEUTRALS.grid}" stroke-dasharray="4 4"/>` +
      svgText(width / 2, height / 2, "No data for this period.", {
        anchor: "middle",
        baseline: "middle",
        size: 11,
      }),
  );
}

function swatch(x: number, y: number, color: string): string {
  return `<rect x="${n(x)}" y="${n(y)}" width="9" height="9" rx="2" fill="${color}"/>`;
}

function percent(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : "0%";
}

// ---------------------------------------------------------------------------
// Donuts
// ---------------------------------------------------------------------------

interface Slice {
  label: string;
  value: number;
  color: ChartColor;
}

const DONUT_W = 400;
const DONUT_H = 190;
const DONUT_CX = 92;
const DONUT_CY = 95;
const DONUT_R = 62;
const DONUT_STROKE = 26;

/**
 * A donut drawn as `stroke-dasharray` arcs on concentric circles rather than as
 * `<path>` arcs.
 *
 * Path arcs need `large-arc-flag` computed per segment, and the degenerate case
 * — one category holding 100% — becomes a zero-length path that draws nothing,
 * i.e. an all-critical estate would print an empty circle. Dash offsets have no
 * such case: a full-circumference dash is just a complete ring. The `rotate(-90)`
 * puts segment zero at twelve o'clock, which is where a reader expects it.
 */
function donut(slices: readonly Slice[], centreLabel: string): string {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return emptyState(DONUT_W, DONUT_H);

  const circumference = 2 * Math.PI * DONUT_R;
  let offset = 0;
  const arcs = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const length = (s.value / total) * circumference;
      const arc =
        `<circle cx="${DONUT_CX}" cy="${DONUT_CY}" r="${DONUT_R}" fill="none" ` +
        `stroke="${s.color.fill}" stroke-width="${DONUT_STROKE}" ` +
        `stroke-dasharray="${n(length)} ${n(circumference - length)}" ` +
        `stroke-dashoffset="${n(-offset)}"/>`;
      offset += length;
      return arc;
    })
    .join("");

  const legend = slices
    .map((s, i) => {
      const y = 26 + i * 22;
      return (
        swatch(200, y - 8, s.color.fill) +
        svgText(216, y, s.label, { size: 11, fill: CHART_NEUTRALS.strong }) +
        svgText(DONUT_W - 46, y, String(s.value), {
          size: 11,
          anchor: "end",
          weight: 600,
          fill: CHART_NEUTRALS.strong,
        }) +
        svgText(DONUT_W - 4, y, percent(s.value, total), { size: 10, anchor: "end" })
      );
    })
    .join("");

  return svg(
    DONUT_W,
    DONUT_H,
    `<g transform="rotate(-90 ${DONUT_CX} ${DONUT_CY})">` +
      `<circle cx="${DONUT_CX}" cy="${DONUT_CY}" r="${DONUT_R}" fill="none" ` +
      `stroke="${CHART_NEUTRALS.grid}" stroke-width="${DONUT_STROKE}"/>${arcs}</g>` +
      svgText(DONUT_CX, DONUT_CY - 2, String(total), {
        size: 24,
        anchor: "middle",
        baseline: "middle",
        weight: 700,
        fill: CHART_NEUTRALS.strong,
      }) +
      svgText(DONUT_CX, DONUT_CY + 18, centreLabel, { size: 10, anchor: "middle", baseline: "middle" }) +
      legend,
  );
}

export function severityDonut(rows: readonly SeverityCountFact[]): string {
  return donut(
    SEVERITY_ORDER.map((severity) => ({
      label: SEVERITY_COLORS[severity].label,
      value: rows.find((r) => r.severity === severity)?.count ?? 0,
      color: SEVERITY_COLORS[severity],
    })),
    "findings",
  );
}

export function complianceDonut(rows: readonly ComplianceCountFact[]): string {
  const order = ["compliant", "noncompliant", "unknown"] as const;
  return donut(
    order.map((compliance) => ({
      label: COMPLIANCE_COLORS[compliance].label,
      value: rows.find((r) => r.compliance === compliance)?.count ?? 0,
      color: COMPLIANCE_COLORS[compliance],
    })),
    "devices",
  );
}

// ---------------------------------------------------------------------------
// SLA burn-down
// ---------------------------------------------------------------------------

const PLOT = { left: 42, right: 12, top: 16, bottom: 34 };

/** Grid, y-axis ticks and the baseline, shared by every cartesian chart here. */
function grid(width: number, height: number, max: number, opts: { label?: string } = {}): string {
  const innerH = height - PLOT.top - PLOT.bottom;
  const lines = ticks(max)
    .map((value) => {
      const y = PLOT.top + innerH - (value / max) * innerH;
      return (
        `<line x1="${PLOT.left}" y1="${n(y)}" x2="${width - PLOT.right}" y2="${n(y)}" ` +
        `stroke="${CHART_NEUTRALS.grid}" stroke-width="1"/>` +
        svgText(PLOT.left - 6, y, tickLabel(value), { anchor: "end", baseline: "middle", size: 9 })
      );
    })
    .join("");
  const labelX = PLOT.left - 34;
  const labelY = PLOT.top + innerH / 2;
  const axisLabel = opts.label
    ? svgText(labelX, labelY, opts.label, {
        anchor: "middle",
        size: 9,
        transform: `rotate(-90 ${n(labelX)} ${n(labelY)})`,
      })
    : "";
  return lines + axisLabel;
}

function legendRow(y: number, entries: readonly { label: string; color: string }[]): string {
  let x = PLOT.left;
  return entries
    .map((entry) => {
      const block = swatch(x, y - 8, entry.color) + svgText(x + 13, y, entry.label, { size: 9 });
      x += 22 + entry.label.length * 5.2;
      return block;
    })
    .join("");
}

/**
 * The six fixed burn-down buckets, each stacked by severity.
 *
 * `bucketFindings` guarantees all six exist even when empty, so the x-axis is
 * stable across reports — a bucket that quietly disappeared in a good month
 * would make two consecutive reports incomparable. The rose baseline under
 * "breached" is what separates "overdue" from "merely soon" at a glance.
 */
export function slaBucketBars(rows: readonly SlaBucketFact[]): string {
  const width = 640;
  const height = 250;
  const total = rows.reduce((sum, r) => sum + r.total, 0);
  if (rows.length === 0 || total === 0) return emptyState(width, height);

  const max = niceMax(Math.max(...rows.map((r) => r.total)));
  const innerW = width - PLOT.left - PLOT.right;
  const innerH = height - PLOT.top - PLOT.bottom;
  const slot = innerW / rows.length;
  const barW = Math.min(48, slot * 0.6);

  const bars = rows
    .map((row, i) => {
      const x = PLOT.left + slot * i + (slot - barW) / 2;
      let y = PLOT.top + innerH;
      const stack = SEVERITY_ORDER.map((severity) => {
        const value = row[severity];
        if (value <= 0) return "";
        const h = (value / max) * innerH;
        y -= h;
        return (
          `<rect x="${n(x)}" y="${n(y)}" width="${n(barW)}" height="${n(h)}" ` +
          `fill="${SEVERITY_COLORS[severity].fill}"/>`
        );
      }).join("");
      const label = svgText(x + barW / 2, PLOT.top + innerH + 14, row.bucket, {
        anchor: "middle",
        size: 9,
      });
      const count =
        row.total > 0
          ? svgText(x + barW / 2, y - 4, String(row.total), {
              anchor: "middle",
              size: 9,
              weight: 600,
              fill: CHART_NEUTRALS.strong,
            })
          : "";
      // The overdue bucket gets a rose underline so it reads as a category of
      // its own, not simply the leftmost column.
      const marker =
        row.bucket === "breached"
          ? `<rect x="${n(x)}" y="${n(PLOT.top + innerH + 1)}" width="${n(barW)}" height="2.5" ` +
            `fill="${SLA_COLORS.breached.fill}"/>`
          : "";
      return stack + count + label + marker;
    })
    .join("");

  return svg(
    width,
    height,
    grid(width, height, max, { label: "Findings" }) +
      bars +
      legendRow(
        height - 6,
        SEVERITY_ORDER.map((s) => ({ label: SEVERITY_COLORS[s].label, color: SEVERITY_COLORS[s].fill })),
      ),
  );
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

export interface TrendSeries {
  key: keyof TrendPointFact;
  label: string;
  color: string;
}

/** Executive plots open findings; Compliance plots the three SLA states. One
 * generator, because they differ only in which keys they read. */
export const POSTURE_TREND_SERIES: readonly TrendSeries[] = [
  { key: "openFindings", label: "Open findings", color: "#4f46e5" },
  { key: "critical", label: "Critical", color: SEVERITY_COLORS.critical.fill },
];

export const SLA_TREND_SERIES: readonly TrendSeries[] = [
  { key: "slaBreached", label: "Overdue", color: SLA_COLORS.breached.fill },
  { key: "slaDueSoon", label: "Due soon", color: SLA_COLORS["due-soon"].fill },
  { key: "slaOk", label: "Within SLA", color: SLA_COLORS.ok.fill },
];

/** "2026-08-14" -> "14 Aug". Formatted here rather than with `toLocaleDateString`
 * because the container has no ICU data beyond `en-US` and a report should read
 * the same wherever it was rendered. */
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return day;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? ""}`.trim();
}

/**
 * A single point cannot describe a direction, so fewer than two renders the
 * empty state rather than a lone dot the reader would try to read a slope into.
 * `trendCoverage` is printed beneath by the template for the same reason.
 */
export function trendLine(
  points: readonly TrendPointFact[],
  series: readonly TrendSeries[] = POSTURE_TREND_SERIES,
): string {
  const width = 640;
  const height = 230;
  if (points.length < 2) return emptyState(width, height);

  const values = points.flatMap((p) => series.map((s) => Number(p[s.key]) || 0));
  const max = niceMax(Math.max(...values));
  const innerW = width - PLOT.left - PLOT.right;
  const innerH = height - PLOT.top - PLOT.bottom;
  const x = (i: number) => PLOT.left + (innerW * i) / (points.length - 1);
  const y = (value: number) => PLOT.top + innerH - (value / max) * innerH;

  const lines = series
    .map((s) => {
      const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${n(x(i))} ${n(y(Number(p[s.key]) || 0))}`).join(" ");
      const dots = points
        .map((p, i) => `<circle cx="${n(x(i))}" cy="${n(y(Number(p[s.key]) || 0))}" r="2" fill="${s.color}"/>`)
        .join("");
      return (
        `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" ` +
        `stroke-linejoin="round" stroke-linecap="round"/>${dots}`
      );
    })
    .join("");

  // At most eight date labels, however long the window — thirty overlapping
  // ticks is worse than none.
  const step = Math.max(1, Math.ceil(points.length / 8));
  const xLabels = points
    .map((p, i) =>
      i % step === 0 || i === points.length - 1
        ? svgText(x(i), PLOT.top + innerH + 14, shortDay(p.day), { anchor: "middle", size: 9 })
        : "",
    )
    .join("");

  return svg(
    width,
    height,
    grid(width, height, max) +
      lines +
      xLabels +
      legendRow(height - 6, series.map((s) => ({ label: s.label, color: s.color }))),
  );
}

// ---------------------------------------------------------------------------
// Top software
// ---------------------------------------------------------------------------

/**
 * Horizontal bars — software titles are long, and a vertical layout would force
 * either rotated labels or truncation down to uselessness.
 */
export function topSoftwareBars(rows: readonly TopSoftwareFact[]): string {
  const width = 640;
  const rowH = 26;
  const capped = rows.slice(0, 8);
  const height = 34 + capped.length * rowH;
  if (capped.length === 0 || capped.every((r) => r.affectedDeviceCount <= 0)) {
    return emptyState(width, 140);
  }

  const labelW = 190;
  const valueW = 44;
  const trackW = width - labelW - valueW - 8;
  const max = niceMax(Math.max(...capped.map((r) => r.affectedDeviceCount)));

  const bars = capped
    .map((row, i) => {
      const y = 8 + i * rowH;
      const w = (row.affectedDeviceCount / max) * trackW;
      const color = SEVERITY_COLORS[row.severity];
      // The value sits inside the bar when it fits and outside when it doesn't;
      // a label printed over a 3px bar is unreadable either way.
      const inside = w > 34;
      const valueX = inside ? labelW + w - 6 : labelW + w + 6;
      return (
        svgText(labelW - 8, y + 12, truncate(row.displayName || row.software, 34), {
          anchor: "end",
          baseline: "middle",
          size: 10,
          fill: CHART_NEUTRALS.strong,
        }) +
        `<rect x="${labelW}" y="${n(y + 3)}" width="${n(trackW)}" height="18" rx="3" fill="${CHART_NEUTRALS.cursor}"/>` +
        `<rect x="${labelW}" y="${n(y + 3)}" width="${n(Math.max(w, 1))}" height="18" rx="3" fill="${color.fill}"/>` +
        svgText(valueX, y + 12, String(row.affectedDeviceCount), {
          anchor: inside ? "end" : "start",
          baseline: "middle",
          size: 10,
          weight: 600,
          fill: inside ? "#ffffff" : CHART_NEUTRALS.strong,
        })
      );
    })
    .join("");

  const used = SEVERITY_ORDER.filter((s) => capped.some((r) => r.severity === s));
  return svg(
    width,
    height,
    bars +
      legendRow(
        height - 6,
        used.map((s) => ({ label: SEVERITY_COLORS[s].label, color: SEVERITY_COLORS[s].fill })),
      ),
  );
}

// ---------------------------------------------------------------------------
// Remediation throughput
// ---------------------------------------------------------------------------

export function remediationBars(days: readonly RemediationDayFact[]): string {
  const width = 640;
  const height = 220;
  if (days.length === 0 || days.every((d) => d.succeeded + d.failed === 0)) {
    return emptyState(width, height);
  }

  const max = niceMax(Math.max(...days.map((d) => d.succeeded + d.failed)));
  const innerW = width - PLOT.left - PLOT.right;
  const innerH = height - PLOT.top - PLOT.bottom;
  const slot = innerW / days.length;
  const barW = Math.min(26, slot * 0.62);

  const bars = days
    .map((day, i) => {
      const x = PLOT.left + slot * i + (slot - barW) / 2;
      const failedH = (day.failed / max) * innerH;
      const okH = (day.succeeded / max) * innerH;
      const base = PLOT.top + innerH;
      return (
        (day.failed > 0
          ? `<rect x="${n(x)}" y="${n(base - failedH)}" width="${n(barW)}" height="${n(failedH)}" fill="${SLA_COLORS.breached.fill}"/>`
          : "") +
        (day.succeeded > 0
          ? `<rect x="${n(x)}" y="${n(base - failedH - okH)}" width="${n(barW)}" height="${n(okH)}" fill="${SLA_COLORS.ok.fill}"/>`
          : "") +
        svgText(x + barW / 2, base + 14, shortDay(day.day), { anchor: "middle", size: 8 })
      );
    })
    .join("");

  return svg(
    width,
    height,
    grid(width, height, max, { label: "Runs" }) +
      bars +
      legendRow(height - 6, [
        { label: "Succeeded", color: SLA_COLORS.ok.fill },
        { label: "Failed", color: SLA_COLORS.breached.fill },
      ]),
  );
}

// ---------------------------------------------------------------------------
// Time to remediate
// ---------------------------------------------------------------------------

/**
 * Average and 90th-percentile hours per severity, with the SLA threshold drawn
 * as a dashed marker.
 *
 * The marker is the whole point of the chart: "38 hours to fix a critical" means
 * nothing on its own, and everything against a 7-day deadline. Thresholds are
 * configured in days and converted here — the only unit conversion in this file,
 * kept next to the thing that needs it.
 */
export function ttrSeverityBars(facts: TimeToRemediateFacts, thresholds: SlaThresholds): string {
  const width = 640;
  const height = 230;
  const present = SEVERITY_ORDER.filter((s) => (facts.bySeverity[s]?.count ?? 0) > 0);
  if (present.length === 0) return emptyState(width, height);

  const measured = present.flatMap((s) => [
    facts.bySeverity[s].avgHours ?? 0,
    facts.bySeverity[s].p90Hours ?? 0,
  ]);
  const thresholdHours = present.map((s) => thresholds[s] * 24);
  const max = niceMax(Math.max(...measured, ...thresholdHours));
  const innerW = width - PLOT.left - PLOT.right;
  const innerH = height - PLOT.top - PLOT.bottom;
  const slot = innerW / present.length;
  const barW = Math.min(34, slot * 0.24);

  const groups = present
    .map((severity, i) => {
      const bucket = facts.bySeverity[severity];
      const centre = PLOT.left + slot * i + slot / 2;
      const base = PLOT.top + innerH;
      const bar = (value: number | null, offset: number, fill: string) => {
        if (value === null) return "";
        const h = (value / max) * innerH;
        const x = centre + offset;
        return (
          `<rect x="${n(x)}" y="${n(base - h)}" width="${n(barW)}" height="${n(h)}" fill="${fill}"/>` +
          svgText(x + barW / 2, base - h - 4, String(Math.round(value)), {
            anchor: "middle",
            size: 8,
            fill: CHART_NEUTRALS.label,
          })
        );
      };
      const color = SEVERITY_COLORS[severity];
      const thresholdY = base - (Math.min(thresholds[severity] * 24, max) / max) * innerH;
      return (
        bar(bucket.avgHours, -barW - 3, color.fill) +
        bar(bucket.p90Hours, 3, color.stroke) +
        `<line x1="${n(centre - slot * 0.34)}" y1="${n(thresholdY)}" x2="${n(centre + slot * 0.34)}" ` +
        `y2="${n(thresholdY)}" stroke="${CHART_NEUTRALS.strong}" stroke-width="1.2" stroke-dasharray="5 3"/>` +
        svgText(centre, base + 14, `${color.label} (n=${bucket.count})`, { anchor: "middle", size: 9 })
      );
    })
    .join("");

  return svg(
    width,
    height,
    grid(width, height, max, { label: "Hours" }) +
      groups +
      legendRow(height - 6, [
        { label: "Average", color: SEVERITY_COLORS.high.fill },
        { label: "90th percentile", color: SEVERITY_COLORS.high.stroke },
        { label: "SLA deadline", color: CHART_NEUTRALS.strong },
      ]),
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * The facts a chart might read, as the template sees them.
 *
 * Deliberately a structural bag of optionals rather than `AnyReportFacts`: the
 * two fact shapes overlap but neither is a superset, and the registry already
 * decides which charts a type asks for. A chart whose facts aren't present
 * returns `null` and the template omits the whole figure — better than an empty
 * frame captioned "Most exposed software" on a compliance report.
 */
export interface ChartFacts {
  thresholds?: SlaThresholds;
  severity?: readonly SeverityCountFact[];
  complianceCounts?: readonly ComplianceCountFact[];
  slaBuckets?: readonly SlaBucketFact[];
  topSoftware?: readonly TopSoftwareFact[];
  trend?: readonly TrendPointFact[];
  remediation?: { days: readonly RemediationDayFact[] };
  timeToRemediate?: TimeToRemediateFacts;
}

export function renderChart(id: ReportChartId, facts: ChartFacts): string | null {
  switch (id) {
    case "severity-donut":
      return facts.severity ? severityDonut(facts.severity) : null;
    case "compliance-donut":
      return facts.complianceCounts ? complianceDonut(facts.complianceCounts) : null;
    case "sla-buckets":
      return facts.slaBuckets ? slaBucketBars(facts.slaBuckets) : null;
    case "posture-trend":
      return facts.trend ? trendLine(facts.trend, POSTURE_TREND_SERIES) : null;
    case "sla-trend":
      return facts.trend ? trendLine(facts.trend, SLA_TREND_SERIES) : null;
    case "top-software":
      return facts.topSoftware ? topSoftwareBars(facts.topSoftware) : null;
    case "remediation-bars":
      return facts.remediation ? remediationBars(facts.remediation.days) : null;
    case "ttr-severity":
      return facts.timeToRemediate && facts.thresholds
        ? ttrSeverityBars(facts.timeToRemediate, facts.thresholds)
        : null;
    default: {
      // Exhaustiveness: a new REPORT_CHART_IDS entry is a compile error here
      // rather than a silently missing figure.
      const never: never = id;
      return never;
    }
  }
}
