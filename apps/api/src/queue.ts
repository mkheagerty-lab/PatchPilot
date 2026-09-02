import { Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  REMEDIATION_QUEUE,
  SCHEDULE_QUEUE,
  REPORT_QUEUE,
  type RemediationJob,
  type ScheduleFireJob,
  type ReportJob,
} from "@patchpilot/shared";
import { config } from "./config.js";

/**
 * The api side of the remediation queue: a BullMQ producer only. The worker owns
 * the consumer (apps/worker). Both reference the same queue name + payload
 * contract from `@patchpilot/shared`; the runtime (connection, Queue) is built
 * per-app so the api never imports the worker.
 *
 * Lazily connected so DEMO_MODE — which never enqueues — touches no Redis.
 *
 * Exported (not module-private) so routes/onboarding-pairing.ts can PUBLISH
 * the credentials-rotated notification on the same connection rather than
 * opening a second one just to send one message.
 */
export const connection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

// Same rationale as apps/worker/src/queue.ts: an unhandled "error" event
// crashes the whole api process. Log and let ioredis reconnect instead.
connection.on("error", (err) => console.error("[api] redis connection error:", err.message));

export const remediationQueue = new Queue<RemediationJob>(REMEDIATION_QUEUE, { connection });
// BullMQ's Queue is its own EventEmitter and re-emits connection/internal
// errors on itself, separately from the raw ioredis `connection` above —
// listening on `connection` alone doesn't cover it. An unlistened "error"
// here crashes the whole api process the same way, so it needs its own handler.
remediationQueue.on("error", (err) => console.error("[api] remediation queue error:", err.message));

/**
 * Producer for the schedule queue. The worker owns the cron reconciler + fan-out
 * consumer; the api only ever enqueues an on-demand "fire" via "Run now", letting
 * an engineer exercise a recurring schedule immediately instead of waiting for its
 * next cron tick. The fan-out logic (posture re-check, target filter, per-device
 * enqueue) is identical to a cron fire — it all runs in the worker.
 */
export const scheduleQueue = new Queue<ScheduleFireJob>(SCHEDULE_QUEUE, { connection });
scheduleQueue.on("error", (err) => console.error("[api] schedule queue error:", err.message));

/**
 * Producer for the report queue. `POST /api/reports` inserts the `reports` row,
 * enqueues here and returns that row's id; the worker renders the PDF into the
 * same row. The client polls the row, never this job — see REPORT_QUEUE's
 * contract note for why that distinction is the point of the whole table.
 */
export const reportQueue = new Queue<ReportJob>(REPORT_QUEUE, { connection });
reportQueue.on("error", (err) => console.error("[api] report queue error:", err.message));
