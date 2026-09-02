import Fastify, { type FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Same harness shape as feature-updates.test.ts — see that file's top-level
 * comment for why a full `.inject()` harness is used instead of extracting
 * pure functions. `parseReleaseCadence`/`parseReleaseDate` are left real
 * (spread from `actual`) since the catalog route's newest-per-cadence
 * filtering is exactly the behavior worth exercising.
 */

const {
  tableRows,
  insertedRows,
  deletedRows,
  auditMock,
  listQualityUpdateCatalogItemsMock,
  createAndAssignQualityUpdateProfileMock,
  deleteQualityUpdateProfileMock,
} = vi.hoisted(() => ({
  tableRows: new Map<unknown, unknown[]>(),
  insertedRows: new Map<unknown, unknown[]>(),
  deletedRows: new Map<unknown, unknown[]>(),
  auditMock: vi.fn(),
  listQualityUpdateCatalogItemsMock: vi.fn(),
  createAndAssignQualityUpdateProfileMock: vi.fn(),
  deleteQualityUpdateProfileMock: vi.fn(),
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
    listQualityUpdateCatalogItems: listQualityUpdateCatalogItemsMock,
    createAndAssignQualityUpdateProfile: createAndAssignQualityUpdateProfileMock,
    deleteQualityUpdateProfile: deleteQualityUpdateProfileMock,
  };
});

const { qualityUpdatesRoutes } = await import("./quality-updates.js");
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
      ...overrides,
    },
  ]);
}

async function buildApp() {
  const app = Fastify();
  app.decorateRequest("session", null as unknown as never);
  app.decorateRequest("currentUser", null as unknown as never);
  app.addHook("onRequest", async (req) => {
    req.session = { engineer: ENGINEER } as FastifyRequest["session"];
    req.currentUser = { id: "engineer-1", upn: ENGINEER.upn, displayName: ENGINEER.displayName, role: "admin" };
  });
  await app.register(qualityUpdatesRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  tableRows.clear();
  insertedRows.clear();
  deletedRows.clear();
  auditMock.mockReset().mockResolvedValue(undefined);
  listQualityUpdateCatalogItemsMock.mockReset().mockResolvedValue([]);
  createAndAssignQualityUpdateProfileMock.mockReset().mockResolvedValue("profile-1");
  deleteQualityUpdateProfileMock.mockReset().mockResolvedValue(undefined);
  setTenant();
});

