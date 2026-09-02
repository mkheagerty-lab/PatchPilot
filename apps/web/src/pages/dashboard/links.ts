// The only place the Dashboard's outbound query-param contract is encoded.
// Chart components never call useNavigate directly — they expose
// onSelect(datum), and the composing card resolves it to a path via one of
// these. Same "defaults are deleted, not written" discipline as the list
// pages themselves (Vulnerabilities.tsx's own param builder).
import type { DeviceCompliance, Severity } from "../../lib/api";
import type { SlaTone } from "@patchpilot/shared";

export function toSeverity(severity: Severity): string {
  return `/vulnerabilities?severity=${severity}&view=cves`;
}

export function toSla(tone: SlaTone): string {
  return tone === "ok" ? "/vulnerabilities?view=cves" : `/vulnerabilities?sla=${tone}&view=cves`;
}

/** Same as `toSla`, plus a severity filter — for a single heatmap cell. */
export function toSlaSeverity(tone: SlaTone, severity: Severity): string {
  return tone === "ok"
    ? `/vulnerabilities?severity=${severity}&view=cves`
    : `/vulnerabilities?sla=${tone}&severity=${severity}&view=cves`;
}

export function toCompliance(compliance: DeviceCompliance): string {
  return `/devices?compliance=${compliance}`;
}

export function toDevice(id: string): string {
  return `/devices?device=${encodeURIComponent(id)}`;
}

export function toMisconfigurations(): string {
  return "/recommendations?kind=misconfiguration";
}

export function toExcludedDevices(): string {
  return "/devices?exclusion=excluded";
}

export function toExceptions(): string {
  return "/recommendations?panel=exceptions";
}

export function toVulnerabilities(): string {
  return "/vulnerabilities?view=cves";
}

export function toGroupedVulnerabilities(): string {
  return "/vulnerabilities?view=grouped";
}

export function toDevices(): string {
  return "/devices";
}

export function toJobStatus(status: "succeeded" | "failed"): string {
  return `/jobs?status=${status}`;
}

export function toCatalog(): string {
  return "/catalog";
}

// CoverageCard's donut uses the dashboard's own "uncovered" key (see
// CoverageKey in lib/palette.ts); the Catalog page's actual filter values are
// CoverageStatus ("covered" | "not-supported" | "os"), so this is the one
// place that translation happens.
export function toCatalogStatus(key: "covered" | "uncovered" | "os"): string {
  const status = key === "uncovered" ? "not-supported" : key;
  return `/catalog?status=${status}`;
}

export function toDeviceOs(os: string): string {
  return `/devices?os=${encodeURIComponent(os)}`;
}

export function toAudit(): string {
  return "/audit";
}

export function toAuditResource(resourceId: string): string {
  return `/audit?resourceId=${encodeURIComponent(resourceId)}`;
}

export function toRemediationHistory(): string {
  return "/remediation-history";
}

/** Same as `toRemediationHistory`, scoped to one CVE — used by the CVE trend
 * chart and by Vulnerabilities' "no matching CVE" empty state. */
export function toRemediationHistoryCve(cveId: string): string {
  return `/remediation-history?cveId=${encodeURIComponent(cveId)}`;
}
