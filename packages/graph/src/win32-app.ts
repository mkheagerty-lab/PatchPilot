import { createHash } from "node:crypto";
import { buildIntuneWinPackage, type IntuneWinEncryptionInfo } from "@patchpilot/shared/intunewin";
import {
  generateWin32ChocolateyWrapperInstall,
  generateWin32ChocolateyWrapperUninstall,
  generateWin32WingetWrapperInstall,
  generateWin32WingetWrapperUninstall,
  generateWin32ScriptWrapperInstall,
  generateWin32ScriptWrapperUninstall,
  type Win32ScriptWrapperInput,
} from "@patchpilot/shared";
import { graphGet, graphWrite, GraphError } from "./client.js";
import { audit } from "./audit.js";

/**
 * Win32 app creation + content upload (Phase 2 of Intune app deployment).
 *
 * Unlike `winGetApp` (winget-app.ts), a `win32LobApp` needs its content —
 * the `.intunewin`-format encrypted blob `@patchpilot/shared`'s
 * `buildIntuneWinPackage` produces — uploaded through Intune's own
 * content-version pipeline before the app is usable. That pipeline is nine
 * calls: create a content version, create a file placeholder, poll it for an
 * Azure Blob SAS URI, PUT the encrypted bytes there in blocks, commit the
 * block list, commit the file (with the encryption info Intune needs to
 * decrypt it service-side), poll for that commit to succeed, then PATCH the
 * app to point at the newly committed version.
 *
 * The blob-upload steps (PUT block / PUT blocklist) are plain `fetch` calls,
 * not `graphWrite` — the SAS URI is a separately pre-authenticated endpoint
 * (auth lives in its own query string), not Graph or Defender, so it isn't in
 * client.ts's `HOSTS` map and needs no bearer token. They still get a single
 * summarizing `audit()` call (invariant #3: every outbound call is audited)
 * rather than one per chunk, matching the descriptor-not-bytes shape
 * `graphUpload` already uses for the Live Response library upload.
 *
 * Confirmed via winget-app.ts's own research note: unlike `winGetApp`,
 * `win32LobApp` is supported on v1.0, so every call here uses the default
 * `host: "graph"` rather than `beta`.
 */

export const WIN32_LOB_APP_ODATA_TYPE = "#microsoft.graph.win32LobApp";

/**
 * Fixed name for the uploaded content file, independent of the real wrapper
 * script name. This upload path doesn't build Microsoft's
 * `IntuneWinAppUtil.exe` container (see intunewin.ts's own JSDoc for why), so
 * there's no real "package file" for this name to describe — it only needs
 * to be *a* name Intune can display, and every third-party Graph-upload
 * reimplementation of this pipeline uses this same placeholder.
 */
const CONTENT_FILE_NAME = "IntunePackage.intunewin";

/** Broadest baseline unless the caller knows the package is architecture-specific. */
const DEFAULT_APPLICABLE_ARCHITECTURES = "x64, x86";

/**
 * Microsoft's own documented default return-code table — what the Intune
 * admin center itself pre-fills on a new Win32 app's Return Codes tab.
 * `win32LobApp.returnCodes` is required at creation (Graph rejects an empty
 * list), so this is a real default, not a placeholder — CIPP's per-app
 * Restart Behaviour toggle (task tracked separately) only needs to touch
 * `installExperience.deviceRestartBehavior`, not this table.
 */
const DEFAULT_RETURN_CODES = [
  { returnCode: 0, type: "success" },
  { returnCode: 1707, type: "success" },
  { returnCode: 3010, type: "softReboot" },
  { returnCode: 1641, type: "hardReboot" },
  { returnCode: 1618, type: "retry" },
];

export type Win32WrapperFamily = "winget" | "chocolatey";

export interface Win32WrapperPackage {
  /** Always "install.ps1" — the file Intune's `setupFilePath` points at. "uninstall.ps1" ships in the same content. */
  setupFileName: string;
  package: Buffer;
  encryptionInfo: IntuneWinEncryptionInfo;
  unencryptedContentSize: number;
}

