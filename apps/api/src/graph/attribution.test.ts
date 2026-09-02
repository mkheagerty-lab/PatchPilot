import { describe, expect, it } from "vitest";
import { tables } from "@patchpilot/db";
import { attributeClears, detectReclassifiedCves, type DoomedFinding } from "./attribution.js";

/**
 * Fakes just enough of a drizzle transaction for attribution.ts's own query
 * shape: `tx.select({...}).from(table).where(cond)`, resolved by matching
 * the `table` argument's identity against the real `tables.*` exports (the
 * same singletons attribution.ts imports), so no real database is needed to
 * unit-test the matching logic itself.
 */
function fakeTx(data: {
  manualRemediations?: unknown[];
  devices?: unknown[];
  jobs?: unknown[];
  vulnerabilities?: unknown[];
}) {
  const byTable = new Map<unknown, unknown[]>([
    [tables.manualRemediations, data.manualRemediations ?? []],
    [tables.devices, data.devices ?? []],
    [tables.jobs, data.jobs ?? []],
    [tables.vulnerabilities, data.vulnerabilities ?? []],
  ]);
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => Promise.resolve(byTable.get(table) ?? []),
      }),
    }),
  } as any;
}

const TENANT = "contoso";
const NOW = new Date("2026-06-23T12:00:00Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

function chromeFinding(overrides: Partial<DoomedFinding> = {}): DoomedFinding {
  return {
    kind: "vulnerability",
    cveId: "CVE-2026-1111",
    recommendationId: null,
    software: "Google Chrome",
    detectedAt: hoursAgo(48),
    wingetPackageId: "Google.Chrome",
    ...overrides,
  };
}

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    deviceId: "device-1",
    deviceHostname: "CON-LT-001",
    cveId: "CVE-2026-1111",
    software: "Google Chrome",
    packageId: "Google.Chrome",
    channel: "live-response" as const,
    engineer: "engineer@blackiron.example",
    queuedAt: hoursAgo(2),
    startedAt: hoursAgo(1.5),
    finishedAt: hoursAgo(1),
    ...overrides,
  };
}

