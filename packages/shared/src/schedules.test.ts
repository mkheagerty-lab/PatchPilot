import { describe, it, expect } from "vitest";
import { matchesScheduleTarget, type ScheduleCandidate } from "./schedules.js";

const app = (severity: string, software = "Google Chrome"): ScheduleCandidate => ({
  severity,
  wingetRemediable: true,
  software,
});
const os = (severity: string): ScheduleCandidate => ({
  severity,
  wingetRemediable: false,
  software: "Windows",
});

describe("matchesScheduleTarget", () => {
  it("empty target matches every finding, app or OS", () => {
    expect(matchesScheduleTarget(app("low"), {})).toBe(true);
    expect(matchesScheduleTarget(os("critical"), {})).toBe(true);
  });

  it("patchType=app keeps winget-remediable, drops OS", () => {
    expect(matchesScheduleTarget(app("high"), { patchType: "app" })).toBe(true);
    expect(matchesScheduleTarget(os("high"), { patchType: "app" })).toBe(false);
  });

  it("patchType=os keeps non-winget, drops app", () => {
    expect(matchesScheduleTarget(os("high"), { patchType: "os" })).toBe(true);
    expect(matchesScheduleTarget(app("high"), { patchType: "os" })).toBe(false);
  });

  it("severity is a floor, not an exact match", () => {
    const t = { severity: "high" };
    expect(matchesScheduleTarget(app("critical"), t)).toBe(true);
    expect(matchesScheduleTarget(app("high"), t)).toBe(true);
    expect(matchesScheduleTarget(app("medium"), t)).toBe(false);
    expect(matchesScheduleTarget(app("low"), t)).toBe(false);
  });

  it("an unrecognised target severity applies no floor (fails open, not shut)", () => {
    expect(matchesScheduleTarget(app("low"), { severity: "urgent" })).toBe(true);
  });

  it("an unrecognised vuln severity only passes when there is no floor", () => {
    expect(matchesScheduleTarget(app("informational"), {})).toBe(true);
    expect(
      matchesScheduleTarget(app("informational"), { severity: "low" }),
    ).toBe(false);
  });

  it("ANDs patchType and severity together", () => {
    const t = { patchType: "app" as const, severity: "high" };
    expect(matchesScheduleTarget(app("critical"), t)).toBe(true);
    expect(matchesScheduleTarget(os("critical"), t)).toBe(false); // right severity, wrong type
    expect(matchesScheduleTarget(app("low"), t)).toBe(false); // right type, too low
  });

  it("software restricts to an exact title match", () => {
    const t = { software: "Google Chrome" };
    expect(matchesScheduleTarget(app("low", "Google Chrome"), t)).toBe(true);
    expect(matchesScheduleTarget(app("critical", "Firefox"), t)).toBe(false);
  });

  it("ANDs software with severity/patchType", () => {
    const t = { software: "Google Chrome", severity: "high" };
    expect(matchesScheduleTarget(app("critical", "Google Chrome"), t)).toBe(true);
    expect(matchesScheduleTarget(app("critical", "Firefox"), t)).toBe(false); // right severity, wrong software
    expect(matchesScheduleTarget(app("low", "Google Chrome"), t)).toBe(false); // right software, too low
  });
});
