import { describe, expect, it } from "vitest";
import {
  complianceDonut,
  niceMax,
  remediationBars,
  renderChart,
  severityDonut,
  slaBucketBars,
  topSoftwareBars,
  trendLine,
  truncate,
  ttrSeverityBars,
  type ChartFacts,
} from "./charts.js";
import type {
  ComplianceCountFact,
  RemediationDayFact,
  SeverityCountFact,
  SlaBucketFact,
  TimeToRemediateFacts,
  TopSoftwareFact,
  TrendPointFact,
} from "@patchpilot/shared";
import { DEFAULT_SLA } from "@patchpilot/shared";

const SEVERITY_ZERO: SeverityCountFact[] = [
  { severity: "critical", count: 0 },
  { severity: "high", count: 0 },
  { severity: "medium", count: 0 },
  { severity: "low", count: 0 },
];

const SEVERITY_SOME: SeverityCountFact[] = [
  { severity: "critical", count: 3 },
  { severity: "high", count: 5 },
  { severity: "medium", count: 0 },
  { severity: "low", count: 1 },
];

const COMPLIANCE_ZERO: ComplianceCountFact[] = [
  { compliance: "compliant", count: 0 },
  { compliance: "noncompliant", count: 0 },
  { compliance: "unknown", count: 0 },
];

const SLA_BUCKETS_ZERO: SlaBucketFact[] = [
  "breached",
  "0-3d",
  "4-7d",
  "8-14d",
  "15-30d",
  "30d+",
].map((bucket) => ({ bucket, critical: 0, high: 0, medium: 0, low: 0, total: 0 }));

const SLA_BUCKETS_SOME: SlaBucketFact[] = SLA_BUCKETS_ZERO.map((b) =>
  b.bucket === "breached" ? { ...b, critical: 2, high: 1, total: 3 } : b,
);

function svgOf(markup: string): { tag: string; attrs: Record<string, string> } {
  const m = /<svg\b([^>]*)>/.exec(markup);
  const openTag = m?.[1];
  if (openTag === undefined) throw new Error("no <svg> found");
  const attrs: Record<string, string> = {};
  for (const attrMatch of openTag.matchAll(/([\w-]+)="([^"]*)"/g)) {
    const [, key, value] = attrMatch;
    if (key !== undefined && value !== undefined) attrs[key] = value;
  }
  return { tag: "svg", attrs };
}

describe("niceMax", () => {
  it("handles the degenerate inputs that would otherwise divide by zero", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(-5)).toBe(1);
    expect(niceMax(NaN)).toBe(1);
  });

  it("rounds up to a readable ceiling", () => {
    expect(niceMax(4321)).toBeGreaterThanOrEqual(4321);
    expect(niceMax(4)).toBe(5);
    expect(niceMax(87)).toBe(100);
  });
});

