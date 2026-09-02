import { describe, expect, it } from "vitest";
import {
  preflight,
  type PreflightVuln,
  type PreflightDevice,
  type PreflightTenant,
} from "./preflight.js";
import { isExclusionLive } from "./exclusions.js";

const appVuln: PreflightVuln = {
  id: "v1",
  title: "7-Zip heap overflow",
  software: "7-Zip",
  severity: "critical",
  wingetRemediable: true,
  wingetPackageId: "7zip.7zip",
};

const osVuln: PreflightVuln = {
  id: "v2",
  title: "Windows TCP/IP information disclosure",
  software: "Microsoft Windows",
  severity: "medium",
  wingetRemediable: false,
  wingetPackageId: null,
};

const device: PreflightDevice = {
  id: "d1",
  hostname: "CON-LT-014",
  managedDeviceId: "dev-1",
  defenderMachineId: "mde-1",
  compliance: "noncompliant",
  lastSeen: "2026-06-22T00:00:00Z",
  excluded: false,
  exclusionReason: null,
};

const writableTenant: PreflightTenant = {
  tenantId: "contoso",
  displayName: "Contoso Legal",
  consentStatus: "consented",
  readOnly: false,
  licenses: ["intune", "mde-p2"],
};

const status = (r: ReturnType<typeof preflight>, id: string) =>
  r.checks.find((c) => c.id === id)?.status;

