import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  manualRemediationReason,
  slaTone,
  type InstallScope,
} from "@patchpilot/shared";
import type { Sla } from "../lib/api";
import {
  chipClasses,
  COMPLIANCE_TOKENS,
  SEVERITY_TOKENS,
  SLA_TOKENS,
} from "../lib/palette";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}

export function KpiCard({
  label,
  value,
  hint,
  tone = "default",
  to,
  sparkline,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "critical" | "warn" | "good";
  /** When set, the card becomes a link to a (usually pre-filtered) list view. */
  to?: string;
  /** Optional trend sparkline (e.g. `<Sparkline .../>`), rendered top-right. */
  sparkline?: ReactNode;
}) {
  const toneClass = {
    default: "text-slate-900",
    critical: "text-rose-600",
    warn: "text-amber-600",
    good: "text-emerald-600",
  }[tone];

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-slate-500">{label}</div>
        {sparkline && <div className="shrink-0">{sparkline}</div>}
      </div>
      <div className={`mt-2 text-3xl font-semibold ${toneClass}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </>
  );

  if (to) {
    return (
      <Link to={to} className="block">
        <Card className="h-full transition-colors hover:border-slate-300 hover:bg-slate-50">
          {body}
        </Card>
      </Link>
    );
  }

  return <Card>{body}</Card>;
}

/**
 * Right-hand slide-over drawer for row detail. Closes on backdrop click or Esc.
 * Renders nothing when closed so list pages can mount it unconditionally.
 */
export function SlideOver({
  open,
  onClose,
  title,
  subtitle,
  children,
  elevated = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  /**
   * Raise this drawer above a sibling SlideOver that is already open, so a
   * detail popout launched from within another panel stacks on top of it
   * instead of rendering behind. Base drawers use z-40; elevated ones z-50.
   */
  elevated?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={`fixed inset-0 flex justify-end ${elevated ? "z-50" : "z-40"}`}
    >
      <div
        className="absolute inset-0 bg-slate-900/30"
        onClick={onClose}
        aria-hidden
      />
      <aside className="relative z-10 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-slate-200 bg-white shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-slate-900">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 truncate text-sm text-slate-500">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-5 w-5"
              aria-hidden
            >
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </aside>
    </div>
  );
}

/** Label/value row for detail panels. Render inside a <dl>. */
export function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 py-2.5 last:border-0">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium text-slate-800">
        {children}
      </dd>
    </div>
  );
}

// Chip classes come from lib/palette, the single source these share with the
// charts. `severity` is typed `string` (Defender can hand us anything), so the
// lookup keeps its `?? low` fallback rather than being indexed as a Severity.
const SEVERITY_STYLES: Record<string, string> = chipClasses(SEVERITY_TOKENS);

export function SeverityChip({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
        SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.low
      }`}
    >
      {severity}
    </span>
  );
}

/**
 * Defender returns remediation types as PascalCase tokens ("AttentionRequired",
 * "ConfigurationChange"); the portal renders them spaced and sentence-cased, so
 * we match it rather than leaking the raw API token into the table.
 */
export function prettyRemediationType(type: string | null | undefined): string {
  if (!type) return "—";
  const spaced = type.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Defender remediation types PatchPilot can actually drive. "Update" installs a
 * newer package and "Uninstall" removes it — both map to a Run Now flow.
 * "AttentionRequired" is Defender's own signal that there is no package to act
 * on (the vulnerable code is a component bundled inside another app), and
 * "ConfigurationChange" is a misconfiguration handled in Intune/Group Policy.
 * An unrecognised type is treated as unsupported rather than silently offered.
 */
const REMEDIABLE_TYPES = new Set(["update", "uninstall"]);

export function isRemediableType(type: string | null | undefined): boolean {
  return REMEDIABLE_TYPES.has((type ?? "").toLowerCase());
}

export const UNSUPPORTED_REMEDIATION_REASON =
  "Attention required — Defender has no package to update; the owning application has to ship the fix";

// The "due soon" threshold and the three-state bucketing now live in
// @patchpilot/shared so the server can compute the same Dashboard tile counts
// the list pages filter by. Re-exported here because ~20 call sites already
// import them from this module.
export { DUE_SOON_DAYS, slaTone, type SlaTone } from "@patchpilot/shared";

const SLA_STYLES = chipClasses(SLA_TOKENS);

/** Findings with no patch clock (Defender misconfigurations) pass `null`. */
export function SlaChip({ sla }: { sla: Sla | null }) {
  if (!sla) return <span className="text-slate-400">—</span>;
  const tone = slaTone(sla);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${SLA_STYLES[tone]}`}
    >
      {sla.chip}
    </span>
  );
}

// Per-user vs machine-wide install evidence — "machine" drives automated
// SYSTEM-context remediation (winget/Live Response/Intune); "user" cannot,
// so this tag doubles as a supported-method hint at a glance. "unknown"
// means Defender reported no disk/registry evidence either way.
const SCOPE_STYLES: Record<InstallScope, string> = {
  machine: "bg-sky-100 text-sky-700",
  user: "bg-purple-100 text-purple-700",
  unknown: "bg-slate-100 text-slate-500",
  os: "bg-amber-100 text-amber-700",
};

const SCOPE_LABELS: Record<InstallScope, string> = {
  machine: "SYSTEM",
  user: "User",
  unknown: "Unknown scope",
  os: "OS",
};

const SCOPE_TOOLTIPS: Record<InstallScope, string> = {
  machine:
    "Installed machine-wide — supported by Live Response, Intune and winget (SYSTEM context).",
  user:
    "Installed per-user only — SYSTEM-context automation (Live Response, Intune, winget) can't see or manage this install.",
  unknown: "No disk/registry evidence reported yet — install scope can't be determined.",
  os: "This is the operating system itself — Defender's raw feed misattributes it to a driver/component name.",
};

export function ScopeChip({ scope }: { scope: InstallScope }) {
  return (
    <span
      title={SCOPE_TOOLTIPS[scope]}
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${SCOPE_STYLES[scope]}`}
    >
      {SCOPE_LABELS[scope]}
    </span>
  );
}

