import { beforeEach, describe, expect, it, vi } from "vitest";

const { graphWriteMock, graphGetMock } = vi.hoisted(() => ({
  graphWriteMock: vi.fn(),
  graphGetMock: vi.fn(),
}));
vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return { ...actual, graphWrite: graphWriteMock, graphGet: graphGetMock };
});

beforeEach(() => {
  graphWriteMock.mockReset();
  graphGetMock.mockReset();
});

const {
  createAndAssignCampaignFeatureUpdateProfile,
  deleteFeatureUpdateProfile,
  listFeatureUpdateProfiles,
  resolveGroupNames,
} = await import("./feature-updates.js");
const { GraphError } = await import("./client.js");

const CALL = { engineer: "engineer@example.com", homeTenantId: "home-tenant", tenantId: "customer-tenant" };

describe("createAndAssignCampaignFeatureUpdateProfile", () => {
  const groupTarget = { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "group-1" };
  const excludeTarget = { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: "group-2" };

  it("creates a profile with rolloutSettings and assigns it to the group target", async () => {
    graphWriteMock
      .mockResolvedValueOnce({ ok: true, status: 201, latencyMs: 1, data: { id: "campaign-profile-1" } })
      .mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: {} });

    const profileId = await createAndAssignCampaignFeatureUpdateProfile({
      ...CALL,
      displayName: "Move Finance to 24H2",
      targetBuild: 26100,
      targets: [groupTarget],
      offerStartDateTimeInUTC: "2026-09-01T00:00:00Z",
      offerEndDateTimeInUTC: "2026-09-15T00:00:00Z",
      offerIntervalInDays: 2,
      installFeatureUpdatesOptional: true,
    });

    expect(profileId).toBe("campaign-profile-1");
    const createCall = graphWriteMock.mock.calls[0]![0];
    expect(createCall.body.displayName).toBe("Move Finance to 24H2");
    expect(createCall.body.installFeatureUpdatesOptional).toBe(true);
    expect(createCall.body.rolloutSettings).toEqual({
      offerStartDateTimeInUTC: "2026-09-01T00:00:00Z",
      offerEndDateTimeInUTC: "2026-09-15T00:00:00Z",
      offerIntervalInDays: 2,
    });

    const assignCall = graphWriteMock.mock.calls[1]![0];
    expect(assignCall.body).toEqual({ assignments: [{ target: groupTarget }] });
  });

  it("assigns both an include and an exclude target when both are given", async () => {
    graphWriteMock
      .mockResolvedValueOnce({ ok: true, status: 201, latencyMs: 1, data: { id: "campaign-profile-3" } })
      .mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: {} });

    await createAndAssignCampaignFeatureUpdateProfile({
      ...CALL,
      displayName: "Move Finance to 24H2",
      targetBuild: 26100,
      targets: [groupTarget, excludeTarget],
      offerStartDateTimeInUTC: "2026-09-01T00:00:00Z",
      offerEndDateTimeInUTC: "2026-09-15T00:00:00Z",
      offerIntervalInDays: 2,
      installFeatureUpdatesOptional: true,
    });

    const assignCall = graphWriteMock.mock.calls[1]![0];
    expect(assignCall.body).toEqual({
      assignments: [{ target: groupTarget }, { target: excludeTarget }],
    });
  });

  it("throws a GraphError when profile creation fails", async () => {
    graphWriteMock.mockResolvedValueOnce({ ok: false, status: 403, latencyMs: 1 });

    await expect(
      createAndAssignCampaignFeatureUpdateProfile({
        ...CALL,
        displayName: "Campaign",
        targetBuild: 26100,
        targets: [groupTarget],
        offerStartDateTimeInUTC: "2026-09-01T00:00:00Z",
        offerEndDateTimeInUTC: "2026-09-15T00:00:00Z",
        offerIntervalInDays: 2,
        installFeatureUpdatesOptional: false,
      }),
    ).rejects.toThrow(GraphError);
  });

  it("throws a distinct GraphError when group assignment fails after a successful create", async () => {
    graphWriteMock
      .mockResolvedValueOnce({ ok: true, status: 201, latencyMs: 1, data: { id: "campaign-profile-2" } })
      .mockResolvedValueOnce({ ok: false, status: 400, latencyMs: 1 });

    await expect(
      createAndAssignCampaignFeatureUpdateProfile({
        ...CALL,
        displayName: "Campaign",
        targetBuild: 26100,
        targets: [groupTarget],
        offerStartDateTimeInUTC: "2026-09-01T00:00:00Z",
        offerEndDateTimeInUTC: "2026-09-15T00:00:00Z",
        offerIntervalInDays: 2,
        installFeatureUpdatesOptional: false,
      }),
    ).rejects.toThrow(/was created but assignment failed/);
  });
});

describe("deleteFeatureUpdateProfile", () => {
  it("calls graphWrite with DELETE and the profile path", async () => {
    graphWriteMock.mockResolvedValueOnce({ ok: true, status: 204, latencyMs: 1, data: null });

    await deleteFeatureUpdateProfile({ ...CALL, intuneProfileId: "profile-1" });

    expect(graphWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        path: "/deviceManagement/windowsFeatureUpdateProfiles/profile-1",
      }),
    );
  });

  it("resolves without throwing when Graph returns 404 (already gone)", async () => {
    graphWriteMock.mockResolvedValueOnce({ ok: false, status: 404, latencyMs: 1, data: null });

    await expect(deleteFeatureUpdateProfile({ ...CALL, intuneProfileId: "profile-1" })).resolves.toBeUndefined();
  });

  it("throws a GraphError for any other failure status", async () => {
    graphWriteMock.mockResolvedValueOnce({ ok: false, status: 403, latencyMs: 1, data: null });

    await expect(
      deleteFeatureUpdateProfile({ ...CALL, intuneProfileId: "profile-1" }),
    ).rejects.toThrow(GraphError);
  });
});

