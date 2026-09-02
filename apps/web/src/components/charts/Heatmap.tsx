import { Fragment } from "react";
import { CHART_NEUTRALS } from "../../lib/palette";

export interface HeatmapRow {
  key: string;
  label: string;
}

export interface HeatmapColumn {
  key: string;
  label: string;
  /** Hex fill for this column's cells — intensity scales with value. */
  color: string;
}

function alphaHex(intensity: number): string {
  return Math.round(intensity * 255)
    .toString(16)
    .padStart(2, "0");
}

/**
 * Row x column grid, cell shade = column color at an opacity proportional to
 * that cell's value (relative to the grid's max) — no Recharts primitive for
 * this, so it's plain CSS grid rather than SVG. Column color carries the
 * "what kind of cell is this" signal (e.g. SLA urgency); opacity carries
 * magnitude, so a light cell always means "few" regardless of column.
 */
export function Heatmap({
  rows,
  columns,
  getValue,
  formatTitle,
  onSelect,
}: {
  rows: HeatmapRow[];
  columns: HeatmapColumn[];
  getValue: (rowKey: string, colKey: string) => number;
  formatTitle?: (rowKey: string, colKey: string, value: number) => string;
  onSelect?: (rowKey: string, colKey: string) => void;
}) {
  const max = Math.max(1, ...rows.flatMap((r) => columns.map((c) => getValue(r.key, c.key))));

  return (
    <div
      className="grid h-full gap-1"
      style={{ gridTemplateColumns: `minmax(72px, max-content) repeat(${columns.length}, 1fr)` }}
    >
      <div />
      {columns.map((c) => (
        <div
          key={c.key}
          className="flex items-end justify-center pb-1 text-center text-[11px] font-medium text-slate-500"
        >
          {c.label}
        </div>
      ))}
      {rows.map((r) => (
        <Fragment key={r.key}>
          <div className="flex items-center justify-end pr-2 text-[11px] font-medium text-slate-500">
            {r.label}
          </div>
          {columns.map((c) => {
            const value = getValue(r.key, c.key);
            const intensity = value === 0 ? 0 : 0.16 + 0.74 * (value / max);
            const title = formatTitle?.(r.key, c.key, value) ?? `${r.label} · ${c.label}: ${value}`;
            const className = `flex min-h-[32px] items-center justify-center rounded text-xs font-semibold tabular-nums transition-transform ${
              onSelect ? "cursor-pointer hover:scale-[1.04]" : ""
            } ${value === 0 ? "text-slate-400" : "text-slate-900"}`;
            const style = {
              backgroundColor: value === 0 ? CHART_NEUTRALS.cursor : `${c.color}${alphaHex(intensity)}`,
            };
            return onSelect ? (
              <button
                key={c.key}
                type="button"
                title={title}
                onClick={() => onSelect(r.key, c.key)}
                className={className}
                style={style}
              >
                {value}
              </button>
            ) : (
              <div key={c.key} title={title} className={className} style={style}>
                {value}
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
