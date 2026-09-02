import "./load-env.js"; // MUST be first: populates process.env from the root .env before db/queue config is read.
import { Worker } from "bullmq";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { auditSafe, env } from "@patchpilot/graph";
import { CHANNEL_SPECS, CREDENTIALS_ROTATED_CHANNEL, SYSTEM_ACTORS, sanitizeDbTextBounded } from "@patchpilot/shared";
import { sendAlertEmail } from "@patchpilot/shared/alerting";
import { registerAlertingResolver } from "./alerting-config.js";
import { REMEDIATION_QUEUE, connection, RemediationJob } from "./queue.js";
import { executeRemediation } from "./executor.js";
import {
  backfillMissedVerifications,
  backfillRemediationAttribution,
  recordRemediationSuccess,
} from "./post-remediation.js";
import { startScheduler } from "./scheduler.js";
import { startBackupWatchdog } from "./backup-watchdog.js";
import { closeBrowser } from "./reports/browser.js";
import { startReportWorker } from "./reports/worker.js";
import { startReportRetention } from "./reports/retention.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "worker" });

registerAlertingResolver();

/**
 * Backstop above every timeout internal to `executeRemediation` (e.g. the
 * live-response channel's own 5-minute polling bound, or `graphGet`/`graphWrite`'s
 * 30s-per-request bound). Guarantees the job always reaches a terminal DB status
 * instead of parking at "running" forever — the failure mode a live "Run Now"
 * hit in production before these timeouts existed.
 */
const JOB_TIMEOUT_MS = 7 * 60_000;

/**
 * Distinguishes "the backstop above fired" from "the executor itself threw".
 * Both end the job the same way, but only the first is a worker decision that
 * overrode a run still in flight — which is the one worth auditing.
 */
class JobTimeoutError extends Error {}

/** Bounded id list for `detail` — a sweep can cover more rows than anyone reads. */
function idList(ids: readonly string[], max = 10): string {
  if (ids.length <= max) return ids.join(", ");
  return `${ids.slice(0, max).join(", ")} + ${ids.length - max} more`;
}

/**
 * Startup-only orphan sweep: any job already "running" the instant this
 * process boots cannot legitimately belong to this instance — it hasn't
 * dispatched anything yet — so a "running" row at this point can only be a
 * leftover from a previous process that died or restarted mid-execution
 * (the in-flight `JOB_TIMEOUT_MS` race and the periodic stale sweep both
 * live in that dead process's memory and died with it). Unlike
 * `sweepStaleJobs`, this ignores `startedAt`/age entirely, closing the gap
 * where such an orphan would otherwise sit "running" for up to
 * `STALE_TIMEOUT_MS` (2h) before the periodic sweep caught up to it — this
 * is what left a live-response job stuck "running" for ~1h in production.
 *
 * Must run and complete BEFORE the BullMQ `Worker` below starts consuming:
 * otherwise a job BullMQ legitimately redelivers to this fresh process could
 * be marked "running" first and then incorrectly failed by this sweep.
 */
async function sweepOrphanedRunningJobs(): Promise<void> {
  const orphaned = await db
    .update(tables.jobs)
    .set({
      status: "failed",
      exitCode: 1,
      output:
        "Job orphaned: still 'running' when the worker started (previous process likely died or restarted mid-execution).",
      finishedAt: new Date(),
    })
    .where(eq(tables.jobs.status, "running"))
    .returning({ id: tables.jobs.id });

  if (orphaned.length > 0) {
    log.warn(
      { jobIds: orphaned.map((j) => j.id) },
      `startup sweep: failed ${orphaned.length} orphaned running job(s)`,
    );
    // Only when the sweep actually took rows: a clean restart is the normal case
    // and would otherwise write an empty "swept nothing" row on every boot.
    // The sweep spans whatever tenants those jobs belonged to, so it belongs to
    // none of them — the ids in `detail` are how you get back to the rows.
    await auditSafe({
      engineer: SYSTEM_ACTORS.startup,
      actorType: "worker",
      tenantId: null,
      endpoint: "worker:startup-sweep",
      method: "SWEEP",
      action: "job:orphan-swept",
      resourceType: "job",
      summary: `Failed ${orphaned.length} job(s) left "running" by a previous worker process`,
      outcome: "success",
      detail: idList(orphaned.map((j) => j.id)),
      responseStatus: 200,
    });
    void sendAlertEmail("worker", {
      key: "orphaned-jobs-swept",
      subject: `${orphaned.length} job(s) orphaned by a previous worker crash/restart`,
      body: `The worker's startup sweep failed ${orphaned.length} job(s) still marked "running" from a previous process:\n\n${idList(orphaned.map((j) => j.id), 25)}\n\nThis usually means the worker process died or restarted mid-remediation.`,
    });
  }
}

