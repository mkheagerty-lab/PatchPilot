import type { ArchDiagramData } from "../types";

/** Shared by the three example customer tenants — they differ only by name. */
const customerDetail = {
  summary:
    "One of the MSP's client organizations. PatchPilot reaches it through a GDAP (Granular Delegated Admin Privileges) relationship agreed during onboarding. Access is delegated: the token is minted from the signed-in engineer's credential and inherits whatever GDAP roles that engineer holds in this customer — PatchPilot has no standing credential of its own here.",
  facts: [
    { label: "How it's reached", value: "Secure Application Model (delegated)" },
    { label: "Sign-in authority", value: "login.microsoftonline.com/{customer tenant}" },
    {
      label: "Roles inherited",
      value:
        "Security Administrator, Intune Administrator, Windows Update Deployment Administrator, Helpdesk Administrator, Global Reader",
    },
  ],
};

export const connectionTopology: ArchDiagramData = {
  columns: 3,
  rows: 4,
  groups: [
    {
      id: "customer-tenants",
      label: "Customer tenants — GDAP",
      colRange: [2, 2],
      rowRange: [1, 3],
      tone: "customer",
    },
  ],
  nodes: [
    {
      id: "engineer",
      label: "Engineer",
      category: "actor",
      col: 0,
      row: 0,
      description: "MSP staff member with GDAP roles",
      detail: {
        summary:
          "An MSP staff member. They sign in to PatchPilot with their own Microsoft account, and they bring their GDAP roles with them — the delegated-admin rights their account already holds in each customer tenant. That personal access is what PatchPilot borrows, so every action is attributable to a named person rather than to a faceless service account.",
        facts: [
          {
            label: "Access to customers",
            value:
              "Through GDAP — the engineer's own delegated-admin roles, granted per customer at onboarding",
          },
          { label: "PatchPilot's own access", value: "None — it can only reach what this engineer can" },
          { label: "Browser holds", value: "A session cookie only — never a Microsoft token" },
          { label: "Session length", value: "8 hours" },
        ],
      },
    },
    {
      id: "patchpilot",
      label: "PatchPilot",
      category: "app",
      col: 0,
      row: 1,
      description: "The platform, hosted by the MSP",
      detail: {
        summary:
          "The platform itself, run by the MSP on its own infrastructure. It never holds a password for a customer. When it needs to read findings or push a fix, it asks Microsoft Entra ID for a short-lived token for that one tenant, on behalf of the engineer who owns the work.",
        facts: [
          { label: "Access model", value: "Delegated only — no app-only credentials" },
          { label: "Scheduled runs", value: "Use the owning engineer's stored credential" },
        ],
      },
    },
    {
      id: "entra",
      label: "Microsoft Entra ID",
      category: "identity",
      col: 1,
      row: 1,
      description: "Signs people in, issues tokens",
      detail: {
        summary:
          "Microsoft's identity service, and the gate in front of every tenant. It signs the engineer in, then issues a separate short-lived access token for each tenant PatchPilot needs to touch. Nothing reaches a tenant without a token minted here first.",
        facts: [
          { label: "Sign-in host", value: "login.microsoftonline.com" },
          { label: "Token lifetime", value: "Short-lived, re-minted on demand per tenant" },
          {
            label: "Background access",
            value:
              "The engineer's refresh credential is stored for up to 90 days so overnight schedules can run with nobody logged in",
          },
        ],
      },
    },
    {
      id: "msp-tenant",
      label: "MSP home tenant",
      category: "tenant",
      col: 2,
      row: 0,
      description: "The MSP's own Microsoft 365 tenant",
      detail: {
        summary:
          "The MSP's own Microsoft 365 tenant — where the engineers' accounts live and where PatchPilot itself is registered. It's reached differently from a customer: PatchPilot exchanges the engineer's live sign-in for a token here (the On-Behalf-Of flow), which is why home-tenant reads need someone actually signed in.",
        facts: [
          { label: "How it's reached", value: "On-Behalf-Of (delegated)" },
          { label: "Needs a live session", value: "Yes — unlike customer tenants" },
        ],
      },
    },
    {
      id: "customer-a",
      label: "Customer Tenant A",
      category: "tenant",
      col: 2,
      row: 1,
      description: "A client organization",
      detail: customerDetail,
    },
    {
      id: "customer-b",
      label: "Customer Tenant B",
      category: "tenant",
      col: 2,
      row: 2,
      description: "A client organization",
      detail: customerDetail,
    },
    {
      id: "customer-c",
      label: "Customer Tenant C",
      category: "tenant",
      col: 2,
      row: 3,
      description: "A client organization",
      detail: customerDetail,
    },
  ],
  edges: [
    {
      id: "c1",
      from: "engineer",
      to: "patchpilot",
      label: "signs in with GDAP roles",
      style: "sync",
    },
    {
      id: "c2",
      from: "patchpilot",
      to: "entra",
      label: "asks for a token",
      style: "sync",
    },
    { id: "c3", from: "entra", to: "msp-tenant", label: "On-Behalf-Of", style: "sync" },
    // Only the first branch is labelled — all three carry the same delegated
    // token, and repeating the label three times down the trunk is just noise.
    { id: "c4", from: "entra", to: "customer-a", label: "delegated token", style: "sync" },
    { id: "c5", from: "entra", to: "customer-b", style: "sync" },
    { id: "c6", from: "entra", to: "customer-c", style: "sync" },
  ],
};
