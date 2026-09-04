import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { permissionsFor, currentScopeBaseline, type ScopeBaseline } from "@patchpilot/shared";
import { config, webOrigins } from "../config.js";
import { resolveWebOrigin } from "./origin.js";
import {
  getCca,
  getLoginScopes,
  redeemLoginCode,
  redeemStepUpConsentCode,
  syncAppRegistrationScopes,
  testAppRegistrationScopes,
  updateAppRegistrationRedirectUris,
  storeToken,
  clearTokens,
  auditSafe,
} from "@patchpilot/graph";

/**
 * Who to attribute an auth event to before the identity is known.
 *
 * `engineer` is NOT NULL, and "anonymous" is honest here — a failed sign-in has
 * no verified identity, and recording an unverified claim from the query string
 * would make the actor column untrustworthy for every other row.
 */
const ANONYMOUS = "anonymous";

/**
 * Minimal HTML landing page for the consent/error redirects that have no auth
 * code to exchange. AUTH_REDIRECT_URI is on the web origin (Vite proxies /auth/*
 * to this API), so returning text/html renders directly in the admin's browser.
 */
function landingPage(opts: {
  title: string;
  heading: string;
  body: string;
  tone: "ok" | "error";
  origin: string;
}): string {
  const accent = opts.tone === "ok" ? "#16a34a" : "#dc2626";
  const escape = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(opts.title)}</title>
