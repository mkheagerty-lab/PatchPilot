// One custom tooltip `content` for every chart in the app, styled to match
// the existing popover pattern (see ui.tsx's ManualRemediationTag popover:
// `rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-lg`).
// Recharts' built-in tooltip is never used — it looks visually foreign here.
//
// Props are intentionally a loose local shape rather than Recharts'
// `TooltipContentProps` — Recharts only exports `NameType`/`ValueType` for
// its `DefaultTooltipContent`'s generic params under other names
// (`TooltipValueType`, and `NameType` isn't re-exported at all from the
// package root), and Recharts clones `content={<ChartTooltip />}` at render
// time regardless of the props declared here, so all fields are optional.
import type { ReactNode } from "react";

interface ChartTooltipPayloadEntry {
  dataKey?: string | number;
  name?: ReactNode;
  value?: number | string | ReadonlyArray<number | string>;
  color?: string;
  fill?: string;
}

export function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: readonly ChartTooltipPayloadEntry[];
  label?: ReactNode;
}) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-lg">
      {label !== undefined && label !== null && (
        <div className="mb-1.5 font-medium text-slate-900">{label}</div>
      )}
      <ul className="space-y-1">
        {payload.map((entry, i) => (
          <li key={`${String(entry.dataKey ?? i)}`} className="flex items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color ?? entry.fill }}
            />
            <span className="text-slate-500">{entry.name}</span>
            <span className="ml-auto font-medium text-slate-900">{String(entry.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
