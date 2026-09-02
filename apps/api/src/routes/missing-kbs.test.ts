import Fastify, { type FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fastify `.inject()` coverage for the missing-KBs routes, focused on the
 * validation/guard logic this session added on top of the existing
 * preflight/dispatch pipeline (Feature A's scheduleAt, Feature B's
 * qualityUpdate* options and the two new quality-update-releases/campaigns
 * routes) — same harness shape as feature-updates.test.ts: an in-memory,
 * table-reference-keyed `@patchpilot/db` mock, a fake `session.engineer` +
 * `currentUser` via a top-level `onRequest` hook, and the Graph-calling
 * boundary mocked directly. `/fix` and `/fix-all`'s deep preflight/createJob
 * path (real tenant/device/KB rows, BullMQ dispatch) is intentionally out of
 * scope here — every case below is decided by validation that runs before
 * any of that, so it needs no createJob/queue mocking at all.
 *
 * `resolveAssignmentTargets` (from `../services/win32-app-deploy.js`) is left
 * real for the quality-update-campaigns tests below — it's a pure,
 * synchronous target-array builder now that group ids are resolved
 * client-side by the Entra group picker, so there's no Graph call left in
 * that route to mock beyond the profile-create/assign call itself.
 */

const { tableRows, insertedRows, auditMock, createProfileMock, listReleasesMock } = vi.hoisted(() => ({
  tableRows: new Map<unknown, unknown[]>(),
  insertedRows: new Map<unknown, unknown[]>(),
  auditMock: vi.fn(),
  createProfileMock: vi.fn(),
  listReleasesMock: vi.fn(),
}));

interface Chain extends PromiseLike<unknown[]> {
  where: () => Chain;
  limit: (n: number) => Chain;
  orderBy: () => Chain;
}

function chain(rows: unknown[]): Chain {
  return {
    where: () => chain(rows),
    limit: (n: number) => chain(rows.slice(0, n)),
    orderBy: () => chain(rows),
    then: (onFulfilled, onRejected) => Promise.resolve(rows).then(onFulfilled, onRejected),
  };
}

vi.mock("@patchpilot/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@patchpilot/db")>();
  const db = {
    select: () => ({
      from: (table: unknown) => chain(tableRows.get(table) ?? []),
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        returning: async () => {
          const row = { id: `row-${(insertedRows.get(table)?.length ?? 0) + 1}`, createdAt: new Date(), ...vals };
          const list = insertedRows.get(table) ?? [];
          list.push(row);
          insertedRows.set(table, list);
          return [row];
        },
      }),
    }),
  };
  return { ...actual, db };
});

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, config: { ...actual.config, DEMO_MODE: false } };
});

vi.mock("@patchpilot/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@patchpilot/graph")>();
  return {
    ...actual,
    audit: auditMock,
    createAndAssignQualityUpdateProfile: createProfileMock,
    listQualityUpdateCatalogItems: listReleasesMock,
  };
});

const { missingKbRoutes } = await import("./missing-kbs.js");
const { tables, demoMissingKbs } = await import("@patchpilot/db");
const { config } = await import("../config.js");
const { GraphError } = await import("@patchpilot/graph");

const TENANT_ID = "customer-tenant";
const ENGINEER = { upn: "engineer@example.com", displayName: "Engineer", homeTenantId: "home-tenant" };
const DEVICE_ID = "11111111-1111-1111-1111-111111111111";
const KB_ROW_ID = "22222222-2222-2222-2222-222222222222";

function setTenant(overrides: Record<string, unknown> = {}) {
  tableRows.set(tables.tenants, [
    {
      tenantId: TENANT_ID,
      displayName: "Customer",
      readOnly: false,
      consentStatus: "consented",
      licenses: ["intune"],
      ...overrides,
    },
  ]);
}

function setDevice(overrides: Record<string, unknown> = {}) {
  tableRows.set(tables.devices, [
    {
      id: DEVICE_ID,
      tenantId: TENANT_ID,
      hostname: "WKS-01",
      os: "Windows 11",
      defenderMachineId: "machine-1",
      ...overrides,
    },
  ]);
}

function setMissingKb(overrides: Record<string, unknown> = {}) {
  tableRows.set(tables.missingKbs, [
    {
      id: KB_ROW_ID,
      tenantId: TENANT_ID,
      deviceId: DEVICE_ID,
      kbId: "5121003",
      title: "2026-08 Cumulative Update for Windows 11",
      products: ["Windows 11"],
      cveCount: 1,
      cveIds: ["CVE-2026-1234"],
      url: null,
      syncedAt: new Date(),
      ...overrides,
    },
  ]);
}

