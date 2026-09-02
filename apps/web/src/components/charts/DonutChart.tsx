import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartTooltip } from "./ChartTooltip";

export interface DonutDatum {
  key: string;
  label: string;
  value: number;
  fill: string;
  href?: string;
}

/**
 * innerRadius="62%" + paddingAngle so segments read as a ring, not a pie.
 * The `<ul>` of `<button>`s to the right is the accessible/keyboard path —
 * SVG segments in the donut itself aren't focusable.
 */
export function DonutChart({
  data,
  onSelect,
  centerLabel,
  centerValue,
}: {
  data: DonutDatum[];
  onSelect?: (datum: DonutDatum) => void;
  centerLabel?: string;
  centerValue?: string | number;
}) {
  const total = data.reduce((n, d) => n + d.value, 0);

  return (
    <div className="flex h-full items-center gap-4">
      <div className="relative h-full min-w-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart accessibilityLayer>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius="62%"
              outerRadius="100%"
              paddingAngle={2}
              stroke="#fff"
              strokeWidth={2}
              cursor={onSelect ? "pointer" : undefined}
              onClick={(_, index) => {
                const d = data[index];
                if (d) onSelect?.(d);
              }}
            >
              {data.map((d) => (
                <Cell key={d.key} fill={d.fill} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        {(centerLabel || centerValue !== undefined) && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            {centerValue !== undefined && (
              <div className="text-2xl font-semibold text-slate-900">{centerValue}</div>
            )}
            {centerLabel && <div className="text-xs text-slate-500">{centerLabel}</div>}
          </div>
        )}
      </div>
      <ul className="w-36 shrink-0 space-y-1.5 overflow-y-auto self-stretch py-1">
        {data.map((d) => {
          const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
          return (
            <li key={d.key}>
              <button
                type="button"
                onClick={() => onSelect?.(d)}
                disabled={!onSelect}
                className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-slate-50 disabled:hover:bg-transparent"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: d.fill }}
                />
                <span className="truncate text-slate-600">{d.label}</span>
                <span className="ml-auto shrink-0 font-medium text-slate-900">{d.value}</span>
                <span className="w-9 shrink-0 text-right text-slate-400">{pct}%</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
