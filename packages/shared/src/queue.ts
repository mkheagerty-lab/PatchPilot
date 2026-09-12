import { z } from "zod";
import { RemediationChannel } from "./channels.js";
import { PackageSource } from "./sources.js";
import { REPORT_TYPES } from "./reports.js";

/**
 * The remediation queue *contract* — shared by the api (producer) and the worker
 * (consumer). Only the queue name and the job-payload shape live here; each app
 * owns its own BullMQ runtime (Queue/Worker + Redis connection) so this stays a
 * dependency-light, pure contract with no ioredis/bullmq import.
 *
 * A job may be scheduled for later execution, so the worker resolves the
 * delegated token itself at run time (see `@patchpilot/graph`) rather than
 * carrying a token on the payload — the payload never holds a secret.
 */
export const REMEDIATION_QUEUE = "patchpilot-remediation";

/**
 * Redis pub/sub channel (not a BullMQ queue — no job payload, no consumer
 * group, no persistence) that `POST /api/onboarding/pair` publishes to once a
 * new Entra app registration has been paired and stored. Both `apps/api` and
 * `apps/worker` subscribe at startup and exit on receipt, relying on Docker
 * Compose's `restart: unless-stopped` to bring them back up so the freshly
 * extended `load-env.ts` in each can pick up the new credentials. See
 * apps/api/src/routes/onboarding-pairing.ts.
 */
export const CREDENTIALS_ROTATED_CHANNEL = "patchpilot:credentials-rotated";

/**
 * Redis pub/sub channel published by apps/api/src/routes/domains.ts whenever
 * the set of *active* custom domains changes (a verify succeeds, or an active
 * row is deleted). apps/api-only restart signal — EXTRA_WEB_ORIGINS/CORS is an
 * api-only concern (see load-env.ts's loadCustomDomains), so unlike
 * CREDENTIALS_ROTATED_CHANNEL above, apps/worker does not subscribe to this
 * one; restarting it on every domain edit would be a pointless extra restart.
 */
export const CUSTOM_DOMAINS_CHANGED_CHANNEL = "patchpilot:custom-domains-changed";

/**
 * The recurring-schedule queue *contract*. The worker owns the cron reconciler and
 * fan-out consumer (see apps/worker/src/scheduler.ts); the api is a producer only —
 * a "Run now" action enqueues a single "fire" job so an engineer can exercise a
 * recurring schedule on demand without waiting for its cron. The name lives here so
 * both sides agree on it.
 */
export const SCHEDULE_QUEUE = "patchpilot-schedules";

/** Payload for a schedule "fire" job — just the schedule to fan out. */
export const ScheduleFireJob = z.object({
  scheduleId: z.string().uuid(),
});
export type ScheduleFireJob = z.infer<typeof ScheduleFireJob>;