// A crash after this point should alert-then-exit rather than keep running in
// an unknown state (Node's own guidance on uncaughtException), and the process
// manager (dev:resilient locally, systemd/pm2 in production) is what restarts
// it. sendAlertEmail is awaited here specifically so the email has a chance to
// leave before the process exits underneath it.
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "uncaughtException");
  void sendAlertEmail("worker", {
    key: "uncaughtException",
    subject: "Uncaught exception — worker exiting",
    body: `${err.stack ?? err.message}\n\nThe worker process is exiting; it should be restarted by its process manager.`,
  }).finally(() => process.exit(1));
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.fatal({ err }, "unhandledRejection");
  void sendAlertEmail("worker", {
    key: "unhandledRejection",
    subject: "Unhandled promise rejection — worker exiting",
    body: `${err.stack ?? err.message}\n\nThe worker process is exiting; it should be restarted by its process manager.`,
  }).finally(() => process.exit(1));
});

await sweepOrphanedRunningJobs();

/**
 * Processes remediation jobs from the queue: marks job state transitions in
 * Postgres and dispatches to the real channel executor, which resolves a
 * delegated token itself (Option C) and either issues a Microsoft write or
 * honestly refuses one. DEMO_MODE and the read-only-first gate live in the
 * executor (see ./executor.ts), so this loop is just the job lifecycle.
 */
const worker = new Worker(
  REMEDIATION_QUEUE,
  async (job) => {
    const payload = RemediationJob.parse(job.data);
    const spec = CHANNEL_SPECS[payload.channel];
    // Child logger scoped to this job: every log line for its lifetime carries
    // jobId/tenantId/channel as structured fields, so they can be filtered and
    // correlated across the whole run without re-interpolating ids into strings.
    const jobLog = log.child({ jobId: payload.jobId, tenantId: payload.tenantId, channel: payload.channel });

    await db
      .update(tables.jobs)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(tables.jobs.id, payload.jobId));

    jobLog.info({ endpoint: spec.endpointTemplate }, `dispatching -> ${spec.label}`);

    // Persists the live-response progress transcript onto the job row as it's
    // built, so the Jobs UI shows real device-side activity instead of an
    // opaque "Running" the whole time. A failed write here is logged, not
    // thrown — it must never abort the remediation itself.
    const onProgress = async (transcript: string): Promise<void> => {
      try {
        await db
          .update(tables.jobs)
          .set({ output: sanitizeDbTextBounded(transcript) })
          .where(eq(tables.jobs.id, payload.jobId));
      } catch (err) {
        jobLog.error({ err }, "progress write failed");
      }
    };

    let result: Awaited<ReturnType<typeof executeRemediation>>;
    try {
      result = await Promise.race([
        executeRemediation(payload, onProgress),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new JobTimeoutError(`remediation timed out after ${JOB_TIMEOUT_MS}ms`)),
            JOB_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { exitCode: 1, output: `${spec.label}: ${message}` };

      // Only the backstop, not every executor failure: an executor error is the
      // job's own outcome (already on the jobs row), whereas a timeout is the
      // worker cutting a run short with nobody deciding so.
      if (err instanceof JobTimeoutError) {
        await auditSafe({
          engineer: SYSTEM_ACTORS.worker,
          actorType: "worker",
          tenantId: payload.tenantId,
          endpoint: "worker:job-timeout",
          method: "SWEEP",
          action: "job:timeout",
          resourceType: "job",
          resourceId: payload.jobId,
          resourceLabel: payload.cveId ?? spec.label,
          summary: `Timed out a ${spec.label} job after ${JOB_TIMEOUT_MS / 60_000} minutes`,
          outcome: "failure",
          detail: `dispatched by ${payload.engineer}`,
          responseStatus: 504,
          latencyMs: JOB_TIMEOUT_MS,
        });
      }
    }

    // Reaching a terminal status must not depend on `output` being storable.
    // A single unstorable character in device output used to throw here, which
    // escaped the processor and left the row at "running" forever with a
    // transcript truncated at the last clean write — indistinguishable in the UI
    // from a hung job. So: sanitize first, and if the write still fails, retry
    // with the transcript dropped rather than lose the status.
    // Exit code 6 is the live-response winget script's own verdict for "already
    // on the newest version winget has available" (see wingetLiveResponseLibraryScript
    // in packages/shared/src/scripts.ts) — compliant, not a failure. No other
    // channel ever returns 6, so this can't misclassify a real failure elsewhere.
    const terminalStatus = result.exitCode === 0 || result.exitCode === 6 ? "succeeded" : "failed";
    try {
      await db
        .update(tables.jobs)
        .set({
          status: terminalStatus,
          exitCode: result.exitCode,
          output: sanitizeDbTextBounded(result.output),
          finishedAt: new Date(),
        })
        .where(eq(tables.jobs.id, payload.jobId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jobLog.error({ err }, "terminal write failed, retrying without output");
      await db
        .update(tables.jobs)
        .set({
          status: terminalStatus,
          exitCode: result.exitCode,
          output: `Job finished with exit code ${result.exitCode}, but its output could not be stored (${message}).`,
          finishedAt: new Date(),
        })
        .where(eq(tables.jobs.id, payload.jobId));
    }

    // A patched device won't clear in Defender for another 3-4 hours (its
    // inventory cadence, which Microsoft gives no way to force). Record what the
    // script proved on the device and queue the catch-up syncs that will let
    // Defender confirm it. Annotation only — never allowed to change the verdict
    // above, so failures are logged and swallowed.
    if (terminalStatus === "succeeded") {
      try {
        await recordRemediationSuccess(payload, result.output);
      } catch (err) {
        jobLog.error({ err }, "post-remediation bookkeeping failed");
      }
    }

    return result;
  },
  { connection, concurrency: 5 },
);

worker.on("ready", () => log.info("ready, listening for remediation jobs"));
worker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err }, "job failed");
  // Keyed by job id (not a fixed string) so a batch of independent failures
  // each gets reported once, rather than the cooldown swallowing the 2nd..Nth
  // job in an unattended overnight run just because one already alerted.
  void sendAlertEmail("worker", {
    key: `remediation-job-failed:${job?.id ?? "unknown"}`,
    subject: "A remediation job failed",
    body: `Remediation job ${job?.id ?? "(unknown)"} failed:\n\n${err.message}`,
  });
});
// BullMQ's Worker is its own EventEmitter and re-emits connection/internal
// errors on itself (distinct from the raw ioredis `connection` in ./queue.ts,
// which is already handled there). Node's default for an unlistened "error"
// event is to throw and crash the process — exactly the failure mode that
// leaves every job stuck "queued" forever, since the sweeps above live in
// this same process and die with it. Log and let ioredis's own reconnect
// handle transient blips instead.
worker.on("error", (err) => {
  log.error({ err }, "job worker error");
  void sendAlertEmail("worker", {
    key: "remediation-worker-error",
    subject: "Remediation worker error",
    body: `The remediation job worker reported an error:\n\n${err.message}`,
  });
});

