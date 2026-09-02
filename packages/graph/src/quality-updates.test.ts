import { beforeEach, describe, expect, it, vi } from "vitest";

const { graphGetMock, graphWriteMock } = vi.hoisted(() => ({ graphGetMock: vi.fn(), graphWriteMock: vi.fn() }));
vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return { ...actual, graphGet: graphGetMock, graphWrite: graphWriteMock };
});

const {
  findQualityUpdateCatalogItem,
  listQualityUpdateCatalogItems,
  parseReleaseCadence,
  parseReleaseDate,
  createAndAssignQualityUpdateProfile,
} = await import("./quality-updates.js");

const CALL = { engineer: "engineer@example.com", homeTenantId: "home-tenant", tenantId: "customer-tenant" };

beforeEach(() => {
  graphGetMock.mockReset();
  graphWriteMock.mockReset();
});

function catalogItem(id: string, kbIds: string[]) {
  return {
    id,
    displayName: `Catalog item ${id}`,
    isExpeditable: true,
    productRevisions: kbIds.map((articleId) => ({
      knowledgeBaseArticle: { articleId, articleUrl: `https://support.microsoft.com/help/${articleId.slice(2)}` },
    })),
  };
}

describe("findQualityUpdateCatalogItem", () => {
  it("never filters on the broken top-level kbArticleId field", async () => {
    graphGetMock.mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: { value: [] } });

    await findQualityUpdateCatalogItem({ ...CALL, kbId: "5043080" });

    expect(graphGetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.not.stringContaining("kbArticleId"),
      }),
    );
    const path = graphGetMock.mock.calls[0]![0].path as string;
    expect(path).toContain(encodeURIComponent("isof('microsoft.graph.windowsQualityUpdateCatalogItem')"));
  });

  it("matches against productRevisions[].knowledgeBaseArticle.articleId, adding the KB prefix", async () => {
    graphGetMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: { value: [catalogItem("item-1", ["KB5041580"]), catalogItem("item-2", ["KB5043080"])] },
    });

    const result = await findQualityUpdateCatalogItem({ ...CALL, kbId: "5043080" });

    expect(result?.id).toBe("item-2");
  });

  it("matches case-insensitively", async () => {
    graphGetMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: { value: [catalogItem("item-1", ["kb5043080"])] },
    });

    const result = await findQualityUpdateCatalogItem({ ...CALL, kbId: "5043080" });

    expect(result?.id).toBe("item-1");
  });

  it("returns null when no catalog item's productRevisions contains the KB", async () => {
    graphGetMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: { value: [catalogItem("item-1", ["KB5041580"])] },
    });

    const result = await findQualityUpdateCatalogItem({ ...CALL, kbId: "9999999" });

    expect(result).toBeNull();
  });

  it("ignores the unreliable top-level kbArticleId even if it happens to equal the target", async () => {
    graphGetMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: {
        value: [
          {
            id: "item-1",
            kbArticleId: "5043080",
            productRevisions: [],
          },
        ],
      },
    });

    const result = await findQualityUpdateCatalogItem({ ...CALL, kbId: "5043080" });

    expect(result).toBeNull();
  });

  it("follows @odata.nextLink across pages until a match is found", async () => {
    graphGetMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        latencyMs: 1,
        data: {
          value: [catalogItem("item-1", ["KB5041580"])],
          "@odata.nextLink": "https://graph.microsoft.com/beta/deviceManagement/windowsUpdateCatalogItems?$skiptoken=abc",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        latencyMs: 1,
        data: { value: [catalogItem("item-2", ["KB5043080"])] },
      });

    const result = await findQualityUpdateCatalogItem({ ...CALL, kbId: "5043080" });

    expect(result?.id).toBe("item-2");
    expect(graphGetMock).toHaveBeenCalledTimes(2);
    expect(graphGetMock.mock.calls[1]![0].path).toBe(
      "/deviceManagement/windowsUpdateCatalogItems?$skiptoken=abc",
    );
  });

  it("stops paging and returns null once MAX_CATALOG_PAGES is hit without a match", async () => {
    graphGetMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: {
        value: [catalogItem("item-x", ["KB0000000"])],
        "@odata.nextLink": "https://graph.microsoft.com/beta/deviceManagement/windowsUpdateCatalogItems?$skiptoken=next",
      },
    }));

    const result = await findQualityUpdateCatalogItem({ ...CALL, kbId: "5043080" });

    expect(result).toBeNull();
    expect(graphGetMock.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it("throws (does not silently return null) when a page request fails", async () => {
    graphGetMock.mockResolvedValueOnce({ ok: false, status: 400, latencyMs: 1, data: null });

    await expect(findQualityUpdateCatalogItem({ ...CALL, kbId: "5043080" })).rejects.toThrow(/HTTP 400/);
  });
});

