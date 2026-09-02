/**
 * Per-action pre-flight checks.
 *
 * Readiness answers "is this tenant wired up?"; pre-flight answers "can THIS
 * specific remediation — this vuln, on this device, via this channel — actually
 * run, right now, safely?". It is the last gate before a write action is offered.
 *
 * It enforces the same non-negotiables at the point of action: graceful
 * licensing degradation (#4 — a channel the tenant isn't licensed for fails)
 * and read-only-first (#6 — a read-only tenant can never proceed with a write).
 *
 * Pure and deterministic — runs identically in demo and production.
 */
import { CHANNEL_SPECS, type RemediationChannel } from "./channels.js";
import { isOsFinding } from "./os.js";
import { manualRemediationReason } from "./manual-remediation.js";
import { SOURCE_SPECS, type PackageSource } from "./sources.js";
import type { InstallScope } from "./winget.js";

export type PreflightStatus = "pass" | "warn" | "fail";

export interface PreflightCheck {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
}

/** Minimal vulnerability shape needed to pre-flight a remediation. */
export interface PreflightVuln {
  id: string;
  title: string;
  software: string;
  severity: string;
  /** True for third-party app findings drivable via winget; false for OS. */
  wingetRemediable: boolean;
  wingetPackageId: string | null;
}

/** Minimal device shape — we need the channel-specific target identifiers. */
export interface PreflightDevice {
  id: string;
  hostname: string;
  managedDeviceId: string | null;
  defenderMachineId: string | null;
  compliance: "compliant" | "noncompliant" | "unknown";
  lastSeen: string | null;
  /**
   * The engineer has excluded this device (see exclusions.ts). Required rather
   * than optional on purpose: every caller that builds a PreflightInput has to
   * answer the question, and the compiler is what proves none was missed.
   */
  excluded: boolean;
  /** Justification (and note) behind the exclusion, for the failure detail. */
  exclusionReason: string | null;
}

/** Minimal tenant shape — consent + write posture + licenses. */
export interface PreflightTenant {
  tenantId: string;
  displayName: string;
  consentStatus: "consented" | "pending" | "expired";
  readOnly: boolean;
  licenses: string[];
}

export interface PreflightInput {
  vuln: PreflightVuln;
  device: PreflightDevice;
  tenant: PreflightTenant;
  channel: RemediationChannel;
  /**
   * Alternate repo this run resolves through, for an app winget doesn't drive
   * (`not-supported`). When set, the package-resolution check validates the
   * source-native `altPackageId` instead of the winget mapping.
   */
  source?: PackageSource | null;
  /** Source-native package id (Chocolatey id / Store product id) for `source`. */
  altPackageId?: string | null;
  /**
   * Per-user vs machine-wide install scope, derived from Defender Software
   * Evidence (see `detectInstallScope`). Diagnostic signal from the caller —
   * this check only reads it to explain a doomed dispatch, it never feeds
   * back into the winget script itself.
   */
  installScope?: InstallScope;
  /**
   * The dispatch uses an engineer-supplied script instead of a generated one
   * (Manual remediation option, "dispatch" sub-mode). There is no catalog
   * package to validate, so check #7 is replaced by a single pass check.
   */
  manualScript?: boolean;
  /**
   * winget-app channel only: the Microsoft Store package id resolved from a
   * live `manifestSearch` pick (`MicrosoftStorePicker`). This channel has no
   * relationship to `vuln.wingetPackageId` at all — that id is a community
   * winget-repo id, and this channel deploys a real Store package through a
   * `winGetApp` Graph object instead. Checked independently of `source`/
   * `altPackageId`, which cover the older curated-alternate-source feature.
   */
  storePackageId?: string | null;
  /**
   * PatchPilot's vendor-controlled write gate (entitlement + instance-wide
   * tenant cap), combined with the tenant's own `readOnly` toggle by the
   * caller via `@patchpilot/graph`'s `assertWritesAllowed` — preflight()
   * stays pure/DB-free, so it can't compute this itself. Required rather
   * than optional so every caller has to answer the question explicitly.
   */
  writeGate: { allowed: boolean; reason: string | null };
  /**
   * Per-tenant Live Response device quota (see entitlement_device_usage).
   * Optional and populated by the caller only when `channel ===
   * "live-response"` — every other channel has no device-quota concept.
   */
  liveResponseQuota?: { allowed: boolean; reason: string };
}