/**
 * Stale-job sweep: a periodic backstop above `JOB_TIMEOUT_MS`, which only
 * protects against `executeRemediation` itself hanging. It does NOT protect
 * against the worker *process* dying/restarting mid-flight, which orphans a
 * DB row in "running" forever (confirmed live: several `live-response` jobs
 * from an earlier session are still "running" with no `finishedAt`). This
 * sweep marks any job over 2 hours old as failed so the rest of the queue
 * (and anyone waiting on it in the UI) isn't stuck behind a dead run.
 */
const STALE_TIMEOUT_MS = 2 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

async function sweepStaleJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_TIMEOUT_MS);

  const staleRunning = await db
    .update(tables.jobs)
    .set({
      status: "failed",
      exitCode: 1,
      output: `Job timed out: still running after ${STALE_TIMEOUT_MS / 3_600_000}h.`,
      finishedAt: new Date(),
    })
    .where(and(eq(tables.jobs.status, "running"), lt(tables.jobs.startedAt, cutoff)))
    .returning({ id: tables.jobs.id });

  // Queued jobs: measure from scheduleAt when set (a deliberately deferred
  // job shouldn't be killed before its scheduled time ever arrives), else
  // from queuedAt.
  const staleQueued = await db
    .update(tables.jobs)
    .set({
      status: "failed",
      exitCode: 1,
      output: `Job timed out: still queued after ${STALE_TIMEOUT_MS / 3_600_000}h.`,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(tables.jobs.status, "queued"),
        or(
          and(isNull(tables.jobs.scheduleAt), lt(tables.jobs.queuedAt, cutoff)),
          lt(tables.jobs.scheduleAt, cutoff),
        ),
      ),
    )
    .returning({ id: tables.jobs.id });

  const timedOut = [...staleRunning, ...staleQueued];
  if (timedOut.length > 0) {
    log.warn({ jobIds: timedOut.map((j) => j.id) }, `swept ${timedOut.length} stale job(s)`);
    // Nothing swept writes nothing: this runs every 5 minutes and finds nothing
    // the overwhelming majority of the time.
    await auditSafe({
      engineer: SYSTEM_ACTORS.worker,
      actorType: "worker",
      tenantId: null,
      endpoint: "worker:stale-sweep",
      method: "SWEEP",
      action: "job:stale-swept",
      resourceType: "job",
      summary: `Failed ${timedOut.length} job(s) stuck for over ${STALE_TIMEOUT_MS / 3_600_000}h — ${staleRunning.length} running, ${staleQueued.length} queued`,
      outcome: "success",
      detail: idList(timedOut.map((j) => j.id)),
      responseStatus: 200,
    });
    void sendAlertEmail("worker", {
      key: "stale-jobs-swept",
      subject: `${timedOut.length} job(s) stuck for over ${STALE_TIMEOUT_MS / 3_600_000}h`,
      body: `The periodic stale-job sweep failed ${timedOut.length} job(s) — ${staleRunning.length} stuck "running", ${staleQueued.length} stuck "queued":\n\n${idList(timedOut.map((j) => j.id), 25)}`,
    });
  }
}

