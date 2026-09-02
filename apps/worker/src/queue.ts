import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { REMEDIATION_QUEUE, RemediationJob } from "@patchpilot/shared";
import { sendAlertEmail } from "@patchpilot/shared/alerting";
import { logger } from "./logger.js";

const log = logger.child({ module: "queue" });

export { REMEDIATION_QUEUE, RemediationJob };

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/** Shared BullMQ connection (separate clients are created internally per role). */
export const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

// An unhandled "error" event on an ioredis client crashes the whole Node
// process (Node's EventEmitter default for "error"). Mid-job that would kill
// the JOB_TIMEOUT_MS race in index.ts along with it, permanently orphaning
// the job's DB row at status "running" with nothing left alive to sweep it.
// Logging instead of crashing lets ioredis's built-in reconnect handle
// transient blips (network hiccup, Redis restart) without taking the worker
// process down mid-remediation. Alerted too: a Redis outage means every
// remediation and schedule fire on this process is stuck until it clears.
connection.on("error", (err) => {
  log.error({ err }, "redis connection error");
  void sendAlertEmail("worker", {
    key: "redis-connection-error",
    subject: "Redis connection error",
    body: `The worker's Redis connection reported an error:\n\n${err.message}\n\nJob dispatch and schedule firing are stuck until this clears.`,
  });
});

export const remediationQueue = new Queue<RemediationJob>(REMEDIATION_QUEUE, { connection });
// Same rationale as the ioredis `connection` handler above: BullMQ's Queue is
// its own EventEmitter and re-emits connection/internal errors on itself, so
// listening on `connection` alone doesn't cover it — an unlistened "error"
// here still crashes the process.
remediationQueue.on("error", (err) => {
  log.error({ err }, "remediation queue error");
  void sendAlertEmail("worker", {
    key: "remediation-queue-error",
    subject: "Remediation queue error",
    body: `The remediation queue reported an error:\n\n${err.message}`,
  });
});
