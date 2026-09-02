import { Area, AreaChart, ResponsiveContainer } from "recharts";

/**
 * A single 40×20 trend line for a KPI tile — no axes, grid, or tooltip, just
 * shape. `isAnimationActive={false}` since these render several-per-page and
 * a staggered draw-in reads as jank, not polish.
 */
export function Sparkline({
  data,
  dataKey,
  color,
}: {
  data: Record<string, unknown>[];
  dataKey: string;
  color: string;
}) {
  return (
    <div style={{ width: 40, height: 20 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            fill={color}
            fillOpacity={0.2}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