const SETUP_FILE_NAME = "install.ps1";
const UNINSTALL_FILE_NAME = "uninstall.ps1";

const WRAPPER_SOURCES: Record<Win32WrapperFamily, () => { install: string; uninstall: string }> = {
  winget: () => ({
    install: generateWin32WingetWrapperInstall(),
    uninstall: generateWin32WingetWrapperUninstall(),
  }),
  chocolatey: () => ({
    install: generateWin32ChocolateyWrapperInstall(),
    uninstall: generateWin32ChocolateyWrapperUninstall(),
  }),
};

const wrapperPackageCache = new Map<Win32WrapperFamily, Win32WrapperPackage>();

/**
 * Builds (and memoizes, per process) the `.intunewin` content for one of the
 * two wrapper-script families. A win32LobApp has exactly one content
 * version, and its `installCommandLine`/`uninstallCommandLine` both invoke
 * files *within that same package* — so `install.ps1` and `uninstall.ps1`
 * are packaged together here, not as two separate uploads.
 *
 * Every Win32 app built from a given family — every winget package deployed
 * as a Win32 app, say — shares this exact same packaged content;
 * per-package variation lives entirely in the plain-text
 * `installCommandLine`/`uninstallCommandLine` strings on each app object,
 * never in the content itself (see scripts.ts's wrapper generators — they
 * take zero arguments). Intune has no "attach existing content to a new
 * app" API, so `uploadWin32AppContent` still runs its full upload pipeline
 * for every new app; this cache only saves the redundant zip+encrypt CPU
 * work, not a network round-trip.
 *
 * Reusing one build's random key/ciphertext across every app in a family
 * looks at first like it contradicts intunewin.ts's own "never reuse a key
 * across packages" rationale, but that rationale is about *different*
 * plaintext content sharing a key — here every app in a family has
 * byte-identical plaintext (no secrets, no package-specific data), so
 * decrypting one instance reveals nothing beyond what decrypting any other
 * instance of the same family already would.
 */
export function getWin32WrapperPackage(family: Win32WrapperFamily): Win32WrapperPackage {
  const cached = wrapperPackageCache.get(family);
  if (cached) return cached;

  const { install, uninstall } = WRAPPER_SOURCES[family]();
  const built = buildIntuneWinPackage({
    files: [
      { name: SETUP_FILE_NAME, content: Buffer.from(install, "utf-8") },
      { name: UNINSTALL_FILE_NAME, content: Buffer.from(uninstall, "utf-8") },
    ],
    setupFileName: SETUP_FILE_NAME,
  });
  const result: Win32WrapperPackage = { setupFileName: SETUP_FILE_NAME, ...built };
  wrapperPackageCache.set(family, result);
  return result;
}

/**
 * Per-entry cache for Script Catalog-sourced Win32 wrappers, keyed by
 * `scriptCatalogEntryId:contentHash` rather than by family the way
 * `wrapperPackageCache` is. Every winget (or Chocolatey) Win32 app shares one
 * byte-identical wrapper because the wrapper is generic and parameterized at
 * install time — a script-sourced wrapper embeds one specific catalog
 * entry's content, so no two entries (and no two edits of the same entry)
 * can share a cached package. Keying on the content hash rather than just the
 * entry id also means an edited-then-reverted script re-hits the same cache
 * entry instead of rebuilding.
 */
const scriptWrapperPackageCache = new Map<string, Win32WrapperPackage>();

export function getWin32ScriptWrapperPackage(input: Win32ScriptWrapperInput): Win32WrapperPackage {
  const cacheKey = `${input.scriptCatalogEntryId}:${input.contentHash}`;
  const cached = scriptWrapperPackageCache.get(cacheKey);
  if (cached) return cached;

  const install = generateWin32ScriptWrapperInstall(input);
  const uninstall = generateWin32ScriptWrapperUninstall(input);
  const built = buildIntuneWinPackage({
    files: [
      { name: SETUP_FILE_NAME, content: Buffer.from(install, "utf-8") },
      { name: UNINSTALL_FILE_NAME, content: Buffer.from(uninstall, "utf-8") },
    ],
    setupFileName: SETUP_FILE_NAME,
  });
  const result: Win32WrapperPackage = { setupFileName: SETUP_FILE_NAME, ...built };
  scriptWrapperPackageCache.set(cacheKey, result);
  return result;
}

