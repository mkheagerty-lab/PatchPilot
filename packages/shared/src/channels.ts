import { z } from "zod";

/**
 * The remediation execution channels — the core IP of PatchPilot.
 * Each maps to a specific Graph/Defender endpoint and has different latency
 * and licensing requirements.
 */
export const RemediationChannel = z.enum([
  "live-response", // Defender Live Response — seconds, real-time
  "intune-remediation", // On-demand proactive remediation — 1-5 min
  "win32-app", // Win32 app deploy + device sync — 5-15 min
  "winget-app", // Microsoft Store app (winGetApp) deploy + device sync — 3-10 min
  "expedited-quality-update", // Expedited Quality Update — hours, OS patches
  "expedited-feature-update", // Expedited Feature Update — hours-days, OS version upgrade
]);
export type RemediationChannel = z.infer<typeof RemediationChannel>;

/** Required Microsoft license for a channel, used for graceful degradation. */
export const RequiredLicense = z.enum([
  "intune",
  "defender-business-premium",
  "mde-p2",
]);
export type RequiredLicense = z.infer<typeof RequiredLicense>;

export interface ChannelSpec {
  channel: RemediationChannel;
  label: string;
  latency: string;
  useCase: string;
  /** `{id}` is the managed device id; `{machineId}` the Defender machine id. */
  endpointTemplate: string;
  /** Defender API host vs Graph host. */
  host: "graph" | "defender";
  requiredLicenses: RequiredLicense[];
  /** Live Response/Expedited only fit certain patch types. */
  supports: { app: boolean; os: boolean };
  /**
   * Honest-preview flag, mirrors `SourceSpec.availability` (sources.ts): the
   * channel is modeled end-to-end (selectable, preflight-checked) but the
   * worker's executor always returns `notPerformed(...)` for it today.
   */
  availability?: "preview";
}

export const CHANNEL_SPECS: Record<RemediationChannel, ChannelSpec> = {
  "live-response": {
    channel: "live-response",
    label: "Defender Live Response",
    latency: "seconds",
    useCase: "Critical zero-day, single device, ad-hoc",
    endpointTemplate: "POST /api/machines/{machineId}/runliveresponse",
    host: "defender",
    requiredLicenses: ["defender-business-premium"],
    supports: { app: true, os: true },
  },
  "intune-remediation": {
    channel: "intune-remediation",
    label: "On-demand Intune Remediation",
    latency: "1-5 min",
    useCase: "Most third-party patches, per-device/group",
    endpointTemplate:
      "POST /deviceManagement/managedDevices/{id}/initiateOnDemandProactiveRemediation",
    host: "graph",
    requiredLicenses: ["intune"],
    supports: { app: true, os: false },
    availability: "preview",
  },
  "win32-app": {
    channel: "win32-app",
    label: "Intune (Win32 app)",
    latency: "5-15 min",
    useCase: "Group-level deployments authored via Deploy App, expedited per device",
    endpointTemplate: "POST /deviceManagement/managedDevices/{id}/syncDevice",
    host: "graph",
    requiredLicenses: ["intune"],
    supports: { app: true, os: false },
  },
  "winget-app": {
    channel: "winget-app",
    label: "Microsoft Store app (new)",
    latency: "3-10 min",
    useCase: "Genuine Microsoft Store packages, resolved live via manifestSearch, per device",
    endpointTemplate: "POST /deviceManagement/managedDevices/{id}/syncDevice",
    host: "graph",
    requiredLicenses: ["intune"],
    // Run Now only — there is no per-CVE Store-package match table analogous to
    // winget_catalog for Fix All to dispatch against, so this channel is never
    // added to selectableChannels()'s offer list.
    supports: { app: true, os: false },
  },
  "expedited-quality-update": {
    channel: "expedited-quality-update",
    label: "Expedited Quality Update",
    latency: "hours",
    useCase: "OS patches, push specific KB to a group fast",
    endpointTemplate: "POST /deviceManagement/windowsQualityUpdateProfiles",
    host: "graph",
    requiredLicenses: ["intune"],
    supports: { app: false, os: true },
  },
  "expedited-feature-update": {
    channel: "expedited-feature-update",
    label: "Expedited Feature Update",
    latency: "hours-days",
    useCase: "Move a device onto a newer Windows feature release ahead of its ring",
    endpointTemplate: "POST /deviceManagement/windowsFeatureUpdateProfiles",
    host: "graph",
    requiredLicenses: ["intune"],
    // Run Now only — there is no per-CVE concept for a feature-update version to
    // key off (it's not a vulnerability finding), so this channel is never added
    // to selectableChannels()'s offer list; it gets its own dedicated Devices-page
    // action instead. Same reasoning as winget-app's exclusion above.
    supports: { app: false, os: true },
  },
};

export type PatchType = "app" | "os";
export type Urgency = "now" | "expedite" | "schedule";

/**
 * Routes a remediation request to its default channel. Always Live Response —
 * timing (now / scheduled once / recurring) no longer changes which Microsoft
 * channel is used; only the engineer's explicit Method override does. Keeps
 * the `(patchType, urgency)` signature so existing call sites don't need to
 * change, even though neither argument affects the result anymore.
 */
export function routeChannel(_patchType: PatchType, _urgency: Urgency): RemediationChannel {
  return "live-response";
}

/**
 * The channels the Run Now dialog offers for a patch type — the routable set,
 * in display order. `intune-remediation` stays a valid stored channel for
 * historical job rows but is excluded from new dispatches (extra licensing).
 */
export function selectableChannels(patchType: PatchType): RemediationChannel[] {
  const all: RemediationChannel[] = [
    "live-response",
    "expedited-quality-update",
    "win32-app",
  ];
  return all.filter((c) => CHANNEL_SPECS[c].supports[patchType]);
}
