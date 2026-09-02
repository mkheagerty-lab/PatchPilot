import { graphWrite, GraphError } from "./client.js";

/**
 * WinGet app creation (Phase 1 of Intune app deployment).
 *
 * Unlike a Win32 app, a `winGetApp` needs no packaging or content upload —
 * Intune resolves and builds the package server-side from `packageIdentifier`
 * (the same id `apps/api/src/catalog/winget-mirror.ts` already mirrors from
 * the community winget source into `winget_catalog`). This is the one Graph
 * call Phase 1 needs beyond the shared intune-apps.ts primitives.
 */

export const WINGET_APP_ODATA_TYPE = "#microsoft.graph.winGetApp";

export interface CreateWinGetAppInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  displayName: string;
  description: string;
  publisher: string;
  /** winget package id, e.g. "Google.Chrome" — matches winget_catalog.packageId. */
  packageIdentifier: string;
  runAsAccount: "system" | "user";
}

interface CreatedMobileApp {
  id: string;
}

/**
 * `POST /deviceAppManagement/mobileApps` with `@odata.type: "#microsoft.graph.winGetApp"`.
 * Returns the new app's id. Confirmed minimal required-at-creation fields:
 * `packageIdentifier` and `installExperience.runAsAccount` — everything else
 * is metadata editable later via updateMobileAppMetadata.
 *
 * Live-verified against BLACK IRON: v1.0 rejects this create with "Invalid
 * OData type specified" — `winGetApp` is a beta-only entity type, unlike
 * `win32LobApp` (Phase 2), which v1.0 does support. Must use the beta host.
 *
 * Package-id source matters: a community winget-repo id (e.g. "Google.Chrome",
 * per the Phase 1 root-cause finding — see task #20 history) stalls Intune's
 * server-side content resolution indefinitely. A Store-resolved id from the
 * `manifestSearch` endpoint (e.g. "9NZVDKPMR9RD" for Mozilla Firefox) does
 * NOT have this problem — live-verified against BLACK IRON: create + publish
 * succeeded in well under `waitForAppPublished`'s 90s default timeout. This is
 * exactly the distinction the "Microsoft Store app (new)" channel exists for.
 */
export async function createWinGetApp(input: CreateWinGetAppInput): Promise<string> {
  const { engineer, homeTenantId, tenantId, displayName, description, publisher, packageIdentifier, runAsAccount } =
    input;

  const created = await graphWrite<CreatedMobileApp>({
    engineer,
    homeTenantId,
    tenantId,
    host: "beta",
    method: "POST",
    path: "/deviceAppManagement/mobileApps",
    body: {
      "@odata.type": WINGET_APP_ODATA_TYPE,
      displayName,
      description,
      publisher,
      packageIdentifier,
      installExperience: { runAsAccount },
    },
  });
  if (!created.ok || !created.data?.id) {
    const detail = created.errorBody ? ` — ${created.errorBody}` : "";
    throw new GraphError(
      created.status,
      `failed to create winget app "${displayName}" (${packageIdentifier}) (HTTP ${created.status})${detail}`,
    );
  }
  return created.data.id;
}
