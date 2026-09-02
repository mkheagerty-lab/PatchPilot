import { useNavigate } from "react-router-dom";
import { ChartCard } from "../../components/charts/ChartCard";
import { Heatmap, type HeatmapColumn } from "../../components/charts/Heatmap";
import { SEVERITY_TOKENS, SLA_TOKENS } from "../../lib/palette";
import type { DashboardSlaBucket, Severity, SlaBucketName } from "../../lib/api";
import type { SlaTone } from "@patchpilot/shared";
import { toSlaSeverity } from "./links";

const ROWS = (["critical", "high", "medium", "low"] as const).map((k) => ({
  key: k,
  label: SEVERITY_TOKENS[k].label,
}));

const BUCKET_LABELS: Record<SlaBucketName, string> = {
  breached: "Breached",
  "0-3d": "0-3 days",
  "4-7d": "4-7 days",
  "8-14d": "8-14 days",
  "15-30d": "15-30 days",
  "30d+": "30+ days",
};

// Same 3-tone urgency the rest of the dashboard uses (slaTone/DUE_SOON_DAYS)
// for navigation — "0-3d" is the bucket that lines up with "due soon".
const BUCKET_TONE: Record<SlaBucketName, SlaTone> = {
  breached: "breached",
  "0-3d": "due-soon",
  "4-7d": "ok",
  "8-14d": "ok",
  "15-30d": "ok",
  "30d+": "ok",
};

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `#${[mix(ar, br), mix(ag, bg), mix(ab, bb)]
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
}

// Column colour is a gradient across the same rose→amber→emerald hues
// SLA_TOKENS uses everywhere else, not just the 3 discrete tones — otherwise
// 4-7d/8-14d/15-30d/30d+ all render as identical "ok" green and the heatmap
// loses the urgency gradient it's supposed to show. "breached" and "0-3d"
// stay pinned to the exact SLA_TOKENS hex so they still match the SlaChip /
// KpiRow colours pixel-for-pixel; the remaining buckets fade from due-soon
// amber to ok emerald.
const AMBER = SLA_TOKENS["due-soon"].fill;
const EMERALD = SLA_TOKENS.ok.fill;

const BUCKET_COLOR: Record<SlaBucketName, string> = {
  breached: SLA_TOKENS.breached.fill,
  "0-3d": AMBER,
  "4-7d": lerpHex(AMBER, EMERALD, 1 / 4),
  "8-14d": lerpHex(AMBER, EMERALD, 2 / 4),
  "15-30d": lerpHex(AMBER, EMERALD, 3 / 4),
  "30d+": EMERALD,
};

const COLUMNS: HeatmapColumn[] = (
  ["breached", "0-3d", "4-7d", "8-14d", "15-30d", "30d+"] as const
).map((bucket) => ({
  key: bucket,
  label: BUCKET_LABELS[bucket],
  color: BUCKET_COLOR[bucket],
}));

export function SlaComplianceCard({
  slaBuckets,
  isLoading,
}: {
  slaBuckets: DashboardSlaBucket[];
  isLoading: boolean;
}) {
  const nav = useNavigate();
  const total = slaBuckets.reduce((n, b) => n + b.total, 0);
  const byBucket = new Map(slaBuckets.map((b) => [b.bucket, b]));

  return (
    <ChartCard
      title="SLA Compliance"
      subtitle="Open findings by severity and time-to-deadline"
      height={240}
      isLoading={isLoading}
      isEmpty={total === 0}
      emptyNote="No open findings."
    >
      <Heatmap
        rows={ROWS}
        columns={COLUMNS}
        getValue={(rowKey, colKey) => byBucket.get(colKey as SlaBucketName)?.[rowKey as Severity] ?? 0}
        onSelect={(rowKey, colKey) =>
          nav(toSlaSeverity(BUCKET_TONE[colKey as SlaBucketName], rowKey as Severity))
        }
      />
    </ChartCard>
  );
}
