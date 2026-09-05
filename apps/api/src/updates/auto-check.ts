import { auditSafe } from "@patchpilot/graph";
import { SYSTEM_ACTORS } from "@patchpilot/shared";
import { config } from "../config.js";
import { checkForUpdateOnce } from "../routes/update-settings.js";

/**
 * Background GitHub Releases poll (Settings > Updates). Same shape as
 * catalog/auto-refresh.ts, with one deliberate difference: this one is NOT
 * disabled in DEMO_MODE — it's a harmless public read (no tenant, no
 * database write outside the in-memory demo fixture), and "an update is
 * available" is a legitimate thing for a demo to show.
 *
 * No staleness-on-boot check like auto-refresh.ts's — a fresh boot always
 * waits out the first FIRST_CYCLE_DELAY_MS before its first check, since
 * there's no cheap "last refreshed" column to read ahead of loadStored().
 */

/** Delay the first cycle so boot (server listen, migrations) settles first. */
const FIRST_CYCLE_DELAY_MS = 45_000;

async function checkOnce(reason: string): Promise<void> {
  try {
    const result = await checkForUpdateOnce();
    console.log(`[update-check] ${reason}: latest is v${result.latestVersion}`);
    await auditSafe({
      engineer: SYSTEM_ACTORS.updateCheck,
      actorType: "system",
      endpoint: config.GITHUB_RELEASES_URL,
      method: "GET",
      action: "update:check",
      resourceType: "setting",
      resourceLabel: "updates",
      summary: `Auto-checked for updates (${reason}) — latest is v${result.latestVersion}`,
      outcome: "success",
      responseStatus: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[update-check] ${reason} failed — ${message}`);
    await auditSafe({
      engineer: SYSTEM_ACTORS.updateCheck,
      actorType: "system",
      endpoint: config.GITHUB_RELEASES_URL,
      method: "GET",
      action: "update:check",
      resourceType: "setting",
      resourceLabel: "updates",
      summary: `Auto-check for updates failed (${reason})`,
      outcome: "failure",
      detail: message,
      responseStatus: 502,
    });
  }
}

/**
 * Starts the background update-availability poll. Returns a stop function
 * for graceful shutdown. No-op only when the interval is <= 0 — unlike every
 * other auto-* scheduler in this file's family, DEMO_MODE does NOT disable it.
 */
export function startUpdateAutoCheck(): () => void {
  const intervalHours = config.UPDATE_CHECK_INTERVAL_HOURS;
  if (intervalHours <= 0) {
    console.log("[update-check] disabled (UPDATE_CHECK_INTERVAL_HOURS=0)");
    return () => {};
  }

  const intervalMs = intervalHours * 60 * 60_000;
  let interval: NodeJS.Timeout | undefined;

  const firstCycle = setTimeout(() => {
    void checkOnce("initial check").then(() => {
      interval = setInterval(() => void checkOnce("scheduled"), intervalMs);
    });
  }, FIRST_CYCLE_DELAY_MS);

  console.log(`[update-check] enabled — every ${intervalHours}h (first check in 45s)`);

  return () => {
    clearTimeout(firstCycle);
    if (interval) clearInterval(interval);
  };
}