async function buildApp() {
  const app = Fastify();
  app.decorateRequest("session", null as unknown as never);
  app.decorateRequest("currentUser", null as unknown as never);
  app.addHook("onRequest", async (req) => {
    // Test-only session stand-in — the real shape comes from @fastify/session.
    req.session = { engineer: ENGINEER } as FastifyRequest["session"];
    req.currentUser = { id: "engineer-1", upn: ENGINEER.upn, displayName: ENGINEER.displayName, role: "admin" };
  });
  await app.register(missingKbRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  tableRows.clear();
  insertedRows.clear();
  auditMock.mockReset().mockResolvedValue(undefined);
  createProfileMock.mockReset().mockResolvedValue("profile-1");
  listReleasesMock.mockReset().mockResolvedValue([]);
  config.DEMO_MODE = false;
  setTenant();
  setDevice();
  setMissingKb();
});

describe("POST /api/missing-kbs/fix", () => {
  const BODY = { tenantId: TENANT_ID, id: KB_ROW_ID, channel: "live-response" };

  it("returns 400 when tenantId, id or channel is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/missing-kbs/fix", payload: { tenantId: TENANT_ID } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("tenantId, id and channel are required");
    await app.close();
  });

  it("returns 400 for an unknown channel", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/fix",
      payload: { ...BODY, channel: "carrier-pigeon" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("unknown channel");
    await app.close();
  });

  it("returns 400 when qualityUpdateDaysUntilForcedReboot is out of range", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/fix",
      payload: { ...BODY, channel: "expedited-quality-update", qualityUpdateDaysUntilForcedReboot: 3 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("qualityUpdateDaysUntilForcedReboot must be 0, 1, or 2");
    await app.close();
  });

  it("returns 400 for an invalid scheduleAt", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/fix",
      payload: { ...BODY, scheduleAt: "not-a-date" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 when the tenant does not exist", async () => {
    tableRows.set(tables.tenants, []);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/missing-kbs/fix", payload: BODY });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("tenant not found");
    await app.close();
  });
});

describe("POST /api/missing-kbs/fix-all", () => {
  const BODY = { tenantId: TENANT_ID, kbId: "5121003", channel: "live-response" };

  it("returns 400 when tenantId, kbId or channel is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/missing-kbs/fix-all", payload: { tenantId: TENANT_ID } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("tenantId, kbId and channel are required");
    await app.close();
  });

  it("returns 400 when the channel does not support OS remediation", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/fix-all",
      payload: { ...BODY, channel: "win32-app" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("does not support OS remediation");
    await app.close();
  });

  it("returns 400 when qualityUpdateDaysUntilForcedReboot is out of range", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/fix-all",
      payload: { ...BODY, channel: "expedited-quality-update", qualityUpdateDaysUntilForcedReboot: -1 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("qualityUpdateDaysUntilForcedReboot must be 0, 1, or 2");
    await app.close();
  });

  it("returns 404 when no device is currently missing that KB", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/fix-all",
      payload: { ...BODY, kbId: "9999999" },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("missing KB not found");
    await app.close();
  });
});

describe("GET /api/missing-kbs/:id/quality-update-releases", () => {
  it("returns 400 when tenantId is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/missing-kbs/${KB_ROW_ID}/quality-update-releases` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 when the missing KB row does not exist", async () => {
    // The mock db chain's `.where()` doesn't actually filter (see `chain()`
    // above), so an empty table is what makes "not found" observable here —
    // a mismatched id in the URL alone wouldn't be, since the chain would
    // still hand back whatever's in `tableRows` regardless of the id.
    tableRows.set(tables.missingKbs, []);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/missing-kbs/does-not-exist/quality-update-releases?tenantId=${TENANT_ID}`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns an empty list in demo mode without calling Graph", async () => {
    // In demo mode, loadMissingKbById reads from the real `demoMissingKbs`
    // fixtures (not the mocked db table), so the lookup needs a real fixture
    // id/tenantId rather than our synthetic KB_ROW_ID/TENANT_ID.
    config.DEMO_MODE = true;
    const demoKb = demoMissingKbs[0]!;
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/missing-kbs/${demoKb.id}/quality-update-releases?tenantId=${demoKb.tenantId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ releases: [] });
    expect(listReleasesMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("annotates catalog items with cadence and reflects the KB match", async () => {
    listReleasesMock.mockResolvedValue([
      { id: "item-1", displayName: "08/12/2026 - 2026.08 B Cumulative Update for Windows 11", isExpeditable: true },
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/missing-kbs/${KB_ROW_ID}/quality-update-releases?tenantId=${TENANT_ID}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0]).toMatchObject({ id: "item-1", cadence: "B" });
    await app.close();
  });

  it("reduces to only the single latest B and single latest OOB release, matching Intune's own wizard", async () => {
    listReleasesMock.mockResolvedValue([
      { id: "b-old", displayName: "07/08/2026 - 2026.07 B Cumulative Update for Windows 11", isExpeditable: true },
      { id: "b-new", displayName: "08/12/2026 - 2026.08 B Cumulative Update for Windows 11", isExpeditable: true },
      { id: "oob-old", displayName: "06/01/2026 - 2026.06 OOB SecurityUpdate for Windows 11", isExpeditable: true },
      { id: "oob-new", displayName: "07/18/2026 - 2026.07 OOB SecurityUpdate for Windows 11", isExpeditable: true },
      { id: "preview", displayName: "07/25/2026 - 2026.07 D Update for Windows 11", isExpeditable: true },
      {
        id: "not-expeditable",
        displayName: "08/20/2026 - 2026.08 B Cumulative Update for Windows 11",
        isExpeditable: false,
      },
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/missing-kbs/${KB_ROW_ID}/quality-update-releases?tenantId=${TENANT_ID}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.releases.map((r: { id: string }) => r.id).sort()).toEqual(["b-new", "oob-new"]);
    await app.close();
  });

  it("surfaces a failed catalog fetch as an error status, not an empty release list", async () => {
    // Regression: a transient Graph failure (expired token, 429, 5xx) used to
    // come back from listQualityUpdateCatalogItems as a silently swallowed
    // empty array, indistinguishable from "this tenant's catalog genuinely has
    // no releases" — live-observed against BLACK IRON as a false "No
    // expeditable releases found" for a KB Intune's own UI showed did have
    // releases for.
    listReleasesMock.mockRejectedValue(new GraphError(503, "failed to list quality-update catalog (HTTP 503)"));
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/missing-kbs/${KB_ROW_ID}/quality-update-releases?tenantId=${TENANT_ID}`,
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toMatch(/HTTP 503/);
    await app.close();
  });
});

