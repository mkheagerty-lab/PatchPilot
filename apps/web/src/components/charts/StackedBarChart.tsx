import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_NEUTRALS } from "../../lib/palette";
import { ChartTooltip } from "./ChartTooltip";

export interface StackedBarSeries {
  /** Key read off each row of `data`. */
  key: string;
  label: string;
  fill: string;
}

/** Optional right-axis line — e.g. rolling remediation success rate. */
export interface StackedBarLine {
  key: string;
  label: string;
  color: string;
  /** Right-axis tick/tooltip formatter, e.g. a percentage. */
  formatValue?: (value: number) => string;
}

/**
 * Remediation throughput stacks bars over a category axis. `line` composes
 * an optional right-axis `<Line>` (via ComposedChart)
 * for something like a rolling success rate alongside the stacked counts.
 */
export function StackedBarChart<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  line,
  onSelect,
}: {
  data: T[];
  xKey: keyof T & string;
  series: StackedBarSeries[];
  line?: StackedBarLine;
  onSelect?: (datum: T, seriesKey: string) => void;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} accessibilityLayer>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_NEUTRALS.grid} vertical={false} />
        <XAxis
          dataKey={xKey as string}
          axisLine={false}
          tickLine={false}
          tick={{ fill: CHART_NEUTRALS.axis, fontSize: 11 }}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={{ fill: CHART_NEUTRALS.axis, fontSize: 11 }}
          allowDecimals={false}
        />
        {line && (
          <YAxis
            yAxisId="right"
            orientation="right"
            axisLine={false}
            tickLine={false}
            tick={{ fill: CHART_NEUTRALS.axis, fontSize: 11 }}
            tickFormatter={line.formatValue}
          />
        )}
        <Tooltip content={<ChartTooltip />} cursor={{ fill: CHART_NEUTRALS.cursor }} />
        {series.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stackId="stack"
            fill={s.fill}
            cursor={onSelect ? "pointer" : undefined}
            onClick={(_, index) => {
              const d = data[index];
              if (d) onSelect?.(d, s.key);
            }}
          />
        ))}
        {line && (
          <Line
            yAxisId="right"
            type="monotone"
            dataKey={line.key}
            name={line.label}
            stroke={line.color}
            strokeWidth={2}
            dot={false}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
