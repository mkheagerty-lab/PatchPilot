import type { FastifyInstance } from "fastify";
import { db, tables, demoTenants, type TenantRow } from "@patchpilot/db";
import {
  buildConsentUrl,
  GRAPH_SCOPES,
  DEFENDER_SCOPES,
  PARTNER_CENTER_SCOPES,
} from "@patchpilot/shared";
import { getCca, APP_REGISTRATION_SYNC_SCOPES, auditSafe } from "@patchpilot/graph";
import { config, webOrigins } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import { resolveWebOrigin } from "../auth/origin.js";

/**
 * Onboarding / app-registration route (Phase 4).
 *
 * Backs the App Registration page. Returns the multi-tenant app identity and
 * requested scopes, plus a per-tenant admin-consent URL for every known
 * customer tenant (the GDAP onboarding step). Consent URLs are generated with
 * the same `buildConsentUrl` helper the Deploy script uses, so the web console
 * and the PowerShell installer always agree.
 *
 * Tokens never leave the server (non-negotiable #2): a consent URL only carries
 * the public client id and redirect URI — no secret.
 */
interface ConsentTarget {
  tenantId: string;
  displayName: string;
  consentStatus: TenantRow["consentStatus"];
  /**
   * Honest "can PatchPilot actually call Graph for this tenant" signal (Phase A),
   * distinct from the GDAP relationship/consent status. Drives the calm
   * informational rows on the status surface (reseller-only / unlicensed never
   * render as errors — invariant #4).
   */
  reachability: TenantRow["reachability"];
  licenses: string[];
  isMspTenant: boolean;
  consentUrl: string;
}

interface OnboardingReport {
  demoMode: boolean;
  clientId: string;
  tenantId: string;
  redirectUri: string;
  /**
   * Every "<origin>/auth/callback" this instance currently accepts an OAuth
   * round trip from — PUBLIC_URL plus every active custom domain (see
   * routes/domains.ts), post-restart. This is this server's own allowlist,
   * not a live read of the real Entra app registration — the two only agree
   * once "Update via browser" (or the equivalent PowerShell command) has
   * actually pushed each one in. Shown so the Application identity card
   * stops looking frozen at deploy-time's single AUTH_REDIRECT_URI once a
   * custom domain goes active.
   */
  redirectUris: string[];
  /**
   * One-click admin-consent URL for the MSP's OWN (home) tenant. A Global
   * Administrator opens this to grant PatchPilot's read-only permissions in the
   * home tenant — the step that makes the first "Discover tenants" succeed. It is
   * the same /adminconsent endpoint as the per-customer URLs, just pointed at the
   * home tenant, and carries only the public client id (never a secret).
   */
  homeConsentUrl: string;
  scopes: {
    graph: readonly string[];
    defender: readonly string[];
    partnerCenter: readonly string[];
  };
  consentTargets: ConsentTarget[];
}

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("settings:read"));

  async function allTenants(): Promise<TenantRow[]> {
    if (config.DEMO_MODE) return demoTenants;
    return db.select().from(tables.tenants);
  }

  app.get("/api/onboarding", async () => {
    // Admin consent redirects back to the registered redirect URI.
    const redirectUri = config.AUTH_REDIRECT_URI;
    const tenants = await allTenants();

    const consentTargets: ConsentTarget[] = tenants
      // The MSP home tenant consents during app deployment, not via a per-customer URL.
      .filter((t) => !t.isMspTenant)
      .map((t) => ({
        tenantId: t.tenantId,
        displayName: t.displayName,
        consentStatus: t.consentStatus,
        reachability: t.reachability,
        licenses: t.licenses,
        isMspTenant: t.isMspTenant,
        consentUrl: buildConsentUrl(t.tenantId, config.ENTRA_CLIENT_ID, redirectUri),
      }));

    const report: OnboardingReport = {
      demoMode: config.DEMO_MODE,
      clientId: config.ENTRA_CLIENT_ID,
      tenantId: config.ENTRA_TENANT_ID,
      redirectUri,
      redirectUris: webOrigins.map((o) => `${o}/auth/callback`),
      homeConsentUrl: buildConsentUrl(config.ENTRA_TENANT_ID, config.ENTRA_CLIENT_ID, redirectUri),
      scopes: {
        graph: GRAPH_SCOPES,
        defender: DEFENDER_SCOPES,
        partnerCenter: PARTNER_CENTER_SCOPES,
      },
      consentTargets,
    };
    return report;
  });

  // Starts the one-time "Sync permissions" step-up consent redirect (see
  // packages/graph/src/app-registration-sync.ts for what it does once the
  // callback in apps/api/src/auth/routes.ts redeems the code). Elevated above
  // the router's settings:read hook to settings:write — this kicks off a
  // directory write, unlike everything else in this file.
  app.get<{ Querystring: { includeWriteScopes?: string } }>(
    "/api/onboarding/sync-permissions/start",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      const includeWriteScopes = req.query.includeWriteScopes === "true";

      if (config.DEMO_MODE) {
        return reply.code(400).send({ error: "not_available_in_demo_mode" });
      }

      // Resolved per-request (see auth/origin.ts) so this step-up round-trips
      // back to whichever allow-listed origin (e.g. a cloudflared tunnel host)
      // the admin is actually using, matching the main login flow in
      // apps/api/src/auth/routes.ts rather than always bouncing to PUBLIC_URL.
      const origin = resolveWebOrigin(req);
      const state = `patchpilot-syncperm:${req.session.sessionId}:${includeWriteScopes ? "1" : "0"}`;
      const url = await getCca().getAuthCodeUrl({
        scopes: APP_REGISTRATION_SYNC_SCOPES,
        redirectUri: `${origin}/auth/callback`,
        state,
      });

      await auditSafe({
        engineer: req.session.engineer!.upn,
        tenantId: config.ENTRA_TENANT_ID,
        endpoint: "/api/onboarding/sync-permissions/start",
        method: "GET",
        action: "app-registration:sync-start",
        resourceType: "application",
        resourceId: config.ENTRA_CLIENT_ID,
        summary: `${req.session.engineer!.upn} started a permission sync${
          includeWriteScopes ? " (including write scopes)" : ""
        }`,
        outcome: "success",
        responseStatus: 302,
      });

      return reply.redirect(url);
    },
  );
}