<style>
  body { margin:0; font-family: system-ui, -apple-system, Segoe UI, sans-serif;
    background:#0b1020; color:#e5e7eb; display:grid; place-items:center; min-height:100vh; }
  .card { max-width:32rem; padding:2.5rem; background:#111827; border-radius:0.75rem;
    border:1px solid #1f2937; box-shadow:0 10px 40px rgba(0,0,0,.4); }
  .badge { display:inline-block; width:2.5rem; height:2.5rem; border-radius:9999px;
    background:${accent}; color:#fff; text-align:center; line-height:2.5rem; font-size:1.4rem; }
  h1 { font-size:1.25rem; margin:1rem 0 0.5rem; }
  p { color:#9ca3af; line-height:1.5; }
  a { color:#818cf8; text-decoration:none; font-weight:600; }
</style></head>
<body><div class="card">
  <span class="badge">${opts.tone === "ok" ? "✓" : "!"}</span>
  <h1>${escape(opts.heading)}</h1>
  <p>${opts.body}</p>
  <p><a href="${escape(opts.origin)}">Return to PatchPilot →</a></p>
</div></body></html>`;
}

/**
 * OIDC Authorization Code + PKCE login against the MSP tenant.
 * The session cookie holds only the engineer identity; the access/refresh
 * tokens are encrypted and cached server-side (Redis), never sent to the browser.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Step 1: kick off login -> redirect to Microsoft.
  app.get("/auth/login", async (req, reply) => {
    const origin = resolveWebOrigin(req);
    // DEMO_MODE: skip Microsoft entirely; the demo engineer session is already
    // injected by the global hook, so just bounce back to the app.
    if (config.DEMO_MODE) {
      return reply.redirect(origin);
    }
    const url = await getCca().getAuthCodeUrl({
      scopes: getLoginScopes(),
      // Must be byte-for-byte the same URI /auth/callback later redeems the
      // code with (see redeemLoginCode) — resolved per-request rather than
      // config.AUTH_REDIRECT_URI so a login started from an allow-listed
      // alternate origin (see auth/origin.ts) round-trips back to itself
      // instead of always landing on the default origin.
      redirectUri: `${origin}/auth/callback`,
      // state ties the callback to this session (CSRF protection).
      state: req.session.sessionId,
    });

    // auditSafe throughout this file: a failed audit write must never be able to
    // lock an engineer out of the console.
    await auditSafe({
      engineer: ANONYMOUS,
      tenantId: config.ENTRA_TENANT_ID,
      endpoint: "/auth/login",
      method: "GET",
      action: "auth:login-start",
      resourceType: "session",
      summary: "Sign-in started — redirected to Microsoft",
      outcome: "success",
      responseStatus: 302,
    });

    return reply.redirect(url);
  });

  // Step 2: handle the redirect. This single URI receives two different flows:
  //   - login Auth Code (has `code`)        -> exchange for tokens, start session
  //   - admin-consent return (has `admin_consent`/`tenant`, NO code)
  //   - either flow can return an `error`
  // Consent and error returns have no code to exchange, so they render a friendly
  // HTML landing instead of the old {"error":"missing_code"} dead-end.
  app.get<{
    Querystring: {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
      admin_consent?: string;
      tenant?: string;
    };
  }>(
    "/auth/callback",
    async (req, reply) => {
      const { code, state, error, error_description, admin_consent, tenant } = req.query;
      // Resolved once and reused throughout: this callback is only ever
      // reached via the exact origin /auth/login (or the sync-permissions
      // step-up start) sent as redirectUri, so this always matches.
      const origin = resolveWebOrigin(req);

      // An error from either the login or the admin-consent flow.
      if (error) {
        // Only the two named params, never the raw query string: it can carry a
        // state token and, on some flows, tenant-identifying claims.
        await auditSafe({
          engineer: ANONYMOUS,
          tenantId: tenant ?? null,
          endpoint: "/auth/callback",
          method: "GET",
          action: "auth:login-failed",
          resourceType: "session",
          summary: `Microsoft returned "${error}" on the auth callback`,
          outcome: "failure",
          detail: error_description ?? null,
          responseStatus: 400,
        });

        return reply.type("text/html").code(400).send(
          landingPage({
            origin,
            tone: "error",
            title: "PatchPilot — authorization failed",
            heading: "Authorization didn't complete",
            body: `Microsoft returned <code>${error}</code>${
              error_description ? `: ${error_description}` : ""
            }. You can close this tab and try again from PatchPilot.`,
          }),
        );
      }

      // "Sync permissions" step-up return (Setup -> App Registration). Reuses this
      // redirect URI rather than registering a new one; discriminated from the
      // login/admin-consent flows above by the state prefix set when the redirect
      // was built (apps/api/src/routes/onboarding.ts). The elevated token this
      // exchange yields is used exactly once, right here, and never persisted —
      // no storeToken, no MSAL cache write.
      const SYNC_STATE_PREFIX = "patchpilot-syncperm:";
      if (code && state?.startsWith(SYNC_STATE_PREFIX)) {
        const [sessionId, writeFlag] = state.slice(SYNC_STATE_PREFIX.length).split(":");
        const includeWriteScopes = writeFlag === "1";
        const engineer = req.session.engineer;

        if (!engineer || sessionId !== req.session.sessionId) {
          await auditSafe({
            engineer: engineer?.upn ?? ANONYMOUS,
            tenantId: config.ENTRA_TENANT_ID,
            endpoint: "/auth/callback",
            method: "GET",
            action: "app-registration:sync-failed",
            resourceType: "application",
            resourceId: config.ENTRA_CLIENT_ID,
            summary: "Permission sync callback rejected — session mismatch",
            outcome: "failure",
            responseStatus: 400,
          });

          return reply.type("text/html").code(400).send(
            landingPage({
              origin,
              tone: "error",
              title: "PatchPilot — sync permissions",
              heading: "This link is no longer valid",
              body: "This permission-sync link doesn't match your current PatchPilot session. Start the sync again from Setup → App Registration.",
            }),
          );
        }

        try {
          const stepUp = await redeemStepUpConsentCode(code, `${origin}/auth/callback`);
          const result = await syncAppRegistrationScopes({
            accessToken: stepUp.accessToken,
            clientId: config.ENTRA_CLIENT_ID,
            includeWriteScopes,
          });

          // Stamps the same drift baseline onboarding-pairing.ts sets on a
          // fresh pairing — but ONLY for the resources syncAppRegistrationScopes
          // actually confirmed applied. Earlier this unconditionally stamped all
          // three resources whenever result.applied was non-empty, which marked
          // Defender/Partner Center as "synced" even on a run where their scopes
          // were entirely missing/skipped (a resource with zero matches never
          // reaches the app registration's requiredResourceAccess at all — see
          // app-registration-sync.ts) — the "Sync needed" badge would then clear
          // itself despite those resources still being out of date. Resources not
          // in this run keep whatever baseline they already had, so a still-broken
          // resource keeps flagging drift instead of silently reporting all-clear.
          if (result.applied.length > 0) {
            const [existingRow] = await db
              .select()
              .from(tables.settings)
              .where(eq(tables.settings.key, "entra-scopes-baseline"));
            const prior = (existingRow?.value ?? {}) as Partial<ScopeBaseline>;
            const fresh = currentScopeBaseline(includeWriteScopes);
            const appliedResources = new Set(result.applied.map((a) => a.resource));
            const value = {
              includeWriteScopes,
              graph: appliedResources.has("graph") ? fresh.graph : (prior.graph ?? []),
              defender: appliedResources.has("defender") ? fresh.defender : (prior.defender ?? []),
              partnerCenter: appliedResources.has("partnerCenter")
                ? fresh.partnerCenter
                : (prior.partnerCenter ?? []),
            };
            await db
              .insert(tables.settings)
              .values({ key: "entra-scopes-baseline", value })
              .onConflictDoUpdate({ target: tables.settings.key, set: { value, updatedAt: new Date() } });
          }

          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: "app-registration:sync-success",
            resourceType: "application",
            resourceId: config.ENTRA_CLIENT_ID,
            summary: `${engineer.upn} synced app registration permissions (${result.applied.length} resource${
              result.applied.length === 1 ? "" : "s"
            } updated${result.warnings.length ? `, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}` : ""})`,
            outcome: result.warnings.length > 0 ? "partial" : "success",
            detail: result.warnings.join("\n") || null,
            responseStatus: 200,
          });

          const appliedList = result.applied
            .map((a) => `${a.resource} (${a.scopeCount} scope${a.scopeCount === 1 ? "" : "s"})`)
            .join(", ");
          const warningList = result.warnings.length
            ? `<br/><br/>Warnings:<br/>${result.warnings.map((w) => `&bull; ${w}`).join("<br/>")}`
            : "";

          return reply.type("text/html").send(
            landingPage({
              origin,
              tone: result.warnings.length > 0 ? "error" : "ok",
              title: "PatchPilot — sync permissions",
              heading: result.warnings.length > 0 ? "Permissions synced with warnings" : "Permissions synced",
              body: `Requested API permissions and admin consent were refreshed${
                appliedList ? ` for: ${appliedList}` : ""
              }.${warningList} Return to PatchPilot and confirm in Setup → App Registration.`,
            }),
          );
        } catch (err) {
          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: "app-registration:sync-failed",
            resourceType: "application",
            resourceId: config.ENTRA_CLIENT_ID,
            summary: `${engineer.upn}'s permission sync failed`,
            outcome: "failure",
            detail: err instanceof Error ? err.message : String(err),
            responseStatus: 500,
          });

          return reply.type("text/html").code(500).send(
            landingPage({
              origin,
              tone: "error",
              title: "PatchPilot — sync permissions",
              heading: "Permission sync failed",
              body: `Microsoft returned an error while syncing permissions: ${
                err instanceof Error ? err.message : "unknown error"
              }. No changes may have been applied — check Azure Portal, or try again from PatchPilot.`,
            }),
          );
        }
      }

      // "Test Connection" step-up return (Setup -> App Registration, Requested
      // API permissions section). Same step-up mechanics as the syncperm
      // branch above, discriminated by state prefix (apps/api/src/routes/onboarding.ts),
      // but calls the read-only testAppRegistrationScopes instead of
      // syncAppRegistrationScopes — nothing here is ever written back to Entra.
      const TEST_CONN_STATE_PREFIX = "patchpilot-testconn:";
      if (code && state?.startsWith(TEST_CONN_STATE_PREFIX)) {
        const sessionId = state.slice(TEST_CONN_STATE_PREFIX.length);
        const engineer = req.session.engineer;

        if (!engineer || sessionId !== req.session.sessionId) {
          await auditSafe({
            engineer: engineer?.upn ?? ANONYMOUS,
            tenantId: config.ENTRA_TENANT_ID,
            endpoint: "/auth/callback",
            method: "GET",
            action: "app-registration:test-connection-failed",
            resourceType: "application",
            resourceId: config.ENTRA_CLIENT_ID,
            summary: "Connection test callback rejected — session mismatch",
            outcome: "failure",
            responseStatus: 400,
          });

          return reply.type("text/html").code(400).send(
            landingPage({
              origin,
              tone: "error",
              title: "PatchPilot — test connection",
              heading: "This link is no longer valid",
              body: "This connection-test link doesn't match your current PatchPilot session. Start the test again from Setup → App Registration.",
            }),
          );
        }

        try {
          const stepUp = await redeemStepUpConsentCode(code, `${origin}/auth/callback`);
          const result = await testAppRegistrationScopes({
            accessToken: stepUp.accessToken,
            clientId: config.ENTRA_CLIENT_ID,
          });

          const value = { checkedAt: new Date().toISOString(), results: result.results };
          await db
            .insert(tables.settings)
            .values({ key: "entra-scope-status", value })
            .onConflictDoUpdate({ target: tables.settings.key, set: { value, updatedAt: new Date() } });

          const ok = result.results.filter((r) => r.status === "ok").length;
          const skipped = result.results.filter((r) => r.status === "skipped").length;
          const failed = result.results.filter((r) => r.status === "failed").length;

          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: "app-registration:test-connection-success",
            resourceType: "application",
            resourceId: config.ENTRA_CLIENT_ID,
            summary: `${engineer.upn} tested app registration permissions (${ok} ok, ${skipped} skipped, ${failed} failed)`,
            outcome: failed > 0 ? "partial" : "success",
            responseStatus: 200,
          });

          return reply.type("text/html").send(
            landingPage({
              origin,
              tone: failed > 0 ? "error" : "ok",
              title: "PatchPilot — test connection",
              heading: "Connection test complete",
              body: `${ok} permission${ok === 1 ? "" : "s"} OK, ${skipped} skipped, ${failed} failed. Nothing was changed — this was a read-only check. Return to PatchPilot and see Setup → App Registration for the breakdown.`,
            }),
          );
        } catch (err) {
          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: "app-registration:test-connection-failed",
            resourceType: "application",
            resourceId: config.ENTRA_CLIENT_ID,
            summary: `${engineer.upn}'s connection test failed`,
            outcome: "failure",
            detail: err instanceof Error ? err.message : String(err),
            responseStatus: 500,
          });

          return reply.type("text/html").code(500).send(
            landingPage({
              origin,
              tone: "error",
              title: "PatchPilot — test connection",
              heading: "Connection test failed",
              body: `Microsoft returned an error while testing the connection: ${
                err instanceof Error ? err.message : "unknown error"
              }. Nothing was changed — try again from PatchPilot.`,
            }),
          );
        }
      }

      // "Update app registration" step-up return (Setup -> App Registration,
      // Custom domain section). Same step-up mechanics as the syncperm branch
      // above, discriminated by state prefix (apps/api/src/routes/domains.ts),
      // but calls updateAppRegistrationRedirectUris instead of
      // syncAppRegistrationScopes — it patches Web.RedirectUris, not permissions.
      const SYNC_DOMAINS_STATE_PREFIX = "patchpilot-syncdomains:";
      if (code && state?.startsWith(SYNC_DOMAINS_STATE_PREFIX)) {
        const sessionId = state.slice(SYNC_DOMAINS_STATE_PREFIX.length);
        const engineer = req.session.engineer;

        if (!engineer || sessionId !== req.session.sessionId) {
          await auditSafe({
            engineer: engineer?.upn ?? ANONYMOUS,
            tenantId: config.ENTRA_TENANT_ID,
            endpoint: "/auth/callback",
            method: "GET",
            action: "app-registration:domain-sync-failed",
            resourceType: "application",
            resourceId: config.ENTRA_CLIENT_ID,
            summary: "Redirect URI sync callback rejected — session mismatch",
            outcome: "failure",
            responseStatus: 400,
          });

          return reply.type("text/html").code(400).send(
            landingPage({
              origin,
              tone: "error",
              title: "PatchPilot — sync redirect URIs",
              heading: "This link is no longer valid",
              body: "This redirect-URI-sync link doesn't match your current PatchPilot session. Start it again from Setup → App Registration.",
            }),
          );
        }

        try {
          const stepUp = await redeemStepUpConsentCode(code, `${origin}/auth/callback`);
          const result = await updateAppRegistrationRedirectUris({
            accessToken: stepUp.accessToken,
            clientId: config.ENTRA_CLIENT_ID,
            redirectOrigins: webOrigins,
          });

          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: "app-registration:domain-sync-success",
            resourceType: "application",
            resourceId: config.ENTRA_CLIENT_ID,
            summary: `${engineer.upn} synced app registration redirect URIs (${result.added.length} added, ${result.alreadyPresent.length} already present)`,
            outcome: "success",
            responseStatus: 200,
          });

          return reply.type("text/html").send(
            landingPage({
              origin,
              tone: "ok",
              title: "PatchPilot — sync redirect URIs",
              heading: result.added.length ? "Redirect URIs updated" : "Already up to date",
              body: result.added.length
                ? `Added: ${result.added.join(", ")}. Already present: ${result.alreadyPresent.length}.`
                : "Every active domain's redirect URI was already registered — nothing to change.",
            }),
          );
        } catch (err) {
          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: "app-registration:domain-sync-failed",
            resourceType: "application",
            resourceId: config.ENTRA_CLIENT_ID,
            summary: `${engineer.upn}'s redirect URI sync failed`,
            outcome: "failure",
            detail: err instanceof Error ? err.message : String(err),
            responseStatus: 500,
          });

          return reply.type("text/html").code(500).send(
            landingPage({
              origin,
              tone: "error",
              title: "PatchPilot — sync redirect URIs",
              heading: "Redirect URI sync failed",
              body: `Microsoft returned an error while updating redirect URIs: ${
                err instanceof Error ? err.message : "unknown error"
              }. No changes may have been applied — check Azure Portal, or try again from PatchPilot.`,
            }),
          );
        }
      }

      // Admin-consent return (no auth code). The service principal + permissions
      // are now provisioned in the admin's tenant; discovery can reach it.
      if (admin_consent !== undefined && !code) {
        const granted = admin_consent.toLowerCase() === "true";

        // The highest-value event in this file: a customer tenant granting (or
        // refusing) PatchPilot standing permission to read its estate. Until now
        // this left no trace anywhere.
        await auditSafe({
          engineer: ANONYMOUS,
          tenantId: tenant ?? null,
          endpoint: "/auth/callback",
          method: "GET",
          action: granted ? "auth:consent-granted" : "auth:consent-denied",
          resourceType: "tenant",
          resourceId: tenant ?? null,
          summary: granted
            ? `Admin consent granted${tenant ? ` for tenant ${tenant}` : ""}`
            : `Admin consent declined${tenant ? ` for tenant ${tenant}` : ""}`,
          outcome: granted ? "success" : "failure",
          responseStatus: 200,
        });

        return reply.type("text/html").send(
          landingPage({
            origin,
            tone: granted ? "ok" : "error",
            title: "PatchPilot — admin consent",
            heading: granted ? "PatchPilot authorized" : "Consent was not granted",
            body: granted
              ? `Admin consent was recorded${
                  tenant ? ` for tenant <code>${tenant}</code>` : ""
                }. PatchPilot can now discover and read this tenant. Return to PatchPilot and run Discover.`
              : "The admin-consent grant was declined or cancelled. PatchPilot will not be able to read this tenant until consent is granted.",
          }),
        );
      }

      // Neither a code nor a consent return — nothing to do.
      if (!code) {
        return reply.type("text/html").code(400).send(
          landingPage({
            origin,
            tone: "error",
            title: "PatchPilot — nothing to do",
            heading: "Nothing to process",
            body: "This page is the Microsoft sign-in / consent return. There was no authorization code or consent result to handle.",
          }),
        );
      }

      // CSRF protection for the login flow itself: state must match the
      // sessionId this browser was carrying when /auth/login built this trip
      // (see the state: req.session.sessionId comment above). Without this
      // check an attacker could complete their own auth code exchange inside
      // a victim's browser (classic "login CSRF"), landing the victim in the
      // attacker's PatchPilot session.
      if (!state || state !== req.session.sessionId) {
        await auditSafe({
          engineer: ANONYMOUS,
          tenantId: config.ENTRA_TENANT_ID,
          endpoint: "/auth/callback",
          method: "GET",
          action: "auth:login-failed",
          resourceType: "session",
          summary: "Auth callback rejected — state parameter mismatch",
          outcome: "failure",
          responseStatus: 400,
        });

        return reply.type("text/html").code(400).send(
          landingPage({
            origin,
            tone: "error",
            title: "PatchPilot — authorization failed",
            heading: "This sign-in link is no longer valid",
            body: "This sign-in link doesn't match your current browser session. Close this tab and try signing in again from PatchPilot.",
          }),
        );
      }

      // Redeem the code AND persist the engineer's MSAL cache (refresh token) so
      // customer-tenant access can be minted silently later (Secure App Model).
      let result: Awaited<ReturnType<typeof redeemLoginCode>>;
      try {
        result = await redeemLoginCode(code, `${origin}/auth/callback`);
      } catch (err) {
        await auditSafe({
          engineer: ANONYMOUS,
          tenantId: config.ENTRA_TENANT_ID,
          endpoint: "/auth/callback",
          method: "GET",
          action: "auth:login-failed",
          resourceType: "session",
          summary: "Authorization code exchange failed",
          outcome: "failure",
          detail: err instanceof Error ? err.message : String(err),
          responseStatus: 500,
        });
        throw err;
      }

      const rawUpn = result.account?.username ?? result.account?.homeAccountId ?? "unknown";
      const upn = rawUpn.toLowerCase();
      const tenantId = result.account?.tenantId ?? config.ENTRA_TENANT_ID;

      // Gate on provisioning: a successful Entra sign-in is necessary but not
      // sufficient. Only a person with an active row in Settings -> Users may
      // actually get a PatchPilot session — GDAP alone doesn't get you in.
      const [userRow] = await db
        .select()
        .from(tables.engineers)
        .where(eq(tables.engineers.upn, upn))
        .limit(1);

      if (!userRow || userRow.status !== "active") {
        await auditSafe({
          engineer: upn,
          tenantId,
          endpoint: "/auth/callback",
          method: "GET",
          action: "auth:login-denied",
          resourceType: "session",
          resourceLabel: result.account?.name ?? upn,
          summary: `${result.account?.name ?? upn} signed in with Microsoft but has no active PatchPilot account`,
          outcome: "failure",
          responseStatus: 403,
        });

        return reply.type("text/html").code(403).send(
          landingPage({
            origin,
            tone: "error",
            title: "PatchPilot — not provisioned",
            heading: "Your account isn't set up in PatchPilot",
            body: `Signed in to Microsoft as <code>${upn}</code>, but no active PatchPilot account matches. Ask a PatchPilot admin to add you under Settings → Users, then try signing in again.`,
          }),
        );
      }

      await storeToken(upn, tenantId, {
        accessToken: result.accessToken,
        expiresAt: result.expiresOn?.getTime() ?? Date.now() + 3_600_000,
        scopes: result.scopes,
      });

      // Backfill a blank displayName from the Entra claim; never overwrite one
      // that's already set (an admin may have deliberately renamed the row).
      const displayName = userRow.displayName || result.account?.name || upn;
      await db
        .update(tables.engineers)
        .set({
          lastLoginAt: new Date(),
          updatedAt: new Date(),
          ...(userRow.displayName ? {} : { displayName }),
        })
        .where(eq(tables.engineers.id, userRow.id));

      // Rotate the session ID on privilege change (pre-auth -> authenticated)
      // rather than reusing the one issued before Microsoft ever vouched for
      // this browser — closes the session-fixation window where a fixed
      // pre-login sessionId could be hijacked post-login.
      await req.session.regenerate();
      req.session.engineer = {
        upn,
        displayName,
        homeTenantId: tenantId,
      };

      await auditSafe({
        engineer: upn,
        tenantId,
        endpoint: "/auth/callback",
        method: "GET",
        action: "auth:login-success",
        resourceType: "session",
        resourceLabel: displayName,
        summary: `${displayName} signed in`,
        outcome: "success",
        responseStatus: 302,
      });

      return reply.redirect(origin);
    },
  );

  app.get("/auth/me", async (req, reply) => {
    // req.currentUser is resolved fresh on every request by resolveCurrentUser
    // (see auth/current-user.ts) — if the row backing this session was disabled
    // or deleted, that preHandler already destroyed the session before we get
    // here, so seeing session.engineer without currentUser shouldn't happen in
    // practice. Guard on both anyway rather than assume.
    if (!req.session.engineer || !req.currentUser) {
      // entraConfigured rides even the 401 body: the web AuthGate needs it
      // BEFORE deciding whether to redirect to /auth/login at all — that
      // redirect is a dead end on a fresh, unpaired instance (Microsoft
      // rejects a blank client_id), so the SPA shows the pairing setup
      // screen instead. See apps/web/src/lib/auth.tsx.
      return reply.code(401).send({ authenticated: false, entraConfigured: config.ENTRA_CONFIGURED });
    }
    // Lazily issued rather than only at login: a session created before this
    // field existed (a Redis-persisted session surviving an api restart, see
    // the Session.csrfToken doc comment in types.d.ts) still gets a token the
    // next time its owner loads the app, instead of being unable to submit
    // any mutating request until they log out and back in.
    if (!req.session.csrfToken) {
      req.session.csrfToken = randomBytes(32).toString("hex");
    }
    return {
      authenticated: true,
      entraConfigured: config.ENTRA_CONFIGURED,
      engineer: {
        ...req.session.engineer,
        role: req.currentUser.role,
        permissions: permissionsFor(req.currentUser.role),
      },
      csrfToken: req.session.csrfToken,
    };
  });

  app.post("/auth/logout", async (req, reply) => {
    // Read the identity before destroy() — afterwards there is no session left
    // to attribute the sign-out to.
    const upn = req.session.engineer?.upn;
    const homeTenantId = req.session.engineer?.homeTenantId ?? null;
    if (upn) {
      // Deliberately does NOT clear the engineer's persisted MSAL cache here.
      // That cache is a self-renewing background-access credential (see
      // packages/graph/src/msal.ts) that auto-sync and this engineer's
      // schedules depend on to run headlessly — destroying it on routine
      // sign-out breaks background sync the moment the last engineer logs
      // out. Real revocation is an explicit admin action (users.ts) or an
      // automatic side effect of disabling/deleting the account.
      await clearTokens(upn);
    }
    await req.session.destroy();

    await auditSafe({
      engineer: upn ?? ANONYMOUS,
      tenantId: homeTenantId,
      endpoint: "/auth/logout",
      method: "POST",
      action: "auth:logout",
      resourceType: "session",
      summary: upn ? `${upn} signed out` : "Sign-out on a session with no engineer",
      outcome: "success",
      responseStatus: 200,
    });

    return reply.send({ ok: true });
  });
}