/** Payload for a single remediation job. */
export const RemediationJob = z.object({
  jobId: z.string().uuid(), // matches jobs.id in Postgres
  tenantId: z.string(),
  deviceId: z.string().nullable(),
  cveId: z.string().nullable(),
  /**
   * Set instead of `cveId` for a Missing-KB dispatch (Expedited Quality Update
   * or the Live Response OS-remediation path) — the Defender KB id the
   * executor threads into `generateWuaRemediationCom` / the catalog-item match.
   * Mutually exclusive with `cveId`.
   */
  kbId: z.string().nullable().optional(),
  /**
   * Set instead of `cveId`/`kbId` for an `expedited-feature-update` dispatch —
   * the friendly target label (e.g. "24H2") the executor resolves to a build
   * number via `resolveTargetBuild()`. Mutually exclusive with both.
   */
  featureUpdateVersion: z.string().nullable().optional(),
  channel: RemediationChannel,
  engineer: z.string(),
  script: z.string().optional(),
  /**
   * Engineer-selected winget package id override (Run Now dialog). When absent
   * the worker falls back to the CVE's stored winget mapping.
   */
  packageId: z.string().nullable().optional(),
  /**
   * Install-scope evidence at dispatch time. For channel "live-response" this
   * drives which invocation the worker sends — "user" routes through the
   * scheduled-task-as-logged-in-user path baked into the library script.
   */
  installScope: z.enum(["machine", "user", "unknown", "os"]).nullable().optional(),
  /**
   * "uninstall" routes the worker to the winget uninstall library script/args
   * instead of the upgrade one. Absent/"upgrade" = existing behaviour.
   */
  action: z.enum(["upgrade", "uninstall"]).nullable().optional(),
  /**
   * Alternate repo to drive a not-supported app through (winget has no
   * package for it). When set alongside `altPackageId`, the worker's
   * live-response dispatch prefers this over the winget/CVE resolution path —
   * mirrors `RemediationScriptInput.source` in scripts.ts so the job that
   * actually runs matches the script the engineer reviewed at dispatch time.
   *
   * `"script"` is a second, unrelated use of this same field: a win32-app
   * dispatch of a Script Catalog entry (not an alternate winget repo at
   * all) tags itself this way purely so the worker's win32-app executor case
   * knows to look up the `intune_app_deployments` reuse row under
   * `source: "script"` instead of resolving a winget package — see
   * `Win32Source` in scripts.ts, which is the real type for this concept.
   * Deliberately not folded into `PackageSource` itself: that type's
   * `SOURCE_SPECS` map (sources.ts) is a UI-facing "alternate repo for a
   * not-supported app" picker, and "script" isn't a repo an app can be
   * not-supported-in — adding it there would leak a bogus option into that
   * picker for no reason.
   */
  source: z.union([PackageSource, z.literal("script")]).nullable().optional(),
  /** Source-native package id (Chocolatey id / Store product id) / script_catalog.id for `source`. */
  altPackageId: z.string().nullable().optional(),
  /**
   * Engineer-chosen options for an `expedited-quality-update` dispatch
   * (single-device Fix Now / Fix All checklist path only — the group-campaign
   * path bypasses the job queue entirely, see `/api/missing-kbs/quality-update-campaigns`).
   * Queue-payload-only: no `jobs` table column, since these values are only
   * ever read once by the worker at dispatch time, not displayed on the Jobs
   * page or retried independently of the job itself.
   */
  qualityUpdateDisplayName: z.string().nullable().optional(),
  /** When set, the worker uses this catalog item directly instead of
   *  re-running `findQualityUpdateCatalogItem`'s KB-match lookup. */
  qualityUpdateCatalogItemId: z.string().nullable().optional(),
  qualityUpdateDaysUntilForcedReboot: z.union([z.literal(0), z.literal(1), z.literal(2)]).nullable().optional(),
});
export type RemediationJob = z.infer<typeof RemediationJob>;

/**
 * The report queue *contract*. Rendering a branded PDF means launching Chromium
 * and, optionally, several rounds of local inference — seconds to minutes, so
 * the api enqueues and `apps/worker/src/reports/worker.ts` consumes.
 *
 * This replaced an earlier "AI report" queue (`patchpilot-ai-reports`, now
 * retired — see the reports plan's §6 "Fate of the old surface") whose only
 * persistence was a BullMQ job's return value, so a finished report couldn't
 * survive an eviction, a `removeOnComplete`, or a Redis restart. Here,
 * **the job's return value is not the persistence**: `POST /api/reports`
 * inserts a `reports` row first and the worker writes its outcome (and the
 * PDF bytes) back to that row. The client polls the row id.
 *
 * The facts are gathered once by the api at enqueue time and ride the payload,
 * so the worker never re-derives a number: that's what makes the narration
 * fact-check meaningful. Every array in them is bounded before enqueue, because
 * this payload is JSON sitting in Redis.
 */
export const REPORT_QUEUE = "patchpilot-reports";

/** Branding as it crosses the queue: already sanitized by the api (hex colours
 * validated, logo reduced to a data URI or dropped), because the renderer is a
 * real browser and these values land in CSS and an `<img src>`. */
export const ReportJobBranding = z.object({
  productName: z.string(),
  primary: z.string(),
  secondary: z.string(),
  accent: z.string(),
  logo: z.string().nullable(),
});

export const ReportJob = z.object({
  /** Matches `reports.id` in Postgres — the row the worker updates, and the id
   * the client is polling. Not a BullMQ job id. */
  reportId: z.string().uuid(),
  reportType: z.enum(REPORT_TYPES),
  /** UPN of the requesting engineer. Re-validated at run time (still active,
   * still holds `operations:read`) since a job can outlive its request. */
  engineer: z.string(),
  /** null = every reachable tenant. */
  tenantId: z.string().nullable(),
  tenantName: z.string().nullable(),
  windowDays: z.number().int().min(1).max(365),
  /** Printed on the cover; resolved by the api so the document states the same
   * scope the api actually queried. */
  title: z.string(),
  /** What the engineer asked for. Whether it happens is the worker's outcome —
   * a missing `ai:use` is refused at the route, but an unreachable Ollama
   * degrades to the registry's deterministic captions. */
  narrate: z.boolean(),
  branding: ReportJobBranding,
  /** The report type's fact shape from `packages/shared/src/reports.ts`,
   * gathered by `apps/api/src/reports/facts.ts`. Typed `unknown` here because
   * this contract is shared with the api, which has no reason to re-validate a
   * blob it just produced; the worker narrows it by `reportType`. */
  facts: z.unknown(),
});
export type ReportJob = z.infer<typeof ReportJob>;
