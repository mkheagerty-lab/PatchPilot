import type { ArchDiagramData } from "../types";

export const windowsUpdatesFlow: ArchDiagramData = {
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
      description: "Picks the release and the target group",
      detail: {
        summary:
          "Decides which Windows release to roll out and which devices should get it, then writes that decision into Intune as a policy. PatchPilot never installs anything itself — Windows Update for Business, running on each device, does that on its own schedule once the policy reaches it.",
        facts: [
          {
            label: "Feature updates target",
            value: "A Windows version label (e.g. \"24H2\"), per tenant default or per campaign",
          },
          {
            label: "Quality updates target",
            value: "A specific monthly (B) or out-of-band (OOB) release, matched by KB or picked from the catalog",
          },
          { label: "Update Rings / Driver Updates", value: "Read-only — PatchPilot mirrors these, never writes them" },
        ],
      },
    },
    {
      id: "graph",
      label: "Microsoft Graph — Windows Update APIs",
      category: "external-ms",
      shape: "cloud",
      col: 1,
      row: 0,
      description: "Where updates are identified and where policy is written",
      detail: {
        summary:
          "One Graph surface, two jobs. Reading it returns Microsoft's own catalog of what updates exist for this tenant, plus whatever update policy is already configured. Writing to it is how PatchPilot's two owned policy types — feature updates and expedited quality updates — actually get created.",
        facts: [
          { label: "Host", value: "graph.microsoft.com (beta)" },
          {
            label: "Identifies quality updates via",
            value: "GET /deviceManagement/windowsUpdateCatalogItems — the tenant's real monthly B/OOB release list",
          },
          {
            label: "Identifies feature updates via",
            value: "featureUpdateVersion — a release label PatchPilot sets, not a catalog lookup",
          },
          {
            label: "Writes feature updates via",
            value: "POST /deviceManagement/windowsFeatureUpdateProfiles + /assign",
          },
          {
            label: "Writes quality updates via",
            value: "POST /deviceManagement/windowsQualityUpdateProfiles + /assign",
          },
          {
            label: "Read-only mirrors",
            value:
              "windowsUpdateForBusinessConfiguration (Update Rings, via deviceConfigurations isof-filter) and windowsDriverUpdateProfiles (Driver Updates) — synced and shown, never written",
          },
        ],
      },
    },
    {
      id: "group",
      label: "Entra security group",
      category: "tenant",
      col: 1,
      row: 1,
      description: "What a PatchPilot policy is assigned to",
      detail: {
        summary:
          "Every policy PatchPilot creates targets a real Entra group, never a single device directly — Graph's windowsFeatureUpdateProfiles and windowsQualityUpdateProfiles both only support group assignment, the same limit the Intune admin center itself has. An optional exclude group can carve out devices that shouldn't get the policy.",
        facts: [
          { label: "Assignment shape", value: "Include group, plus an optional exclude group" },
          {
            label: "Exception — one-device quality updates",
            value:
              "Missing KBs' \"Fix Now\"/\"Fix All\" still target a single device, by auto-creating an Intune assignment filter on that device's hostname instead of using a group",
          },
        ],
      },
    },
    {
      id: "device",
      label: "Managed Windows device",
      category: "device",
      col: 2,
      row: 0,
      colSpan: 1,
      description: "Installs on its own schedule",
      detail: {
        summary:
          "Already enrolled in Intune. It doesn't receive a push the way Live Response drives one — it evaluates its own Windows Update for Business policy on its normal check-in cycle and installs the release once it's due, honoring whatever deferral and reboot settings the policy carries.",
        facts: [
          { label: "Delivery mechanism", value: "Pull, not push — the device's own Windows Update client" },
          { label: "Reboot pacing (quality updates)", value: "daysUntilForcedReboot on the policy: 0, 1, or 2 days" },
        ],
      },
    },
  ],
  edges: [
    {
      id: "w1",
      from: "patchpilot",
      to: "graph",
      label: "read catalog / write policy",
      style: "sync",
    },
    {
      id: "w2",
      from: "graph",
      to: "patchpilot",
      label: "catalog & policy state",
      style: "async",
    },
    {
      id: "w3",
      from: "graph",
      to: "group",
      label: "assigns policy",
      style: "sync",
    },
    {
      id: "w4",
      from: "group",
      to: "device",
      label: "device installs when due",
      style: "async",
    },
  ],
};
