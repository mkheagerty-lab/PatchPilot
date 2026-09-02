import type { ArchDiagramData } from "../types";

export const remediationFlow: ArchDiagramData = {
  columns: 3,
  rows: 2,
  groups: [
    {
      id: "inside-customer",
      label: "Inside the customer tenant",
      colRange: [1, 2],
      rowRange: [0, 1],
      tone: "customer",
    },
  ],
  nodes: [
    {
      id: "patchpilot",
      label: "PatchPilot",
      category: "app",
      col: 0,
      row: 0,
      description: "Decides what to fix, and when",
      detail: {
        summary:
          "Picks the device and the fix — either because an engineer pressed Run now, or because a schedule came due — then calls the customer's own Microsoft services to carry it out. PatchPilot never touches the device directly; Microsoft does, on its behalf.",
        facts: [
          { label: "Runs as", value: "The engineer who owns the job" },
          { label: "Refuses to write", value: "When the tenant is in read-only mode" },
        ],
      },
    },
    {
      id: "defender",
      label: "Defender for Endpoint",
      category: "external-ms",
      shape: "shield",
      col: 1,
      row: 0,
      description: "Runs the fix on the device",
      detail: {
        summary:
          "Microsoft Defender for Endpoint is how every fix actually reaches a machine. PatchPilot publishes its remediation script to the tenant's Live Response library once, then asks Defender to run it on the target device and watches until it finishes. Defender is also where the vulnerability findings come from in the first place.",
        facts: [
          { label: "Host", value: "api.securitycenter.microsoft.com" },
          { label: "Starts a fix", value: "POST /api/machines/{id}/runliveresponse" },
          { label: "Watches it finish", value: "GET /api/machineactions/{id}, every 6s for up to 5 min" },
          { label: "Publishes the script", value: "GET / POST /api/libraryfiles" },
          {
            label: "Judges success by",
            value:
              "A PatchPilot-Exit marker printed by the script itself, not Defender's own exit code",
          },
        ],
      },
    },
    {
      id: "intune",
      label: "Intune / Microsoft Graph",
      category: "external-ms",
      shape: "cloud",
      col: 1,
      row: 1,
      description: "Update policy and check-ins",
      detail: {
        summary:
          "Used for the update paths Live Response can't drive itself: forcing a device to check in straight away, and expediting a Windows quality update so a specific machine takes a monthly patch early rather than waiting for its ring.",
        facts: [
          { label: "Host", value: "graph.microsoft.com" },
          { label: "Forces a check-in", value: "POST /deviceManagement/managedDevices/{id}/syncDevice" },
          {
            label: "Expedites an update",
            value: "POST /deviceManagement/windowsQualityUpdateProfiles (+ /assign)",
          },
          { label: "Targets one device via", value: "An Intune assignment filter on the device name" },
        ],
      },
    },
    {
      id: "device",
      label: "Managed Windows device",
      category: "device",
      col: 2,
      row: 0,
      description: "The endpoint being patched",
      detail: {
        summary:
          "The customer's machine. It's already enrolled in Defender and Intune — PatchPilot adds no agent of its own. The fix runs there as a PowerShell script under the Defender sensor, upgrading the package with winget or Chocolatey, or installing a Windows update.",
        facts: [
          { label: "Package tools used", value: "winget, Chocolatey, Windows Update" },
          { label: "PatchPilot agent", value: "None — nothing extra is installed" },
        ],
      },
    },
  ],
  edges: [
    {
      id: "r1",
      from: "patchpilot",
      to: "defender",
      label: "run this script",
      style: "sync",
    },
    {
      id: "r2",
      from: "defender",
      to: "patchpilot",
      label: "poll for the result",
      style: "async",
    },
    {
      id: "r3",
      from: "defender",
      to: "device",
      label: "runs it on the machine",
      style: "sync",
    },
    {
      id: "r4",
      from: "patchpilot",
      to: "intune",
      label: "sync / expedite update",
      style: "sync",
    },
    { id: "r5", from: "intune", to: "device", label: "applies policy", style: "sync" },
  ],
};
