import Fastify, { type FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Full Fastify `.inject()` coverage for the feature-update campaign route —
 * no repo precedent for this (every other `routes/*.test.ts` file tests only
 * an extracted pure function), but `feature-updates.ts` has no pure functions
 * to extract: all its validation/guard/error-mapping logic lives inside the
 * route handler closure. Pulling it out just to make it unit-testable would
 * be a bigger change than the tests are worth, so this builds a minimal
 * harness instead — fake `session.engineer` + `currentUser` via a top-level
 * `onRequest` hook (mirroring what the real app wires globally, see
 * types.d.ts), `@patchpilot/db` mocked with an in-memory, table-reference-keyed
 * store (same pattern as apps/worker/src/executor.test.ts), and the Graph-
 * calling boundary mocked directly. `@patchpilot/shared`'s pure helpers
 * (resolveTargetBuild, etc.) are left real so the tests exercise the actual
 * business logic, not a synthetic stand-in for it. `resolveAssignmentTargets`
 * (from `../services/win32-app-deploy.js`) is left real too — it's a pure,
 * synchronous target-array builder now that group ids are resolved
 * client-side by the Entra group picker, so there's no Graph call left in
 * this route to mock beyond the profile-create/assign call itself.
 */

const {
  tableRows,
  insertedRows,
  deletedRows,
  auditMock,
  createCampaignProfileMock,
  syncFeatureUpdateProfilesMock,
  deleteFeatureUpdateProfileMock,
} = vi.hoisted(() => ({
  tableRows: new Map<unknown, unknown[]>(),
  insertedRows: new Map<unknown, unknown[]>(),
  deletedRows: new Map<unknown, unknown[]>(),
  auditMock: vi.fn(),
  createCampaignProfileMock: vi.fn(),
  syncFeatureUpdateProfilesMock: vi.fn(),
  deleteFeatureUpdateProfileMock: vi.fn(),
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
    delete: (table: unknown) => ({
      where: async () => {
        const list = deletedRows.get(table) ?? [];
        list.push({});
        deletedRows.set(table, list);
      },
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
    createAndAssignCampaignFeatureUpdateProfile: createCampaignProfileMock,
    deleteFeatureUpdateProfile: deleteFeatureUpdateProfileMock,
  };
});

vi.mock("../graph/sync.js", () => ({
  syncFeatureUpdateProfiles: syncFeatureUpdateProfilesMock,
}));

const { featureUpdatesRoutes } = await import("./feature-updates.js");
const { tables } = await import("@patchpilot/db");

const TENANT_ID = "customer-tenant";
const ENGINEER = { upn: "engineer@example.com", displayName: "Engineer", homeTenantId: "home-tenant" };

function setTenant(overrides: Record<string, unknown> = {}) {
  tableRows.set(tables.tenants, [
    {
      tenantId: TENANT_ID,
      displayName: "Customer",
      readOnly: false,
      consentStatus: "consented",
      licenses: ["intune"],
      featureUpdateTargetVersion: null,
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
  await app.register(featureUpdatesRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  tableRows.clear();
  insertedRows.clear();
  deletedRows.clear();
  auditMock.mockReset().mockResolvedValue(undefined);
  createCampaignProfileMock.mockReset().mockResolvedValue("profile-1");
  syncFeatureUpdateProfilesMock.mockReset().mockResolvedValue({ count: 0 });
  deleteFeatureUpdateProfileMock.mockReset().mockResolvedValue(undefined);
  setTenant();
});

describe("POST /api/feature-updates/campaigns", () => {
  const CAMPAIGN_BODY = {
    tenantId: TENANT_ID,
    displayName: "24H2 rollout — Finance",
    targetVersionLabel: "24H2",
    groupId: "group-1",
    groupName: "Finance workstations",
    offerStartDateTimeInUTC: "2026-09-01T00:00:00.000Z",
    offerEndDateTimeInUTC: "2026-09-15T00:00:00.000Z",
    offerIntervalInDays: 7,
    installFeatureUpdatesOptional: false,
  };

  it("creates and assigns a campaign profile, then records it", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/feature-updates/campaigns",
      payload: CAMPAIGN_BODY,
    });

    expect(res.statusCode).toBe(201);
    expect(createCampaignProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        targets: [
          expect.objectContaining({
            "@odata.type": "#microsoft.graph.groupAssignmentTarget",
            groupId: "group-1",
          }),
        ],
      }),
    );
    const [inserted] = insertedRows.get(tables.featureUpdateCampaigns) ?? [];
    expect(inserted).toMatchObject({
      source: "patchpilot",
      assignments: [{ kind: "include", groupId: "group-1", groupName: "Finance workstations" }],
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "feature-update-campaign:create" }),
    );
    await app.close();
  });

  it("also assigns an exclude target when excludeGroupId is given", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/feature-updates/campaigns",
      payload: { ...CAMPAIGN_BODY, excludeGroupId: "group-2", excludeGroupName: "Contractors" },
    });

    expect(res.statusCode).toBe(201);
    expect(createCampaignProfileMock).toHaveBeenCalledWith(
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
    const [inserted] = insertedRows.get(tables.featureUpdateCampaigns) ?? [];
    expect((inserted as { assignments: unknown[] }).assignments).toEqual([
      { kind: "include", groupId: "group-1", groupName: "Finance workstations" },
      { kind: "exclude", groupId: "group-2", groupName: "Contractors" },
    ]);
    await app.close();
  });

  it("returns 400 when groupId is missing", async () => {
    const { groupId: _groupId, ...rest } = CAMPAIGN_BODY;

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/feature-updates/campaigns",
      payload: rest,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("groupId");
    expect(createCampaignProfileMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 403 when the tenant is read-only", async () => {
    setTenant({ readOnly: true });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/feature-updates/campaigns",
      payload: CAMPAIGN_BODY,
    });

    expect(res.statusCode).toBe(403);
    expect(createCampaignProfileMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("surfaces a Graph error status when profile creation fails", async () => {
    const { GraphError } = await import("@patchpilot/graph");
    createCampaignProfileMock.mockRejectedValue(new GraphError(502, "upstream error"));

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/feature-updates/campaigns",
      payload: CAMPAIGN_BODY,
    });

    expect(res.statusCode).toBe(502);
    expect(insertedRows.get(tables.featureUpdateCampaigns) ?? []).toHaveLength(0);
    await app.close();
  });
});

