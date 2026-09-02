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
};
