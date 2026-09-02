/**
 * The composite key a finding lives at, and the one function that counts
 * distinct exposed machines for it.
 *
 * Defender's finding grain is (CVE, software) — one CVE can affect several
 * products on the same machine — so neither half alone identifies a finding.
 * `vulnerabilities.affectedDeviceCount` is stamped at sync time and still counts
 * devices that have since been excluded, so every surface that has to be honest
 * about exposure recomputes it from `device_vulnerabilities` instead.
 *
 * A pure leaf module on purpose: `routes/data.ts` (the fleet-evidence pass behind
 * /api/vulnerabilities) and `posture/findings.ts` (the Dashboard + snapshotter)
 * both need this count, and if they each grouped the rows themselves the two
 * would eventually disagree about how many devices a CVE touches. Nothing here
 * imports a route, so neither direction can form an import cycle.
 */

/**
 * Separator inside the composite key. A unit separator can't occur in a CVE id
 * or a Defender software title, so the key is unambiguous without escaping.
 */
export const FINDING_KEY_SEP = "\x1f";

export const findingKey = (cveId: string, software: string): string =>
  `${cveId}${FINDING_KEY_SEP}${software}`;

/** The device⇄CVE join columns this module reads — a structural subset of the row. */
export interface ExposureRow {
  cveId: string;
  software: string;
  defenderMachineId: string;
}

/**
 * Distinct machines per (cveId, software).
 *
 * Callers filter excluded machines out of `rows` before calling: an excluded
 * device contributes no exposure anywhere, and doing it once upstream keeps the
 * count, the evidence and the device list agreeing.
 */
export function exposureByFinding(rows: readonly ExposureRow[]): Map<string, number> {
  const machines = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = findingKey(r.cveId, r.software);
    (machines.get(key) ?? machines.set(key, new Set()).get(key)!).add(r.defenderMachineId);
  }
  const exposure = new Map<string, number>();
  for (const [key, set] of machines) exposure.set(key, set.size);
  return exposure;
}
