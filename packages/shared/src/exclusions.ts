/**
 * Device exclusion — vocabulary and the "is this still in force?" predicate.
 *
 * The device-level sibling of recommendation exceptions. Where an exception
 * hides a *finding* (a recommendation or a CVE, optionally scoped to device
 * groups), an exclusion hides a *device*: a decommissioned box, a duplicate
 * inventory entry left over from a reimage, a lab machine, something that was
 * never really there. Mirrors the Defender portal's Assets > Devices > Exclude.
 *
 * Lives in `shared` rather than beside the routes because four consumers need
 * the same words and the same predicate: the API (writing and filtering), the
 * worker (refusing scheduled work against an excluded device), `preflight`
 * (the dispatch gate) and the web page (labels in the modal and the details
 * panel). Keep this module free of any Node/Postgres import — `apps/web`
 * depends on `@patchpilot/shared`, so everything here ships to the browser.
 *
 * PatchPilot's exclusion deliberately goes one step further than Defender's.
 * Defender's is visibility-only: an excluded device still appears in the device
 * inventory and can still be acted on. Ours also *blocks remediation* — see the
 * `device-excluded` check in preflight.ts. Hiding a device from every view while
 * still letting a schedule fan out onto it would be the worst of both worlds.
 */

/**
 * Defender's five exclusion justifications, verbatim from the portal.
 *
 * Kept separate from the recommendation-exception justifications, whose six
 * values are finding-shaped ("CVE has no patch available") and say nothing
 * useful about a device. This list is the single source of truth: the API
 * validates against it, the modal renders it, and the enum in
 * `packages/db/src/schema.ts` carries the same values.
 */
export const DEVICE_EXCLUSION_JUSTIFICATIONS = [
  "inactive-device",
  "duplicate-device",
  "device-does-not-exist",
  "out-of-scope",
  "other",
] as const;

export type DeviceExclusionJustification = (typeof DEVICE_EXCLUSION_JUSTIFICATIONS)[number];

const JUSTIFICATION_SET: ReadonlySet<string> = new Set(DEVICE_EXCLUSION_JUSTIFICATIONS);

/** Narrows an arbitrary string (a request body, a legacy row) to a known justification. */
export function isDeviceExclusionJustification(
  value: string,
): value is DeviceExclusionJustification {
  return JUSTIFICATION_SET.has(value);
}

/** Portal wording, used in the modal, the details panel and the audit summary. */
export const DEVICE_EXCLUSION_JUSTIFICATION_LABELS: Record<DeviceExclusionJustification, string> = {
  "inactive-device": "Inactive device",
  "duplicate-device": "Duplicate device",
  "device-does-not-exist": "Device doesn't exist",
  "out-of-scope": "Out of scope",
  other: "Other",
};

/**
 * The minimum an exclusion row has to expose to be judged live. Structural so
 * the API can pass a `DeviceExclusionRow` straight in and the worker can pass a
 * hand-rolled projection, without either importing the other's types.
 */
export interface ExclusionLifetime {
  status: "active" | "cancelled";
  /** Null means never expires — the Defender default. */
  expiresAt: Date | null;
}

/**
 * True when an exclusion is still in force: not cancelled, and either open-ended
 * or not yet past its review date.
 *
 * "Expired" is derived here rather than stored, the same way recommendation
 * exceptions do it — nothing sweeps the table, so a stored flag would be a lie
 * between the expiry instant and whenever a sweep next ran.
 *
 * Note the null case: unlike an exception, whose expiry is mandatory, an
 * exclusion with no `expiresAt` never lapses. That is Defender's behaviour —
 * exclusions there have no expiry at all — and it makes the expiry field an
 * optional review deadline rather than a required one.
 */
export function isExclusionLive(e: ExclusionLifetime, now: Date = new Date()): boolean {
  if (e.status !== "active") return false;
  if (e.expiresAt === null) return true;
  return e.expiresAt.getTime() > now.getTime();
}
