import { existsSync, statSync } from "node:fs";
import { sendAlertEmail } from "@patchpilot/shared/alerting";
import { logger } from "./logger.js";

const log = logger.child({ module: "backup-watchdog" });

/**
 * Watches the nightly pg_dump backup (infra/backup.sh, the `backup` compose
 * service) for staleness or failure. Both containers share the same
 * bind-mounted /backups directory; this only reads the marker files that
 * script writes — it never runs pg_dump itself. A safe no-op when the
 * directory isn't mounted (bare `pnpm dev`, no Docker): nothing to watch.
 */

const BACKUP_DIR = process.env.BACKUP_STATUS_DIR || "/backups";
const CHECK_INTERVAL_MS = 60 * 60_000; // hourly
const STALE_AFTER_MS = 26 * 60 * 60_000; // one missed nightly run, plus margin

function readMTime(path: string): Date | null {
  try {
    return statSync(path).mtime;
  } catch {
    return null;
  }
}

export async function checkBackupHealth(): Promise<void> {
  if (!existsSync(BACKUP_DIR)) return;

  const successAt = readMTime(`${BACKUP_DIR}/.last_success`);
  const failureAt = readMTime(`${BACKUP_DIR}/.last_failure`);

  if (failureAt && (!successAt || failureAt > successAt)) {
    void sendAlertEmail("worker", {
      key: "postgres-backup-failed",
      subject: "Nightly Postgres backup failed",
      body: `The backup container's most recent run failed (see infra/backup.sh, .last_failure at ${failureAt.toISOString()}). Last known good backup: ${successAt ? successAt.toISOString() : "none on record"}.`,
    });
    return;
  }

  if (!successAt || Date.now() - successAt.getTime() > STALE_AFTER_MS) {
    void sendAlertEmail("worker", {
      key: "postgres-backup-stale",
      subject: "Nightly Postgres backup is overdue",
      body: successAt
        ? `The last successful Postgres backup was at ${successAt.toISOString()}, more than ${STALE_AFTER_MS / 3_600_000}h ago.`
        : "No successful Postgres backup has ever been recorded in the backups volume.",
    });
  }
}

export function startBackupWatchdog(): () => void {
  const timer = setInterval(() => {
    checkBackupHealth().catch((err) => log.error({ err }, "backup health check failed"));
  }, CHECK_INTERVAL_MS);
  timer.unref();
  checkBackupHealth().catch((err) => log.error({ err }, "backup health check failed"));
  return () => clearInterval(timer);
}