describe("truncate", () => {
  it("leaves short text alone and ellipsises long text within the budget", () => {
    expect(truncate("short", 10)).toBe("short");
    const long = truncate("a very long software title indeed", 10);
    expect(long.length).toBe(10);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("severityDonut", () => {
  it("emits a valid svg wrapper with one arc per non-zero severity", () => {
    const out = severityDonut(SEVERITY_SOME);
    expect(out.startsWith("<svg")).toBe(true);
    expect(out.endsWith("</svg>")).toBe(true);
    // Non-zero severities (critical, high, low) each draw one stroke arc.
    expect((out.match(/stroke-dasharray/g) ?? []).length).toBe(3);
    expect(out).toContain("Critical");
    expect(out).toContain("9</text>"); // total = 3+5+0+1
  });

  it("renders the empty state rather than a divide-by-zero when everything is zero", () => {
    const out = severityDonut(SEVERITY_ZERO);
    expect(out).toContain("No data for this period.");
    // The empty-state frame itself uses a dashed *rect* outline — what must be
    // absent is an actual arc segment, drawn as a dashed *circle*.
    expect(out).not.toContain("<circle");
  });
});

describe("complianceDonut", () => {
  it("draws the empty state on an all-zero fleet", () => {
    const out = complianceDonut(COMPLIANCE_ZERO);
    expect(out).toContain("No data for this period.");
  });
});

describe("slaBucketBars", () => {
  it("draws all six buckets even when most are empty", () => {
    const out = slaBucketBars(SLA_BUCKETS_SOME);
    expect(out).toContain("breached");
    expect(out).toContain("30d+");
  });

  it("shows the empty state when every bucket is zero", () => {
    expect(slaBucketBars(SLA_BUCKETS_ZERO)).toContain("No data for this period.");
  });

  it("shows the empty state on an empty array, not a crash", () => {
    expect(slaBucketBars([])).toContain("No data for this period.");
  });
});

describe("trendLine", () => {
  const points: TrendPointFact[] = [
    {
      day: "2026-08-01",
      devices: 10,
      devicesCompliant: 8,
      devicesNoncompliant: 2,
      devicesUnknown: 0,
      openFindings: 20,
      critical: 4,
      high: 6,
      medium: 5,
      low: 5,
      slaBreached: 3,
      slaDueSoon: 2,
      slaOk: 15,
    },
    {
      day: "2026-08-02",
      devices: 10,
      devicesCompliant: 9,
      devicesNoncompliant: 1,
      devicesUnknown: 0,
      openFindings: 15,
      critical: 2,
      high: 5,
      medium: 4,
      low: 4,
      slaBreached: 1,
      slaDueSoon: 3,
      slaOk: 16,
    },
  ];

  it("draws a line for two or more points", () => {
    const out = trendLine(points);
    expect(out).toContain("<path");
    expect(out).not.toContain("No data for this period.");
  });

  it("falls back to the empty state below two points, rather than plotting a lone dot", () => {
    expect(trendLine([])).toContain("No data for this period.");
    expect(trendLine(points.slice(0, 1))).toContain("No data for this period.");
  });
});

describe("topSoftwareBars", () => {
  const rows: TopSoftwareFact[] = [
    { software: "chrome", displayName: "<script>evil</script>", severity: "critical", affectedDeviceCount: 12, cveCount: 3 },
    { software: "7zip", displayName: "7-Zip", severity: "medium", affectedDeviceCount: 4, cveCount: 1 },
  ];

  it("escapes a malicious display name instead of injecting it", () => {
    const out = topSoftwareBars(rows);
    expect(out).not.toContain("<script>evil</script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("shows the empty state when nothing is exposed", () => {
    expect(topSoftwareBars([])).toContain("No data for this period.");
    expect(
      topSoftwareBars([{ software: "x", displayName: "X", severity: "low", affectedDeviceCount: 0, cveCount: 0 }]),
    ).toContain("No data for this period.");
  });
});

describe("remediationBars", () => {
  const days: RemediationDayFact[] = [
    { day: "2026-08-01", succeeded: 3, failed: 1 },
    { day: "2026-08-02", succeeded: 0, failed: 0 },
  ];

  it("draws bars when there is any activity", () => {
    expect(remediationBars(days)).toContain("<rect");
  });

  it("shows the empty state with no activity at all", () => {
    expect(remediationBars([{ day: "2026-08-01", succeeded: 0, failed: 0 }])).toContain(
      "No data for this period.",
    );
  });
});

describe("ttrSeverityBars", () => {
  const facts: TimeToRemediateFacts = {
    windowDays: 30,
    count: 10,
    avgHours: 40,
    p90Hours: 96,
    bySeverity: {
      critical: { count: 4, avgHours: 20, p90Hours: 40 },
      high: { count: 6, avgHours: 60, p90Hours: 100 },
      medium: { count: 0, avgHours: null, p90Hours: null },
      low: { count: 0, avgHours: null, p90Hours: null },
    },
  };

  it("draws a threshold marker per severity present", () => {
    const out = ttrSeverityBars(facts, DEFAULT_SLA);
    expect(out).toContain("stroke-dasharray=\"5 3\"");
    expect(out).toContain("Critical");
    expect(out).toContain("High");
    expect(out).not.toContain("Medium (n=");
  });

  it("shows the empty state when nothing was remediated", () => {
    const none: TimeToRemediateFacts = {
      windowDays: 30,
      count: 0,
      avgHours: null,
      p90Hours: null,
      bySeverity: {
        critical: { count: 0, avgHours: null, p90Hours: null },
        high: { count: 0, avgHours: null, p90Hours: null },
        medium: { count: 0, avgHours: null, p90Hours: null },
        low: { count: 0, avgHours: null, p90Hours: null },
      },
    };
    expect(ttrSeverityBars(none, DEFAULT_SLA)).toContain("No data for this period.");
  });
});

describe("renderChart dispatch", () => {
  it("returns null when a chart's facts are absent, rather than throwing", () => {
    const facts: ChartFacts = {};
    expect(renderChart("severity-donut", facts)).toBeNull();
    expect(renderChart("top-software", facts)).toBeNull();
  });

  it("renders when the matching facts are present", () => {
    const facts: ChartFacts = { severity: SEVERITY_SOME };
    expect(renderChart("severity-donut", facts)).not.toBeNull();
  });
});

describe("every chart wraps in a single well-formed <svg>", () => {
  it("has a viewBox and no external namespace to keep the offline-html assertion mechanical", () => {
    const out = severityDonut(SEVERITY_SOME);
    const { attrs } = svgOf(out);
    expect(attrs.viewBox).toBeTruthy();
    expect(attrs.xmlns).toBeUndefined();
  });
});
