import { describe, expect, it } from "vitest";
import {
  computeSla,
  slaChipLabel,
  deviceSlaCompliance,
  normalizeSlaThresholds,
  DEFAULT_SLA,
} from "./sla.js";
import { routeChannel } from "./channels.js";
import { generateWingetRemediation, generateWingetDetect } from "./scripts.js";

const NOW = new Date("2026-06-23T00:00:00Z");

describe("computeSla", () => {
  it("reports days remaining for a fresh critical finding", () => {
    const detected = new Date("2026-06-20T00:00:00Z");
    const status = computeSla("critical", detected, DEFAULT_SLA, NOW);
    expect(status.overdue).toBe(false);
    expect(status.daysRemaining).toBe(4); // 7-day SLA, detected 3 days ago
    expect(slaChipLabel(status)).toBe("4d left");
  });

  it("flags overdue findings", () => {
    const detected = new Date("2026-06-01T00:00:00Z");
    const status = computeSla("critical", detected, DEFAULT_SLA, NOW);
    expect(status.overdue).toBe(true);
    expect(slaChipLabel(status)).toMatch(/^Overdue/);
  });

  it("tightens the deadline for a verified exploit even on a low-severity finding", () => {
    // low SLA is 90d; verifiedExploit override is 3d — detected 5 days ago
    // is still fresh under low, but overdue once verified.
    const detected = new Date("2026-06-18T00:00:00Z");
    const notVerified = computeSla("low", detected, DEFAULT_SLA, NOW, false);
    const verified = computeSla("low", detected, DEFAULT_SLA, NOW, true);
    expect(notVerified.overdue).toBe(false);
    expect(verified.overdue).toBe(true);
  });

  it("never lengthens the deadline when the severity SLA is already shorter than the override", () => {
    // critical SLA (7d) is already shorter than the default 3d... wait, the
    // override is stricter — a critical finding's 7d deadline should still be
    // clamped down to 3d when verified, never relaxed back up to 7d.
    const detected = new Date("2026-06-19T00:00:00Z"); // 4 days ago
    const verified = computeSla("critical", detected, DEFAULT_SLA, NOW, true);
    const notVerified = computeSla("critical", detected, DEFAULT_SLA, NOW, false);
    expect(notVerified.overdue).toBe(false); // within the 7d critical SLA
    expect(verified.overdue).toBe(true); // clamped to the 3d verified-exploit override
  });
});

describe("normalizeSlaThresholds", () => {
  it("fills in defaults for a legacy saved settings row missing verifiedExploit", () => {
    const legacy = { critical: 5, high: 10, medium: 20, low: 60 };
    expect(normalizeSlaThresholds(legacy)).toEqual({
      critical: 5,
      high: 10,
      medium: 20,
      low: 60,
      verifiedExploit: DEFAULT_SLA.verifiedExploit,
    });
  });

  it("falls back to all defaults for undefined or malformed input", () => {
    expect(normalizeSlaThresholds(undefined)).toEqual(DEFAULT_SLA);
    expect(normalizeSlaThresholds({ critical: "not a number" })).toEqual(DEFAULT_SLA);
  });
});

describe("deviceSlaCompliance", () => {
  it("returns unknown when there is no Defender coverage (null findings)", () => {
    expect(deviceSlaCompliance(null, DEFAULT_SLA, NOW)).toBe("unknown");
  });

  it("returns compliant for a covered device with zero findings", () => {
    expect(deviceSlaCompliance([], DEFAULT_SLA, NOW)).toBe("compliant");
  });

  it("returns compliant when every finding is still within its SLA", () => {
    const findings = [
      { severity: "critical" as const, detectedAt: new Date("2026-06-20T00:00:00Z") }, // 4d left
      { severity: "high" as const, detectedAt: new Date("2026-06-18T00:00:00Z") }, // 9d left
    ];
    expect(deviceSlaCompliance(findings, DEFAULT_SLA, NOW)).toBe("compliant");
  });

  it("returns noncompliant when any finding has breached its SLA", () => {
    const findings = [
      { severity: "high" as const, detectedAt: new Date("2026-06-18T00:00:00Z") }, // within SLA
      { severity: "critical" as const, detectedAt: new Date("2026-06-01T00:00:00Z") }, // overdue
    ];
    expect(deviceSlaCompliance(findings, DEFAULT_SLA, NOW)).toBe("noncompliant");
  });
});

describe("routeChannel", () => {
  it("routes patch-now to Live Response", () => {
    expect(routeChannel("app", "now")).toBe("live-response");
    expect(routeChannel("os", "now")).toBe("live-response");
  });
  it("routes scheduled OS patches to Live Response too (Method override, not timing, picks the channel)", () => {
    expect(routeChannel("os", "expedite")).toBe("live-response");
  });
  it("routes scheduled app patches to Live Response too (Method override, not timing, picks the channel)", () => {
    expect(routeChannel("app", "schedule")).toBe("live-response");
  });
});

describe("script generators", () => {
  it("emits a winget upgrade command with the package id", () => {
    const script = generateWingetRemediation({ packageId: "7zip.7zip" });
    expect(script).toContain("upgrade --id 7zip.7zip");
    expect(script).toContain("exit $LASTEXITCODE");
  });
  it("emits a detect script using the min version", () => {
    const script = generateWingetDetect({ packageId: "7zip.7zip", minVersion: "24.08" });
    expect(script).toContain("24.08");
    expect(script).toContain("exit 0");
  });
});
