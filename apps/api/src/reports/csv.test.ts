import { describe, expect, it } from "vitest";
import { DEFAULT_SLA } from "@patchpilot/shared";
import type { CoverageRow } from "../catalog/coverage.js";
import type { TimeToRemediateSummary } from "../posture/time-to-remediate.js";
import {
  capRows,
  deviceComplianceTable,
  postureTrendTable,
  renderCsv,
  slaComplianceTable,
  softwareExposureTable,
  timeToRemediateTable,
  REPORT_CSV_MAX_ROWS,
  type CsvTable,
  type DeviceComplianceInput,
  type SlaComplianceInput,
} from "./csv.js";

/** The invariant that makes a CSV openable at all: if any builder ever emits a
 * row of a different width than its header, every column after the short row is
 * shifted and the file is silently wrong rather than loudly broken. */
function expectRectangular(table: CsvTable) {
  for (const row of table.rows) {
    expect(row.length).toBe(table.headers.length);
  }
}

function finding(over: Partial<SlaComplianceInput> = {}): SlaComplianceInput {
  return {
    tenantId: "t1",
    tenantName: "Contoso",
    cveId: "CVE-2025-1234",
    software: "microsoft-edge",
    severity: "critical",
    detectedAt: new Date("2026-07-01T00:00:00.000Z"),
    sla: { dueDate: new Date("2026-07-08T00:00:00.000Z"), daysRemaining: 3, overdue: false },
    tone: "due-soon",
    affectedDeviceCount: 12,
    ...over,
  };
}

function device(over: Partial<DeviceComplianceInput> = {}): DeviceComplianceInput {
  return {
    id: "d1",
    tenantId: "t1",
    managedDeviceId: "m1",
    hostname: "WS-001",
    os: "Windows 11",
    compliance: "noncompliant",
    vulnerabilityCount: 4,
    lastSeen: new Date("2026-08-01T10:00:00.000Z"),
    ...over,
  };
}

function coverageRow(over: Partial<CoverageRow> = {}): CoverageRow {
  return {
    tenantId: "t1",
    software: "microsoft-edge",
    displayName: "Microsoft Edge",
    publisher: "Microsoft",
    severity: "high",
    patchType: "app",
    applicable: true,
    status: "covered",
    match: null,
    latestVersion: "126.0.1",
    altSources: [] as unknown as CoverageRow["altSources"],
    cveCount: 3,
    cveIds: ["CVE-1", "CVE-2", "CVE-3"],
    affectedDeviceCount: 9,
    vulnId: "v1",
    ...over,
  };
}

