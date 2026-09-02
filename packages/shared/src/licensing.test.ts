import { describe, expect, it } from "vitest";
import {
  mapSkusToLicenses,
  mapAssignedPlansToLicenses,
  unmappedPlanIds,
  type AssignedPlan,
} from "./licensing.js";

// Well-known service plan IDs used across the assignedPlans tests.
const INTUNE_A = "c1ec4a95-1f05-45b3-a911-aa3fa01094f5";
const MDE_SMB = "bfc1bbd9-981b-4f71-9b82-17c35fd0e2a4"; // Defender for Business (confirmed live: M365 Business Premium)
const WINDEFATP = "871d91ec-ec1a-452b-a83f-bd76c7d770ef"; // Defender for Endpoint P2
const EXCHANGE = "9aaf7827-d63c-4b61-89c3-182f06f82e5c"; // unmapped (Exchange Online)

describe("mapSkusToLicenses", () => {
  it("maps Microsoft 365 E5 to intune + mde-p2 (no Defender for Business tier)", () => {
    const licenses = mapSkusToLicenses(["SPE_E5"]);
    expect(licenses).toContain("intune");
    expect(licenses).toContain("mde-p2");
    expect(licenses).not.toContain("defender-business-premium");
  });

  it("maps Business Premium to intune + defender-business-premium", () => {
    const licenses = mapSkusToLicenses(["SPB"]);
    expect(licenses).toContain("intune");
    expect(licenses).toContain("defender-business-premium");
    expect(licenses).not.toContain("mde-p2");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(mapSkusToLicenses([" spe_e5 "])).toContain("mde-p2");
  });

  it("maps standalone add-ons", () => {
    expect(mapSkusToLicenses(["INTUNE_A"])).toEqual(["intune"]);
    expect(mapSkusToLicenses(["DEFENDER_ENDPOINT_P2"])).toEqual(["mde-p2"]);
  });

  it("de-duplicates when multiple SKUs grant the same capability", () => {
    const licenses = mapSkusToLicenses(["SPE_E5", "INTUNE_A", "WIN_DEF_ATP"]);
    expect(licenses.filter((l) => l === "intune")).toHaveLength(1);
    expect(licenses.filter((l) => l === "mde-p2")).toHaveLength(1);
  });

  it("returns nothing for unknown or empty SKUs", () => {
    expect(mapSkusToLicenses([])).toEqual([]);
    expect(mapSkusToLicenses(["SOME_RANDOM_SKU"])).toEqual([]);
  });
});

describe("mapAssignedPlansToLicenses", () => {
  const plan = (servicePlanId: string, capabilityStatus = "Enabled"): AssignedPlan => ({
    servicePlanId,
    capabilityStatus,
  });

  it("maps Intune + Defender for Endpoint P2 service plans", () => {
    const licenses = mapAssignedPlansToLicenses([plan(INTUNE_A), plan(WINDEFATP)]);
    expect(licenses).toContain("intune");
    expect(licenses).toContain("mde-p2");
    expect(licenses).not.toContain("defender-business-premium");
  });

  it("maps Defender for Business to the business-premium tier", () => {
    expect(mapAssignedPlansToLicenses([plan(MDE_SMB)])).toEqual(["defender-business-premium"]);
  });

  it("is case-insensitive on the service plan GUID", () => {
    expect(mapAssignedPlansToLicenses([plan(INTUNE_A.toUpperCase())])).toEqual(["intune"]);
  });

  it("ignores plans that are not Enabled", () => {
    expect(mapAssignedPlansToLicenses([plan(INTUNE_A, "Suspended")])).toEqual([]);
  });

  it("treats a missing capabilityStatus as enabled", () => {
    expect(mapAssignedPlansToLicenses([{ servicePlanId: INTUNE_A }])).toEqual(["intune"]);
  });

  it("de-duplicates and ignores unmapped/empty plans", () => {
    const licenses = mapAssignedPlansToLicenses([
      plan(INTUNE_A),
      plan(INTUNE_A),
      plan(EXCHANGE),
      { service: "exchange" },
    ]);
    expect(licenses).toEqual(["intune"]);
  });
});

describe("unmappedPlanIds", () => {
  it("returns distinct enabled plan IDs we don't yet map, excluding known ones", () => {
    const result = unmappedPlanIds([
      { servicePlanId: INTUNE_A, capabilityStatus: "Enabled" },
      { servicePlanId: EXCHANGE, capabilityStatus: "Enabled" },
      { servicePlanId: EXCHANGE, capabilityStatus: "Enabled" },
    ]);
    expect(result).toEqual([EXCHANGE]);
  });

  it("excludes disabled plans and empty IDs", () => {
    expect(
      unmappedPlanIds([
        { servicePlanId: EXCHANGE, capabilityStatus: "Suspended" },
        { service: "no-id" },
      ]),
    ).toEqual([]);
  });
});