export interface CreateWin32LobAppInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  displayName: string;
  description: string;
  publisher: string;
  /** Plain-text CLI invocation, e.g. `powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -PackageId 7zip.7zip`. */
  installCommandLine: string;
  uninstallCommandLine: string;
  runAsAccount: "system" | "user";
  /**
   * Relative path of the wrapper script inside the packaged content, e.g.
   * "install.ps1" — must match the `setupFileName` passed to
   * `buildIntuneWinPackage` when the content was built.
   */
  setupFileName: string;
  /**
   * Base64-encoded PowerShell detection script content (the caller
   * base64-encodes `generateWingetDetect`/`generateChocolateyDetect`'s
   * output) — a plain-text property on the app object, not part of the
   * encrypted content, so it's free to vary per package.
   */
  detectionScriptContentBase64: string;
  applicableArchitectures?: string;
}

interface CreatedMobileApp {
  id: string;
}

/**
 * `POST /deviceAppManagement/mobileApps` with `@odata.type: "#microsoft.graph.win32LobApp"`.
 * Returns the new app's id. The app is not installable yet — content still
 * needs uploading via `uploadWin32AppContent`, mirroring how a real
 * Win32 app stays in "Not ready" in the Intune admin center until its
 * content version commits.
 */
export async function createWin32LobApp(input: CreateWin32LobAppInput): Promise<string> {
  const {
    engineer,
    homeTenantId,
    tenantId,
    displayName,
    description,
    publisher,
    installCommandLine,
    uninstallCommandLine,
    runAsAccount,
    setupFileName,
    detectionScriptContentBase64,
    applicableArchitectures,
  } = input;

  const created = await graphWrite<CreatedMobileApp>({
    engineer,
    homeTenantId,
    tenantId,
    method: "POST",
    path: "/deviceAppManagement/mobileApps",
    body: {
      "@odata.type": WIN32_LOB_APP_ODATA_TYPE,
      displayName,
      description,
      publisher,
      fileName: CONTENT_FILE_NAME,
      setupFilePath: setupFileName,
      installCommandLine,
      uninstallCommandLine,
      applicableArchitectures: applicableArchitectures ?? DEFAULT_APPLICABLE_ARCHITECTURES,
      minimumSupportedOperatingSystem: { v10_1607: true },
      installExperience: { runAsAccount, deviceRestartBehavior: "basedOnReturnCode" },
      returnCodes: DEFAULT_RETURN_CODES,
      // `detectionRules`/`win32LobAppPowerShellScriptDetection` is the old
      // (pre-GA) shape and is silently ignored by the current v1.0 backend —
      // detection lives under the unified `rules` collection instead, as a
      // `win32LobAppPowerShellScriptRule` with `ruleType: "detection"`
      // (confirmed against learn.microsoft.com's current win32LobApp-create
      // example, which shows `rules`, not `detectionRules`).
      rules: [
        {
          "@odata.type": "#microsoft.graph.win32LobAppPowerShellScriptRule",
          ruleType: "detection",
          scriptContent: detectionScriptContentBase64,
          enforceSignatureCheck: false,
          runAs32Bit: false,
          operationType: "notConfigured",
          operator: "notConfigured",
        },
      ],
    },
  });
  if (!created.ok || !created.data?.id) {
    const detail = created.errorBody ? ` — ${created.errorBody}` : "";
    throw new GraphError(
      created.status,
      `failed to create win32 app "${displayName}" (HTTP ${created.status})${detail}`,
    );
  }
  return created.data.id;
}