const emptyTtr: TimeToRemediateSummary = {
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

const tenantNames = new Map([["t1", "Contoso"]]);

describe("every metric table is rectangular", () => {
  it("holds for populated inputs", () => {
    expectRectangular(slaComplianceTable([finding(), finding({ cveId: "CVE-2025-2" })]));
    expectRectangular(deviceComplianceTable([device(), device({ id: "d2" })], tenantNames));
    expectRectangular(softwareExposureTable([coverageRow()], tenantNames));
    expectRectangular(timeToRemediateTable(emptyTtr, DEFAULT_SLA, "All tenants"));
    expectRectangular(
      postureTrendTable([
        {
          tenantId: "t1",
          tenantName: "Contoso",
          points: [
            {
              day: "2026-08-01",
              devices: 10,
              devicesCompliant: 6,
              devicesNoncompliant: 3,
              devicesUnknown: 1,
              openFindings: 20,
              critical: 2,
              high: 5,
              medium: 8,
              low: 5,
              slaBreached: 1,
              slaDueSoon: 4,
              slaOk: 15,
            },
          ],
        },
      ]),
    );
  });

  it("holds for empty inputs", () => {
    expectRectangular(slaComplianceTable([]));
    expectRectangular(deviceComplianceTable([], new Map()));
    expectRectangular(softwareExposureTable([], new Map()));
    expectRectangular(postureTrendTable([]));
  });
});

describe("slaComplianceTable", () => {
  it("puts the most overdue finding first, so a capped export keeps the worst rows", () => {
    const table = slaComplianceTable([
      finding({ cveId: "CVE-OK", sla: { dueDate: new Date(), daysRemaining: 20, overdue: false } }),
      finding({
        cveId: "CVE-BREACHED",
        tone: "breached",
        sla: { dueDate: new Date(), daysRemaining: -9, overdue: true },
      }),
    ]);
    expect(table.rows[0]![2]).toBe("CVE-BREACHED");
    expect(table.rows[0]![8]).toBe("yes");
  });

  it("labels every SLA tone in words, not slugs", () => {
    const tones = slaComplianceTable([
      finding({ tone: "ok" }),
      finding({ tone: "due-soon" }),
      finding({ tone: "breached" }),
    ]).rows.map((r) => r[9]);
    expect(new Set(tones)).toEqual(new Set(["Within SLA", "Due soon", "Breached"]));
  });
});

describe("timeToRemediateTable", () => {
  it("leaves the SLA verdict blank when nothing was remediated", () => {
    const rows = timeToRemediateTable(emptyTtr, DEFAULT_SLA, "Contoso").rows;
    // "no" here would assert a missed deadline that never happened.
    for (const row of rows) expect(row[7]).toBe("");
  });

  it("compares the average against that severity's own threshold", () => {
    const summary: TimeToRemediateSummary = {
      ...emptyTtr,
      count: 2,
      avgHours: 100,
      p90Hours: 160,
      bySeverity: {
        ...emptyTtr.bySeverity,
        // 6 days against a 7-day critical SLA.
        critical: { count: 1, avgHours: 144, p90Hours: 144 },
        // 20 days against a 14-day high SLA.
        high: { count: 1, avgHours: 480, p90Hours: 480 },
      },
    };
    const rows = timeToRemediateTable(summary, DEFAULT_SLA, "Contoso").rows;
    expect(rows[0]).toEqual(["Contoso", 30, "critical", 1, "144.0", "144.0", 7, "yes"]);
    expect(rows[1]).toEqual(["Contoso", 30, "high", 1, "480.0", "480.0", 14, "no"]);
    // The mixed "all" row asserts no threshold, because no single one applies.
    expect(rows[4]![6]).toBe("");
    expect(rows[4]![7]).toBe("");
  });
});

describe("softwareExposureTable", () => {
  it("falls back to the tenant id when the name isn't known", () => {
    const table = softwareExposureTable([coverageRow({ tenantId: "unknown" })], tenantNames);
    expect(table.rows[0]![0]).toBe("unknown");
  });

  it("renders coverage status and patch type as prose, and null cells as empty", () => {
    const table = softwareExposureTable(
      [coverageRow({ status: "os", patchType: "os", publisher: null, latestVersion: null })],
      tenantNames,
    );
    expect(table.rows[0]![7]).toBe("OS");
    expect(table.rows[0]![8]).toBe("OS update");
    expect(renderCsv(table)).toContain(",,"); // null publisher/version → empty cells
  });
});

describe("postureTrendTable", () => {
  it("emits one row per (day, tenant) rather than collapsing tenants", () => {
    const point = {
      day: "2026-08-01",
      devices: 1,
      devicesCompliant: 1,
      devicesNoncompliant: 0,
      devicesUnknown: 0,
      openFindings: 0,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      slaBreached: 0,
      slaDueSoon: 0,
      slaOk: 0,
    };
    const table = postureTrendTable([
      { tenantId: "t2", tenantName: "Fabrikam", points: [point] },
      { tenantId: "t1", tenantName: "Contoso", points: [point, { ...point, day: "2026-08-02" }] },
    ]);
    expect(table.rows).toHaveLength(3);
    expect(table.rows.map((r) => [r[0], r[1]])).toEqual([
      ["2026-08-01", "Contoso"],
      ["2026-08-01", "Fabrikam"],
      ["2026-08-02", "Contoso"],
    ]);
  });
});

describe("renderCsv", () => {
  it("leads with a BOM and terminates rows with CRLF", () => {
    const csv = renderCsv({ headers: ["A", "B"], rows: [[1, 2]] });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe("﻿A,B\r\n1,2\r\n");
  });

  it("neutralises a software title that Excel would run as a formula", () => {
    const table = softwareExposureTable(
      [coverageRow({ displayName: "=cmd|'/c calc'!A1" })],
      tenantNames,
    );
    // Apostrophe-prefixed but NOT quoted: the value holds no comma, quote or
    // newline, so RFC-4180 quoting doesn't apply. The two guards are separate.
    expect(renderCsv(table)).toContain(",'=cmd|'/c calc'!A1,");
  });

  it("applies both guards when a title needs quoting and neutralising", () => {
    const table = softwareExposureTable([coverageRow({ displayName: "=SUM(A1,B1)" })], tenantNames);
    expect(renderCsv(table)).toContain("\"'=SUM(A1,B1)\"");
  });

  it("quotes a hostname containing a comma instead of splitting the row", () => {
    const csv = renderCsv(deviceComplianceTable([device({ hostname: "WS-001, spare" })], tenantNames));
    expect(csv).toContain('"WS-001, spare"');
  });
});

describe("capRows", () => {
  it("reports truncation only when the cap actually bit", () => {
    expect(capRows([1, 2, 3])).toEqual({ rows: [1, 2, 3], truncated: false });
    const over = new Array(REPORT_CSV_MAX_ROWS + 1).fill(0);
    const capped = capRows(over);
    expect(capped.rows).toHaveLength(REPORT_CSV_MAX_ROWS);
    expect(capped.truncated).toBe(true);
  });
});
