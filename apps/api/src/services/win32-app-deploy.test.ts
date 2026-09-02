import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * deployOrReuseWin32App is DB + Graph coupled by design (it's the shared
 * create-or-reuse pipeline both the standalone route and the Run Now/Fix All
 * dispatch routes call synchronously) — these tests mock @patchpilot/db and
 * drizzle-orm's query-builder helpers entirely (no real connection exists in
 * a unit test process) but keep @patchpilot/graph's pure pieces
 * (GraphError, sha256Hex, buildAssignmentTargets) real, replacing only the
 * functions that make an actual Graph HTTP call. Group ids are resolved
 * client-side by the Entra group picker now, so assignment input carries
 * `groupId`/`excludeGroupId` directly — there is no server-side group-name
 * lookup left in this module to mock.
 */

const dbState = vi.hoisted(() => ({
  // Queue of rows returned by successive `db.select()...limit()` calls, in
  // call order — each test pushes exactly as many as the code path takes.
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
    wingetCatalog: { packageId: "wingetCatalog.packageId" },
    chocolateyCatalog: { packageId: "chocolateyCatalog.packageId" },
    scriptCatalog: { id: "scriptCatalog.id", tenantId: "scriptCatalog.tenantId" },
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
  // Unused here (the real audit() is itself replaced below), but
  // @patchpilot/graph's audit.ts imports this at module load time, so it
  // must exist as a named export for that import chain to resolve.
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
  createWin32LobApp: vi.fn(async () => "new-app-id"),
  uploadWin32AppContent: vi.fn(async () => undefined),
  getWin32WrapperPackage: vi.fn(() => fakeWrapperPackage()),
  getWin32ScriptWrapperPackage: vi.fn(() => fakeWrapperPackage()),
}));

function fakeWrapperPackage() {
  return {
    setupFileName: "install.ps1",
    package: Buffer.from("fake-package-bytes"),
    encryptionInfo: {
      encryptionKey: "key",
      fileDigest: "digest",
      fileDigestAlgorithm: "SHA256",
      initializationVector: "iv",
      mac: "mac",
      macKey: "mackey",
      profileIdentifier: "ProfileVersion1",
    },
    unencryptedContentSize: 19,
  };
}

vi.mock("@patchpilot/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@patchpilot/graph")>();
  return {
    ...actual,
    audit: graphMocks.audit,
    assignMobileApp: graphMocks.assignMobileApp,
    getMobileApp: graphMocks.getMobileApp,
    waitForAppPublished: graphMocks.waitForAppPublished,
    createWin32LobApp: graphMocks.createWin32LobApp,
    uploadWin32AppContent: graphMocks.uploadWin32AppContent,
    getWin32WrapperPackage: graphMocks.getWin32WrapperPackage,
    getWin32ScriptWrapperPackage: graphMocks.getWin32ScriptWrapperPackage,
  };
});

const { deployOrReuseWin32App, Win32DeployError } = await import("./win32-app-deploy.js");
const { GraphError } = await import("@patchpilot/graph");

const baseCtx = { engineer: "engineer@contoso.com", homeTenantId: "home-tenant", tenantId: "tenant-1" };

beforeEach(() => {
  // vi.clearAllMocks() only clears call history, not a mockResolvedValue/
  // mockRejectedValue set by a previous test — every graphMocks fn's default
  // success behavior must be re-armed here so one test's override (e.g. a
  // rejected uploadWin32AppContent) can't leak into the next test.
  vi.clearAllMocks();
  dbState.selectResults = [];
  graphMocks.audit.mockResolvedValue(undefined);
  graphMocks.assignMobileApp.mockResolvedValue(undefined);
  graphMocks.getMobileApp.mockReset();
  graphMocks.waitForAppPublished.mockResolvedValue(true);
  graphMocks.createWin32LobApp.mockResolvedValue("new-app-id");
  graphMocks.uploadWin32AppContent.mockResolvedValue(undefined);
  graphMocks.getWin32WrapperPackage.mockReturnValue(fakeWrapperPackage());
  graphMocks.getWin32ScriptWrapperPackage.mockReturnValue(fakeWrapperPackage());
});

