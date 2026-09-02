import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * deployOrReuseWinGetApp is DB + Graph coupled the same way
 * deployOrReuseWin32App is (see win32-app-deploy.test.ts's doc comment) — same
 * mocking shape: @patchpilot/db and drizzle-orm's query-builder helpers are
 * mocked entirely, @patchpilot/graph keeps its pure pieces (GraphError,
 * buildAssignmentTargets) real and replaces only the functions that make an
 * actual Graph HTTP call. resolveAssignmentTargets/isAssignmentMode/
 * Win32DeployError are imported straight from win32-app-deploy.js (not
 * mocked) since winget-app-deploy.ts imports them directly, not through
 * @patchpilot/graph.
 */

const dbState = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  insertValues: vi.fn(),
}));

vi.mock("@patchpilot/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(dbState.selectResults.shift() ?? [])),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: unknown) => {
        dbState.insertValues(v);
        return { onConflictDoUpdate: vi.fn(() => Promise.resolve()) };
      }),
    })),
  },
  tables: {
    intuneAppDeployments: {
      tenantId: "iad.tenantId",
      appType: "iad.appType",
      source: "iad.source",
      packageId: "iad.packageId",
      intuneAppId: "iad.intuneAppId",
      createdBy: "iad.createdBy",
      createdAt: "iad.createdAt",
    },
  },
  demoAuditLog: [],
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({ __op: "eq" })),
  and: vi.fn(() => ({ __op: "and" })),
  or: vi.fn(() => ({ __op: "or" })),
  isNull: vi.fn(() => ({ __op: "isNull" })),
}));

const graphMocks = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  assignMobileApp: vi.fn(async () => undefined),
  getMobileApp: vi.fn(),
  waitForAppPublished: vi.fn(async () => true),
  createWinGetApp: vi.fn(async () => "new-app-id"),
}));

vi.mock("@patchpilot/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@patchpilot/graph")>();
  return {
    ...actual,
    audit: graphMocks.audit,
    assignMobileApp: graphMocks.assignMobileApp,
    getMobileApp: graphMocks.getMobileApp,
    waitForAppPublished: graphMocks.waitForAppPublished,
    createWinGetApp: graphMocks.createWinGetApp,
  };
});

const { deployOrReuseWinGetApp } = await import("./winget-app-deploy.js");
const { GraphError } = await import("@patchpilot/graph");

const baseCtx = { engineer: "engineer@contoso.com", homeTenantId: "home-tenant", tenantId: "tenant-1" };
const baseInput = {
  ...baseCtx,
  source: "microsoft-store" as const,
  packageId: "9NZVDKPMR9RD",
  displayName: "Mozilla Firefox",
  publisher: "Mozilla",
};

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selectResults = [];
  graphMocks.audit.mockResolvedValue(undefined);
  graphMocks.assignMobileApp.mockResolvedValue(undefined);
  graphMocks.getMobileApp.mockReset();
  graphMocks.waitForAppPublished.mockResolvedValue(true);
  graphMocks.createWinGetApp.mockResolvedValue("new-app-id");
});

