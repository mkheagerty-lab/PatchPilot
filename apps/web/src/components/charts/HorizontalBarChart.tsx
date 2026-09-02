import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_NEUTRALS } from "../../lib/palette";
import { ChartTooltip } from "./ChartTooltip";

export interface HorizontalBarDatum {
  key: string;
  label: string;
  value: number;
  fill: string;
  href?: string;
}

/** Top-software / top-N bars, one colour per row (e.g. worst severity). */
export function HorizontalBarChart({
  data,
  onSelect,
}: {
  data: HorizontalBarDatum[];
  onSelect?: (datum: HorizontalBarDatum) => void;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" accessibilityLayer margin={{ left: 8, right: 12 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_NEUTRALS.grid} horizontal={false} />
        <XAxis
          type="number"
          axisLine={false}
          tickLine={false}
          tick={{ fill: CHART_NEUTRALS.axis, fontSize: 11 }}
          allowDecimals={false}
        />
        <YAxis
          dataKey="label"
          type="category"
          width={150}
          axisLine={false}
          tickLine={false}
          tick={{ fill: CHART_NEUTRALS.label, fontSize: 11 }}
        />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: CHART_NEUTRALS.cursor }} />
        <Bar
          dataKey="value"
          name="Affected devices"
          radius={[0, 4, 4, 0]}
          cursor={onSelect ? "pointer" : undefined}
          onClick={(_, index) => {
            const d = data[index];
            if (d) onSelect?.(d);
          }}
        >
          {data.map((d) => (
            <Cell key={d.key} fill={d.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
