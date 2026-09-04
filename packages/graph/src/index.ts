/**
 * @patchpilot/graph — the shared Microsoft-API auth + client layer.
 *
 * Imported by both `apps/api` (request-time reads/writes) and `apps/worker`
 * (deferred/scheduled remediation), so the worker can resolve a delegated token
 * itself at execution time rather than depending on a request-bound token that
 * may have expired by the time a scheduled job runs.
 */
export { env, loadEnv, type GraphEnv } from "./env.js";
export { encrypt, decrypt, payloadHash, sha256Hex } from "./crypto.js";
export {
  storeToken,
  getToken,
  clearTokens,
  redis,
  type TokenSlot,
  type CachedToken,
} from "./token-store.js";
export {
  getCca,
  getLoginScopes,
  APP_REGISTRATION_SYNC_SCOPES,
  APP_REGISTRATION_TEST_SCOPES,
  ccaForEngineer,
  clearMsalCache,
  redeemLoginCode,
  redeemStepUpConsentCode,
  listEngineersWithCache,
  hasCachedSession,
  acquireTokenForTenant,
  acquireTokenForCustomerTenant,
  refreshLoginToken,
} from "./msal.js";
export {
  encodeKeysetCursor,
  decodeKeysetCursor,
  type KeysetCursor,
} from "./keyset-cursor.js";
export {
  audit,
  auditSafe,
  listAudits,
  listAuditsForExport,
  matchesAuditQuery,
  encodeAuditCursor,
  decodeAuditCursor,
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  AUDIT_MAX_EXPORT_ROWS,
  type AuditEntry,
  type AuditRecord,
  type AuditQuery,
  type AuditPage,
} from "./audit.js";
export {
  graphGet,
  graphWrite,
  graphUpload,
  GraphError,
  type GraphHost,
  type GraphCallOptions,
  type GraphWriteOptions,
  type GraphUploadOptions,
  type GraphUploadFile,
  type GraphResult,
} from "./client.js";
export {
  findQualityUpdateCatalogItem,
  listQualityUpdateCatalogItems,
  parseReleaseCadence,
  parseReleaseDate,
  catalogItemMatchesKb,
  ensureDeviceAssignmentFilter,
  createAndAssignQualityUpdateProfile,
  deleteQualityUpdateProfile,
  listQualityUpdateProfiles,
  listQualityUpdatePolicies,
  type QualityUpdateCatalogItem,
  type FindCatalogItemInput,
  type ListCatalogItemsInput,
  type EnsureAssignmentFilterInput,
  type CreateAndAssignProfileInput,
  type DeleteQualityUpdateProfileInput,
  type ListQualityUpdateProfilesInput,
  type QualityUpdateProfileSummary,
} from "./quality-updates.js";
export {
  listUpdateRingProfiles,
  type ListUpdateRingProfilesInput,
  type UpdateRingProfileSummary,
} from "./update-rings.js";
export {
  listDriverUpdateProfiles,
  type ListDriverUpdateProfilesInput,
  type DriverUpdateProfileSummary,
} from "./driver-updates.js";
export {
  resolveGroupIdByName,
  searchGroups,
  buildAssignmentTargets,
  assignMobileApp,
  getMobileApp,
  updateMobileAppMetadata,
  waitForAppPublished,
  type AssignmentMode,
  type AssignmentTarget,
  type MobileApp,
  type MobileAppAssignment,
  type GroupLookupResult,
  type ResolveGroupIdByNameInput,
  type SearchGroupsInput,
  type BuildAssignmentTargetInput,
  type AssignMobileAppInput,
  type GetMobileAppInput,
  type UpdateMobileAppMetadataInput,
  type WaitForAppPublishedInput,
} from "./intune-apps.js";
export {
  createWinGetApp,
  WINGET_APP_ODATA_TYPE,
  type CreateWinGetAppInput,
} from "./winget-app.js";
export {
  createWin32LobApp,
  uploadWin32AppContent,
  getWin32WrapperPackage,
  getWin32ScriptWrapperPackage,
  WIN32_LOB_APP_ODATA_TYPE,
  type CreateWin32LobAppInput,
  type UploadWin32AppContentInput,
  type Win32WrapperFamily,
  type Win32WrapperPackage,
} from "./win32-app.js";
export {
  syncAppRegistrationScopes,
  type ScopeSyncResult,
  testAppRegistrationScopes,
  type ScopeTestResult,
  type ScopeStatusEntry,
  updateAppRegistrationRedirectUris,
  type UpdateRedirectUrisResult,
  encodeRedirectUriRemoval,
  decodeRedirectUriRemoval,
} from "./app-registration-sync.js";
export {
  loadStoredEntitlement,
  saveStoredEntitlement,
  verifyEntitlement,
  decodeEntitlementClaims,
  loadStoredTrial,
  startTrial,
  trialExpiresAt,
  isTrialActive,
  resolveEffectiveEntitlement,
  FREE_TIER_TENANT_CAP,
  TRIAL_DEVICE_POOL,
  type EntitlementPayload,
  type StoredEntitlement,
  type StoredTrial,
  type EffectiveEntitlement,
} from "./entitlement.js";
export { ENTITLEMENT_PUBLIC_KEY_JWK } from "./entitlement-public-key.js";
export { assertWritesAllowed, assertSyncAllowed } from "./write-gate.js";
export {
  checkLiveResponseDeviceQuota,
  reserveLiveResponseDeviceSlot,
} from "./live-response-quota.js";
export {
  createAndAssignCampaignFeatureUpdateProfile,
  type CreateAndAssignCampaignFeatureUpdateProfileInput,
  deleteFeatureUpdateProfile,
  type DeleteFeatureUpdateProfileInput,
  listFeatureUpdateProfiles,
  resolveGroupNames as resolveFeatureUpdateGroupNames,
  type ListFeatureUpdateProfilesInput,
  type FeatureUpdateProfileSummary,
  type ResolveGroupNamesInput as ResolveFeatureUpdateGroupNamesInput,
} from "./feature-updates.js";
