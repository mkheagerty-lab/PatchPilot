// Shared CVE presentation pieces used by both the Vulnerabilities page and the
// Devices detail panel's per-device CVE drill-down, so the two surfaces render
// identical severity pills, sortable headers, and per-CVE detail popouts.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  detectMicrosoftStoreInstall,
  isOsFinding,
  requiresManualRemediation,
  SEVERITY_ORDER as SEVERITY_ORDER_SHARED,
} from "@patchpilot/shared";
import type { Severity, Vulnerability } from "../lib/api";
import { SEVERITY_TOKENS } from "../lib/palette";
import { DetailRow, ManualRemediationTag, MsStoreChip, SeverityChip, SlaChip } from "./ui";

/** Whole-number days since a timestamp, floored at 0. */
export function daysAgo(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/** Short calendar date (e.g. "23 Jun 2026"); em-dash for null/invalid input. */
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** EPSS probability (0..1) rendered as a whole-percent; em-dash when absent. */
export function formatEpss(epss: number | null): string {
  if (epss == null) return "—";
  return `${Math.round(epss * 100)}%`;
}

// Severity rank and worst-first order live in @patchpilot/shared. Re-exported
// here because the pages already import them from this module alongside the
// rest of the CVE presentation kit.
export { SEVERITY_ORDER, SEVERITY_RANK } from "@patchpilot/shared";

// Sortable per-CVE table column keys + direction.
export type CveSortKey = "cve" | "severity" | "sla";
export type SortDir = "asc" | "desc";

/**
 * Colored per-severity count chips — e.g. a rose "3 Critical", an orange "5 High".
 * Only categories with at least one CVE are shown; renders nothing when none.
 */
export function SeverityCounts({ counts }: { counts: Record<Severity, number> }) {
  const shown = SEVERITY_ORDER_SHARED.filter((s) => counts[s] > 0);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((s) => {
        const token = SEVERITY_TOKENS[s];
        return (
          <span
            key={s}
            title={`${counts[s]} ${token.label}`}
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${token.chip}`}
          >
            {counts[s]} {token.label}
          </span>
        );
      })}
    </div>
  );
}

/** Up/down caret indicating sort direction; faint until the column is active. */
export function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
      className={`h-3 w-3 transition ${
        active ? "text-slate-700" : "text-slate-300 group-hover:text-slate-400"
      } ${active && dir === "desc" ? "rotate-180" : ""}`}
    >
      <path
        fillRule="evenodd"
        d="M10 5a.75.75 0 0 1 .53.22l4 4a.75.75 0 0 1-1.06 1.06L10 6.81 6.53 10.28a.75.75 0 1 1-1.06-1.06l4-4A.75.75 0 0 1 10 5Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** A clickable per-CVE drill-down column header that sorts by `sortKey`. */
export function CveSortableTh({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
}: {
  label: string;
  sortKey: CveSortKey;
  activeKey: CveSortKey;
  dir: SortDir;
  onSort: (key: CveSortKey) => void;
}) {
  const active = sortKey === activeKey;
  return (
    <th className="px-4 py-2 font-medium">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
        className="group inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-slate-700"
      >
        {label}
        <SortIcon active={active} dir={dir} />
      </button>
    </th>
  );
}

/**
 * A compact inline sort control (not a `<th>`), for CVE lists laid out as flex
 * rows rather than a table — e.g. the narrow Devices detail drawer, where a rigid
 * table would clip the severity/SLA chips off the right edge.
 */
export function CveSortButton({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
}: {
  label: string;
  sortKey: CveSortKey;
  activeKey: CveSortKey;
  dir: SortDir;
  onSort: (key: CveSortKey) => void;
}) {
  const active = sortKey === activeKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className="group inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-500 transition-colors hover:text-slate-700"
    >
      {label}
      <SortIcon active={active} dir={dir} />
    </button>
  );
}

/**
 * Classifies how a finding would actually get fixed. `wingetRemediable` alone
 * can't tell "ships via Windows Update" apart from "bundled library, the
 * owning app has to ship it" or "just no winget package exists" — the live
 * matcher (buildWingetMatcher in apps/api/src/catalog/matching.ts) returns
 * false for all three. Shared by the Vulnerabilities page's "All CVEs" table
 * and the Devices detail panel's per-device CVE table so the two can't drift
 * out of sync with each other.
 */
export function remediationRoute(
  software: string,
  wingetRemediable: boolean,
): "winget" | "os" | "manual" | "unsupported" {
  if (wingetRemediable) return "winget";
  if (isOsFinding(software)) return "os";
  if (requiresManualRemediation(software)) return "manual";
  return "unsupported";
}

/** Friendly remediation route label. */
export function RemediationBadge({
  software,
  wingetRemediable,
}: {
  software: string;
  wingetRemediable: boolean;
}) {
  switch (remediationRoute(software, wingetRemediable)) {
    case "winget":
      return (
        <span className="inline-flex items-center rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
          Winget
        </span>
      );
    case "os":
      return (
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
          OS / Update Ring
        </span>
      );
    case "manual":
      return (
        <span className="inline-flex items-center rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-medium text-rose-700">
          Manual
        </span>
      );
    case "unsupported":
      return (
        <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">
          Unsupported
        </span>
      );
  }
}

/** Compact "exploit available" warning chip, reused across CVE surfaces. */
export function ExploitChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-medium text-rose-700">
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className="h-3 w-3">
        <path
          fillRule="evenodd"
          d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.515 2.625H3.72c-1.345 0-2.188-1.458-1.515-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
          clipRule="evenodd"
        />
      </svg>
      Exploit available
    </span>
  );
}

/** Stronger warning chip for confirmed active exploitation — distinct from
 * ExploitChip (public PoC/kit only) because it drives the tightened
 * "verified exploit" Compliance SLA override, not just a severity nudge. */
export function VerifiedExploitChip() {
  return (
    <span
      title="Defender has confirmed active exploitation of this vulnerability."
      className="inline-flex items-center gap-1 rounded-full bg-rose-600 px-2.5 py-0.5 text-xs font-medium text-white"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className="h-3 w-3">
        <path
          fillRule="evenodd"
          d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.515 2.625H3.72c-1.345 0-2.188-1.458-1.515-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
          clipRule="evenodd"
        />
      </svg>
      Verified exploit
    </span>
  );
}

/** Marks a row/detail panel covered by an active, non-expired local exception. */
export function ExceptionChip() {
  return (
    <span
      title="An active PatchPilot exception covers this — hidden from default views."
      className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-700"
    >
      Excepted
    </span>
  );
}

/**
 * A remediation this device already applied, proven by the job transcript's own
 * upgrade line, that Defender hasn't published yet. Set only on the per-device
 * drill-down (`/api/devices/:id/vulnerabilities`); absent fleet-wide.
 */
export type FixedOnDevice = NonNullable<Vulnerability["fixedOnDevice"]>;

/** Time of day for a fix made today; day + time once it's older than that. */
function formatFixedAt(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const at = new Date(ms);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

/** True when the job found the device already on the latest version — nothing was upgraded. */
function wasAlreadyCurrent(fix: FixedOnDevice): boolean {
  return fix.versionBefore != null && fix.versionBefore === fix.versionAfter;
}

/** "1.2.3 → 1.2.4", or just the new version when the old one wasn't reported. */
function versionMove(fix: FixedOnDevice): string {
  const after = fix.versionAfter ?? "a newer version";
  return fix.versionBefore && !wasAlreadyCurrent(fix) ? `${fix.versionBefore} → ${after}` : after;
}

/** The full explanation, as a tooltip for the space-constrained chip. */
function fixTooltip(fix: FixedOnDevice): string {
  const verb = wasAlreadyCurrent(fix)
    ? `confirmed already on ${versionMove(fix)}`
    : `upgraded ${versionMove(fix)}`;
  return (
    `${fix.packageId} ${verb} on this device at ${formatFixedAt(fix.verifiedAt)}. ` +
    `Defender still reports the finding because its software inventory refreshes every 3-4 hours ` +
    `and Microsoft provides no way to force it — PatchPilot is re-checking until it clears.`
  );
}

/**
 * Compact "already patched, Defender hasn't caught up" chip for list rows.
 *
 * Deliberately does NOT hide or soften the finding it sits next to: Defender
 * stays the source of truth for whether a vulnerability exists, and this only
 * explains why a device the engineer just fixed is still listed.
 */
export function FixedOnDeviceChip({ fix }: { fix: FixedOnDevice }) {
  return (
    <span
      title={fixTooltip(fix)}
      className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className="h-3 w-3">
        <path
          fillRule="evenodd"
          d="M16.704 5.29a.75.75 0 0 1 .006 1.06l-7.5 7.6a.75.75 0 0 1-1.07 0l-3.85-3.9a.75.75 0 1 1 1.068-1.054l3.316 3.36 6.97-7.06a.75.75 0 0 1 1.06-.006Z"
          clipRule="evenodd"
        />
      </svg>
      Fixed on device {formatFixedAt(fix.verifiedAt)} · awaiting Defender
    </span>
  );
}

/** The same evidence as a full callout, for detail panels that have the room. */
export function FixedOnDeviceNote({ fix }: { fix: FixedOnDevice }) {
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
      <p className="text-sm font-medium text-emerald-800">
        Fixed on device {formatFixedAt(fix.verifiedAt)} — awaiting Defender
      </p>
      <p className="mt-1 text-xs leading-relaxed text-emerald-700">
        {wasAlreadyCurrent(fix) ? (
          <>
            A PatchPilot remediation confirmed{" "}
            <span className="font-mono">{fix.packageId}</span> was already on{" "}
            <span className="font-mono">{fix.versionAfter ?? "the latest version"}</span> on this
            device — no update was needed
          </>
        ) : (
          <>
            A PatchPilot remediation upgraded{" "}
            <span className="font-mono">{fix.packageId}</span> to{" "}
            <span className="font-mono">{fix.versionAfter ?? "a newer version"}</span>
            {fix.versionBefore && (
              <>
                {" "}
                from <span className="font-mono">{fix.versionBefore}</span>
              </>
            )}
            , and the device confirmed it
          </>
        )}
        . Defender's software inventory refreshes on its own
        3–4 hour cadence with no way to force it, so it keeps reporting this software until
        then. PatchPilot re-checks the tenant repeatedly over the next six hours and clears
        the finding as soon as Defender does.
      </p>
    </div>
  );
}

/**
 * Informational winget upgrade command with a copy button. Display-only — running
 * remediation (jobs/schedules) is a separate surface; this just shows the engineer
 * the command PatchPilot would run.
 */
export function WingetCommand({ packageId }: { packageId: string }) {
  const [copied, setCopied] = useState(false);
  const command = `winget upgrade --id ${packageId} --silent --accept-source-agreements --accept-package-agreements`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — silently no-op.
    }
  };

  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Recommended winget command
        </h4>
        <button
          type="button"
          onClick={copy}
          className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-slate-900 px-4 py-3 text-xs leading-relaxed text-slate-100">
        <code>{command}</code>
      </pre>
    </section>
  );
}

/**
 * "How it was detected": the installed version(s) and the union of disk/registry
 * paths Defender reported. Registry paths matter on their own — a HKEY_USERS path
 * is Defender's own evidence of a per-user install (the case winget running as
 * SYSTEM can't correlate against), so it's shown even when no disk path was
 * reported. Renders nothing when all three arrays are empty, so callers can
 * include it unconditionally.
 */
export function DetectionEvidence({
  installedVersions,
  diskPaths,
  registryPaths,
  showVersion = true,
}: {
  installedVersions: string[];
  diskPaths: string[];
  registryPaths: string[];
  /** Set false when the host panel already shows the installed version
   *  elsewhere (e.g. SoftwareInventory's "Detected version" row), so this
   *  section doesn't repeat it as a redundant "—". */
  showVersion?: boolean;
}) {
  if (installedVersions.length === 0 && diskPaths.length === 0 && registryPaths.length === 0) {
    return null;
  }
  return (
    <section>
      <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        How it was detected
        <MsStoreChip isStoreInstall={detectMicrosoftStoreInstall(diskPaths, registryPaths)} />
      </h4>
      <dl className="space-y-3 text-sm">
        {showVersion && (
          <div>
            <dt className="text-slate-500">Installed version</dt>
            <dd className="font-mono text-xs text-slate-700">
              {installedVersions.length > 0 ? installedVersions.join(", ") : "—"}
            </dd>
          </div>
        )}
        {diskPaths.length > 0 && (
          <div>
            <dt className="text-slate-500">Disk path(s)</dt>
            <dd>
              <ul className="mt-1 space-y-1">
                {diskPaths.map((p) => (
                  <li
                    key={p}
                    className="break-all rounded bg-slate-50 px-2 py-1 font-mono text-xs text-slate-700"
                  >
                    {p}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {registryPaths.length > 0 && (
          <div>
            <dt className="text-slate-500">Registry path(s)</dt>
            <dd>
              <ul className="mt-1 space-y-1">
                {registryPaths.map((p) => (
                  <li
                    key={p}
                    className="break-all rounded bg-slate-50 px-2 py-1 font-mono text-xs text-slate-700"
                  >
                    {p}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-slate-400">
                {registryPaths.some((p) => /^HKEY_USERS\\|^HKU\\/i.test(p))
                  ? "Registered under HKEY_USERS — installed per-user, not machine-wide."
                  : "Registered under HKEY_LOCAL_MACHINE — installed machine-wide."}
              </p>
            </dd>
          </div>
        )}
        {diskPaths.length === 0 && registryPaths.length === 0 && (
          <div>
            <dt className="text-slate-500">Detected at</dt>
            <dd>
              <p className="text-xs text-slate-400">
                Detected as an OS/registry component — Defender reported no file or
                registry path.
              </p>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/**
 * The body of the per-CVE detail SlideOver: title + chips, description, detection
 * & threat insights, affected software, optional winget command, and SLA detail.
 * Rendered inside a <SlideOver> on both the Vulnerabilities page and the Devices
 * detail panel so individual CVEs pop out identically from either surface.
 *
 * `latestVersion` (from the winget catalog) and `tenantLabel` (shown only in the
 * All-Tenants view) are optional context the host page supplies when available.
 */
export function CveDetailBody({
  vuln,
  latestVersion,
  tenantLabel,
  onCreateException,
}: {
  vuln: Vulnerability;
  latestVersion?: string | null;
  tenantLabel?: string | null;
  /** Renders a "Create exception" button next to the related-recommendation
   *  link when supplied — omitted callers get no exception entry point here. */
  onCreateException?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="space-y-6">
      {/* Title + chips */}
      <div>
        <h3 className="text-base font-semibold text-slate-900">{vuln.title}</h3>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SeverityChip severity={vuln.severity} />
          {vuln.cvss != null && (
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
              CVSS {vuln.cvss.toFixed(1)}
            </span>
          )}
          <SlaChip sla={vuln.sla} />
          {vuln.exploitVerified ? (
            <VerifiedExploitChip />
          ) : (
            vuln.exploitAvailable && <ExploitChip />
          )}
          {vuln.exception && <ExceptionChip />}
          <span className="text-xs text-slate-400">
            detected {daysAgo(vuln.detectedAt)}d ago
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          {vuln.relatedRecommendationId && (
            <button
              type="button"
              onClick={() =>
                navigate(
                  `/recommendations?tenantId=${encodeURIComponent(
                    vuln.tenantId,
                  )}&recommendationId=${encodeURIComponent(vuln.relatedRecommendationId!)}`,
                )
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-100"
            >
              Go to related Security Recommendation
              <span aria-hidden>→</span>
            </button>
          )}
          {onCreateException && !vuln.exception && (
            <button
              type="button"
              onClick={onCreateException}
              className="inline-flex items-center gap-1 rounded font-medium text-slate-600 underline-offset-2 hover:underline"
            >
              Create exception
            </button>
          )}
        </div>
      </div>

      {/* Already patched here, per the device's own job transcript — shown above
          everything else so an engineer looking at a finding they just fixed
          sees why it's still listed. Only ever set on the device drill-down. */}
      {vuln.fixedOnDevice && <FixedOnDeviceNote fix={vuln.fixedOnDevice} />}

      {/* Description */}
      <section>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Description
        </h4>
        <p className="text-sm leading-relaxed text-slate-600">
          {vuln.description ?? "No description available for this finding."}
        </p>
      </section>

      {/* Detection & threat insights */}
      <section>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Detection &amp; threat insights
        </h4>
        <dl>
          <DetailRow label="First detected">
            {formatDate(vuln.detectedAt)}
            <span className="ml-1 font-normal text-slate-400">
              ({daysAgo(vuln.detectedAt)}d ago)
            </span>
          </DetailRow>
          <DetailRow label="CVSS score">
            {vuln.cvss != null ? vuln.cvss.toFixed(1) : "—"}
          </DetailRow>
          {vuln.cvssVector && (
            <DetailRow label="CVSS vector">
              <span className="break-all font-mono text-xs">
                {vuln.cvssVector}
              </span>
            </DetailRow>
          )}
          <DetailRow label="EPSS">{formatEpss(vuln.epss)}</DetailRow>
          <DetailRow label="Exploit availability">
            {vuln.exploitVerified ? (
              <span className="font-medium text-rose-600">
                Active exploitation confirmed
              </span>
            ) : vuln.exploitAvailable ? (
              <span className="text-rose-600">Public exploit known</span>
            ) : (
              "None reported"
            )}
          </DetailRow>
          <DetailRow label="Published">
            {formatDate(vuln.publishedOn)}
          </DetailRow>
          <DetailRow label="Last updated">
            {formatDate(vuln.updatedOn)}
          </DetailRow>
        </dl>
      </section>

      {/* How it was detected — omitted entirely when the caller has no evidence
          (e.g. fleet-wide rows before the tenant-wide aggregation is available). */}
      <DetectionEvidence
        installedVersions={vuln.installedVersion ? [vuln.installedVersion] : []}
        diskPaths={vuln.diskPaths ?? []}
        registryPaths={vuln.registryPaths ?? []}
      />

      {/* Affected software */}
      <section>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Affected software
        </h4>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="font-medium text-slate-800">{vuln.displayName ?? vuln.software}</div>
          {vuln.publisher && (
            <div className="text-sm text-slate-500">{vuln.publisher}</div>
          )}
          <ManualRemediationTag software={vuln.software} className="mt-1" />
          <dl className="mt-3 space-y-1.5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Affected devices</dt>
              <dd className="font-medium text-slate-800">
                {vuln.affectedDeviceCount}
              </dd>
            </div>
            {latestVersion && (
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Latest version</dt>
                <dd className="font-medium text-slate-800">{latestVersion}</dd>
              </div>
            )}
            {tenantLabel && (
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Customer tenant</dt>
                <dd className="min-w-0 truncate font-medium text-slate-800">
                  {tenantLabel}
                </dd>
              </div>
            )}
          </dl>
        </div>
      </section>

      {/* Recommended winget command (informational only) */}
      {vuln.wingetRemediable && vuln.wingetPackageId && (
        <WingetCommand packageId={vuln.wingetPackageId} />
      )}

      {/* SLA detail */}
      <section>
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          SLA
        </h4>
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">Status</dt>
            <dd className="font-medium text-slate-800 capitalize">
              {vuln.status}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">Due</dt>
            <dd className="font-medium text-slate-800">
              {new Date(vuln.sla.dueDate).toLocaleDateString()}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">Days remaining</dt>
            <dd className="font-medium text-slate-800">
              {vuln.sla.overdue
                ? `${Math.abs(vuln.sla.daysRemaining)} overdue`
                : vuln.sla.daysRemaining}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