describe("resolveGroupNames", () => {
  it("resolves each group id to its displayName, individually", async () => {
    graphGetMock
      .mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: { id: "g1", displayName: "Finance" } })
      .mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: { id: "g2", displayName: "IT" } });

    const names = await resolveGroupNames({ ...CALL, groupIds: ["g1", "g2"] });

    expect(names.get("g1")).toBe("Finance");
    expect(names.get("g2")).toBe("IT");
    expect(graphGetMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes repeated group ids into a single call", async () => {
    graphGetMock.mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: { id: "g1", displayName: "Finance" } });

    await resolveGroupNames({ ...CALL, groupIds: ["g1", "g1"] });

    expect(graphGetMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a group unresolved (no map entry) when the lookup fails", async () => {
    graphGetMock.mockResolvedValueOnce({ ok: false, status: 404, latencyMs: 1 });

    const names = await resolveGroupNames({ ...CALL, groupIds: ["deleted-group"] });

    expect(names.has("deleted-group")).toBe(false);
  });
});

describe("listFeatureUpdateProfiles", () => {
  it("maps each @odata.type to the right assignment kind and resolves group names", async () => {
    graphGetMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        latencyMs: 1,
        data: {
          value: [
            {
              id: "profile-1",
              displayName: "Move Finance to 24H2",
              featureUpdateVersion: "Windows 11, version 24H2",
              installFeatureUpdatesOptional: true,
              rolloutSettings: {
                offerStartDateTimeInUTC: "2026-09-01T00:00:00Z",
                offerEndDateTimeInUTC: "2026-09-15T00:00:00Z",
                offerIntervalInDays: 2,
              },
              assignments: [
                { target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "g1" } },
                { target: { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: "g2" } },
                { target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } },
                { target: { "@odata.type": "#microsoft.graph.allLicensedUsersAssignmentTarget" } },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: { id: "g1", displayName: "Finance" } })
      .mockResolvedValueOnce({ ok: true, status: 200, latencyMs: 1, data: { id: "g2", displayName: "Legal" } });

    const [profile] = await listFeatureUpdateProfiles(CALL);

    expect(profile!.intuneProfileId).toBe("profile-1");
    expect(profile!.targetBuild).toBe(26100);
    expect(profile!.assignments).toEqual([
      { kind: "include", groupId: "g1", groupName: "Finance" },
      { kind: "exclude", groupId: "g2", groupName: "Legal" },
      { kind: "all-devices" },
      { kind: "all-users" },
    ]);
  });

  it("drops an assignment target type it doesn't recognize instead of guessing", async () => {
    graphGetMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: {
        value: [
          {
            id: "profile-2",
            displayName: "Unknown target type",
            featureUpdateVersion: "Windows 11, version 24H2",
            assignments: [{ target: { "@odata.type": "#microsoft.graph.someFutureAssignmentTarget" } }],
          },
        ],
      },
    });

    const [profile] = await listFeatureUpdateProfiles(CALL);

    expect(profile!.assignments).toEqual([]);
  });

  it("returns null targetBuild for a version string that doesn't match any known CLIENT_BUILDS label", async () => {
    graphGetMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: {
        value: [
          {
            id: "profile-3",
            displayName: "Unrecognized version",
            featureUpdateVersion: "Windows 11, version 99Q9",
          },
        ],
      },
    });

    const [profile] = await listFeatureUpdateProfiles(CALL);

    expect(profile!.targetBuild).toBeNull();
    expect(profile!.targetVersion).toBe("Windows 11, version 99Q9");
  });

  it("leaves offer/rollout fields null when rolloutSettings is absent", async () => {
    graphGetMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      latencyMs: 1,
      data: {
        value: [
          {
            id: "profile-4",
            displayName: "No rollout schedule",
            featureUpdateVersion: "Windows 11, version 24H2",
          },
        ],
      },
    });

    const [profile] = await listFeatureUpdateProfiles(CALL);

    expect(profile!.offerStartDateTimeInUTC).toBeNull();
    expect(profile!.offerEndDateTimeInUTC).toBeNull();
    expect(profile!.offerIntervalInDays).toBeNull();
    expect(profile!.installFeatureUpdatesOptional).toBe(false);
  });

  it("throws a GraphError when a page fetch fails, rather than treating it as empty", async () => {
    graphGetMock.mockResolvedValueOnce({ ok: false, status: 500, latencyMs: 1 });

    await expect(listFeatureUpdateProfiles(CALL)).rejects.toThrow(GraphError);
  });

  it("follows @odata.nextLink across pages", async () => {
    graphGetMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        latencyMs: 1,
        data: {
          value: [{ id: "profile-a", displayName: "A", featureUpdateVersion: "Windows 11, version 24H2" }],
          "@odata.nextLink":
            "https://graph.microsoft.com/beta/deviceManagement/windowsFeatureUpdateProfiles?$skiptoken=abc",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        latencyMs: 1,
        data: {
          value: [{ id: "profile-b", displayName: "B", featureUpdateVersion: "Windows 11, version 24H2" }],
        },
      });

    const profiles = await listFeatureUpdateProfiles(CALL);

    expect(profiles.map((p) => p.intuneProfileId)).toEqual(["profile-a", "profile-b"]);
    expect(graphGetMock).toHaveBeenCalledTimes(2);
    expect(graphGetMock.mock.calls[1]![0].path).toBe(
      "/deviceManagement/windowsFeatureUpdateProfiles?$skiptoken=abc",
    );
  });
});
