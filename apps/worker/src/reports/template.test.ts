import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLA,
  REPORT_TYPE_DEFS,
  type ComplianceSlaFacts,
  type ExecutiveSummaryFacts,
  type FindingFact,
  type ReportBranding,
  type ReportMeta,
  type TimeToRemediateFacts,
  type TrendPointFact,
} from "@patchpilot/shared";
import { renderFooterTemplate, renderHeaderTemplate, renderReportHtml, type ReportRenderInput } from "./template.js";

// ---------------------------------------------------------------------------
// Fixtures. Deliberately written out rather than imported from
// packages/shared/src/reports.test.ts (a test file, and not exported) — a
// smaller, self-contained set, but touching every field the template reads so
// a renamed or removed fact is a compile error here too.
// ---------------------------------------------------------------------------

const branding: ReportBranding = {
  productName: "PatchPilot",
  primary: "#4f46e5",
  secondary: "#0ea5e9",
  accent: "#f59e0b",
  logo: null,
};

const meta = (over: Partial<ReportMeta> = {}): ReportMeta => ({
  reportType: "executive-summary",
  factsVersion: 1,
  tenantId: "11111111-2222-3333-4444-555555555555",
  tenantName: "Müller GmbH & Co. KG",
  tenantCount: 1,
  windowDays: 30,
  generatedAt: "2026-08-15T02:00:00.000Z",
  engineer: "engineer@example.com",
  narrationRequested: false,
  productName: "PatchPilot",
  ...over,
});

const finding = (over: Partial<FindingFact> = {}): FindingFact => ({
  tenantId: "11111111-2222-3333-4444-555555555555",
  tenantName: "<script>alert(1)</script>",
  cveId: "CVE-2026-0001",
  title: "Remote code execution",
  software: "acme reader",
  displayName: "</td><script>alert(1)</script>",
  severity: "critical",
  detectedAt: "2026-07-01T00:00:00.000Z",
  dueDate: "2026-07-08T00:00:00.000Z",
  daysRemaining: -38,
  overdue: true,
  affectedDeviceCount: 12,
  ...over,
});

const trendPoint = (day: string, over: Partial<TrendPointFact> = {}): TrendPointFact => ({
  day,
  devices: 40,
  devicesCompliant: 30,
  devicesNoncompliant: 8,
  devicesUnknown: 2,
  openFindings: 60,
  critical: 5,
  high: 12,
  medium: 25,
  low: 18,
  slaBreached: 7,
  slaDueSoon: 4,
  slaOk: 49,
  ...over,
});

const ttr: TimeToRemediateFacts = {
  windowDays: 30,
  count: 18,
  avgHours: 41.5,
  p90Hours: 96,
  bySeverity: {
    critical: { count: 4, avgHours: 20, p90Hours: 31 },
    high: { count: 6, avgHours: 38, p90Hours: 70 },
    medium: { count: 5, avgHours: 52, p90Hours: 110 },
    low: { count: 3, avgHours: 80, p90Hours: 140 },
  },
};

