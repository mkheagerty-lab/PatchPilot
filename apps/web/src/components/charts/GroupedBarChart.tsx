import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_NEUTRALS } from "../../lib/palette";
import { ChartTooltip } from "./ChartTooltip";

export interface GroupedBarSeries {
  key: string;
  label: string;
  fill: string;
}

/**
 * Side-by-side (not stacked) bars per category — for comparing two counts
 * that aren't parts of a whole, e.g. CVEs detected vs remediated per day.
 * `StackedBarChart` is the wrong tool for this: its bars share `stackId`, so
 * summing unrelated metrics would render a meaningless combined height.
 */
export function GroupedBarChart<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  onSelect,
}: {
  data: T[];
  xKey: keyof T & string;
  series: GroupedBarSeries[];
  onSelect?: (datum: T, seriesKey: string) => void;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} accessibilityLayer>
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
        <Tooltip content={<ChartTooltip />} cursor={{ fill: CHART_NEUTRALS.cursor }} />
        {series.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={s.fill}
            radius={[2, 2, 0, 0]}
            cursor={onSelect ? "pointer" : undefined}
            onClick={(_, index) => {
              const d = data[index];
              if (d) onSelect?.(d, s.key);
            }}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
