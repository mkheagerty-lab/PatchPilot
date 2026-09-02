import { z } from "zod";
import { Severity } from "./sla.js";
import { RemediationChannel } from "./channels.js";

/** A GDAP-linked customer tenant (or the MSP's own tenant). */
export const Tenant = z.object({
  id: z.string().uuid(),
  tenantId: z.string(), // Entra tenant GUID
  displayName: z.string(),
  consentStatus: z.enum(["consented", "pending", "expired"]),
  /** Channels enabled per detected licensing. Empty until probed. */
  readOnly: z.boolean().default(true),
  createdAt: z.coerce.date(),
});
export type Tenant = z.infer<typeof Tenant>;

export const Device = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  managedDeviceId: z.string(), // Intune managed device id
  defenderMachineId: z.string().nullable(),
  hostname: z.string(),
  os: z.string(),
  lastSeen: z.coerce.date().nullable(),
  compliance: z.enum(["compliant", "noncompliant", "unknown"]),
  vulnerabilityCount: z.number().int().nonnegative(),
  owner: z.string().nullable(),
});
export type Device = z.infer<typeof Device>;

export const Vulnerability = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  cveId: z.string(),
  title: z.string(),
  severity: Severity,
  cvss: z.number().nullable(),
  affectedDeviceCount: z.number().int().nonnegative(),
  software: z.string(),
  detectedAt: z.coerce.date(),
  /** True when a Winget package id is mapped for the affected software. */
  wingetRemediable: z.boolean(),
  wingetPackageId: z.string().nullable(),
  status: z.enum(["open", "in-progress", "remediated", "dismissed"]),
});
export type Vulnerability = z.infer<typeof Vulnerability>;

export const JobStatus = z.enum(["queued", "running", "succeeded", "failed"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const Job = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  deviceId: z.string().nullable(),
  cveId: z.string().nullable(),
  /** Set instead of `cveId` for Missing-KB Fix Now dispatches (OS remediation). */
  kbId: z.string().nullable().optional(),
  channel: RemediationChannel,
  status: JobStatus,
  engineer: z.string(),
  exitCode: z.number().nullable(),
  output: z.string().nullable(),
  queuedAt: z.coerce.date(),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
});
export type Job = z.infer<typeof Job>;

/**
 * A recurring remediation schedule — a cron expression driving a BullMQ
 * repeatable job in production. `target` is a free-form descriptor of the
 * device group / filter the schedule applies to.
 */
export const Schedule = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  name: z.string(),
  cron: z.string(),
  channel: RemediationChannel,
  target: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
  createdAt: z.coerce.date(),
});
export type Schedule = z.infer<typeof Schedule>;

/**
 * A single Defender missing-KB row (`getmissingkbs`) — the "By OS" / Missing
 * KBs surface, distinct from `Vulnerability`: this is per-device KB detail,
 * not a per-tenant product recommendation. `kbId` is Defender's `id` field
 * unmodified — the same value the Expedited Quality Update dispatch matches
 * against `windowsQualityUpdateCatalogItem.kbArticleId`.
 */
export const MissingKb = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  deviceId: z.string().uuid(),
  kbId: z.string(),
  title: z.string(),
  products: z.array(z.string()),
  cveCount: z.number().int().nonnegative(),
  cveIds: z.array(z.string()).default([]),
  url: z.string().nullable(),
  syncedAt: z.coerce.date(),
});
export type MissingKb = z.infer<typeof MissingKb>;

/** Branding settings — ported from the prototype's Settings -> Branding page. */
export const Branding = z.object({
  productName: z.string().default("PatchPilot"),
  primary: z.string().default("#4f46e5"),
  secondary: z.string().default("#0ea5e9"),
  accent: z.string().default("#f59e0b"),
  background: z.string().default("#0b1020"),
  logoUrl: z.string().nullable().default(null),
});
export type Branding = z.infer<typeof Branding>;