describe("POST /api/missing-kbs/quality-update-campaigns", () => {
  const CAMPAIGN_BODY = {
    tenantId: TENANT_ID,
    displayName: "Expedite KB5121003 — Finance",
    kbId: "5121003",
    catalogItemId: "item-1",
    releaseLabel: "2026.08 B",
    daysUntilForcedReboot: 1,
    groupId: "group-1",
    groupName: "Finance workstations",
  };

  it("returns 409 in demo mode", async () => {
    config.DEMO_MODE = true;
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/quality-update-campaigns",
      payload: CAMPAIGN_BODY,
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("returns 400 when required fields are missing", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/quality-update-campaigns",
      payload: { tenantId: TENANT_ID },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 400 when daysUntilForcedReboot is out of range", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/quality-update-campaigns",
      payload: { ...CAMPAIGN_BODY, daysUntilForcedReboot: 5 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("daysUntilForcedReboot must be 0, 1 or 2");
    await app.close();
  });

  it("returns 404 when the tenant does not exist", async () => {
    tableRows.set(tables.tenants, []);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/quality-update-campaigns",
      payload: CAMPAIGN_BODY,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 403 when the tenant is read-only", async () => {
    setTenant({ readOnly: true });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/quality-update-campaigns",
      payload: CAMPAIGN_BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(createProfileMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 400 when groupId is missing", async () => {
    const { groupId: _groupId, ...rest } = CAMPAIGN_BODY;
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/quality-update-campaigns",
      payload: rest,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("groupId");
    expect(createProfileMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates and assigns the profile, then records the campaign", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/quality-update-campaigns",
      payload: CAMPAIGN_BODY,
    });

    expect(res.statusCode).toBe(201);
    expect(createProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        catalogItemId: "item-1",
        kbId: "5121003",
        daysUntilForcedReboot: 1,
        targets: [
          expect.objectContaining({
            "@odata.type": "#microsoft.graph.groupAssignmentTarget",
            groupId: "group-1",
          }),
        ],
      }),
    );
    expect(insertedRows.get(tables.qualityUpdateCampaigns)).toHaveLength(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "quality-update-campaign:create" }),
    );
    await app.close();
  });

  it("also assigns an exclude target when excludeGroupId is given", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/quality-update-campaigns",
      payload: { ...CAMPAIGN_BODY, excludeGroupId: "group-2", excludeGroupName: "Contractors" },
    });

    expect(res.statusCode).toBe(201);
    expect(createProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          expect.objectContaining({ groupId: "group-1" }),
          expect.objectContaining({
            "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget",
            groupId: "group-2",
          }),
        ],
      }),
    );
    await app.close();
  });

  it("surfaces a Graph error status when profile creation fails", async () => {
    createProfileMock.mockRejectedValue(new GraphError(502, "Bad Gateway"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/missing-kbs/quality-update-campaigns",
      payload: CAMPAIGN_BODY,
    });
    expect(res.statusCode).toBe(502);
    expect(insertedRows.get(tables.qualityUpdateCampaigns) ?? []).toHaveLength(0);
    await app.close();
  });
});
