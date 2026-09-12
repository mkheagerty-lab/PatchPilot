import { describe, expect, it } from "vitest";
import { DEMO_ENGINEER_UPN, findDemoEngineerByUpn } from "./demo-engineers.js";

describe("findDemoEngineerByUpn", () => {
  it("finds the seeded demo engineer by exact UPN", () => {
    const engineer = findDemoEngineerByUpn(DEMO_ENGINEER_UPN);
    expect(engineer).toBeDefined();
    expect(engineer?.upn).toBe(DEMO_ENGINEER_UPN);
  });

  it("returns undefined for an unknown UPN", () => {
    expect(findDemoEngineerByUpn("nobody@meridianmsp.example")).toBeUndefined();
  });

  it("is case-sensitive", () => {
    expect(findDemoEngineerByUpn(DEMO_ENGINEER_UPN.toUpperCase())).toBeUndefined();
  });
});