/**
 * Flags a Microsoft Store (UWP/MSIX) install, detected from Defender's disk/
 * registry evidence via {@link detectMicrosoftStoreInstall} — a signal
 * winget/Chocolatey/Win32 wrapper remediation can't act on, but the
 * "Microsoft Store app (new)" channel can. Renders nothing when `false` so
 * call sites can place it unconditionally next to a ScopeChip.
 */
export function MsStoreChip({ isStoreInstall }: { isStoreInstall: boolean }) {
  if (!isStoreInstall) return null;
  return (
    <span
      title="Installed via the Microsoft Store — dispatch through the Microsoft Store app (new) channel to manage it."
      className="inline-flex items-center rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700"
    >
      MS Store
    </span>
  );
}

const COMPLIANCE_STYLES: Record<string, string> = chipClasses(COMPLIANCE_TOKENS);

// Compliance here is measured against the remediation SLAs (not Intune state):
// a device is noncompliant when any of its open vulnerabilities is past its SLA
// due date. These tooltips spell that out on hover.
const COMPLIANCE_TOOLTIPS: Record<string, string> = {
  compliant: "No open vulnerabilities are past their SLA due date.",
  noncompliant: "At least one open vulnerability has breached its SLA.",
  unknown: "No Defender coverage for this device — SLA compliance can't be measured.",
};

export function ComplianceChip({ compliance }: { compliance: string }) {
  return (
    <span
      title={COMPLIANCE_TOOLTIPS[compliance] ?? COMPLIANCE_TOOLTIPS.unknown}
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
        COMPLIANCE_STYLES[compliance] ?? COMPLIANCE_STYLES.unknown
      }`}
    >
      {compliance}
    </span>
  );
}

/**
 * Proactive "Not Supported" flag for software families that have no safe
 * automated Run Now path at all (OpenSSL, MySQL, Log4j — see
 * manual-remediation.ts). This is a hard block, unrelated to Catalog's
 * lowercase "Not supported" coverage badge (no winget package yet, but an
 * alternate repo might still work) — rose + title case keeps the two from
 * being read as the same thing. Click the info icon to see why.
 */
export function ManualRemediationTag({
  software,
  className = "",
}: {
  software: string | null | undefined;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const reason = manualRemediationReason(software);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!reason) return null;

  return (
    <span className={`relative inline-flex items-center gap-1 ${className}`}>
      <span className="inline-flex items-center rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-medium normal-case text-rose-700">
        Not Supported
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-label="Why isn't this supported?"
        aria-expanded={open}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-rose-500 transition-colors hover:text-rose-700"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
          <path
            fillRule="evenodd"
            d="M18 10A8 8 0 1 1 2 10a8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a1 1 0 0 0 0 2h.01v3a1 1 0 0 0 1 1H11a1 1 0 1 0 0-2h-.01v-3A1 1 0 0 0 10 9H9Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute left-0 top-full z-30 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-3 text-left text-xs font-normal normal-case text-slate-600 shadow-lg"
          >
            {reason}
          </div>
        </>
      )}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Placeholder({ note }: { note: string }) {
  return (
    <Card className="border-dashed">
      <p className="text-sm text-slate-500">{note}</p>
    </Card>
  );
}
