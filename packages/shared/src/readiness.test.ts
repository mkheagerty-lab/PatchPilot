import { describe, expect, it } from "vitest";
import {
  evaluateReadiness,
  enabledChannels,
  type ReadinessTenant,
} from "./readiness.js";

const mspTenant: ReadinessTenant = {
  tenantId: "msp-root",
  displayName: "Black Iron (MSP)",
  consentStatus: "consented",
  readOnly: false,
  licenses: ["intune", "mde-p2"],
  isMspTenant: true,
};

const contoso: ReadinessTenant = {
  tenantId: "contoso",
  displayName: "Contoso Legal",
  consentStatus: "consented",
  readOnly: true,
  licenses: ["intune", "mde-p2"],
  isMspTenant: false,
};

const northwind: ReadinessTenant = {
  tenantId: "northwind",
  displayName: "Northwind Sales",
  consentStatus: "pending",
  readOnly: true,
  licenses: [],
  isMspTenant: false,
};

const status = (r: ReturnType<typeof evaluateReadiness>, id: string) =>
  r.checks.find((c) => c.id === id)?.status;

describe("enabledChannels", () => {
  it("excludes channels whose licenses are missing", () => {
    // intune + mde-p2, but NOT defender-business-premium -> no live-response.
    const enabled = enabledChannels(["intune", "mde-p2"]);
    expect(enabled).not.toContain("live-response");
    expect(enabled).toContain("intune-remediation");
    expect(enabled).toContain("expedited-quality-update");
  });

  it("returns nothing with no licenses", () => {
    expect(enabledChannels([])).toEqual([]);
  });
});

describe("evaluateReadiness", () => {
  it("home tenant with consent + write is ready and can remediate", () => {
    const r = evaluateReadiness(mspTenant);
    expect(r.ready).toBe(true);
    expect(r.canRemediate).toBe(true);
    expect(status(r, "consent")).toBe("pass");
    expect(status(r, "gdap")).toBe("pass");
    expect(status(r, "write-actions")).toBe("pass");
  });

  it("read-only consented customer is ready but cannot remediate; GDAP passes", () => {
    const r = evaluateReadiness(contoso);
    expect(r.ready).toBe(true);
    expect(r.canRemediate).toBe(false);
    expect(status(r, "write-actions")).toBe("warn");
    // Admin consent establishes the delegated GDAP relationship.
    expect(status(r, "gdap")).toBe("pass");
  });

  it("unconsented, unlicensed tenant is not ready; GDAP pending", () => {
    const r = evaluateReadiness(northwind);
    expect(r.ready).toBe(false);
    expect(r.canRemediate).toBe(false);
    expect(status(r, "consent")).toBe("fail");
    expect(status(r, "licensing")).toBe("fail");
    // No admin consent yet -> GDAP delegation not established.
    expect(status(r, "gdap")).toBe("pending");
    expect(r.enabledChannels).toEqual([]);
  });
});