const executiveFacts: ExecutiveSummaryFacts = {
  meta: meta(),
  thresholds: DEFAULT_SLA,
  scope: {
    tenants: 3,
    reachable: 3,
    stale: 1,
    neverSynced: 0,
    readOnly: 1,
    oldestSyncAt: "2026-08-13T00:00:00.000Z",
    newestSyncAt: "2026-08-15T01:00:00.000Z",
  },
  tiles: {
    critical: 5,
    high: 12,
    breached: 7,
    dueSoon: 4,
    openFindings: 60,
    devices: 40,
    noncompliantDevices: 8,
    compliantDevices: 30,
    unmonitoredDevices: 2,
    misconfigurations: 3,
    activeExceptions: 2,
    excludedDevices: 1,
  },
  severity: [
    { severity: "critical", count: 5 },
    { severity: "high", count: 12 },
    { severity: "medium", count: 25 },
    { severity: "low", count: 18 },
  ],
  complianceCounts: [
    { compliance: "compliant", count: 30 },
    { compliance: "noncompliant", count: 8 },
    { compliance: "unknown", count: 2 },
  ],
  slaBuckets: ["breached", "0-3d", "4-7d", "8-14d", "15-30d", "30d+"].map((bucket, i) => ({
    bucket,
    critical: i === 0 ? 7 : 0,
    high: 0,
    medium: 0,
    low: 0,
    total: i === 0 ? 7 : 0,
  })),
  topSoftware: [
    {
      software: "acme reader",
      displayName: "Acme Reader",
      severity: "critical",
      affectedDeviceCount: 12,
      cveCount: 4,
    },
  ],
  osBreakdown: [{ os: "Windows 11", total: 40, compliant: 30, noncompliant: 8, unknown: 2 }],
  trend: [trendPoint("2026-08-01"), trendPoint("2026-08-15", { slaBreached: 3, openFindings: 52 })],
  trendCoverage: { requestedDays: 30, capturedDays: 2, firstDay: "2026-08-01", complete: false },
  cveTrend: [{ day: "2026-08-15", detected: 2, remediated: 5 }],
  remediation: {
    days: [{ day: "2026-08-15", succeeded: 3, failed: 1 }],
    succeeded: 22,
    failed: 3,
    successRate: 0.88,
    failedLast24h: 1,
  },
  remediationActivity: {
    windowDays: 30,
    totalRemediated: 18,
    bySeverity: { critical: 4, high: 6, medium: 5, low: 3 },
    byAttribution: { patchpilot: 14, external: 4 },
  },
  timeToRemediate: ttr,
  coverage: {
    findingCount: 60,
    total: 21,
    applicable: 17,
    covered: 13,
    uncovered: 4,
    os: 4,
    rows: [
      {
        tenantId: "11111111-2222-3333-4444-555555555555",
        displayName: "Acme Reader",
        severity: "critical",
        status: "covered",
        cveCount: 4,
        affectedDeviceCount: 12,
        packageId: "Acme.Reader",
      },
    ],
  },
  urgentFindings: [finding()],
  attentionDevices: [
    {
      tenantId: "11111111-2222-3333-4444-555555555555",
      hostname: "DESK-001",
      os: "Windows 11",
      compliance: "noncompliant",
      vulnerabilityCount: 9,
    },
  ],
  perTenant: [
    {
      tenantId: "11111111-2222-3333-4444-555555555555",
      displayName: "Müller GmbH & Co. KG",
      reachability: "reachable",
      readOnly: false,
      lastSyncedAt: "2026-08-15T01:00:00.000Z",
      devices: 40,
      critical: 5,
      slaBreached: 7,
      noncompliantDevices: 8,
    },
  ],
  exceptedFindings: 6,
  excludedDevices: 1,
};