describe("attributeClears", () => {
  it("attributes to a job matching on CVE + software title", async () => {
    const finding = chromeFinding();
    const tx = fakeTx({ jobs: [baseJob()] });

    const result = await attributeClears(tx, TENANT, [finding], NOW);
    const key = `${finding.cveId}|${finding.software}`;

    expect(result.get(key)).toMatchObject({
      attribution: "job",
      jobId: "job-1",
      deviceId: "device-1",
      deviceHostname: "CON-LT-001",
      engineer: "engineer@blackiron.example",
      channel: "live-response",
      contributingJobs: 1,
    });
  });

  it("matches on winget package id when the free-text software title disagrees", async () => {
    const finding = chromeFinding({ software: "Chrome (64-bit)" });
    const job = baseJob({ software: "Google Chrome" }); // titles differ, packageId agrees
    const tx = fakeTx({ jobs: [job] });

    const result = await attributeClears(tx, TENANT, [finding], NOW);
    const key = `${finding.cveId}|${finding.software}`;

    expect(result.get(key)?.attribution).toBe("job");
    expect(result.get(key)?.jobId).toBe("job-1");
  });

  it("falls back to CVE-only when the job carries no software at all", async () => {
    const finding = chromeFinding();
    const job = baseJob({ software: null, packageId: null });
    const tx = fakeTx({ jobs: [job] });

    const result = await attributeClears(tx, TENANT, [finding], NOW);
    const key = `${finding.cveId}|${finding.software}`;

    expect(result.get(key)?.attribution).toBe("job");
  });

  it("does not attribute a Chrome job to an Edge finding sharing the same shared-engine CVE", async () => {
    const chrome = chromeFinding({ software: "Google Chrome" });
    const edge = chromeFinding({
      software: "Microsoft Edge (Chromium-based)",
      wingetPackageId: "Microsoft.Edge",
    });
    const chromeJob = baseJob({ software: "Google Chrome", packageId: "Google.Chrome" });
    const tx = fakeTx({ jobs: [chromeJob] });

    const result = await attributeClears(tx, TENANT, [chrome, edge], NOW);

    expect(result.get(`${chrome.cveId}|${chrome.software}`)?.attribution).toBe("job");
    expect(result.get(`${edge.cveId}|${edge.software}`)?.attribution).toBe("unattributed");
  });

  it("prefers a pending manual remediation over a matching succeeded job", async () => {
    const finding = chromeFinding();
    const manual = {
      deviceId: "device-2",
      cveId: finding.cveId,
      software: finding.software,
      engineer: "hand.fixed@blackiron.example",
      markedAt: hoursAgo(3),
    };
    const tx = fakeTx({
      manualRemediations: [manual],
      devices: [{ id: "device-2", hostname: "CON-DT-009" }],
      jobs: [baseJob()],
    });

    const result = await attributeClears(tx, TENANT, [finding], NOW);
    const key = `${finding.cveId}|${finding.software}`;

    expect(result.get(key)).toMatchObject({
      attribution: "manual",
      deviceId: "device-2",
      deviceHostname: "CON-DT-009",
      engineer: "hand.fixed@blackiron.example",
      jobId: null,
      fixStartedAt: manual.markedAt,
      fixFinishedAt: manual.markedAt,
    });
  });

  it("picks the newest of several matching jobs and counts every match in contributingJobs", async () => {
    const finding = chromeFinding();
    const older = baseJob({ id: "job-old", deviceId: "device-a", finishedAt: hoursAgo(20) });
    const newer = baseJob({ id: "job-new", deviceId: "device-b", finishedAt: hoursAgo(1) });
    const tx = fakeTx({ jobs: [older, newer] });

    const result = await attributeClears(tx, TENANT, [finding], NOW);
    const key = `${finding.cveId}|${finding.software}`;
    const attribution = result.get(key);

    expect(attribution?.jobId).toBe("job-new");
    expect(attribution?.deviceId).toBe("device-b");
    expect(attribution?.contributingJobs).toBe(2);
  });

  it("leaves a finding unattributed when neither a manual record nor a job matches", async () => {
    const finding = chromeFinding();
    const tx = fakeTx({});

    const result = await attributeClears(tx, TENANT, [finding], NOW);
    const key = `${finding.cveId}|${finding.software}`;

    expect(result.get(key)).toEqual({
      attribution: "unattributed",
      deviceId: null,
      deviceHostname: null,
      engineer: null,
      jobId: null,
      channel: null,
      fixStartedAt: null,
      fixFinishedAt: null,
      contributingJobs: 0,
    });
  });

  it("matches recommendation findings on software alone (no cveId to key on)", async () => {
    const finding = chromeFinding({
      kind: "recommendation",
      cveId: null,
      recommendationId: "rec-123",
      wingetPackageId: null,
    });
    const job = baseJob({ cveId: null, software: "Google Chrome" });
    const tx = fakeTx({ jobs: [job] });

    const result = await attributeClears(tx, TENANT, [finding], NOW);
    const key = `${finding.recommendationId}|${finding.software}`;

    expect(result.get(key)?.attribution).toBe("job");
  });

  it("returns an empty map for an empty doomed list without querying anything", async () => {
    const tx = fakeTx({});
    const result = await attributeClears(tx, TENANT, [], NOW);
    expect(result.size).toBe(0);
  });
});

describe("detectReclassifiedCves", () => {
  it("flags a CVE whose surviving row this sync carries a different software title", async () => {
    const tx = fakeTx({
      vulnerabilities: [{ cveId: "CVE-2026-2222" }],
    });

    const reclassified = await detectReclassifiedCves(tx, TENANT, ["CVE-2026-2222"], NOW);
    expect(reclassified.has("CVE-2026-2222")).toBe(true);
  });

  it("does not flag a CVE with no surviving row this sync", async () => {
    const tx = fakeTx({ vulnerabilities: [] });
    const reclassified = await detectReclassifiedCves(tx, TENANT, ["CVE-2026-3333"], NOW);
    expect(reclassified.has("CVE-2026-3333")).toBe(false);
  });

  it("returns an empty set for an empty cveIds list without querying anything", async () => {
    const tx = fakeTx({});
    const reclassified = await detectReclassifiedCves(tx, TENANT, [], NOW);
    expect(reclassified.size).toBe(0);
  });
});