describe("listQualityUpdateCatalogItems", () => {
  it("walks every page unconditionally, collecting all items", async () => {
    graphGetMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        latencyMs: 1,
        data: {
          value: [catalogItem("item-1", ["KB5041580"])],
          "@odata.nextLink": "https://graph.microsoft.com/beta/deviceManagement/windowsUpdateCatalogItems?$skiptoken=abc",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        latencyMs: 1,
        data: { value: [catalogItem("item-2", ["KB5043080"])] },
      });

    const result = await listQualityUpdateCatalogItems(CALL);

    expect(result.map((i) => i.id)).toEqual(["item-1", "item-2"]);
    expect(graphGetMock).toHaveBeenCalledTimes(2);
  });

  it("throws (does not silently return an empty array) when the first page request fails", async () => {
    graphGetMock.mockResolvedValueOnce({ ok: false, status: 503, latencyMs: 1, data: null });

    await expect(listQualityUpdateCatalogItems(CALL)).rejects.toThrow(/HTTP 503/);
  });

  it("stops paging once MAX_CATALOG_PAGES is hit", async () => {
    graphGetMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: {
        value: [catalogItem("item-x", ["KB0000000"])],
        "@odata.nextLink": "https://graph.microsoft.com/beta/deviceManagement/windowsUpdateCatalogItems?$skiptoken=next",
      },
    }));

    const result = await listQualityUpdateCatalogItems(CALL);

    expect(result.length).toBeLessThanOrEqual(20);
    expect(graphGetMock.mock.calls.length).toBeLessThanOrEqual(20);
  });
});

describe("parseReleaseCadence", () => {
  it("parses a monthly \"B\" release from displayName", () => {
    const item = catalogItem("item-1", ["KB5041580"]);
    item.displayName = "09/10/2024 - 2024.09 B SecurityUpdate for Windows 10 and later";

    expect(parseReleaseCadence(item)).toBe("B");
  });

  it("parses an out-of-band \"OOB\" release from displayName", () => {
    const item = catalogItem("item-1", ["KB5041580"]);
    item.displayName = "09/12/2024 - 2024.09 OOB SecurityUpdate for Windows 10 and later";

    expect(parseReleaseCadence(item)).toBe("OOB");
  });

  it("falls back to \"unknown\" for an unlabeled/malformed displayName", () => {
    const item = catalogItem("item-1", ["KB5041580"]);
    item.displayName = "Windows 10 and later cumulative update";

    expect(parseReleaseCadence(item)).toBe("unknown");
  });

  it("falls back to \"unknown\" when displayName is missing entirely", () => {
    const item = catalogItem("item-1", ["KB5041580"]);
    delete (item as { displayName?: string }).displayName;

    expect(parseReleaseCadence(item)).toBe("unknown");
  });
});

describe("parseReleaseDate", () => {
  it("parses the MM/DD/YYYY prefix off displayName", () => {
    const item = catalogItem("item-1", ["KB5041580"]);
    item.displayName = "08/11/2026 - 2026.08 B SecurityUpdate for Windows 10 and later";

    const date = parseReleaseDate(item);
    expect(date?.toISOString()).toBe("2026-08-11T00:00:00.000Z");
  });

  it("returns null when displayName has no date prefix", () => {
    const item = catalogItem("item-1", ["KB5041580"]);
    item.displayName = "Windows 10 and later cumulative update";

    expect(parseReleaseDate(item)).toBeNull();
  });

  it("returns null when displayName is missing entirely", () => {
    const item = catalogItem("item-1", ["KB5041580"]);
    delete (item as { displayName?: string }).displayName;

    expect(parseReleaseDate(item)).toBeNull();
  });

  it("orders a later date after an earlier one", () => {
    const older = catalogItem("item-1", ["KB5041580"]);
    older.displayName = "07/08/2026 - 2026.07 B SecurityUpdate";
    const newer = catalogItem("item-2", ["KB5041580"]);
    newer.displayName = "08/12/2026 - 2026.08 B SecurityUpdate";

    expect(parseReleaseDate(newer)!.getTime()).toBeGreaterThan(parseReleaseDate(older)!.getTime());
  });
});

