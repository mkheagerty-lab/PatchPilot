import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_NEUTRALS } from "../../lib/palette";
import { ChartTooltip } from "./ChartTooltip";

export interface TrendAreaSeries {
  key: string;
  label: string;
  color: string;
}

/**
 * Stacked posture trend over time. `sparse` switches every `<Area>` to a
 * visible `dot` — with only 1-2 captured days a hairline stack is otherwise
 * invisible. Never interpolate/gap-fill: `data` is exactly what the caller
 * captured, day by day.
 */
export function TrendAreaChart<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  sparse = false,
}: {
  data: T[];
  xKey: keyof T & string;
  series: TrendAreaSeries[];
  sparse?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} accessibilityLayer>
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
        <Tooltip content={<ChartTooltip />} cursor={{ stroke: CHART_NEUTRALS.grid }} />
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stackId="1"
            stroke={s.color}
            fill={s.color}
            fillOpacity={0.25}
            dot={sparse ? { r: 3 } : false}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