export interface UploadWin32AppContentInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  appId: string;
  /** `buildIntuneWinPackage`'s `package` — the encrypted mac||iv||ciphertext blob, uploaded unmodified. */
  package: Buffer;
  encryptionInfo: IntuneWinEncryptionInfo;
  unencryptedContentSize: number;
}

interface ContentVersion {
  id: string;
}

interface ContentFile {
  id: string;
  azureStorageUri?: string | null;
  uploadState?: string;
}

/** Azure Blob's Put Block limit is 4000 blocks per blob; 6MB keeps well under it for any realistic package. */
const BLOB_CHUNK_BYTES = 6 * 1024 * 1024;
const BLOB_UPLOAD_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_ATTEMPTS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollContentFile(
  opts: { engineer: string; homeTenantId: string; tenantId: string; path: string },
  isReady: (f: ContentFile) => boolean,
  isFailed: (f: ContentFile) => boolean,
  waitingFor: string,
): Promise<ContentFile> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const res = await graphGet<ContentFile>(opts);
    if (!res.ok || !res.data) {
      throw new GraphError(res.status, `failed to poll content file at ${opts.path} (HTTP ${res.status})`);
    }
    if (isFailed(res.data)) {
      throw new GraphError(
        502,
        `content file at ${opts.path} entered a failed state (${res.data.uploadState ?? "unknown"}) while ${waitingFor}`,
      );
    }
    if (isReady(res.data)) return res.data;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new GraphError(408, `timed out ${waitingFor} for content file at ${opts.path}`);
}

/**
 * PUTs `content` to the Azure Blob SAS URI in fixed-size blocks (Put Block),
 * then commits them (Put Block List). Block ids must all share the same
 * decoded length within one blob — the zero-padded index guarantees that.
 * Plain `fetch`, deliberately outside client.ts: the SAS URI carries its own
 * auth in the query string and needs no bearer token.
 */
