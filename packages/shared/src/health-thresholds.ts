/**
 * Staleness thresholds shared between apps/worker (which enforces them) and
 * apps/api's Server Health routes (which report against the same definition
 * of "stuck", so the UI never disagrees with what the worker itself would do).
 * Previously each constant lived only in apps/worker/src — moved here because
 * apps/api cannot import apps/worker/src directly (no workspace dependency,
 * and infra/Dockerfile.api never copies worker source into the api image).
 */

/**
 * How far past its due time a recurring schedule's next fire may sit before
 * it's considered lost rather than merely mid-promotion. See
 * apps/worker/src/scheduler.ts's reconcileSchedules() for the full heal-path
 * rationale — this is the same value, just relocated so it can be imported
 * from both apps/worker and apps/api.
 */
export const MISSED_FIRE_GRACE_MS = 10 * 60_000;

/**
 * How long a job may sit "running" or "queued" before apps/worker's
 * sweepStaleJobs() fails it out from under a dead/hung run. See
 * apps/worker/src/index.ts for the sweep itself — this is the same value,
 * relocated so apps/api's Server Health "stuck jobs" tile can mirror the
 * exact same cutoff.
 */
export const STALE_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * How stale a container_stats row may be before the Processes tab treats a
 * container as stopped/mid-restart rather than just between updater polls.
 * ~3x the updater's default sampling cadence (run.sh's $INTERVAL, 15s).
 */
export const CONTAINER_STATS_STALE_MS = 45_000;
