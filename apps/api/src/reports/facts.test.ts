import { describe, expect, it, vi } from "vitest";
import type { DeviceRow, TenantRow } from "@patchpilot/db";
import type { PostureFinding, TenantPosture } from "../posture/findings.js";

// `rollupTenantPostures` pulls two things per tenant — `loadTenantPosture`
// and `loadActiveExceptions` — and folds them. Everything else it uses
// (`severityCounts`/`slaCounts`/`complianceCounts`) is pure and stays real via
// `importActual`, so the fold under test is exercised with its actual math,
// not a second mock of the thing that would catch a regression in it.
const { loadTenantPostureMock } = vi.hoisted(() => ({ loadTenantPostureMock: vi.fn() }));
vi.mock("../posture/findings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../posture/findings.js")>();
  return { ...actual, loadTenantPosture: loadTenantPostureMock };
});

const { loadActiveExceptionsMock } = vi.hoisted(() => ({ loadActiveExceptionsMock: vi.fn() }));
vi.mock("../routes/recommendations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routes/recommendations.js")>();
  return { ...actual, loadActiveExceptions: loadActiveExceptionsMock };
});

const { rollupTenantPostures } = await import("./facts.js");

const THRESHOLDS = { critical: 7, high: 14, medium: 30, low: 90, verifiedExploit: 3 };
const NOW = new Date("2026-08-15T00:00:00Z");

function makeTenant(overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    id: crypto.randomUUID(),
    tenantId: "tenant-a",
    displayName: "Tenant A",
    consentStatus: "consented",
    reachability: "reachable",
    readOnly: false,
    licenses: [],
    isMspTenant: false,
    lastSyncedAt: NOW,
    featureUpdateTargetVersion: null,
    liveResponseDeviceLimit: 0,
    createdAt: NOW,
    ...overrides,
  };
}

function makeDevice(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: crypto.randomUUID(),
    tenantId: "tenant-a",
    managedDeviceId: "md-1",
    defenderMachineId: null,
    hostname: "host-1",
    os: "Windows 11",
    lastSeen: NOW,
    compliance: "compliant",
    vulnerabilityCount: 0,
    owner: null,
    model: null,
    manufacturer: null,
    serialNumber: null,
    deviceGroupId: null,
    deviceGroupName: null,
    osBuild: null,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<PostureFinding> = {}): PostureFinding {
  return {
    id: crypto.randomUUID(),
    cveId: "CVE-2026-0001",
    title: "Sample vulnerability",
    software: "Sample App",
    severity: "critical",
    detectedAt: NOW,
    affectedDeviceCount: 1,
    exploitVerified: false,
    sla: { daysRemaining: 3, overdue: false, dueDate: NOW, severity: "critical" },
    tone: "due-soon",
    ...overrides,
  };
}

function mockPostureFor(tenantId: string, posture: TenantPosture, exceptionCount: number) {
  loadTenantPostureMock.mockImplementation(async (id: string) => {
    if (id !== tenantId) throw new Error(`unexpected tenantId ${id}`);
    return posture;
  });
  loadActiveExceptionsMock.mockImplementation(async (id: string) => {
    if (id !== tenantId) throw new Error(`unexpected tenantId ${id}`);
    return Array.from({ length: exceptionCount }, () => ({}));
  });
}

