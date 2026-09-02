export { db, schema } from "./client.js";
export type { Database } from "./client.js";
export * as tables from "./schema.js";
export type {
  FeatureUpdateAssignmentKind,
  FeatureUpdateAssignmentSummary,
  IntuneAssignmentKind,
  IntuneAssignmentSummary,
} from "./schema.js";
// Re-exported so API routes can build typed WHERE clauses without taking a
// direct dependency on drizzle-orm.
export { eq } from "drizzle-orm";
export {
  demoTenants,
  demoDevices,
  demoDeviceVulnerabilities,
  demoVulnerabilities,
  demoRecommendations,
  demoWingetCatalog,
  demoWingetCatalogOverrides,
  demoChocolateyCatalog,
  demoChocolateyCatalogOverrides,
  demoDeviceSoftware,
  demoSoftwareInventory,
  demoMissingKbs,
  demoJobs,
  demoSchedules,
  demoSla,
  demoBranding,
  demoRecommendationExceptions,
  demoDeviceExclusions,
  demoDeviceGroups,
  demoDeviceGroupMembers,
  demoAuditLog,
  demoPostureSnapshots,
  demoRemediationEvents,
} from "./demo-data.js";
export type {
  TenantRow,
  DeviceRow,
  DeviceVulnerabilityRow,
  VulnerabilityRow,
  RecommendationRow,
  WingetCatalogRow,
  WingetCatalogOverrideRow,
  ChocolateyCatalogRow,
  ChocolateyCatalogOverrideRow,
  DeviceSoftwareRow,
  SoftwareInventoryRow,
  MissingKbRow,
  JobRow,
  ScheduleRow,
  RecommendationExceptionRow,
  DeviceExclusionRow,
  DeviceGroupRow,
  DeviceGroupMemberRow,
  AuditLogRow,
  PostureSnapshotRow,
  RemediationEventRow,
  EngineerRow,
} from "./demo-data.js";