describe("POST /api/feature-updates/campaigns/sync", () => {
  it("syncs and records the count", async () => {
    syncFeatureUpdateProfilesMock.mockResolvedValue({ count: 3 });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/feature-updates/campaigns/sync",
      payload: { tenantId: TENANT_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ count: 3 });
    expect(syncFeatureUpdateProfilesMock).toHaveBeenCalledWith(
      expect.objectContaining({ upn: ENGINEER.upn }),
      TENANT_ID,
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "feature-update-campaign:sync", outcome: "success" }),
    );
    await app.close();
  });

  it("returns 400 when tenantId is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/feature-updates/campaigns/sync",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(syncFeatureUpdateProfilesMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 404 when the tenant is unknown", async () => {
    tableRows.set(tables.tenants, []);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/feature-updates/campaigns/sync",
      payload: { tenantId: TENANT_ID },
    });

    expect(res.statusCode).toBe(404);
    expect(syncFeatureUpdateProfilesMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("surfaces a Graph error status and records a failed audit entry", async () => {
    const { GraphError } = await import("@patchpilot/graph");
    syncFeatureUpdateProfilesMock.mockRejectedValue(new GraphError(502, "upstream error"));

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/feature-updates/campaigns/sync",
      payload: { tenantId: TENANT_ID },
    });

    expect(res.statusCode).toBe(502);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "feature-update-campaign:sync", outcome: "failure" }),
    );
    await app.close();
  });
});

