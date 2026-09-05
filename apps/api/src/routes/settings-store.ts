import { demoBranding, demoSla } from "@patchpilot/db";

/**
 * In-memory settings for DEMO_MODE, so the Branding/SLA editors persist
 * within a run. Shared module (not owned by routes/data.ts) so
 * routes/recommendations.ts can read the same live SLA thresholds that
 * data.ts's PUT /api/settings/:key mutates, without the two route files
 * importing each other.
 */
export const demoSettings: Record<string, Record<string, unknown>> = {
  sla: { ...demoSla },
  branding: { ...demoBranding },
  smtp: { enabled: false, host: "", port: 587, user: "", passEncrypted: null, secure: false, from: "" },
  // Pre-populated with a fictional newer release (never a real tag) so a
  // fresh demo can show the "update available" banner + release notes card
  // without needing an engineer to click "Check now" first. See
  // routes/update-settings.ts.
  updates: {
    latestVersion: "0.2.0",
    latestReleaseNotes:
      "- Faster dashboard load times\n- Fixed a bug in the missing KBs export\n- Minor UI polish",
    latestReleaseUrl: "https://github.com/mkheagerty-lab/PatchPilot/releases/tag/v0.2.0",
    latestPublishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    lastCheckedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
  },
};