describe("rollupTenantPostures", () => {
  it("returns an empty rollup for zero tenants", async () => {
    const rollup = await rollupTenantPostures([], THRESHOLDS, NOW);

    expect(rollup.tenants).toEqual([]);
    expect(rollup.findings).toEqual([]);
    expect(rollup.devices).toEqual([]);
    expect(rollup.severity).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(rollup.sla).toEqual({ ok: 0, "due-soon": 0, breached: 0 });
    expect(rollup.compliance).toEqual({ compliant: 0, noncompliant: 0, unknown: 0 });
    expect(rollup.exceptedFindings).toBe(0);
    expect(rollup.excludedDevices).toBe(0);
    expect(rollup.activeExceptions).toBe(0);
    expect(rollup.perTenant).toEqual([]);
  });

  it("sums findings, devices, exceptions and exclusions across multiple tenants", async () => {
    const tenantA = makeTenant({ tenantId: "tenant-a", displayName: "Tenant A" });
    const tenantB = makeTenant({ tenantId: "tenant-b", displayName: "Tenant B" });

    const postureA: TenantPosture = {
      tenantId: "tenant-a",
      thresholds: THRESHOLDS,
      findings: [
        makeFinding({ severity: "critical", tone: "breached" }),
        makeFinding({ severity: "high", tone: "ok" }),
      ],
      devices: [
        makeDevice({ tenantId: "tenant-a", compliance: "compliant" }),
        makeDevice({ tenantId: "tenant-a", compliance: "noncompliant" }),
      ],
      exceptedFindings: 1,
      excludedDevices: 0,
    };
    const postureB: TenantPosture = {
      tenantId: "tenant-b",
      thresholds: THRESHOLDS,
      findings: [makeFinding({ severity: "medium", tone: "due-soon" })],
      devices: [makeDevice({ tenantId: "tenant-b", compliance: "unknown" })],
      exceptedFindings: 0,
      excludedDevices: 2,
    };

    loadTenantPostureMock.mockImplementation(async (id: string) =>
      id === "tenant-a" ? postureA : postureB,
    );
    loadActiveExceptionsMock.mockImplementation(async (id: string) =>
      id === "tenant-a" ? [{}] : [],
    );

    const rollup = await rollupTenantPostures([tenantA, tenantB], THRESHOLDS, NOW);

    expect(rollup.tenants).toEqual([tenantA, tenantB]);
    expect(rollup.findings).toHaveLength(3);
    expect(rollup.devices).toHaveLength(3);
    expect(rollup.severity).toEqual({ critical: 1, high: 1, medium: 1, low: 0 });
    expect(rollup.sla).toEqual({ ok: 1, "due-soon": 1, breached: 1 });
    expect(rollup.compliance).toEqual({ compliant: 1, noncompliant: 1, unknown: 1 });
    // Summed from each tenant's own posture, not recomputed here.
    expect(rollup.exceptedFindings).toBe(1);
    expect(rollup.excludedDevices).toBe(2);
    // Summed from loadActiveExceptions().length per tenant.
    expect(rollup.activeExceptions).toBe(1);
  });

  it("propagates exceptedFindings and excludedDevices for a single tenant", async () => {
    const tenant = makeTenant({ tenantId: "tenant-a", displayName: "Tenant A" });
    const posture: TenantPosture = {
      tenantId: "tenant-a",
      thresholds: THRESHOLDS,
      findings: [makeFinding()],
      devices: [makeDevice()],
      exceptedFindings: 4,
      excludedDevices: 7,
    };
    mockPostureFor("tenant-a", posture, 3);

    const rollup = await rollupTenantPostures([tenant], THRESHOLDS, NOW);

    expect(rollup.exceptedFindings).toBe(4);
    expect(rollup.excludedDevices).toBe(7);
    expect(rollup.activeExceptions).toBe(3);
    expect(rollup.perTenant).toHaveLength(1);
    expect(rollup.perTenant[0]).toMatchObject({
      tenantId: "tenant-a",
      displayName: "Tenant A",
      devices: 1,
    });
  });

  it("sorts perTenant by SLA breaches descending, then by display name", async () => {
    const tenantA = makeTenant({ tenantId: "tenant-a", displayName: "Zeta Corp" });
    const tenantB = makeTenant({ tenantId: "tenant-b", displayName: "Acme Inc" });
    const tenantC = makeTenant({ tenantId: "tenant-c", displayName: "Beta LLC" });

    const lowBreach: TenantPosture = {
      tenantId: "tenant-a",
      thresholds: THRESHOLDS,
      findings: [makeFinding({ tone: "breached" })],
      devices: [],
      exceptedFindings: 0,
      excludedDevices: 0,
    };
    const highBreach: TenantPosture = {
      tenantId: "tenant-b",
      thresholds: THRESHOLDS,
      findings: [
        makeFinding({ tone: "breached" }),
        makeFinding({ tone: "breached" }),
      ],
      devices: [],
      exceptedFindings: 0,
      excludedDevices: 0,
    };
    const noBreach: TenantPosture = {
      tenantId: "tenant-c",
      thresholds: THRESHOLDS,
      findings: [],
      devices: [],
      exceptedFindings: 0,
      excludedDevices: 0,
    };

    loadTenantPostureMock.mockImplementation(async (id: string) => {
      if (id === "tenant-a") return lowBreach;
      if (id === "tenant-b") return highBreach;
      return noBreach;
    });
    loadActiveExceptionsMock.mockImplementation(async () => []);

    const rollup = await rollupTenantPostures([tenantA, tenantB, tenantC], THRESHOLDS, NOW);

    expect(rollup.perTenant.map((t) => t.displayName)).toEqual(["Acme Inc", "Zeta Corp", "Beta LLC"]);
  });
});