describe("GET /api/quality-updates/campaigns", () => {
  it("returns both policyTypes together", async () => {
    tableRows.set(tables.qualityUpdateCampaigns, [
      { id: "c1", tenantId: TENANT_ID, policyType: "expedite" },
      { id: "c2", tenantId: TENANT_ID, policyType: "quality-update" },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/quality-updates/campaigns?tenantId=${TENANT_ID}` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).campaigns).toHaveLength(2);
    await app.close();
  });
});

describe("GET /api/quality-updates/catalog", () => {
  it("keeps only the newest B and OOB item per cadence", async () => {
    listQualityUpdateCatalogItemsMock.mockResolvedValue([
      { id: "item-old-b", displayName: "07/01/2026 - 2026.07 B SecurityUpdate" },
      { id: "item-new-b", displayName: "08/11/2026 - 2026.08 B SecurityUpdate" },
      { id: "item-oob", displayName: "08/05/2026 - 2026.08 OOB SecurityUpdate" },
      { id: "item-not-expeditable", displayName: "08/12/2026 - 2026.08 B SecurityUpdate", isExpeditable: false },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/quality-updates/catalog?tenantId=${TENANT_ID}` });

    expect(res.statusCode).toBe(200);
    const { releases } = JSON.parse(res.body);
    expect(releases).toHaveLength(2);
    expect(releases.map((r: { id: string }) => r.id).sort()).toEqual(["item-new-b", "item-oob"]);
    await app.close();
  });

  it("returns 400 when tenantId is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/quality-updates/catalog" });

    expect(res.statusCode).toBe(400);
    expect(listQualityUpdateCatalogItemsMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("surfaces a Graph error status", async () => {
    const { GraphError } = await import("@patchpilot/graph");
    listQualityUpdateCatalogItemsMock.mockRejectedValue(new GraphError(502, "upstream error"));

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/quality-updates/catalog?tenantId=${TENANT_ID}` });

    expect(res.statusCode).toBe(502);
    await app.close();
  });
});

describe("POST /api/quality-updates/campaigns", () => {
  const BODY = {
    tenantId: TENANT_ID,
    displayName: "Expedite August B",
    catalogItemId: "item-new-b",
    releaseLabel: "2026.08 B",
    daysUntilForcedReboot: 1,
    groupId: "group-1",
    groupName: "Finance workstations",
  };

  it("creates and assigns an expedite policy, then records it as policyType expedite", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/quality-updates/campaigns", payload: BODY });

    expect(res.statusCode).toBe(201);
    expect(createAndAssignQualityUpdateProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ catalogItemId: "item-new-b", daysUntilForcedReboot: 1 }),
    );
    const [inserted] = insertedRows.get(tables.qualityUpdateCampaigns) ?? [];
    expect(inserted).toMatchObject({ policyType: "expedite", source: "patchpilot" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "quality-update-campaign:create" }),
    );
    await app.close();
  });

  it("returns 400 when daysUntilForcedReboot is out of range", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/quality-updates/campaigns",
      payload: { ...BODY, daysUntilForcedReboot: 5 },
    });

    expect(res.statusCode).toBe(400);
    expect(createAndAssignQualityUpdateProfileMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 403 when the tenant is read-only", async () => {
    setTenant({ readOnly: true });

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/quality-updates/campaigns", payload: BODY });

    expect(res.statusCode).toBe(403);
    expect(createAndAssignQualityUpdateProfileMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("surfaces a Graph error status when profile creation fails", async () => {
    const { GraphError } = await import("@patchpilot/graph");
    createAndAssignQualityUpdateProfileMock.mockRejectedValue(new GraphError(502, "upstream error"));

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/quality-updates/campaigns", payload: BODY });

    expect(res.statusCode).toBe(502);
    expect(insertedRows.get(tables.qualityUpdateCampaigns) ?? []).toHaveLength(0);
    await app.close();
  });
});

describe("DELETE /api/quality-updates/campaigns/:id", () => {
  const EXPEDITE_POLICY = {
    id: "policy-1",
    tenantId: TENANT_ID,
    policyType: "expedite",
    displayName: "Expedite August B",
    intuneProfileId: "profile-1",
  };
  const QUALITY_UPDATE_POLICY = {
    id: "policy-2",
    tenantId: TENANT_ID,
    policyType: "quality-update",
    displayName: "Ring: IT Pilot",
    intuneProfileId: "profile-2",
  };

  it("deletes an expedite policy's Graph profile and local row", async () => {
    tableRows.set(tables.qualityUpdateCampaigns, [EXPEDITE_POLICY]);

    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `/api/quality-updates/campaigns/${EXPEDITE_POLICY.id}` });

    expect(res.statusCode).toBe(200);
    expect(deleteQualityUpdateProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ intuneProfileId: "profile-1" }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "quality-update-campaign:delete", outcome: "success" }),
    );
    await app.close();
  });

  it("rejects deleting a quality-update policyType with 400", async () => {
    tableRows.set(tables.qualityUpdateCampaigns, [QUALITY_UPDATE_POLICY]);

    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `/api/quality-updates/campaigns/${QUALITY_UPDATE_POLICY.id}` });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("expedite");
    expect(deleteQualityUpdateProfileMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 404 when the policy is unknown", async () => {
    tableRows.set(tables.qualityUpdateCampaigns, []);

    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `/api/quality-updates/campaigns/${EXPEDITE_POLICY.id}` });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 403 when the tenant is read-only", async () => {
    tableRows.set(tables.qualityUpdateCampaigns, [EXPEDITE_POLICY]);
    setTenant({ readOnly: true });

    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `/api/quality-updates/campaigns/${EXPEDITE_POLICY.id}` });

    expect(res.statusCode).toBe(403);
    expect(deleteQualityUpdateProfileMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("POST /api/quality-updates/campaigns/bulk-delete", () => {
  const EXPEDITE_POLICY = {
    id: "policy-1",
    tenantId: TENANT_ID,
    policyType: "expedite",
    displayName: "Expedite August B",
    intuneProfileId: "profile-1",
  };
  const QUALITY_UPDATE_POLICY = {
    id: "policy-2",
    tenantId: TENANT_ID,
    policyType: "quality-update",
    displayName: "Ring: IT Pilot",
    intuneProfileId: "profile-2",
  };

  it("deletes eligible expedite rows and reports non-expedite rows as skipped", async () => {
    tableRows.set(tables.qualityUpdateCampaigns, [EXPEDITE_POLICY, QUALITY_UPDATE_POLICY]);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/quality-updates/campaigns/bulk-delete",
      payload: { tenantId: TENANT_ID, ids: [EXPEDITE_POLICY.id, QUALITY_UPDATE_POLICY.id] },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.deleted).toEqual([EXPEDITE_POLICY.id]);
    expect(body.skipped).toEqual([QUALITY_UPDATE_POLICY.id]);
    expect(deleteQualityUpdateProfileMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "quality-update-campaign:bulk-delete", outcome: "partial" }),
    );
    await app.close();
  });

  it("returns success outcome when every id is an eligible expedite row", async () => {
    tableRows.set(tables.qualityUpdateCampaigns, [EXPEDITE_POLICY]);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/quality-updates/campaigns/bulk-delete",
      payload: { tenantId: TENANT_ID, ids: [EXPEDITE_POLICY.id] },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: [EXPEDITE_POLICY.id], notFound: [], failed: [], skipped: [] });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "quality-update-campaign:bulk-delete", outcome: "success" }),
    );
    await app.close();
  });

  it("returns 403 when the tenant is read-only", async () => {
    tableRows.set(tables.qualityUpdateCampaigns, [EXPEDITE_POLICY]);
    setTenant({ readOnly: true });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/quality-updates/campaigns/bulk-delete",
      payload: { tenantId: TENANT_ID, ids: [EXPEDITE_POLICY.id] },
    });

    expect(res.statusCode).toBe(403);
    expect(deleteQualityUpdateProfileMock).not.toHaveBeenCalled();
    await app.close();
  });
});