describe("preflight", () => {
  it("passes for a licensed app patch via Intune on a writable tenant", () => {
    const r = preflight({
      vuln: appVuln,
      device,
      tenant: writableTenant,
      channel: "intune-remediation",
      writeGate: { allowed: true, reason: null },
    });
    expect(r.canProceed).toBe(true);
    expect(status(r, "consent")).toBe("pass");
    expect(status(r, "write-actions")).toBe("pass");
    expect(status(r, "licensing")).toBe("pass");
    expect(status(r, "patch-type")).toBe("pass");
    expect(status(r, "winget-package")).toBe("pass");
  });

  it("blocks every write on a read-only tenant", () => {
    const r = preflight({
      vuln: appVuln,
      device,
      tenant: { ...writableTenant, readOnly: true },
      channel: "intune-remediation",
      writeGate: { allowed: true, reason: null },
    });
    expect(r.canProceed).toBe(false);
    expect(status(r, "write-actions")).toBe("fail");
  });

  it("fails licensing when the channel's license is missing", () => {
    // live-response needs defender-business-premium, which contoso lacks.
    const r = preflight({
      vuln: appVuln,
      device,
      tenant: writableTenant,
      channel: "live-response",
      writeGate: { allowed: true, reason: null },
    });
    expect(r.canProceed).toBe(false);
    expect(status(r, "licensing")).toBe("fail");
  });

  it("fails when the channel does not support the patch type", () => {
    // Intune remediation supports app, not OS.
    const r = preflight({
      vuln: osVuln,
      device,
      tenant: writableTenant,
      channel: "intune-remediation",
      writeGate: { allowed: true, reason: null },
    });
    expect(r.canProceed).toBe(false);
    expect(status(r, "patch-type")).toBe("fail");
  });

  it("routes OS patches through the expedited quality update channel", () => {
    const r = preflight({
      vuln: osVuln,
      device,
      tenant: writableTenant,
      channel: "expedited-quality-update",
      writeGate: { allowed: true, reason: null },
    });
    expect(r.canProceed).toBe(true);
    expect(status(r, "patch-type")).toBe("pass");
    // OS finding -> no winget-package check.
    expect(r.checks.find((c) => c.id === "winget-package")).toBeUndefined();
  });

  it("fails when the device lacks the channel's target identifier", () => {
    const r = preflight({
      vuln: appVuln,
      device: { ...device, defenderMachineId: null },
      tenant: writableTenant,
      channel: "live-response",
      writeGate: { allowed: true, reason: null },
    });
    expect(status(r, "device-target")).toBe("fail");
    expect(r.canProceed).toBe(false);
  });

  it("warns (does not block) when the device has never checked in", () => {
    const r = preflight({
      vuln: appVuln,
      device: { ...device, lastSeen: null },
      tenant: writableTenant,
      channel: "intune-remediation",
      writeGate: { allowed: true, reason: null },
    });
    expect(status(r, "device-health")).toBe("warn");
    expect(r.canProceed).toBe(true);
  });

  // Device exclusion. PatchPilot's exclusion blocks remediation as well as
  // hiding the device — Defender's is visibility-only — so these are the tests
  // that prove the extra enforcement actually holds at the dispatch gate.
  it("blocks remediation on an excluded device", () => {
    const r = preflight({
      vuln: appVuln,
      device: { ...device, excluded: true, exclusionReason: "Out of scope" },
      tenant: writableTenant,
      channel: "intune-remediation",
      writeGate: { allowed: true, reason: null },
    });
    expect(r.canProceed).toBe(false);
    expect(status(r, "device-excluded")).toBe("fail");
  });

  it("names the justification in the exclusion failure detail", () => {
    const r = preflight({
      vuln: appVuln,
      device: {
        ...device,
        excluded: true,
        exclusionReason: "Duplicate device — reimaged as CON-LT-014b",
      },
      tenant: writableTenant,
      channel: "intune-remediation",
      writeGate: { allowed: true, reason: null },
    });
    expect(r.checks.find((c) => c.id === "device-excluded")?.detail).toContain(
      "Duplicate device — reimaged as CON-LT-014b",
    );
  });

  it("adds no exclusion check for a device that is not excluded", () => {
    const r = preflight({
      vuln: appVuln,
      device,
      tenant: writableTenant,
      channel: "intune-remediation",
      writeGate: { allowed: true, reason: null },
    });
    expect(r.checks.find((c) => c.id === "device-excluded")).toBeUndefined();
    expect(r.canProceed).toBe(true);
  });

  // Cancelled and expired exclusions are filtered out by isExclusionLive before
  // the flag is ever set, so the two together are what prove a lapsed exclusion
  // cannot keep blocking work.
  it("treats a cancelled exclusion as not live", () => {
    expect(isExclusionLive({ status: "cancelled", expiresAt: null })).toBe(false);
  });

  it("treats an exclusion past its review date as not live", () => {
    expect(
      isExclusionLive({ status: "active", expiresAt: new Date("2020-01-01T00:00:00Z") }),
    ).toBe(false);
  });

  it("treats an exclusion with no review date as live forever (Defender parity)", () => {
    expect(isExclusionLive({ status: "active", expiresAt: null })).toBe(true);
  });

  it("blocks Run Now for software requiring manual remediation (OpenSSL)", () => {
    const opensslVuln: PreflightVuln = {
      ...appVuln,
      software: "OpenSSL",
      wingetPackageId: null,
    };
    const r = preflight({
      vuln: opensslVuln,
      device,
      tenant: writableTenant,
      channel: "intune-remediation",
      writeGate: { allowed: true, reason: null },
    });
    expect(r.canProceed).toBe(false);
    expect(status(r, "manual-remediation")).toBe("fail");
  });

  it("blocks Run Now for software requiring manual remediation (MySQL)", () => {
    const mysqlVuln: PreflightVuln = {
      ...appVuln,
      software: "MySQL Server 8.0",
      wingetPackageId: "Oracle.MySQL",
    };
    const r = preflight({
      vuln: mysqlVuln,
      device,
      tenant: writableTenant,
      channel: "intune-remediation",
      writeGate: { allowed: true, reason: null },
    });
    expect(r.canProceed).toBe(false);
    expect(status(r, "manual-remediation")).toBe("fail");
  });

  it("does not flag unrelated software for manual remediation", () => {
    const r = preflight({
      vuln: appVuln,
      device,
      tenant: writableTenant,
      channel: "intune-remediation",
      writeGate: { allowed: true, reason: null },
    });
    expect(r.checks.find((c) => c.id === "manual-remediation")).toBeUndefined();
  });

  const liveResponseLicensedTenant: PreflightTenant = {
    ...writableTenant,
    licenses: ["intune", "defender-business-premium"],
  };

  it("blocks a per-user install with no alternate source via Intune (SYSTEM-only channel)", () => {
    const r = preflight({
      vuln: appVuln,
      device,
      tenant: writableTenant,
      channel: "intune-remediation",
      writeGate: { allowed: true, reason: null },
      installScope: "user",
    });
    expect(r.canProceed).toBe(false);
    expect(status(r, "install-scope")).toBe("fail");
  });

  it("warns rather than blocks a per-user install via Live Response, which can reach it via the signed-in user", () => {
    const r = preflight({
      vuln: appVuln,
      device,
      tenant: liveResponseLicensedTenant,
      channel: "live-response",
      writeGate: { allowed: true, reason: null },
      installScope: "user",
    });
    expect(status(r, "install-scope")).toBe("warn");
    expect(r.canProceed).toBe(true);
  });

  it("does not flag install scope at all once an alternate source is chosen", () => {
    const r = preflight({
      vuln: appVuln,
      device,
      tenant: writableTenant,
      channel: "intune-remediation",
      writeGate: { allowed: true, reason: null },
      installScope: "user",
      source: "chocolatey",
      altPackageId: "7zip",
    });
    expect(r.checks.find((c) => c.id === "install-scope")).toBeUndefined();
  });
});
