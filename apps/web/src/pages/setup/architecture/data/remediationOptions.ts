import type { ArchDiagramData } from "../types";

/**
 * The full remediation picture: what catalogs PatchPilot resolves a finding
 * against, the channels it can dispatch through, and where each one actually
 * lands. Mirrors `RemediationChannel`/`CHANNEL_SPECS` in
 * packages/shared/src/channels.ts and `SOURCE_SPECS` in
 * packages/shared/src/sources.ts — this is the diagram form of that registry,
 * including its honesty about what's real today vs. modeled-but-unused.
 */
export const remediationOptions: ArchDiagramData = {
  columns: 4,
  rows: 4,
  groups: [
    {
      id: "inside-customer",
      label: "Inside the customer tenant",
      colRange: [2, 3],
      rowRange: [0, 3],
      tone: "customer",
    },
  ],
  nodes: [
    {
      id: "winget-catalog",
      label: "Winget Catalog",
      category: "external-ms",
      shape: "cloud",
      col: 0,
      row: 0,
      description: "Default package match for app findings",
      detail: {
        summary:
          "PatchPilot's primary source for app remediation — matches a Defender software finding to a real winget package id. Every other source is only consulted when this one has no match.",
        facts: [
          { label: "Used by", value: "Live Response, Intune Win32 app deploy" },
          { label: "Coverage", value: "Most common commercial and open-source Windows apps" },
        ],
      },
    },
    {
      id: "alt-sources",
      label: "Chocolatey / Microsoft Store",
      category: "external-ms",
      shape: "cloud",
      col: 0,
      row: 1,
      description: "Alternate repos for apps winget doesn't cover",
      detail: {
        summary:
          "A small, hand-curated fallback list for the handful of apps winget has no package for. Chocolatey genuinely installs through Live Response today; both sources still run as a simulated preview on every other channel.",
        facts: [
          { label: "Chocolatey delivery", value: "choco upgrade, run as SYSTEM — real on Live Response" },
          { label: "Microsoft Store delivery", value: "winget install --source msstore — preview everywhere" },
          { label: "Curation", value: "Small, hand-verified mapping — not a live repo index" },
        ],
      },
    },
    {
      id: "wu-catalog",
      label: "Windows Update Catalog",
      category: "external-ms",
      shape: "cloud",
      col: 0,
      row: 2,
      description: "Microsoft's real per-tenant release list",
      detail: {
        summary:
          "Read live from Microsoft Graph, not curated by PatchPilot — the tenant's actual list of monthly (B) and out-of-band (OOB) quality-update releases, used to match a missing KB or to offer a release picker.",
        facts: [
          { label: "Endpoint", value: "GET /deviceManagement/windowsUpdateCatalogItems" },
          { label: "Feeds", value: "Expedited Quality Update profile creation" },
        ],
      },
    },
    {
      id: "script-catalog",
      label: "Script Catalog",
      category: "app",
      col: 0,
      row: 3,
      description: "PatchPilot's own library of custom scripts",
      detail: {
        summary:
          "A library of hand-authored PowerShell scripts an engineer can save and reuse, for findings that don't map to a winget or Chocolatey package. Catalogued today but not yet wired into automatic dispatch — running one against a device is a manual step, not something Fix Now/Fix All picks up on its own.",
        facts: [
          { label: "Dispatchable today", value: "PowerShell only — cmd/bash entries are catalogued but inert" },
          { label: "Scope", value: "Global (every tenant) or saved against one specific tenant" },
        ],
      },
    },
    {
      id: "patchpilot",
      label: "PatchPilot",
      category: "app",
      col: 1,
      row: 1,
      description: "Resolves the fix, picks the channel",
      detail: {
        summary:
          "Matches a finding against the catalogs on the left to resolve an actual package or script, then dispatches it. Live Response is the default for every dispatch regardless of patch type or urgency — an engineer can explicitly pick a different channel from the Run Now dialog, limited to whichever ones that finding's patch type supports.",
        facts: [
          { label: "Default channel", value: "Live Response, always — routeChannel() never varies it" },
          {
            label: "Engineer override offers",
            value: "Live Response, Expedited Quality Update, Intune (Win32 app) — as supported",
          },
          {
            label: "Package resolution order",
            value: "Explicit alternate source, then a matched winget package, then the native Windows Update script",
          },
        ],
      },
    },
    {
      id: "live-response",
      label: "Defender Live Response",
      category: "external-ms",
      shape: "shield",
      col: 2,
      row: 0,
      description: "Real dispatch, seconds — today's default",
      detail: {
        summary:
          "The channel every dispatch uses unless an engineer explicitly picks another. Runs a script directly on the device through a Defender Live Response session and polls for a self-printed success marker rather than trusting Defender's own exit code.",
        facts: [
          { label: "Latency", value: "Seconds" },
          { label: "Use case", value: "Critical zero-day, single device, ad-hoc" },
          { label: "Requires", value: "Defender for Business Premium (or MDE P2)" },
          { label: "Endpoint", value: "POST /api/machines/{machineId}/runliveresponse" },
        ],
      },
    },
    {
      id: "app-deploy",
      label: "Intune app deploy (Win32 / Store)",
      category: "external-ms",
      shape: "cloud",
      col: 2,
      row: 1,
      description: "Real dispatch, minutes — group-authored packages",
      detail: {
        summary:
          "Wraps the resolved package as an Intune Win32 (or genuine Microsoft Store) app, uploads and assigns it once per package family, then forces the target device to check in early so the already-assigned install lands sooner instead of waiting for its normal Intune cycle.",
        facts: [
          { label: "Latency", value: "5-15 min (Win32), 3-10 min (Store app)" },
          { label: "Requires", value: "Intune" },
          { label: "Expedite endpoint", value: "POST /deviceManagement/managedDevices/{id}/syncDevice" },
          {
            label: "Store app note",
            value: "Run Now only — no per-CVE match table, so it's never offered for Fix All",
          },
        ],
      },
    },
    {
      id: "wu-policies",
      label: "Intune Windows Update policies",
      category: "external-ms",
      shape: "cloud",
      col: 2,
      row: 2,
      description: "Real dispatch, hours — expedited quality/feature updates",
      detail: {
        summary:
          "Covered in full by the Windows Updates hub. Creates a windowsQualityUpdateProfile or windowsFeatureUpdateProfile and assigns it to a device or group — the device installs on its own schedule once it checks in, not immediately.",
        facts: [
          { label: "Quality update endpoint", value: "POST /deviceManagement/windowsQualityUpdateProfiles" },
          { label: "Feature update endpoint", value: "POST /deviceManagement/windowsFeatureUpdateProfiles" },
          { label: "Requires", value: "Intune" },
        ],
      },
    },
    {
      id: "intune-remediation",
      label: "Intune proactive remediation",
      category: "external-ms",
      shape: "cloud",
      col: 2,
      row: 3,
      description: "Modeled, not dispatched",
      detail: {
        summary:
          "Selectable in the data model and preflight-checked like a real channel, but the worker never actually executes it — a dispatch that would route here doesn't happen. Kept modeled for a future release rather than removed, so historical job rows that reference it still read correctly.",
        facts: [
          {
            label: "Endpoint (modeled)",
            value: "POST /deviceManagement/managedDevices/{id}/initiateOnDemandProactiveRemediation",
          },
          { label: "Status", value: "availability: \"preview\" — no fix has ever run through this path" },
        ],
      },
    },
    {
      id: "device",
      label: "Managed Windows device",
      category: "device",
      col: 3,
      row: 1,
      description: "Where every real channel ultimately lands",
      detail: {
        summary:
          "Already enrolled in Defender and Intune. How it receives a fix differs by channel: Live Response runs a script on it directly and PatchPilot watches for the result; the Intune channels instead assign a policy that the device pulls down and applies on its own schedule.",
        facts: [
          { label: "Live Response", value: "Script runs immediately; PatchPilot polls for the result" },
          { label: "Intune channels", value: "Device applies the policy on its own check-in/update cycle" },
        ],
      },
    },
  ],
  edges: [
    { id: "o1", from: "winget-catalog", to: "patchpilot", label: "match a package", style: "data" },
    { id: "o2", from: "alt-sources", to: "patchpilot", label: "fallback match", style: "data" },
    { id: "o3", from: "wu-catalog", to: "patchpilot", label: "match a release/KB", style: "data" },
    { id: "o4", from: "script-catalog", to: "patchpilot", label: "manual pick", style: "data" },

    { id: "o5", from: "patchpilot", to: "live-response", label: "seconds", style: "sync" },
    { id: "o6", from: "patchpilot", to: "app-deploy", label: "minutes", style: "sync" },
    { id: "o7", from: "patchpilot", to: "wu-policies", label: "hours", style: "sync" },
    { id: "o8", from: "patchpilot", to: "intune-remediation", label: "modeled — not used", style: "async" },

    { id: "o9", from: "live-response", to: "device", label: "runs the script", style: "sync" },
    { id: "o10", from: "app-deploy", to: "device", label: "installs the app", style: "sync" },
    { id: "o11", from: "wu-policies", to: "device", label: "installs when due", style: "async" },
  ],
};