async function uploadBlobBlocks(azureStorageUri: string, content: Buffer): Promise<string[]> {
  const blockIds: string[] = [];
  const totalBlocks = Math.max(1, Math.ceil(content.length / BLOB_CHUNK_BYTES));

  for (let i = 0; i < totalBlocks; i++) {
    const start = i * BLOB_CHUNK_BYTES;
    const chunk = content.subarray(start, Math.min(start + BLOB_CHUNK_BYTES, content.length));
    const blockId = Buffer.from(String(i).padStart(8, "0")).toString("base64");
    blockIds.push(blockId);

    const url = new URL(azureStorageUri);
    url.searchParams.set("comp", "block");
    url.searchParams.set("blockid", blockId);

    const res = await fetch(url.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: chunk,
      signal: AbortSignal.timeout(BLOB_UPLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new GraphError(
        res.status,
        `Azure Blob block upload failed for block ${i + 1}/${totalBlocks} (HTTP ${res.status})`,
      );
    }
  }
  return blockIds;
}

async function commitBlobBlockList(azureStorageUri: string, blockIds: string[]): Promise<void> {
  const url = new URL(azureStorageUri);
  url.searchParams.set("comp", "blocklist");

  const xml = `<?xml version="1.0" encoding="utf-8"?><BlockList>${blockIds
    .map((id) => `<Latest>${id}</Latest>`)
    .join("")}</BlockList>`;

  const res = await fetch(url.toString(), {
    method: "PUT",
    headers: { "Content-Type": "text/plain; charset=UTF-8" },
    body: xml,
    signal: AbortSignal.timeout(BLOB_UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new GraphError(res.status, `Azure Blob block-list commit failed (HTTP ${res.status})`);
  }
}

/**
 * The full content-upload pipeline for a win32LobApp created by
 * `createWin32LobApp`. Throws `GraphError` on any failed or timed-out step —
 * a half-uploaded app is a real tenant-side artifact ("Not ready" in the
 * Intune admin center forever) the caller needs visibility into, never
 * silently swallowed.
 */
export async function uploadWin32AppContent(input: UploadWin32AppContentInput): Promise<void> {
  const { engineer, homeTenantId, tenantId, appId, package: pkg, encryptionInfo, unencryptedContentSize } = input;
  const gopts = { engineer, homeTenantId, tenantId };
  const contentVersionsPath = `/deviceAppManagement/mobileApps/${appId}/microsoft.graph.win32LobApp/contentVersions`;

  const version = await graphWrite<ContentVersion>({
    ...gopts,
    method: "POST",
    path: contentVersionsPath,
    body: {},
  });
  if (!version.ok || !version.data?.id) {
    const detail = version.errorBody ? ` — ${version.errorBody}` : "";
    throw new GraphError(version.status, `failed to create content version for win32 app ${appId} (HTTP ${version.status})${detail}`);
  }
  const versionId = version.data.id;
  const filesPath = `${contentVersionsPath}/${versionId}/files`;

  const filePlaceholder = await graphWrite<ContentFile>({
    ...gopts,
    method: "POST",
    path: filesPath,
    body: {
      "@odata.type": "#microsoft.graph.mobileAppContentFile",
      name: CONTENT_FILE_NAME,
      size: unencryptedContentSize,
      sizeEncrypted: pkg.length,
      manifest: null,
      isDependency: false,
    },
  });
  if (!filePlaceholder.ok || !filePlaceholder.data?.id) {
    const detail = filePlaceholder.errorBody ? ` — ${filePlaceholder.errorBody}` : "";
    throw new GraphError(
      filePlaceholder.status,
      `failed to create content file placeholder for win32 app ${appId} (HTTP ${filePlaceholder.status})${detail}`,
    );
  }
  const fileId = filePlaceholder.data.id;
  const fileResourcePath = `${filesPath}/${fileId}`;

  const readyFile = await pollContentFile(
    { ...gopts, path: fileResourcePath },
    (f) => f.uploadState === "azureStorageUriRequestSuccess" && !!f.azureStorageUri,
    (f) => f.uploadState === "azureStorageUriRequestFailed",
    "waiting for Azure Storage URI",
  );
  if (!readyFile.azureStorageUri) {
    throw new GraphError(502, `win32 app ${appId} content file ${fileId} has no azureStorageUri after azureStorageUriRequestSuccess`);
  }

  const blockIds = await uploadBlobBlocks(readyFile.azureStorageUri, pkg);
  await commitBlobBlockList(readyFile.azureStorageUri, blockIds);
  await audit({
    engineer,
    tenantId,
    endpoint: "azureblob:win32LobApp/contentVersions/files/blocklist",
    method: "PUT",
    category: "api_call",
    payload: {
      appId,
      versionId,
      fileId,
      sha256: createHash("sha256").update(pkg).digest("hex"),
      sizeEncrypted: pkg.length,
      blockCount: blockIds.length,
    },
    responseStatus: 201,
  });

  const commit = await graphWrite({
    ...gopts,
    method: "POST",
    path: `${fileResourcePath}/commit`,
    body: { fileEncryptionInfo: encryptionInfo },
  });
  if (!commit.ok) {
    const detail = commit.errorBody ? ` — ${commit.errorBody}` : "";
    throw new GraphError(commit.status, `failed to commit content file for win32 app ${appId} (HTTP ${commit.status})${detail}`);
  }

  await pollContentFile(
    { ...gopts, path: fileResourcePath },
    (f) => f.uploadState === "commitFileSuccess",
    (f) => f.uploadState === "commitFileFailed",
    "waiting for content commit",
  );

  const patched = await graphWrite({
    ...gopts,
    method: "PATCH",
    path: `/deviceAppManagement/mobileApps/${appId}`,
    body: { "@odata.type": WIN32_LOB_APP_ODATA_TYPE, committedContentVersion: versionId },
  });
  if (!patched.ok) {
    const detail = patched.errorBody ? ` — ${patched.errorBody}` : "";
    throw new GraphError(patched.status, `failed to set committedContentVersion on win32 app ${appId} (HTTP ${patched.status})${detail}`);
  }
}
