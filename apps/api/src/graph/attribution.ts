import { and, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { tables, type Database } from "@patchpilot/db";

/**
 * Attributes closed findings (about to be pruned by a Defender sync) back to
 * the device, engineer and job that most likely closed them.
 *
 * Called from the three prune sites in graph/sync.ts, inside the same
 * transaction that will insert the `remediation_events` rows and delete the
 * stale findings — right after `doomed` is selected, before either of those
 * happen. Read-only: this module never writes.
 */

// The `tx` a drizzle transaction callback receives isn't separately exported
// by drizzle-orm; pulling it back out of `Database["transaction"]`'s own
// callback parameter keeps this in sync with whatever driver/schema `db` uses
// without importing driver-internal types directly.
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

type Channel = (typeof tables.channelEnum.enumValues)[number];
type AttributionKind = (typeof tables.remediationAttributionEnum.enumValues)[number];

/** A row about to be pruned, as read from `vulnerabilities` or `recommendations`. */
export interface DoomedFinding {
  kind: "vulnerability" | "recommendation";
  // Exactly one of cveId / recommendationId is set, matching `kind`.
  cveId: string | null;
  recommendationId: string | null;
  software: string | null;
  detectedAt: Date;
  // Only ever set for kind "vulnerability" — vulnerabilities.wingetPackageId.
  // Lets the job match agree on software via package id when the job's
  // free-text `software` snapshot and the finding's title disagree in casing
  // or punctuation but both resolve to the same winget package.
  wingetPackageId?: string | null;
}

export interface Attribution {
  attribution: AttributionKind;
  deviceId: string | null;
  deviceHostname: string | null;
  engineer: string | null;
  jobId: string | null;
  channel: Channel | null;
  fixStartedAt: Date | null;
  fixFinishedAt: Date | null;
  contributingJobs: number;
}

const UNATTRIBUTED: Attribution = {
  attribution: "unattributed",
  deviceId: null,
  deviceHostname: null,
  engineer: null,
  jobId: null,
  channel: null,
  fixStartedAt: null,
  fixFinishedAt: null,
  contributingJobs: 0,
};

// How far back a succeeded job can still be considered for attribution. Purely
// a query-size bound (tenants can accumulate years of job history) — the real
// correctness check is per-finding: finishedAt must fall between that
// finding's own detectedAt and `now`, done in JS below. 90 days comfortably
// covers the slowest realistic detectedAt..remediatedAt gap.
const JOB_LOOKBACK_MS = 90 * 24 * 3_600_000;

function keyFor(d: Pick<DoomedFinding, "cveId" | "recommendationId" | "software">): string {
  return `${d.cveId ?? d.recommendationId ?? ""}|${d.software ?? ""}`;
}

function sameTitle(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Match order per doomed finding:
 *
 *  1. Manual record — a pending (unconfirmed) `manual_remediations` row for
 *     this tenant + cveId + software. "Pending" is the load-bearing part: the
 *     auto-confirm step that runs later in this same sync (graph/sync.ts,
 *     right after linkRows is rebuilt) will stamp `confirmedAt` on exactly
 *     the manual records whose (device, CVE) pair Defender no longer reports
 *     — which, for a CVE that is being pruned tenant-wide right now, is
 *     precisely this case. Matching on "pending" here rather than waiting
 *     for that stamp avoids an ordering dependency between the two steps.
 *
 *  2. Job — a succeeded job for this tenant whose finishedAt falls between
 *     the finding's detectedAt and now. The match must agree on software,
 *     not just CVE: Chromium/WebKit/OpenSSL CVEs are reported once per
 *     affected product title by Defender, so a CVE-only match would
 *     attribute a Chrome upgrade job to an Edge finding just as easily as to
 *     Chrome's own. Agreement means either the free-text software titles
 *     match case-insensitively, or both carry a winget package id and those
 *     match — mirroring the disambiguation already done by `lookupSoftware`
 *     in apps/worker/src/post-remediation.ts. A job that carries no software
 *     at all (older channels, or KB-only OS jobs) falls back to CVE-only.
 *     Newest finishedAt wins; contributingJobs counts every match, since one
 *     Defender finding can span many devices and so many closing jobs.
 *
 *  3. Neither → unattributed. Still a real remediation (Autopatch, WSUS, the
 *     end user, or a Defender re-scan closed it) — just not one PatchPilot
 *     can take credit for.
 *
 * Recommendation findings (kind: "recommendation") have no cveId, so they
 * only ever reach case 2 (matched on software vs. jobs.software) or case 3.
 */
export async function attributeClears(
  tx: Tx,
  tenantId: string,
  doomed: DoomedFinding[],
  now: Date,
): Promise<Map<string, Attribution>> {
  const result = new Map<string, Attribution>();
  if (doomed.length === 0) return result;

  const cveIds = [...new Set(doomed.map((d) => d.cveId).filter((v): v is string => !!v))];

  // ---- candidate manual remediations (pending only — see doc comment) ----
  const manualRows =
    cveIds.length > 0
      ? await tx
          .select({
            deviceId: tables.manualRemediations.deviceId,
            cveId: tables.manualRemediations.cveId,
            software: tables.manualRemediations.software,
            engineer: tables.manualRemediations.engineer,
            markedAt: tables.manualRemediations.markedAt,
          })
          .from(tables.manualRemediations)
          .where(
            and(
              eq(tables.manualRemediations.tenantId, tenantId),
              isNull(tables.manualRemediations.confirmedAt),
              inArray(tables.manualRemediations.cveId, cveIds),
            ),
          )
      : [];

  const manualDeviceIds = [...new Set(manualRows.map((m) => m.deviceId))];
  const manualDevices = manualDeviceIds.length
    ? await tx
        .select({ id: tables.devices.id, hostname: tables.devices.hostname })
        .from(tables.devices)
        .where(inArray(tables.devices.id, manualDeviceIds))
    : [];
  const hostnameByDeviceId = new Map(manualDevices.map((d) => [d.id, d.hostname]));

  // ---- candidate succeeded jobs ----
  const lookbackFloor = new Date(now.getTime() - JOB_LOOKBACK_MS);
  const jobRows = await tx
    .select({
      id: tables.jobs.id,
      deviceId: tables.jobs.deviceId,
      deviceHostname: tables.jobs.deviceHostname,
      cveId: tables.jobs.cveId,
      coveredCveIds: tables.jobs.coveredCveIds,
      software: tables.jobs.software,
      packageId: tables.jobs.packageId,
      channel: tables.jobs.channel,
      engineer: tables.jobs.engineer,
      queuedAt: tables.jobs.queuedAt,
      startedAt: tables.jobs.startedAt,
      finishedAt: tables.jobs.finishedAt,
    })
    .from(tables.jobs)
    .where(
      and(
        eq(tables.jobs.tenantId, tenantId),
        eq(tables.jobs.status, "succeeded"),
        isNotNull(tables.jobs.finishedAt),
        gte(tables.jobs.finishedAt, lookbackFloor),
      ),
    );

  for (const d of doomed) {
    const key = keyFor(d);

    // 1. manual
    const manual = manualRows.find(
      (m) => !!d.cveId && m.cveId === d.cveId && sameTitle(m.software, d.software),
    );
    if (manual) {
      result.set(key, {
        attribution: "manual",
        deviceId: manual.deviceId,
        deviceHostname: hostnameByDeviceId.get(manual.deviceId) ?? null,
        engineer: manual.engineer,
        jobId: null,
        channel: null,
        fixStartedAt: manual.markedAt,
        fixFinishedAt: manual.markedAt,
        contributingJobs: 0,
      });
      continue;
    }

    // 2. job
    const candidates = jobRows.filter((j) => {
      if (!j.finishedAt || j.finishedAt < d.detectedAt || j.finishedAt > now) return false;
      if (d.cveId) {
        // A schedule fan-out that consolidated several open CVEs against the
        // same fix into one job stamps only the primary CVE as `cveId`, with
        // the rest riding along in `coveredCveIds` — check both so every
        // consolidated CVE still attributes to the job that actually fixed it.
        if (j.cveId !== d.cveId && !j.coveredCveIds?.includes(d.cveId)) return false;
        if (!j.software) return true; // no software on the job: CVE-only fallback
        const titleMatches = sameTitle(j.software, d.software);
        const packageMatches =
          !!d.wingetPackageId && !!j.packageId && sameTitle(j.packageId, d.wingetPackageId);
        return titleMatches || packageMatches;
      }
      // recommendation kind: no cveId to match on, software is the only signal.
      return sameTitle(j.software, d.software);
    });

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime());
      const best = candidates[0]!;
      result.set(key, {
        attribution: "job",
        deviceId: best.deviceId,
        deviceHostname: best.deviceHostname,
        engineer: best.engineer,
        jobId: best.id,
        channel: best.channel,
        fixStartedAt: best.startedAt ?? best.queuedAt,
        fixFinishedAt: best.finishedAt,
        contributingJobs: candidates.length,
      });
      continue;
    }

    // 3. unattributed
    result.set(key, UNATTRIBUTED);
  }

  return result;
}