describe("deployOrReuseWin32App", () => {
  it("rejects an empty packageId before touching the database", async () => {
    await expect(
      deployOrReuseWin32App({ ...baseCtx, source: "winget", packageId: "   ", displayName: "x", publisher: "y" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(dbState.insertValues).not.toHaveBeenCalled();
    expect(graphMocks.createWin32LobApp).not.toHaveBeenCalled();
  });

  it("reuses an existing deployment when the app still exists live in Intune", async () => {
    dbState.selectResults = [[{ intuneAppId: "existing-app-id" }]];
    graphMocks.getMobileApp.mockResolvedValue({ id: "existing-app-id" });

    const result = await deployOrReuseWin32App({
      ...baseCtx,
      source: "winget",
      packageId: "7zip.7zip",
      displayName: "7-Zip",
      publisher: "Igor Pavlov",
    });

    expect(result).toEqual({ appId: "existing-app-id", reused: true });
    expect(graphMocks.createWin32LobApp).not.toHaveBeenCalled();
    expect(graphMocks.uploadWin32AppContent).not.toHaveBeenCalled();
  });

  it("falls through to a fresh create when the indexed app no longer exists live (deleted out-of-band)", async () => {
    dbState.selectResults = [[{ intuneAppId: "stale-app-id" }]];
    graphMocks.getMobileApp.mockResolvedValue(null);

    const result = await deployOrReuseWin32App({
      ...baseCtx,
      source: "winget",
      packageId: "7zip.7zip",
      displayName: "7-Zip",
      publisher: "Igor Pavlov",
    });

    expect(result.reused).toBe(false);
    expect(graphMocks.createWin32LobApp).toHaveBeenCalledTimes(1);
  });

  it("creates fresh, skips waitForAppPublished/assign entirely for assignment mode 'none'", async () => {
    dbState.selectResults = [[]]; // no existing deployment row
    graphMocks.getWin32WrapperPackage.mockReturnValue(fakeWrapperPackage());

    const result = await deployOrReuseWin32App({
      ...baseCtx,
      source: "winget",
      packageId: "7zip.7zip",
      displayName: "7-Zip",
      publisher: "Igor Pavlov",
      assignment: { mode: "none" },
    });

    expect(result).toEqual({ appId: "new-app-id", reused: false });
    expect(graphMocks.createWin32LobApp).toHaveBeenCalledTimes(1);
    expect(graphMocks.uploadWin32AppContent).toHaveBeenCalledTimes(1);
    expect(graphMocks.waitForAppPublished).not.toHaveBeenCalled();
    expect(graphMocks.assignMobileApp).not.toHaveBeenCalled();
    // Reuse index persisted before assignment, so a later retry can find it.
    expect(dbState.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ intuneAppId: "new-app-id", source: "winget", packageId: "7zip.7zip" }),
    );
  });

  it("resolves displayName/publisher from the winget catalog row when both are omitted", async () => {
    dbState.selectResults = [
      [{ name: "7-Zip", publisher: "Igor Pavlov" }], // catalog lookup
      [], // no existing deployment
    ];

    await deployOrReuseWin32App({
      ...baseCtx,
      source: "winget",
      packageId: "7zip.7zip",
      assignment: { mode: "none" },
    });

    expect(graphMocks.createWin32LobApp).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "7-Zip", publisher: "Igor Pavlov" }),
    );
  });

  it("falls back to the raw packageId/'Unknown' when the catalog has no matching row", async () => {
    dbState.selectResults = [[], []];

    await deployOrReuseWin32App({
      ...baseCtx,
      source: "chocolatey",
      packageId: "filezilla",
      assignment: { mode: "none" },
    });

    expect(graphMocks.createWin32LobApp).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "filezilla", publisher: "Unknown" }),
    );
  });

  it("rejects assignment mode 'group' without a groupId, without ever creating an app", async () => {
    dbState.selectResults = [[]]; // no existing deployment

    await expect(
      deployOrReuseWin32App({
        ...baseCtx,
        source: "winget",
        packageId: "7zip.7zip",
        displayName: "7-Zip",
        publisher: "Igor Pavlov",
        assignment: { mode: "group" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(graphMocks.createWin32LobApp).not.toHaveBeenCalled();
  });

  it("resolves the group, publishes, and assigns on a successful group-targeted deploy", async () => {
    dbState.selectResults = [[]];
    graphMocks.waitForAppPublished.mockResolvedValue(true);

    const result = await deployOrReuseWin32App({
      ...baseCtx,
      source: "winget",
      packageId: "7zip.7zip",
      displayName: "7-Zip",
      publisher: "Igor Pavlov",
      assignment: { mode: "group", groupId: "group-id-1", groupName: "IT Staff" },
    });

    expect(result).toEqual({ appId: "new-app-id", reused: false });
    expect(graphMocks.assignMobileApp).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "new-app-id",
        targets: [
          expect.objectContaining({ groupId: "group-id-1" }),
        ],
      }),
    );
  });

  it("assigns both an include and an exclude target when both are given", async () => {
    dbState.selectResults = [[]];
    graphMocks.waitForAppPublished.mockResolvedValue(true);

    await deployOrReuseWin32App({
      ...baseCtx,
      source: "winget",
      packageId: "7zip.7zip",
      displayName: "7-Zip",
      publisher: "Igor Pavlov",
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

    const result = await deployOrReuseWin32App({
      ...baseCtx,
      source: "winget",
      packageId: "7zip.7zip",
      displayName: "7-Zip",
      publisher: "Igor Pavlov",
      assignment: { mode: "group", groupId: "group-id-1", groupName: "IT Staff" },
    });

    expect(result.reused).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(graphMocks.assignMobileApp).not.toHaveBeenCalled();
  });

  it("keeps the app id on the thrown error when content upload fails, so a retry reuses instead of duplicating", async () => {
    dbState.selectResults = [[]];
    graphMocks.uploadWin32AppContent.mockRejectedValue(new GraphError(502, "upstream error"));

    await expect(
      deployOrReuseWin32App({
        ...baseCtx,
        source: "winget",
        packageId: "7zip.7zip",
        displayName: "7-Zip",
        publisher: "Igor Pavlov",
        assignment: { mode: "none" },
      }),
    ).rejects.toMatchObject({ status: 502, appId: "new-app-id" });

    // The reuse index must already be persisted despite the later failure.
    expect(dbState.insertValues).toHaveBeenCalledWith(expect.objectContaining({ intuneAppId: "new-app-id" }));
  });

  it("keeps the app id on the thrown error when assignment fails after a successful create+upload", async () => {
    dbState.selectResults = [[]];
    graphMocks.waitForAppPublished.mockResolvedValue(true);
    graphMocks.assignMobileApp.mockRejectedValue(new GraphError(403, "assignment forbidden"));

    await expect(
      deployOrReuseWin32App({
        ...baseCtx,
        source: "winget",
        packageId: "7zip.7zip",
        displayName: "7-Zip",
        publisher: "Igor Pavlov",
        assignment: { mode: "group", groupId: "group-id-1", groupName: "IT Staff" },
      }),
    ).rejects.toMatchObject({ status: 403, appId: "new-app-id" });
  });

  describe("source: \"script\"", () => {
    it("bakes the catalog entry's content into the wrapper and resolves name/publisher from the entry", async () => {
      dbState.selectResults = [
        [{ id: "script-1", name: "Disable SMBv1", description: "desc", scriptContent: "Write-Output hi", scriptType: "powershell" }],
        [], // no existing deployment
      ];

      await deployOrReuseWin32App({
        ...baseCtx,
        source: "script",
        packageId: "script-1",
        assignment: { mode: "none" },
      });

      expect(graphMocks.getWin32ScriptWrapperPackage).toHaveBeenCalledWith(
        expect.objectContaining({ scriptCatalogEntryId: "script-1", scriptContent: "Write-Output hi" }),
      );
      expect(graphMocks.createWin32LobApp).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: "Disable SMBv1", publisher: "PatchPilot Script Catalog" }),
      );
    });

    it("rejects a non-PowerShell script catalog entry before ever calling createWin32LobApp", async () => {
      dbState.selectResults = [
        [{ id: "script-2", name: "Cleanup", description: "", scriptContent: "echo hi", scriptType: "batch" }],
      ];

      await expect(
        deployOrReuseWin32App({ ...baseCtx, source: "script", packageId: "script-2" }),
      ).rejects.toMatchObject({ status: 400 });

      expect(graphMocks.createWin32LobApp).not.toHaveBeenCalled();
    });

    it("404s when the script catalog entry doesn't exist (or isn't visible to this tenant)", async () => {
      dbState.selectResults = [[]];

      await expect(
        deployOrReuseWin32App({ ...baseCtx, source: "script", packageId: "does-not-exist" }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});

describe("Win32DeployError", () => {
  it("carries status, an optional needs-reconsent code, and an optional retry-safe appId", () => {
    const err = new Win32DeployError("boom", { status: 502, appId: "app-1" });
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(502);
    expect(err.appId).toBe("app-1");
    expect(err.code).toBeUndefined();
  });
});