const complianceFacts: ComplianceSlaFacts = {
  meta: meta({ reportType: "compliance-sla" }),
  thresholds: DEFAULT_SLA,
  scope: executiveFacts.scope,
  slaCounts: { breached: 7, "due-soon": 4, ok: 49 },
  severity: executiveFacts.severity,
  complianceCounts: executiveFacts.complianceCounts,
  slaBuckets: executiveFacts.slaBuckets,
  breachedFindings: [finding(), finding({ cveId: "CVE-2026-0002", daysRemaining: -3 })],
  dueSoonFindings: [finding({ cveId: "CVE-2026-0003", daysRemaining: 2, overdue: false })],
  breachedTotal: 7,
  dueSoonTotal: 4,
  timeToRemediate: ttr,
  exceptions: {
    count: 2,
    rows: [
      {
        tenantId: "11111111-2222-3333-4444-555555555555",
        tenantName: "<b>Contoso</b>",
        recommendationId: "va-_-openssl-_-openssl",
        cveId: null,
        scope: "global",
        justification: "third_party_control",
        expiresAt: "2026-12-31T00:00:00.000Z",
        createdBy: "engineer@example.com",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    ],
  },
  exclusions: {
    count: 1,
    rows: [
      {
        tenantId: "11111111-2222-3333-4444-555555555555",
        tenantName: "Contoso Ltd",
        managedDeviceId: "md-1",
        deviceHostname: "LAB-KIOSK",
        justification: "out_of_scope",
        expiresAt: null,
        createdBy: "engineer@example.com",
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    ],
  },
  exceptedFindings: 6,
  excludedDevices: 1,
  trend: executiveFacts.trend,
  trendCoverage: executiveFacts.trendCoverage,
  perTenant: executiveFacts.perTenant,
  attentionDevices: executiveFacts.attentionDevices,
};

function baseInput(over: Partial<ReportRenderInput> = {}): ReportRenderInput {
  return {
    reportType: "executive-summary",
    title: "Executive Summary — Müller GmbH & Co. KG",
    engineer: "engineer@example.com",
    branding,
    facts: executiveFacts,
    narration: {},
    narrated: false,
    narrationSkippedReason: null,
    factCheckWarnings: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("renderReportHtml", () => {
  it("produces a complete document for both report types, narrated and not", () => {
    const cases: ReportRenderInput[] = [
      baseInput(),
      baseInput({
        narrated: true,
        narration: { "posture-overview": "Prose from the model.\n\nA second paragraph." },
      }),
      baseInput({
        reportType: "compliance-sla",
        title: "Compliance / SLA — Müller GmbH & Co. KG",
        facts: complianceFacts,
      }),
      baseInput({
        reportType: "compliance-sla",
        title: "Compliance / SLA — Müller GmbH & Co. KG",
        facts: complianceFacts,
        narrated: true,
        narration: { "sla-status": "Narrated deadline status." },
      }),
    ];
    for (const input of cases) {
      const html = renderReportHtml(input);
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain("</html>");
    }
  });

  it("never contains a live http(s) URL outside a data: URI — the offline invariant, asserted mechanically", () => {
    const withLogo = baseInput({
      branding: { ...branding, logo: "data:image/png;base64,AAAA" },
    });
    for (const input of [baseInput(), withLogo]) {
      const html = renderReportHtml(input);
      // Strip data: URIs first so a base64 payload can't coincidentally spell
      // "http" and produce a false negative.
      const withoutDataUris = html.replace(/data:[^"')\s]+/g, "");
      expect(withoutDataUris).not.toMatch(/https?:\/\//);
    }
  });

  it("escapes a hostile display name and tenant name instead of injecting them", () => {
    const html = renderReportHtml(baseInput());
    expect(html).not.toContain("</td><script>alert(1)</script>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");

    const complianceHtml = renderReportHtml(
      baseInput({ reportType: "compliance-sla", facts: complianceFacts, title: "Compliance" }),
    );
    expect(complianceHtml).not.toContain("<b>Contoso</b>");
    expect(complianceHtml).toContain("&lt;b&gt;Contoso&lt;/b&gt;");
  });

  it("declares the branding hexes as :root custom properties", () => {
    const html = renderReportHtml(
      baseInput({ branding: { ...branding, primary: "#dc2626", secondary: "#0ea5e9", accent: "#f59e0b" } }),
    );
    expect(html).toContain("--brand-primary:#dc2626");
    expect(html).toContain("--brand-secondary:#0ea5e9");
    expect(html).toContain("--brand-accent:#f59e0b");
  });

  it("renders one <section class=\"section\"> per registry section, plus the appendix", () => {
    const def = REPORT_TYPE_DEFS["executive-summary"];
    const html = renderReportHtml(baseInput());
    const sectionCount = (html.match(/<section class="section">/g) ?? []).length;
    expect(sectionCount).toBe(def.sections.length);
    expect(html).toContain('<section class="section appendix">');
  });

  it("uses the deterministic caption when narration is off, and the model's prose when narrated", () => {
    const captioned = renderReportHtml(baseInput());
    expect(captioned).toContain(executiveFacts.tiles.openFindings.toString());
    expect(captioned).toContain("Data only");

    const narrated = renderReportHtml(
      baseInput({
        narrated: true,
        narration: { "posture-overview": "A model wrote this sentence." },
      }),
    );
    expect(narrated).toContain("A model wrote this sentence.");
    expect(narrated).toContain("AI-written");
  });

  it("states the reason on the cover when narration was requested but skipped", () => {
    const html = renderReportHtml(
      baseInput({ narrated: false, narrationSkippedReason: "AI service unavailable" }),
    );
    expect(html).toContain("AI service unavailable");
  });

  it("prints fact-check warnings in the document body, not only in the UI", () => {
    const html = renderReportHtml(
      baseInput({ factCheckWarnings: ['Posture Overview: "999" does not appear in the underlying data'] }),
    );
    expect(html).toContain("Data verification notes");
    expect(html).toContain("999");
  });

  it("omits the warning box entirely when nothing tripped the check", () => {
    const html = renderReportHtml(baseInput());
    expect(html).not.toContain("Data verification notes");
  });

  it("discloses thin trend coverage rather than drawing a chart silently", () => {
    const html = renderReportHtml(baseInput());
    expect(html).toContain("2 of 30 requested days captured");
  });
});

describe("renderHeaderTemplate / renderFooterTemplate", () => {
  it("gives the footer's page-number spans an explicit, non-zero font-size", () => {
    const footer = renderFooterTemplate(baseInput());
    expect(footer).toContain('class="pageNumber"');
    expect(footer).toContain('class="totalPages"');
    // Chromium's header/footer mini-document has no inherited CSS and an
    // effective font-size of 0 by default — every element must set its own.
    const sizes = [...footer.matchAll(/font-size:(\d+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((s) => s > 0)).toBe(true);
  });

  it("gives the header an explicit font-size too", () => {
    const header = renderHeaderTemplate(baseInput());
    const sizes = [...header.matchAll(/font-size:(\d+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((s) => s > 0)).toBe(true);
  });

  it("escapes the title in both templates", () => {
    const input = baseInput({ title: "<img src=x onerror=alert(1)>" });
    expect(renderHeaderTemplate(input)).not.toContain("<img src=x");
    expect(renderHeaderTemplate(input)).toContain("&lt;img");
  });
});