describe("deployOrReuseWinGetApp", () => {
  it("rejects an empty packageId before touching the database", async () => {
    await expect(
      deployOrReuseWinGetApp({ ...baseInput, packageId: "   " }),
    ).rejects.toMatchObject({ status: 400 });
    expect(dbState.insertValues).not.toHaveBeenCalled();
    expect(graphMocks.createWinGetApp).not.toHaveBeenCalled();
  });

  it("rejects a missing displayName or publisher before touching the database", async () => {
    await expect(
      deployOrReuseWinGetApp({ ...baseInput, displayName: "  " }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      deployOrReuseWinGetApp({ ...baseInput, publisher: "  " }),
    ).rejects.toMatchObject({ status: 400 });
    expect(graphMocks.createWinGetApp).not.toHaveBeenCalled();
  });

  it("reuses an existing deployment when the app still exists live in Intune (no assignment requested)", async () => {
    dbState.selectResults = [[{ intuneAppId: "existing-app-id" }]];
    graphMocks.getMobileApp.mockResolvedValue({ id: "existing-app-id" });

    const result = await deployOrReuseWinGetApp(baseInput);

    expect(result).toEqual({ appId: "existing-app-id", reused: true });
    expect(graphMocks.createWinGetApp).not.toHaveBeenCalled();
    expect(graphMocks.assignMobileApp).not.toHaveBeenCalled();
  });

  it("re-applies the requested assignment target on a reuse hit even though the app already existed", async () => {
    dbState.selectResults = [[{ intuneAppId: "existing-app-id" }]];
    graphMocks.getMobileApp.mockResolvedValue({ id: "existing-app-id" });

    const result = await deployOrReuseWinGetApp({
      ...baseInput,
      assignment: { mode: "all-devices" },
    });

    expect(result).toEqual({ appId: "existing-app-id", reused: true });
    expect(graphMocks.createWinGetApp).not.toHaveBeenCalled();
    expect(graphMocks.assignMobileApp).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "existing-app-id" }),
    );
  });

  it("falls through to a fresh create when the indexed app no longer exists live (deleted out-of-band)", async () => {
    dbState.selectResults = [[{ intuneAppId: "stale-app-id" }]];
    graphMocks.getMobileApp.mockResolvedValue(null);

    const result = await deployOrReuseWinGetApp(baseInput);

    expect(result.reused).toBe(false);
    expect(graphMocks.createWinGetApp).toHaveBeenCalledTimes(1);
    expect(graphMocks.createWinGetApp).toHaveBeenCalledWith(
      expect.objectContaining({ packageIdentifier: "9NZVDKPMR9RD", runAsAccount: "system" }),
    );
  });

  it("creates fresh, skips waitForAppPublished/assign entirely for assignment mode 'none' (the default)", async () => {
    dbState.selectResults = [[]];

    const result = await deployOrReuseWinGetApp(baseInput);

    expect(result).toEqual({ appId: "new-app-id", reused: false });
    expect(graphMocks.createWinGetApp).toHaveBeenCalledTimes(1);
    expect(graphMocks.waitForAppPublished).not.toHaveBeenCalled();
    expect(graphMocks.assignMobileApp).not.toHaveBeenCalled();
    expect(dbState.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        intuneAppId: "new-app-id",
        appType: "winget",
        source: "microsoft-store",
        packageId: "9NZVDKPMR9RD",
      }),
    );
  });

  it("rejects assignment mode 'group' without a groupId, without ever creating an app", async () => {
    dbState.selectResults = [[]];

    await expect(
      deployOrReuseWinGetApp({
        ...baseInput,
        assignment: { mode: "group" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(graphMocks.createWinGetApp).not.toHaveBeenCalled();
  });

  it("resolves the group, publishes, and assigns on a successful group-targeted deploy", async () => {
    dbState.selectResults = [[]];
    graphMocks.waitForAppPublished.mockResolvedValue(true);

    const result = await deployOrReuseWinGetApp({
      ...baseInput,
      assignment: { mode: "group", groupId: "group-id-1", groupName: "IT Staff" },
    });

    expect(result).toEqual({ appId: "new-app-id", reused: false });
    expect(graphMocks.assignMobileApp).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "new-app-id",
        targets: [expect.objectContaining({ groupId: "group-id-1" })],
      }),
    );
  });

  it("assigns both an include and an exclude target when both are given", async () => {
    dbState.selectResults = [[]];
    graphMocks.waitForAppPublished.mockResolvedValue(true);

    await deployOrReuseWinGetApp({
      ...baseInput,
      assignment: {
        mode: "group",
        groupId: "group-id-1",
        groupName: "IT Staff",
        excludeGroupId: "group-id-2",
        excludeGroupName: "Contractors",
      },
    });

    expect(graphMocks.assignMobileApp).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "new-app-id",
        targets: [
          expect.objectContaining({ groupId: "group-id-1" }),
          expect.objectContaining({
            "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget",
            groupId: "group-id-2",
          }),
        ],
      }),
    );
  });

  it("warns and skips assignment when Intune is still processing the new app server-side", async () => {
    dbState.selectResults = [[]];
    graphMocks.waitForAppPublished.mockResolvedValue(false);

    const result = await deployOrReuseWinGetApp({
      ...baseInput,
      assignment: { mode: "group", groupId: "group-id-1", groupName: "IT Staff" },
    });

    expect(result.reused).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(graphMocks.assignMobileApp).not.toHaveBeenCalled();
  });

  it("keeps the app id on the thrown error when assignment fails after a successful create+publish", async () => {
    dbState.selectResults = [[]];
    graphMocks.waitForAppPublished.mockResolvedValue(true);
    graphMocks.assignMobileApp.mockRejectedValue(new GraphError(403, "assignment forbidden"));

    await expect(
      deployOrReuseWinGetApp({
        ...baseInput,
        assignment: { mode: "group", groupId: "group-id-1", groupName: "IT Staff" },
      }),
    ).rejects.toMatchObject({ status: 403, appId: "new-app-id" });
  });

  it("surfaces a createWinGetApp failure without persisting a reuse-index row", async () => {
    dbState.selectResults = [[]];
    graphMocks.createWinGetApp.mockRejectedValue(new GraphError(502, "upstream error"));

    await expect(deployOrReuseWinGetApp(baseInput)).rejects.toMatchObject({ status: 502 });
    expect(dbState.insertValues).not.toHaveBeenCalled();
  });

  it("keeps the two source values collision-safe in the reuse-index lookup/insert (winget vs microsoft-store)", async () => {
    dbState.selectResults = [[]];

    await deployOrReuseWinGetApp({ ...baseInput, source: "winget", packageId: "Mozilla.Firefox" });

    expect(dbState.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ source: "winget", packageId: "Mozilla.Firefox" }),
    );
  });
});
