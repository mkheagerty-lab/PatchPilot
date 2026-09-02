// The shell every chart sits in. Every chart component renders straight into
// `children` with no loading/empty branching of its own — ChartCard owns all
// of that so no chart has to reimplement a spinner.
//
// Conventions every chart in this app follows (enforced here, not repeated
// per-chart):
// - Always wrap the chart in `<ResponsiveContainer width="100%" height="100%">`
//   inside a fixed-height parent. Recharts collapses to 0 height inside an
//   auto-height flex parent — that's what `height` below guarantees against.
// - `<CartesianGrid strokeDasharray="3 3" stroke={CHART_NEUTRALS.grid} vertical={false} />`
//   on every cartesian chart.
// - Axes: `axisLine={false} tickLine={false} tick={{ fill: CHART_NEUTRALS.axis, fontSize: 11 }}`.
// - Never Recharts' default `<Legend>` — always a custom `<ul>`/`<button>`
//   legend (passed as the `legend` prop here) so entries can carry hrefs and
//   stay keyboard-focusable, which raw SVG segments/bars are not.
// - `accessibilityLayer` on every cartesian chart.
// - Always a custom `<Tooltip content={<ChartTooltip />} />`, never the
//   built-in tooltip — it looks visually foreign to the rest of the app.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Card } from "../ui";

export function ChartCard({
  title,
  subtitle,
  to,
  actions,
  height = 240,
  isLoading = false,
  isEmpty = false,
  emptyNote = "No data yet.",
  notice,
  legend,
  children,
}: {
  title: string;
  subtitle?: string;
  /** When set, renders a "View all →" link in the header. */
  to?: string;
  /** Extra header controls, e.g. a lens-toggle segmented control. */
  actions?: ReactNode;
  /** Fixed pixel height of the chart's plot area. */
  height?: number;
  isLoading?: boolean;
  isEmpty?: boolean;
  emptyNote?: string;
  /** Dashed banner rendered above the chart, e.g. a sparse-trend warning. */
  notice?: ReactNode;
  legend?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="p-0">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {actions}
          {to && (
            <Link
              to={to}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
            >
              View all →
            </Link>
          )}
        </div>
      </div>
      <div className="px-5 py-4">
        {notice && (
          <div className="mb-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-500">
            {notice}
          </div>
        )}
        {isLoading ? (
          <div
            style={{ height }}
            className="flex items-center justify-center text-xs text-slate-400"
          >
            Loading…
          </div>
        ) : isEmpty ? (
          <div
            style={{ height }}
            className="flex items-center justify-center text-xs text-slate-400"
          >
            {emptyNote}
          </div>
        ) : (
          <div style={{ height }}>{children}</div>
        )}
        {legend && !isLoading && !isEmpty && <div className="mt-3">{legend}</div>}
      </div>
    </Card>
  );
}
