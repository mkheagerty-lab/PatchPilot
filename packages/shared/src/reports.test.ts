import { describe, expect, it } from "vitest";
import {
  COMPLIANCE_SLA_DEF,
  DEFAULT_REPORT_BRANDING,
  EXECUTIVE_SUMMARY_DEF,
  REPORT_CSV_METRICS,
  REPORT_TYPES,
  REPORT_TYPE_DEFS,
  factCheckSection,
  isReportType,
  pickSectionFacts,
  reportChartIds,
  safeHex,
  safeLogoDataUri,
  sanitizeReportBranding,
  slugifyFilename,
  type ComplianceSlaFacts,
  type ExecutiveSummaryFacts,
  type FindingFact,
  type ReportMeta,
  type TrendPointFact,
} from "./reports.js";
import { DEFAULT_SLA } from "./sla.js";
import { escapeHtml } from "./text.js";

// ---------------------------------------------------------------------------
// Fixtures — one populated and one all-zero instance of each fact shape, so the
// captions are exercised on both a busy estate and a clean one. Written out in
// full rather than generated: the point of the `factsKeys` test below is to
// catch a key that exists in the registry but not in the shape, and a fixture
// built from the shape's own keys couldn't.
// ---------------------------------------------------------------------------

const meta = (over: Partial<ReportMeta> = {}): ReportMeta => ({
  reportType: "executive-summary",
  factsVersion: 1,
  tenantId: "11111111-2222-3333-4444-555555555555",
  tenantName: "Contoso Ltd",
  tenantCount: 1,
  windowDays: 30,
  generatedAt: "2026-08-15T02:00:00.000Z",
  engineer: "engineer@example.com",
  narrationRequested: false,
  productName: "PatchPilot",
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

const finding = (over: Partial<FindingFact> = {}): FindingFact => ({
  tenantId: "11111111-2222-3333-4444-555555555555",
  tenantName: "Contoso Ltd",
  cveId: "CVE-2026-0001",
  title: "Remote code execution in Acme Reader",
  software: "acme reader",
  displayName: "Acme Reader",
  severity: "critical" as const,
  detectedAt: "2026-07-01T00:00:00.000Z",
  dueDate: "2026-07-08T00:00:00.000Z",
  daysRemaining: -38,
  overdue: true,
  affectedDeviceCount: 12,
  ...over,
});

const ttr = {
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

const emptyTtr = {
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

const slaBucket = (bucket: string, total: number) => ({
  bucket,
  critical: total,
  high: 0,
  medium: 0,
  low: 0,
  total,
});

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
  slaBuckets: [slaBucket("breached", 7), slaBucket("0-3d", 4), slaBucket("4-7d", 9)],
  topSoftware: [
    { software: "acme reader", displayName: "Acme Reader", severity: "critical", affectedDeviceCount: 12, cveCount: 4 },
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
      displayName: "Contoso Ltd",
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

/** Everything at zero — the "quiet estate" path through every caption. */
const emptyExecutiveFacts: ExecutiveSummaryFacts = {
  ...executiveFacts,
  meta: meta({ tenantId: null, tenantName: null, tenantCount: 3 }),
  tiles: {
    critical: 0,
    high: 0,
    breached: 0,
    dueSoon: 0,
    openFindings: 0,
    devices: 0,
    noncompliantDevices: 0,
    compliantDevices: 0,
    unmonitoredDevices: 0,
    misconfigurations: 0,
    activeExceptions: 0,
    excludedDevices: 0,
  },
  severity: [
    { severity: "critical", count: 0 },
    { severity: "high", count: 0 },
    { severity: "medium", count: 0 },
    { severity: "low", count: 0 },
  ],
  complianceCounts: [
    { compliance: "compliant", count: 0 },
    { compliance: "noncompliant", count: 0 },
    { compliance: "unknown", count: 0 },
  ],
  slaBuckets: [],
  topSoftware: [],
  osBreakdown: [],
  trend: [],
  trendCoverage: { requestedDays: 30, capturedDays: 0, firstDay: null, complete: false },
  cveTrend: [],
  remediation: { days: [], succeeded: 0, failed: 0, successRate: null, failedLast24h: 0 },
  remediationActivity: { windowDays: 30, totalRemediated: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, byAttribution: {} },
  timeToRemediate: emptyTtr,
  coverage: { findingCount: 0, total: 0, applicable: 0, covered: 0, uncovered: 0, os: 0, rows: [] },
  urgentFindings: [],
  attentionDevices: [],
  perTenant: [],
  exceptedFindings: 0,
  excludedDevices: 0,
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
        tenantName: "Contoso Ltd",
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

const emptyComplianceFacts: ComplianceSlaFacts = {
  ...complianceFacts,
  slaCounts: { breached: 0, "due-soon": 0, ok: 0 },
  severity: emptyExecutiveFacts.severity,
  complianceCounts: emptyExecutiveFacts.complianceCounts,
  slaBuckets: [],
  breachedFindings: [],
  dueSoonFindings: [],
  breachedTotal: 0,
  dueSoonTotal: 0,
  timeToRemediate: emptyTtr,
  exceptions: { count: 0, rows: [] },
  exclusions: { count: 0, rows: [] },
  exceptedFindings: 0,
  excludedDevices: 0,
  trend: [],
  trendCoverage: { requestedDays: 30, capturedDays: 0, firstDay: null, complete: false },
  perTenant: [],
  attentionDevices: [],
};

const FIXTURES = {
  "executive-summary": [executiveFacts, emptyExecutiveFacts],
  "compliance-sla": [complianceFacts, emptyComplianceFacts],
} as const;

// ---------------------------------------------------------------------------

describe("factCheckSection", () => {
  const facts = { openFindings: 60, breached: 7, avgHours: 41.5, tenants: 1234 };

  it("passes numerals that appear in the section's own data", () => {
    expect(factCheckSection("Posture", "There are 60 open findings, 7 overdue.", facts)).toEqual([]);
  });

  it("flags a numeral that traces to nothing", () => {
    const warnings = factCheckSection("Posture", "There are 88 open findings.", facts);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"88" does not appear');
    expect(warnings[0]).toContain("Posture");
  });

  it("accepts a grouped numeral written against an ungrouped fact", () => {
    expect(factCheckSection("Scope", "Covering 1,234 tenants.", facts)).toEqual([]);
  });

  it("matches decimals verbatim", () => {
    expect(factCheckSection("SLA", "Averaging 41.5 hours.", facts)).toEqual([]);
    expect(factCheckSection("SLA", "Averaging 41.6 hours.", facts)).toHaveLength(1);
  });

  it("reports a repeated bad numeral once", () => {
    const warnings = factCheckSection("Posture", "88 findings, and 88 again, plus 88.", facts);
    expect(warnings).toHaveLength(1);
  });

  it("has nothing to say about prose with no numerals", () => {
    expect(factCheckSection("Posture", "The estate is quiet this period.", facts)).toEqual([]);
  });

  it("flags everything when the facts are empty rather than passing by default", () => {
    expect(factCheckSection("Posture", "There are 3 findings.", {})).toHaveLength(1);
  });
});

describe("pickSectionFacts", () => {
  it("returns only the requested keys", () => {
    const picked = pickSectionFacts(executiveFacts, ["tiles", "severity"]);
    expect(Object.keys(picked).sort()).toEqual(["severity", "tiles"]);
  });

  it("omits an absent key entirely rather than setting it undefined", () => {
    const picked = pickSectionFacts({ a: 1 } as { a: number; b?: number }, ["a", "b"]);
    expect("b" in picked).toBe(false);
    expect(JSON.stringify(picked)).toBe('{"a":1}');
  });
});

describe("the registry", () => {
  it("has a definition for every declared type, keyed by its own id", () => {
    for (const type of REPORT_TYPES) {
      expect(REPORT_TYPE_DEFS[type]).toBeDefined();
      expect(REPORT_TYPE_DEFS[type].id).toBe(type);
    }
  });

  it("recognises only declared types", () => {
    expect(isReportType("executive-summary")).toBe(true);
    expect(isReportType("detailed-vulnerabilities")).toBe(false);
  });

  // The one that matters: a typo in `factsKeys` would otherwise narrate a
  // section over an object missing that field, and the model would quietly
  // invent the number instead of reading it.
  it("resolves every section's factsKeys against real facts", () => {
    for (const [type, [populated]] of Object.entries(FIXTURES)) {
      for (const section of REPORT_TYPE_DEFS[type as keyof typeof FIXTURES].sections) {
        for (const key of section.factsKeys) {
          expect(
            key in (populated as object),
            `${type} / ${section.id} declares "${String(key)}", which is not on the facts`,
          ).toBe(true);
        }
        expect(section.factsKeys.length, `${type} / ${section.id} narrates nothing`).toBeGreaterThan(0);
      }
    }
  });

  it("gives every section a unique id within its type", () => {
    for (const type of REPORT_TYPES) {
      const ids = REPORT_TYPE_DEFS[type].sections.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("produces a de-duplicated chart list per type", () => {
    for (const type of REPORT_TYPES) {
      const charts = reportChartIds(type);
      expect(new Set(charts).size).toBe(charts.length);
      expect(charts.length).toBeGreaterThan(0);
    }
  });

  it("writes a caption for every section on both a busy and a quiet estate", () => {
    const check = (label: string, caption: string) => {
      expect(caption.length, `${label} produced an empty caption`).toBeGreaterThan(40);
      expect(caption, `${label} leaked an undefined`).not.toContain("undefined");
      expect(caption, `${label} leaked a NaN`).not.toContain("NaN");
      expect(caption, `${label} leaked a null`).not.toContain("null");
    };
    check("executive/populated", EXECUTIVE_SUMMARY_DEF.sections[0]!.caption(executiveFacts));
    for (const section of EXECUTIVE_SUMMARY_DEF.sections) {
      check(`executive/${section.id}/populated`, section.caption(executiveFacts));
      check(`executive/${section.id}/empty`, section.caption(emptyExecutiveFacts));
    }
    for (const section of COMPLIANCE_SLA_DEF.sections) {
      check(`compliance/${section.id}/populated`, section.caption(complianceFacts));
      check(`compliance/${section.id}/empty`, section.caption(emptyComplianceFacts));
    }
  });

  it("names the all-tenants scope by count when no tenant is set", () => {
    const caption = EXECUTIVE_SUMMARY_DEF.sections[0]!.caption(emptyExecutiveFacts);
    expect(caption).toContain("all 3 tenants");
  });

  it("says nothing is overdue rather than manufacturing a breach", () => {
    const caption = COMPLIANCE_SLA_DEF.sections[1]!.caption(emptyComplianceFacts);
    expect(caption).toContain("No finding is currently overdue");
  });
});

describe("safeHex", () => {
  it("accepts a six-digit hex, trimmed", () => {
    expect(safeHex("#4F46E5", "#000000")).toBe("#4F46E5");
    expect(safeHex("  #0ea5e9  ", "#000000")).toBe("#0ea5e9");
  });

  it("rejects a value that would close the CSS rule and inject its own", () => {
    expect(safeHex("red; } body { display:none } .x {", "#4f46e5")).toBe("#4f46e5");
    expect(safeHex("#12345", "#4f46e5")).toBe("#4f46e5");
    expect(safeHex("#1234567", "#4f46e5")).toBe("#4f46e5");
    expect(safeHex("rebeccapurple", "#4f46e5")).toBe("#4f46e5");
    expect(safeHex("#ffff", "#4f46e5")).toBe("#4f46e5");
  });

  it("rejects non-strings", () => {
    expect(safeHex(null, "#4f46e5")).toBe("#4f46e5");
    expect(safeHex(0x4f46e5, "#4f46e5")).toBe("#4f46e5");
  });
});

describe("safeLogoDataUri", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

  it("accepts a base64 image data URI", () => {
    expect(safeLogoDataUri(png)).toBe(png);
  });

  // The renderer is a browser inside the worker's Docker network; an http(s)
  // logo URL is an SSRF primitive with the response printed into a PDF.
  it("rejects anything the renderer would have to fetch", () => {
    expect(safeLogoDataUri("https://cdn.example.com/logo.png")).toBeNull();
    expect(safeLogoDataUri("http://ollama:11434/api/tags")).toBeNull();
    expect(safeLogoDataUri("//evil.example.com/logo.png")).toBeNull();
    expect(safeLogoDataUri("file:///etc/passwd")).toBeNull();
  });

  it("rejects a data URI that isn't base64 image bytes", () => {
    expect(safeLogoDataUri("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(safeLogoDataUri("data:image/png,<svg onload=alert(1)>")).toBeNull();
  });

  it("rejects an oversized logo", () => {
    expect(safeLogoDataUri(`data:image/png;base64,${"A".repeat(600_000)}`)).toBeNull();
  });
});

describe("sanitizeReportBranding", () => {
  it("falls back to defaults for a missing or hostile setting", () => {
    expect(sanitizeReportBranding(undefined)).toEqual(DEFAULT_REPORT_BRANDING);
    expect(
      sanitizeReportBranding({ primary: "red; }", secondary: 5, accent: null, logoUrl: "https://x/y.png" }),
    ).toEqual(DEFAULT_REPORT_BRANDING);
  });

  it("keeps a valid brand", () => {
    expect(
      sanitizeReportBranding({
        productName: "Acme Patch",
        primary: "#dc2626",
        secondary: "#0ea5e9",
        accent: "#f59e0b",
        logoUrl: null,
      }),
    ).toEqual({
      productName: "Acme Patch",
      primary: "#dc2626",
      secondary: "#0ea5e9",
      accent: "#f59e0b",
      logo: null,
    });
  });

  // productName is printed, not interpolated raw — escaping is the template's
  // job, but the length cap is this function's.
  it("caps a runaway product name", () => {
    expect(sanitizeReportBranding({ productName: "x".repeat(500) }).productName).toHaveLength(60);
  });
});

describe("slugifyFilename", () => {
  it("folds accents to their base letter rather than dropping them", () => {
    expect(slugifyFilename(["Müller GmbH & Co. KG", "executive summary"], "pdf")).toBe(
      "muller-gmbh-co-kg_executive-summary.pdf",
    );
  });

  it("survives a name with no ASCII at all", () => {
    expect(slugifyFilename(["日本語テナント"], "pdf")).toBe("report.pdf");
  });

  it("bounds the length", () => {
    const name = slugifyFilename(["a".repeat(200), "compliance"], "pdf");
    expect(name.length).toBeLessThanOrEqual(124);
    expect(name.endsWith(".pdf")).toBe(true);
  });

  it("drops empty parts instead of leaving separators behind", () => {
    expect(slugifyFilename(["patchpilot", "", "  ", "2026-08-15"], "csv")).toBe("patchpilot_2026-08-15.csv");
  });
});

describe("REPORT_CSV_METRICS", () => {
  it("has unique ids and api-rooted csv paths", () => {
    const ids = REPORT_CSV_METRICS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const metric of REPORT_CSV_METRICS) {
      expect(metric.path.startsWith("/api/reports/metrics/")).toBe(true);
      expect(metric.path.endsWith(".csv")).toBe(true);
    }
  });
});

describe("escapeHtml", () => {
  it("neutralises a tag and an attribute break-out", () => {
    expect(escapeHtml("</td><script>alert(1)</script>")).toBe(
      "&lt;/td&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(escapeHtml('" onload="alert(1)')).toBe("&quot; onload=&quot;alert(1)");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("escapes ampersands first, so an entity isn't double-decoded", () => {
    expect(escapeHtml("Müller & Co <b>")).toBe("Müller &amp; Co &lt;b&gt;");
  });

  it("renders a missing field as empty rather than the word undefined", () => {
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(0)).toBe("0");
  });
});