/**
 * Detects the known matcher-correction false positive documented on
 * `remediationEvents` in schema.ts: the vulnerabilities upsert conflict key
 * includes `software` (derived from the winget match), so a matcher fix
 * INSERTS a corrected row beside the stale one instead of replacing it — the
 * prune then clears the stale row as a side effect, which looks exactly like
 * a genuine remediation unless checked for.
 *
 * If, within the same tenant and CVE, some row survived this exact sync
 * (lastSeenAt = now) under a title other than the doomed row's own, the
 * doomed row was reclassified, not fixed. Because (tenantId, cveId, software)
 * is the table's own uniqueness constraint, any such survivor is guaranteed
 * to differ in software from every doomed row sharing that CVE — there is no
 * "same software, still counts" case to filter out.
 *
 * Only the vulnerability prune sites call this. Recommendations key their
 * upsert on (tenantId, recommendationId) — Defender's own stable id, not one
 * derived from our matcher — so the equivalent hazard doesn't exist there.
 */
export async function detectReclassifiedCves(
  tx: Tx,
  tenantId: string,
  cveIds: string[],
  now: Date,
): Promise<Set<string>> {
  if (cveIds.length === 0) return new Set();
  const survivors = await tx
    .select({ cveId: tables.vulnerabilities.cveId })
    .from(tables.vulnerabilities)
    .where(
      and(
        eq(tables.vulnerabilities.tenantId, tenantId),
        inArray(tables.vulnerabilities.cveId, cveIds),
        eq(tables.vulnerabilities.lastSeenAt, now),
      ),
    );
  return new Set(survivors.map((s) => s.cveId));
}