const sweepTimer = setInterval(() => {
  sweepStaleJobs().catch((err) => log.error({ err }, "stale-job sweep failed"));
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();
sweepStaleJobs().catch((err) => log.error({ err }, "stale-job sweep failed"));

// Recover evidence from any recently succeeded job whose post-run hook never
// ran — a worker restart between the job finishing and the hook writing, or a
// job that predates the hook. Startup-only: nothing new accumulates while the
// worker is up, because the hook itself covers that.
backfillMissedVerifications().catch((err) => log.error({ err }, "verification backfill failed"));

// Same startup-only reasoning as above, for remediation-history rows whose
// attribution match was still pending (job not finished, or manual record
// not yet marked) at the moment the pruning sync recorded them.
backfillRemediationAttribution().catch((err) => log.error({ err }, "attribution backfill failed"));

// Restart on pairing: POST /api/onboarding/pair (apps/api/src/routes/onboarding-pairing.ts)
// publishes here once it has stored a fresh Entra app registration, so this
// process picks up the new credentials via load-env.ts on its next boot
// instead of waiting for an unrelated restart. A dedicated duplicate()
// connection is required — once a client calls .subscribe() it enters
// subscriber mode and can no longer issue the ordinary commands `connection`
// also backs (the BullMQ Worker/Queue above). Skipped in DEMO_MODE, which
// never pairs.
if (!env.DEMO_MODE) {
  const credentialsSubscriber = connection.duplicate();
  credentialsSubscriber.on("error", (err) => log.error({ err }, "credentials subscriber error"));
  await credentialsSubscriber.subscribe(CREDENTIALS_ROTATED_CHANNEL);
  credentialsSubscriber.on("message", (channel) => {
    if (channel !== CREDENTIALS_ROTATED_CHANNEL) return;
    log.info("credentials rotated — exiting so the process manager restarts us with them");
    process.exit(0);
  });
}

// Recurring-schedule firing: reconciles enabled DB schedules into BullMQ cron
// job-schedulers and fans each fire out into remediation jobs (no-op in demo).
const stopScheduler = startScheduler();

// Alerts if the `backup` compose service's nightly pg_dump goes missing or
// fails. A no-op outside Docker Compose (see backup-watchdog.ts).
const stopBackupWatchdog = startBackupWatchdog();

// Branded PDF reports — deliberately unconditional, NOT gated behind
// AI_FEATURES_ENABLED (the retired ai-report-worker used to do exactly
// that). A reader with only operations:read still needs to generate
// charts/tables/CSVs with no AI involved; only the narration attempt inside
// reports/worker.ts checks that flag. See the reports plan's trap #3.
const stopReportWorker = startReportWorker();
const stopReportRetention = startReportRetention();

process.on("SIGTERM", async () => {
  clearInterval(sweepTimer);
  stopBackupWatchdog();
  await stopScheduler();
  stopReportRetention();
  await stopReportWorker();
  await worker.close();
  // No-op unless a report was actually rendered — getBrowser() is lazy, so a
  // worker that only ran remediations never spawned a Chromium to close.
  await closeBrowser();
  process.exit(0);
});