export interface PreflightReport {
  channel: RemediationChannel;
  /** True only when no check failed (warns are allowed). */
  canProceed: boolean;
  checks: PreflightCheck[];
}

export function preflight(input: PreflightInput): PreflightReport {
  const { vuln, device, tenant, channel } = input;
  const spec = CHANNEL_SPECS[channel];
  // Classify live (app vs OS) rather than trusting the stored `wingetRemediable`
  // flag — that flag conflates "is an app" with "has a winget match", so a
  // not-supported app (an app with no winget package) would misclassify as OS
  // and route to the wrong channel. `isOsFinding` is the same classifier the
  // coverage path uses.
  const patchType: "app" | "os" = isOsFinding(vuln.software) ? "os" : "app";
  const owned = new Set(tenant.licenses);
  const checks: PreflightCheck[] = [];

  // 1. Consent — gates every Graph/Defender call.
  checks.push(
    tenant.consentStatus === "consented"
      ? {
          id: "consent",
          label: "Admin consent",
          status: "pass",
          detail: "Admin consent granted for this tenant.",
        }
      : {
          id: "consent",
          label: "Admin consent",
          status: "fail",
          detail: `Admin consent is ${tenant.consentStatus} — cannot call Microsoft APIs.`,
        },
  );

  // 2. Write posture — read-only tenants can never run a write action (#6).
  checks.push(
    tenant.readOnly
      ? {
          id: "write-actions",
          label: "Write actions",
          status: "fail",
          detail:
            "Tenant is read-only — opt in to write actions before remediating.",
        }
      : {
          id: "write-actions",
          label: "Write actions",
          status: "pass",
          detail: "Write actions are enabled for this tenant.",
        },
  );

  // 2b. Entitlement — PatchPilot's vendor-controlled write gate, layered
  // above the tenant's own write-actions toggle (#2). Deliberately a
  // separate check id from "write-actions" and from "licensing" below (an
  // unrelated, pre-existing concept — per-tenant M365 SKU ownership), so the
  // UI can show an engineer exactly which gate is closed. Rendered only when
  // the tenant isn't already blocked by its own readOnly toggle: the caller
  // computes `writeGate` as the combined answer (readOnly OR entitlement),
  // so with readOnly true it would otherwise always read "fail" here too,
  // duplicating check #2's own message under a misleading "entitlement" id.
  if (!tenant.readOnly) {
    checks.push(
      input.writeGate.allowed
        ? {
            id: "entitlement",
            label: "License key",
            status: "pass",
            detail: "This instance's license key allows write actions.",
          }
        : {
            id: "entitlement",
            label: "License key",
            status: "fail",
            detail:
              input.writeGate.reason ??
              "This instance's license key does not currently allow write actions.",
          },
    );
  }

  // 3. Licensing — the chosen channel must be fully licensed (#4).
  const missingLicenses = spec.requiredLicenses.filter((l) => !owned.has(l));
  checks.push(
    missingLicenses.length === 0
      ? {
          id: "licensing",
          label: "Channel licensing",
          status: "pass",
          detail: `${spec.label} is licensed.`,
        }
      : {
          id: "licensing",
          label: "Channel licensing",
          status: "fail",
          detail: `${spec.label} requires missing license(s): ${missingLicenses.join(", ")}.`,
        },
  );

  // 4. Patch-type fit — the channel must support this kind of patch.
  checks.push(
    spec.supports[patchType]
      ? {
          id: "patch-type",
          label: "Channel suitability",
          status: "pass",
          detail: `${spec.label} supports ${patchType.toUpperCase()} patches.`,
        }
      : {
          id: "patch-type",
          label: "Channel suitability",
          status: "fail",
          detail: `${spec.label} does not support ${patchType.toUpperCase()} patches.`,
        },
  );

  // 5. Device target — the channel needs the right identifier on the device.
  const targetId =
    spec.host === "defender" ? device.defenderMachineId : device.managedDeviceId;
  const targetKind =
    spec.host === "defender" ? "Defender machine ID" : "Intune managed device ID";
  checks.push(
    targetId
      ? {
          id: "device-target",
          label: "Device target",
          status: "pass",
          detail: `${device.hostname} has a ${targetKind}.`,
        }
      : {
          id: "device-target",
          label: "Device target",
          status: "fail",
          detail: `${device.hostname} has no ${targetKind} — channel cannot reach it.`,
        },
  );

  // 6. Device exclusion — the engineer has said this device doesn't count.
  //
  // This is where PatchPilot goes further than Defender, whose exclusion is
  // visibility-only. Hiding a device from every view while still letting a
  // scheduled fan-out reach it would be the worst of both worlds: the device
  // gets patched and nobody can see that it did. Blocking here covers both the
  // interactive and the scheduled paths at once, because the worker's fan-out
  // runs this same function as its dispatch gate.
  //
  // Only live exclusions reach this point — a cancelled or expired one is
  // filtered out by isExclusionLive before the flag is ever set.
  if (device.excluded) {
    checks.push({
      id: "device-excluded",
      label: "Device exclusion",
      status: "fail",
      detail: `${device.hostname} is excluded from PatchPilot${
        device.exclusionReason ? ` (${device.exclusionReason})` : ""
      } — stop the exclusion before remediating it.`,
    });
  }

  // 7. Device health — not blocking, but worth flagging.
  checks.push(
    device.lastSeen === null
      ? {
          id: "device-health",
          label: "Device check-in",
          status: "warn",
          detail: `${device.hostname} has never reported in — the action may not apply until it does.`,
        }
      : {
          id: "device-health",
          label: "Device check-in",
          status: "pass",
          detail: `${device.hostname} last reported ${new Date(device.lastSeen).toLocaleString()}.`,
        },
  );

  // 8. Package resolution — app patches need a package id to install. When an
  // alternate source is chosen (an app winget doesn't drive), validate that
  // source's package id instead of the winget mapping. A manual script
  // supplies its own install logic, so there's nothing to resolve.
  if (patchType === "app") {
    if (input.manualScript) {
      checks.push({
        id: "package",
        label: "Manual script",
        status: "pass",
        detail: "Manual script supplied by the engineer.",
      });
    } else if (channel === "winget-app") {
      // Distinct check id/label from "winget-package" below — this channel
      // never resolves through the winget catalog at all, so labeling this
      // "Winget package" would misrepresent what's about to be dispatched.
      checks.push(
        input.storePackageId
          ? {
              id: "store-package",
              label: "Microsoft Store package",
              status: "pass",
              detail: `Mapped to Microsoft Store package "${input.storePackageId}".`,
            }
          : {
              id: "store-package",
              label: "Microsoft Store package",
              status: "fail",
              detail: `No Microsoft Store package selected for "${vuln.software}" — search and pick one in the Catalog step before dispatching.`,
            },
      );
    } else if (input.source) {
      const sourceSpec = SOURCE_SPECS[input.source];
      // Chocolatey's "(preview)" caveat tracks the *channel's* availability
      // (same rule winget's own message follows) — it actually executes via
      // Live Response and Win32 app deploy, so those channels earn a plain
      // pass like winget does. Microsoft Store curated packages have no live
      // executor on ANY channel (see sources.ts's SOURCE_SPECS note) — the
      // caveat must stick regardless of the channel's own availability, or
      // this check would show a clean "Pass" one step after the Catalog
      // card's own Preview badge for the exact same pick.
      const previewSuffix =
        input.source === "microsoft-store" || spec.availability === "preview" ? " (preview)" : "";
      checks.push(
        input.altPackageId
          ? {
              id: "package",
              label: `${sourceSpec.label} package`,
              status: "pass",
              detail: `Mapped to ${sourceSpec.label} package "${input.altPackageId}"${previewSuffix}.`,
            }
          : {
              id: "package",
              label: `${sourceSpec.label} package`,
              status: "warn",
              detail: `No ${sourceSpec.label} package mapped for "${vuln.software}" — confirm the install command before proceeding.`,
            },
      );
    } else {
      checks.push(
        vuln.wingetPackageId
          ? {
              id: "winget-package",
              label: "Winget package",
              status: "pass",
              detail: `Mapped to ${vuln.wingetPackageId}.`,
            }
          : {
              id: "winget-package",
              label: "Winget package",
              status: "warn",
              detail: `No winget package mapped for "${vuln.software}" — confirm the install command before proceeding.`,
            },
      );
    }
  }

  // 9. Manual-remediation-only software — some families (OpenSSL, MySQL) have
  // no safe automated Run Now path regardless of channel or package mapping;
  // see manual-remediation.ts for why. This overrides checks 4 and 7 for
  // those findings — an app can look otherwise fully resolvable and still be
  // blocked here.
  const manualReason = manualRemediationReason(vuln.software);
  if (manualReason) {
    checks.push({
      id: "manual-remediation",
      label: "Manual remediation required",
      status: "fail",
      detail: `"${vuln.software}" requires manual remediation — automated Run Now is not supported for this software. ${manualReason}`,
    });
  }

  // 10. Per-user install with no alternate source — Defender's Software
  // Evidence shows this app registered only under the interactively
  // logged-on user's profile (HKCU/HKEY_USERS or C:\Users\...), not
  // machine-wide. Intune/win32 remediation ultimately drive a SYSTEM-context
  // winget, which enforces machine scope and cannot see or manage a
  // per-user-scoped install — so a winget dispatch there would fail. Does
  // not apply to winget-app: that channel never drives winget.exe at all —
  // it deploys a real winGetApp object through Intune's own install
  // mechanism, so this evidence-derived heuristic doesn't predict its
  // outcome. When no
  // engineer-chosen or curated alternate source (Chocolatey/Microsoft Store)
  // covers this software, block here with a specific reason instead of
  // letting the dispatch fail opaquely. This is a preflight-time check on
  // Defender's evidence, not a winget-script-internal heuristic — see
  // detectInstallScope's JSDoc for why that distinction matters.
  //
  // Live Response is the one exception: its library script (see
  // wingetLiveResponseLibraryScript in scripts.ts) drives the upgrade through
  // a short-lived scheduled task running AS the logged-in user instead of a
  // direct SYSTEM call when it's told the install is per-user, so the same
  // failure mode doesn't apply there — surface it as an informational warn
  // instead of a hard block, so the engineer still sees how the run differs.
  if (
    patchType === "app" &&
    input.installScope === "user" &&
    !input.source &&
    channel !== "winget-app"
  ) {
    if (channel === "live-response") {
      checks.push({
        id: "install-scope",
        label: "Install scope",
        status: "warn",
        detail: `"${vuln.software}" is installed per-user on ${device.hostname} (Defender's software evidence shows a per-user path, e.g. under the user's profile or HKEY_CURRENT_USER/HKEY_USERS), not machine-wide. Defender Live Response will run this as the signed-in user via a short-lived scheduled task instead of directly as SYSTEM, which requires that user to be signed in on the device — it will fail with a specific reason if no one is.`,
      });
    } else {
      checks.push({
        id: "install-scope",
        label: "Install scope",
        status: "fail",
        detail: `"${vuln.software}" is installed per-user on ${device.hostname} (Defender's software evidence shows a per-user path, e.g. under the user's profile or HKEY_CURRENT_USER/HKEY_USERS), not machine-wide. Intune/win32 remediation runs as SYSTEM and drives a machine-scoped winget, which cannot see or manage a per-user install — and no alternate source (Chocolatey/Microsoft Store) is mapped for this software. This requires manual remediation on the device, Defender Live Response (which can reach a per-user install via the signed-in user), or an engineer-selected alternate source.`,
      });
    }
  }

  // 11. Live Response device quota — the vendor's entitlement caps how many
  // distinct devices per tenant may ever be dispatched over Live Response
  // (see entitlement_device_usage). Only evaluated for the live-response
  // channel, and only when the caller supplies it — see
  // apps/worker/src/executor.ts for the authoritative last-mile recheck and
  // the atomic reservation that actually consumes a slot.
  if (channel === "live-response" && input.liveResponseQuota) {
    checks.push({
      id: "live-response-quota",
      label: "Live Response device quota",
      status: input.liveResponseQuota.allowed ? "pass" : "fail",
      detail: input.liveResponseQuota.allowed
        ? "This device is within the tenant's Live Response device quota."
        : input.liveResponseQuota.reason,
    });
  }

  const canProceed = checks.every((c) => c.status !== "fail");

  return { channel, canProceed, checks };
}