describe("createAndAssignQualityUpdateProfile", () => {
  function targets() {
    return [{ "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "group-1" }];
  }

  it("sends the catalog item's releaseDateTime as qualityUpdateRelease, not its id — Graph 400s on the raw id (live-verified against BLACK IRON)", async () => {
    graphGetMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: { value: [{ id: "catalog-item-1", displayName: "item", releaseDateTime: "2026-08-11T00:00:00Z" }] },
    });
    graphWriteMock.mockResolvedValueOnce({ ok: true, status: 201, latencyMs: 1, data: { id: "profile-1" } });
    graphWriteMock.mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: null });

    await createAndAssignQualityUpdateProfile({
      ...CALL,
      catalogItemId: "catalog-item-1",
      kbId: "5121000",
      targets: targets() as never,
    });

    const createBody = graphWriteMock.mock.calls[0]![0].body;
    expect(createBody.expeditedUpdateSettings.qualityUpdateRelease).toBe("2026-08-11T00:00:00Z");
    expect(createBody.expeditedUpdateSettings.qualityUpdateRelease).not.toBe("catalog-item-1");
  });

  it("posts every target as its own assignment entry (multi-target include+exclude array)", async () => {
    graphGetMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: { value: [{ id: "catalog-item-1", releaseDateTime: "2026-08-11T00:00:00Z" }] },
    });
    graphWriteMock.mockResolvedValueOnce({ ok: true, status: 201, latencyMs: 1, data: { id: "profile-1" } });
    graphWriteMock.mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: null });

    const multiTargets = [
      { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "include-group" },
      { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: "exclude-group" },
    ];

    await createAndAssignQualityUpdateProfile({
      ...CALL,
      catalogItemId: "catalog-item-1",
      kbId: "5121000",
      targets: multiTargets as never,
    });

    const assignBody = graphWriteMock.mock.calls[1]![0].body;
    expect(assignBody.assignments).toEqual(multiTargets.map((target) => ({ target })));
  });

  it("throws when the catalog item id can't be found (never falls back to posting the id itself)", async () => {
    graphGetMock.mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: { value: [] } });

    await expect(
      createAndAssignQualityUpdateProfile({
        ...CALL,
        catalogItemId: "missing-item",
        kbId: "5121000",
        targets: targets() as never,
      }),
    ).rejects.toThrow(/not found/);
    expect(graphWriteMock).not.toHaveBeenCalled();
  });

  it("throws when the matched catalog item has no releaseDateTime", async () => {
    graphGetMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: { value: [{ id: "catalog-item-1", displayName: "undated item" }] },
    });

    await expect(
      createAndAssignQualityUpdateProfile({
        ...CALL,
        catalogItemId: "catalog-item-1",
        kbId: "5121000",
        targets: targets() as never,
      }),
    ).rejects.toThrow(/no releaseDateTime/);
    expect(graphWriteMock).not.toHaveBeenCalled();
  });

  it("throws with the create endpoint's errorBody surfaced when create fails", async () => {
    graphGetMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: { value: [{ id: "catalog-item-1", releaseDateTime: "2026-08-11T00:00:00Z" }] },
    });
    graphWriteMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      latencyMs: 1,
      data: null,
      errorBody: "some diagnostic detail",
    });

    await expect(
      createAndAssignQualityUpdateProfile({
        ...CALL,
        catalogItemId: "catalog-item-1",
        kbId: "5121000",
        targets: targets() as never,
      }),
    ).rejects.toThrow(/some diagnostic detail/);
  });
});