describe("DELETE /api/feature-updates/campaigns/:id", () => {
  const CAMPAIGN = {
    id: "campaign-1",
    tenantId: TENANT_ID,
    displayName: "24H2 rollout — Finance",
    targetVersion: "24H2",
    intuneProfileId: "profile-1",
  };

  it("deletes the Graph profile and the local row, then records success", async () => {
    tableRows.set(tables.featureUpdateCampaigns, [CAMPAIGN]);

    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/feature-updates/campaigns/${CAMPAIGN.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(deleteFeatureUpdateProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, intuneProfileId: "profile-1" }),
    );
    expect(deletedRows.get(tables.featureUpdateCampaigns) ?? []).toHaveLength(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "feature-update-campaign:delete", outcome: "success" }),
    );
    await app.close();
  });

  it("returns 404 when the campaign is unknown", async () => {
    tableRows.set(tables.featureUpdateCampaigns, []);

    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/feature-updates/campaigns/${CAMPAIGN.id}`,
    });

    expect(res.statusCode).toBe(404);
    expect(deleteFeatureUpdateProfileMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 403 when the tenant is read-only", async () => {
    tableRows.set(tables.featureUpdateCampaigns, [CAMPAIGN]);
    setTenant({ readOnly: true });

    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/feature-updates/campaigns/${CAMPAIGN.id}`,
    });

    expect(res.statusCode).toBe(403);
    expect(deleteFeatureUpdateProfileMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("surfaces a Graph error status, leaves the row in place, and records a failed audit entry", async () => {
    tableRows.set(tables.featureUpdateCampaigns, [CAMPAIGN]);
    const { GraphError } = await import("@patchpilot/graph");
    deleteFeatureUpdateProfileMock.mockRejectedValue(new GraphError(502, "upstream error"));

    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/feature-updates/campaigns/${CAMPAIGN.id}`,
    });

    expect(res.statusCode).toBe(502);
    expect(deletedRows.get(tables.featureUpdateCampaigns) ?? []).toHaveLength(0);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "feature-update-campaign:delete", outcome: "failure" }),
    );
    await app.close();
  });
});

describe("POST /api/feature-updates/campaigns/bulk-delete", () => {
  const CAMPAIGN_1 = {
    id: "campaign-1",
    tenantId: TENANT_ID,
    displayName: "24H2 rollout — Finance",
    targetVersion: "24H2",
    intuneProfileId: "profile-1",
  };
  const CAMPAIGN_2 = {
    id: "campaign-2",
    tenantId: TENANT_ID,
    displayName: "24H2 rollout — Sales",
    targetVersion: "24H2",
    intuneProfileId: "profile-2",
  };

  it("deletes each Graph profile and local row, then records one audit entry", async () => {
    tableRows.set(tables.featureUpdateCampaigns, [CAMPAIGN_1, CAMPAIGN_2]);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/feature-updates/campaigns/bulk-delete",
      payload: { tenantId: TENANT_ID, ids: [CAMPAIGN_1.id, CAMPAIGN_2.id] },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      deleted: [CAMPAIGN_1.id, CAMPAIGN_2.id],
      notFound: [],
      failed: [],
    });
    expect(deleteFeatureUpdateProfileMock).toHaveBeenCalledTimes(2);
    expect(deletedRows.get(tables.featureUpdateCampaigns) ?? []).toHaveLength(2);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "feature-update-campaign:bulk-delete", outcome: "success" }),
    );
    await app.close();
  });

  it("reports unknown ids as notFound without deleting anything for them", async () => {
    tableRows.set(tables.featureUpdateCampaigns, [CAMPAIGN_1]);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/feature-updates/campaigns/bulk-delete",
      payload: { tenantId: TENANT_ID, ids: [CAMPAIGN_1.id, "missing-id"] },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.deleted).toEqual([CAMPAIGN_1.id]);
    expect(body.notFound).toEqual(["missing-id"]);
    expect(deleteFeatureUpdateProfileMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "feature-update-campaign:bulk-delete", outcome: "partial" }),
    );
    await app.close();
  });

  it("collects per-id failures and still records the successful deletes", async () => {
    tableRows.set(tables.featureUpdateCampaigns, [CAMPAIGN_1, CAMPAIGN_2]);
    const { GraphError } = await import("@patchpilot/graph");
    deleteFeatureUpdateProfileMock.mockImplementation(async ({ intuneProfileId }: { intuneProfileId: string }) => {
      if (intuneProfileId === "profile-2") throw new GraphError(502, "upstream error");
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/feature-updates/campaigns/bulk-delete",
      payload: { tenantId: TENANT_ID, ids: [CAMPAIGN_1.id, CAMPAIGN_2.id] },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.deleted).toEqual([CAMPAIGN_1.id]);
    expect(body.failed).toEqual([{ id: CAMPAIGN_2.id, label: CAMPAIGN_2.displayName, reason: "upstream error" }]);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "feature-update-campaign:bulk-delete", outcome: "partial" }),
    );
    await app.close();
  });

  it("returns 400 when ids is missing or empty", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/feature-updates/campaigns/bulk-delete",
      payload: { tenantId: TENANT_ID, ids: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(deleteFeatureUpdateProfileMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 403 when the tenant is read-only", async () => {
    tableRows.set(tables.featureUpdateCampaigns, [CAMPAIGN_1]);
    setTenant({ readOnly: true });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/feature-updates/campaigns/bulk-delete",
      payload: { tenantId: TENANT_ID, ids: [CAMPAIGN_1.id] },
    });

    expect(res.statusCode).toBe(403);
    expect(deleteFeatureUpdateProfileMock).not.toHaveBeenCalled();
    await app.close();
  });
});
