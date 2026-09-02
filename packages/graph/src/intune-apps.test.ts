import { describe, expect, it, vi } from "vitest";

const { graphGetMock } = vi.hoisted(() => ({ graphGetMock: vi.fn() }));
vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return { ...actual, graphGet: graphGetMock };
});

const { buildAssignmentTargets, resolveGroupIdByName, searchGroups } = await import("./intune-apps.js");
const { GraphError } = await import("./client.js");

const CALL = { engineer: "engineer@example.com", homeTenantId: "home-tenant", tenantId: "customer-tenant" };

describe("buildAssignmentTargets", () => {
  it('returns an empty array for "none" (Do not Assign)', () => {
    expect(buildAssignmentTargets({ mode: "none" })).toEqual([]);
  });

  it('builds an allDevicesAssignmentTarget for "all-devices"', () => {
    expect(buildAssignmentTargets({ mode: "all-devices" })).toEqual([
      { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" },
    ]);
  });

  it('builds an allLicensedUsersAssignmentTarget for "all-users"', () => {
    expect(buildAssignmentTargets({ mode: "all-users" })).toEqual([
      { "@odata.type": "#microsoft.graph.allLicensedUsersAssignmentTarget" },
    ]);
  });

  it('builds a groupAssignmentTarget for "group"', () => {
    expect(buildAssignmentTargets({ mode: "group", groupId: "group-123" })).toEqual([
      { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "group-123" },
    ]);
  });

  it('throws for "group" without a groupId', () => {
    expect(() => buildAssignmentTargets({ mode: "group" })).toThrow(/groupId is required/);
  });

  it("narrows all-devices to one device via a filterId", () => {
    expect(buildAssignmentTargets({ mode: "all-devices", filterId: "filter-1" })).toEqual([
      {
        "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget",
        deviceAndAppManagementAssignmentFilterId: "filter-1",
        deviceAndAppManagementAssignmentFilterType: "include",
      },
    ]);
  });

  it("ignores excludeGroupId when mode is none (excluding from nothing is meaningless)", () => {
    expect(buildAssignmentTargets({ mode: "none", excludeGroupId: "group-456" })).toEqual([]);
  });

  it("appends an independent exclusionGroupAssignmentTarget alongside a group include", () => {
    expect(
      buildAssignmentTargets({ mode: "group", groupId: "group-123", excludeGroupId: "group-456" }),
    ).toEqual([
      { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "group-123" },
      { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: "group-456" },
    ]);
  });

  it("appends an exclusionGroupAssignmentTarget alongside all-devices/all-users too", () => {
    expect(buildAssignmentTargets({ mode: "all-devices", excludeGroupId: "group-456" })).toEqual([
      { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" },
      { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: "group-456" },
    ]);
  });
});

describe("resolveGroupIdByName", () => {
  it("returns the matched group's id", async () => {
    graphGetMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: { value: [{ id: "group-abc", displayName: "Finance Laptops" }] },
    });

    const id = await resolveGroupIdByName({ ...CALL, name: "Finance Laptops" });

    expect(id).toBe("group-abc");
    expect(graphGetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.stringContaining(encodeURIComponent("displayName eq 'Finance Laptops'")),
      }),
    );
  });

  it("returns null when no group matches", async () => {
    graphGetMock.mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: { value: [] } });

    const id = await resolveGroupIdByName({ ...CALL, name: "Nonexistent Group" });

    expect(id).toBeNull();
  });

  it("throws GraphError on a 403 (missing Group.Read.All / needs re-consent)", async () => {
    graphGetMock.mockResolvedValueOnce({ ok: false, status: 403, latencyMs: 1, data: null });

    await expect(resolveGroupIdByName({ ...CALL, name: "Finance Laptops" })).rejects.toThrow(GraphError);
  });

  it("escapes a single quote in the group name for the OData filter", async () => {
    graphGetMock.mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: { value: [] } });

    await resolveGroupIdByName({ ...CALL, name: "O'Brien's Team" });

    expect(graphGetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.stringContaining(encodeURIComponent("displayName eq 'O''Brien''s Team'")),
      }),
    );
  });
});

describe("searchGroups", () => {
  it("returns matched groups and sends the ConsistencyLevel: eventual header", async () => {
    graphGetMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: { value: [{ id: "group-abc", displayName: "Finance Laptops" }] },
    });

    const results = await searchGroups({ ...CALL, query: "Fin" });

    expect(results).toEqual([{ id: "group-abc", displayName: "Finance Laptops" }]);
    expect(graphGetMock).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { ConsistencyLevel: "eventual" } }),
    );
  });

  it("filters to security-enabled, mail-disabled groups matching a displayName prefix", async () => {
    graphGetMock.mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: { value: [] } });

    await searchGroups({ ...CALL, query: "Fin" });

    const call = graphGetMock.mock.calls.at(-1)![0] as { path: string };
    const decodedPath = decodeURIComponent(call.path);
    expect(decodedPath).toContain("startswith(displayName,'Fin')");
    expect(decodedPath).toContain("securityEnabled eq true");
    expect(decodedPath).toContain("mailEnabled eq false");
  });

  it("returns an empty array when no groups match", async () => {
    graphGetMock.mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: { value: [] } });

    expect(await searchGroups({ ...CALL, query: "Nonexistent" })).toEqual([]);
  });

  it("throws GraphError on a 403 (missing Group.Read.All / needs re-consent)", async () => {
    graphGetMock.mockResolvedValueOnce({ ok: false, status: 403, latencyMs: 1, data: null });

    await expect(searchGroups({ ...CALL, query: "Fin" })).rejects.toThrow(GraphError);
  });
});
