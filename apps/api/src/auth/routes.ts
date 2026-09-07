import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import {
  permissionsFor,
  currentScopeBaseline,
  READONLY_GROUP_NAME,
  WRITE_GROUP_NAME,
  type ScopeBaseline,
} from "@patchpilot/shared";
import { config, webOrigins } from "../config.js";
import { resolveWebOrigin } from "./origin.js";
import { findDemoEngineerByUpn } from "./demo-engineers.js";
import {
  getCca,
  getLoginScopes,
  redeemLoginCode,
  redeemStepUpConsentCode,
  APP_REGISTRATION_TEST_SCOPES,
  ACCESS_GROUP_SCOPES,
  CHECK_ACCESS_SCOPES,
  syncAppRegistrationScopes,
  testAppRegistrationScopes,
  updateAppRegistrationRedirectUris,
  decodeRedirectUriRemoval,
  storeToken,
  clearTokens,
  auditSafe,
  resolveEngineerObjectId,
  addToGroup,
  removeFromGroup,
  AccessGroupPermissionError,
} from "@patchpilot/graph";
import { assembleCheckAccessSummary, stashCheckAccessResult } from "../routes/check-access.js";

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
  /**
   * Where "Return to PatchPilot" sends the admin — e.g. "/setup/app-registration"
   * so a Sync/Test Connection/redirect-URI-sync return lands back on the page
   * that started it, not the bare origin (which the SPA's router sends to the
   * dashboard). Defaults to the origin root for flows with no single obvious
   * page (e.g. admin-consent, which can be started from either App Registration
   * or the Tenants page).
   */
  returnPath?: string;
}): string {
  const accent = opts.tone === "ok" ? "#16a34a" : "#dc2626";
  const escape = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const returnUrl = `${opts.origin}${opts.returnPath ?? ""}`;
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
  <p><a href="${escape(returnUrl)}">Return to PatchPilot →</a></p>
</div></body></html>`;
}

/** Every app-registration step-up flow (sync, test-connection, domain-sync)
 * only ever starts from this one page, so their landing pages should return
 * here rather than the bare origin (which the SPA sends to the dashboard). */
const APP_REGISTRATION_PATH = "/setup/app-registration";

/** Every home-tenant access-group step-up flow starts from Settings -> Users. */
const USERS_PATH = "/settings/users";

/** Every Check Access step-up flow starts from Setup Health -> Check Access. */
const CHECK_ACCESS_PATH = "/setup/health?tab=checkAccess";

type AccessGroupAction = "add-readonly" | "grant-write" | "revoke-write";

interface AccessGroupActionResult {
  ok: boolean;
  reason?: "not_found" | "not_provisioned" | "forbidden" | "error";
  targetUpn?: string;
  groupName: string;
  detail?: string;
}

/**
 * Shared by both the silent (hidden-iframe) and interactive access-group
 * callback branches below — see routes/access-groups.ts's start route for
 * the request side. Resolves the target engineer's Entra object id lazily
 * (cached on first use, per the plan), performs the group-membership change,
 * and stamps the matching sync-status column. A 403 from Graph — the acting
 * engineer's own Entra role isn't Global Administrator/Privileged Role
 * Administrator, which a tenant-wide app consent grant cannot bypass — comes
 * back as reason "forbidden" so both callers can render the same actionable
 * "ask a Global Administrator" message instead of a generic error.
 */
async function applyAccessGroupAction(
  accessToken: string,
  action: AccessGroupAction,
  targetUserId: string,
): Promise<AccessGroupActionResult> {
  const groupName = action === "add-readonly" ? READONLY_GROUP_NAME : WRITE_GROUP_NAME;

  const [target] = await db.select().from(tables.engineers).where(eq(tables.engineers.id, targetUserId)).limit(1);
  if (!target) {
    return { ok: false, reason: "not_found", groupName };
  }

  const groupId = action === "add-readonly" ? config.PATCHPILOT_READONLY_GROUP_ID : config.PATCHPILOT_WRITE_GROUP_ID;
  if (!groupId) {
    return { ok: false, reason: "not_provisioned", targetUpn: target.upn, groupName };
  }

  try {
    let entraObjectId = target.entraObjectId;
    if (!entraObjectId) {
      entraObjectId = await resolveEngineerObjectId(accessToken, config.ENTRA_TENANT_ID, target.upn);
      await db.update(tables.engineers).set({ entraObjectId }).where(eq(tables.engineers.id, target.id));
    }

    if (action === "revoke-write") {
      await removeFromGroup(accessToken, groupId, entraObjectId);
      await db
        .update(tables.engineers)
        .set({ writeAccessEnabled: false, writeGroupSyncedAt: new Date() })
        .where(eq(tables.engineers.id, target.id));
    } else {
      await addToGroup(accessToken, groupId, entraObjectId);
      if (action === "add-readonly") {
        await db
          .update(tables.engineers)
          .set({ readOnlyGroupSyncedAt: new Date() })
          .where(eq(tables.engineers.id, target.id));
      } else {
        await db
          .update(tables.engineers)
          .set({ writeAccessEnabled: true, writeGroupSyncedAt: new Date() })
          .where(eq(tables.engineers.id, target.id));
      }
    }

    return { ok: true, targetUpn: target.upn, groupName };
  } catch (err) {
    if (err instanceof AccessGroupPermissionError) {
      return { ok: false, reason: "forbidden", targetUpn: target.upn, groupName, detail: err.message };
    }
    return {
      ok: false,
      reason: "error",
      targetUpn: target.upn,
      groupName,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function accessGroupAuditAction(action: AccessGroupAction): "access-group:add-readonly" | "access-group:grant-write" | "access-group:revoke-write" {
  return action === "add-readonly"
    ? "access-group:add-readonly"
    : action === "grant-write"
      ? "access-group:grant-write"
      : "access-group:revoke-write";
}

/**
 * Tiny same-origin postMessage bridge for a step-up flow run inside a hidden
 * `<iframe>` (see SILENT_TEST_CONN_STATE_PREFIX below) instead of a top-level
 * navigation. landingPage() assumes the whole tab just navigated here and
 * offers a "Return to PatchPilot" link — inside a hidden iframe that would be
 * both invisible and pointless. This just hands the outcome back to
 * `window.parent` and lets the parent page redraw in place (or fall back to
 * the normal visible redirect if `ok` is false).
 *
 * `source` lets the parent page's `message` listener tell flows apart — every
 * silent iframe flow shares the same `window` event namespace, so a listener
 * that only checked `event.origin` would react to *any* hidden-iframe flow
 * running anywhere on the page, not just its own.
 *
 * Generic over `T` (rather than the original fixed `{ ok: boolean }`) so a
 * flow that needs to hand back real data — Check Access's silent path posts
 * `{ ok, result: CheckAccessSummary }` straight through this same channel —
 * can do so without a second round trip. Every existing call site's literal
 * `{ ok: true/false }` still satisfies `T extends { ok: boolean }` unchanged.
 */
function postMessagePage<T extends { ok: boolean }>(payload: T, targetOrigin: string, source: string): string {
  const json = JSON.stringify({ source, ...payload }).replace(/</g, "\\u003c");
  const safeOrigin = JSON.stringify(targetOrigin);
  return `<!doctype html><html><head><meta charset="utf-8" /></head><body><script>
  try { window.parent.postMessage(${json}, ${safeOrigin}); } catch (e) {}
</script></body></html>`;
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

      // Silent SSO "Test Connection" (hidden iframe, prompt=none) — see
      // onboarding.ts's ?silent=1 branch and AppRegistration.tsx's
      // runTestConnection. Same read-only testAppRegistrationScopes as the
      // visible TEST_CONN_STATE_PREFIX flow further down, but this callback
      // loads inside a hidden iframe, not the top-level page, so it must
      // never render landingPage()'s HTML — it postMessages a tiny {ok}
      // result back to the parent window instead. Checked before the generic
      // `if (error)` block below: a failed prompt=none silent attempt (no
      // active SSO session, a Conditional Access step-up) comes back as
      // `error=interaction_required` with no code, and that generic block
      // doesn't look at `state` at all — left unchecked it would render the
      // full error landingPage inside the hidden iframe instead of letting
      // the parent's fallback kick in immediately.
      const SILENT_TEST_CONN_STATE_PREFIX = "patchpilot-testconn-silent:";
      if (state?.startsWith(SILENT_TEST_CONN_STATE_PREFIX)) {
        const sessionId = state.slice(SILENT_TEST_CONN_STATE_PREFIX.length);
        const engineer = req.session.engineer;

        if (error || !code || !engineer || sessionId !== req.session.sessionId) {
          // Every failure path here is an expected, silent outcome (no SSO
          // session, MFA step-up, a rotated session) — the parent's
          // timeout/fallback to the visible flow handles it, and a human
          // driving that visible retry already produces its own audit trail,
          // so this doesn't need one of its own beyond the start event above.
          return reply.type("text/html").send(postMessagePage({ ok: false }, origin, "patchpilot-test-connection"));
        }

        try {
          const stepUp = await redeemStepUpConsentCode(
            code,
            `${origin}/auth/callback`,
            APP_REGISTRATION_TEST_SCOPES,
          );
          const result = await testAppRegistrationScopes({
            accessToken: stepUp.accessToken,
            clientId: config.ENTRA_CLIENT_ID,
          });

          const value = {
            checkedAt: new Date().toISOString(),
            results: result.results,
            licensing: result.licensing,
          };
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
            summary: `${engineer.upn} tested app registration permissions silently (${ok} ok, ${skipped} skipped, ${failed} failed)`,
            outcome: failed > 0 ? "partial" : "success",
            responseStatus: 200,
          });

          return reply.type("text/html").send(postMessagePage({ ok: true }, origin, "patchpilot-test-connection"));
        } catch (err) {
          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: "app-registration:test-connection-failed",
            resourceType: "application",
            resourceId: config.ENTRA_CLIENT_ID,
            summary: `${engineer.upn}'s silent connection test failed`,
            outcome: "failure",
            detail: err instanceof Error ? err.message : String(err),
            responseStatus: 500,
          });

          return reply.type("text/html").send(postMessagePage({ ok: false }, origin, "patchpilot-test-connection"));
        }
      }

      // Silent home-tenant access-group step-up (hidden iframe, prompt=none) —
      // see routes/access-groups.ts's ?silent=1 branch and Users.tsx's
      // new-user auto-add. Only ever action=add-readonly (the start route
      // rejects silent for grant-write/revoke-write). Same postMessage-not-
      // landingPage handling as SILENT_TEST_CONN_STATE_PREFIX above, for the
      // same reason: this loads inside a hidden iframe, not the top-level page.
      const SILENT_ACCESS_GROUP_STATE_PREFIX = "patchpilot-accessgroup-silent:";
      if (state?.startsWith(SILENT_ACCESS_GROUP_STATE_PREFIX)) {
        const [sessionId, actionRaw, targetUserId] = state.slice(SILENT_ACCESS_GROUP_STATE_PREFIX.length).split(":");
        const action = actionRaw as AccessGroupAction | undefined;
        const engineer = req.session.engineer;

        if (error || !code || !engineer || !action || !targetUserId || sessionId !== req.session.sessionId) {
          // Same reasoning as the silent test-connection failure path above:
          // an expected, silent outcome (no SSO session, MFA step-up) that
          // the Users page's retry action already covers — no audit trail
          // needed beyond what a human-driven retry produces on its own.
          return reply.type("text/html").send(postMessagePage({ ok: false }, origin, "patchpilot-access-group"));
        }

        try {
          const stepUp = await redeemStepUpConsentCode(code, `${origin}/auth/callback`, ACCESS_GROUP_SCOPES);
          const result = await applyAccessGroupAction(stepUp.accessToken, action, targetUserId);

          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: accessGroupAuditAction(action),
            resourceType: "user",
            resourceId: targetUserId,
            resourceLabel: result.targetUpn ?? targetUserId,
            summary: result.ok
              ? `${engineer.upn} added ${result.targetUpn} to ${result.groupName}`
              : `${engineer.upn}'s silent add of ${result.targetUpn ?? targetUserId} to ${result.groupName} failed (${result.reason})`,
            outcome: result.ok ? "success" : "failure",
            detail: result.detail ?? null,
            responseStatus: result.ok ? 200 : 500,
          });

          return reply.type("text/html").send(postMessagePage({ ok: result.ok }, origin, "patchpilot-access-group"));
        } catch (err) {
          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: accessGroupAuditAction(action),
            resourceType: "user",
            resourceId: targetUserId,
            summary: `${engineer.upn}'s silent access-group step-up failed`,
            outcome: "failure",
            detail: err instanceof Error ? err.message : String(err),
            responseStatus: 500,
          });

          return reply.type("text/html").send(postMessagePage({ ok: false }, origin, "patchpilot-access-group"));
        }
      }

      // Interactive home-tenant access-group step-up return (Settings ->
      // Users, Write access toggle). Discriminated from the silent branch
      // above by state prefix (see routes/access-groups.ts's start route).
      // Always a full-page landingPage() response — never postMessage — since
      // this is only ever reached via a real top-level navigation, per the
      // plan's "write-group membership changes always get the full visible
      // consent screen" rule.
      const ACCESS_GROUP_STATE_PREFIX = "patchpilot-accessgroup:";
      if (code && state?.startsWith(ACCESS_GROUP_STATE_PREFIX)) {
        const [sessionId, actionRaw, targetUserId] = state.slice(ACCESS_GROUP_STATE_PREFIX.length).split(":");
        const action = actionRaw as AccessGroupAction | undefined;
        const engineer = req.session.engineer;

        if (!engineer || !action || !targetUserId || sessionId !== req.session.sessionId) {
          return reply.type("text/html").code(400).send(
            landingPage({
              origin,
              returnPath: USERS_PATH,
              tone: "error",
              title: "PatchPilot — access groups",
              heading: "This link is no longer valid",
              body: "This link doesn't match your current PatchPilot session. Start the request again from Settings → Users.",
            }),
          );
        }

        try {
          const stepUp = await redeemStepUpConsentCode(code, `${origin}/auth/callback`, ACCESS_GROUP_SCOPES);
          const result = await applyAccessGroupAction(stepUp.accessToken, action, targetUserId);

          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: accessGroupAuditAction(action),
            resourceType: "user",
            resourceId: targetUserId,
            resourceLabel: result.targetUpn ?? targetUserId,
            summary: result.ok
              ? `${engineer.upn} ${action === "revoke-write" ? "removed" : "added"} ${result.targetUpn} ${
                  action === "revoke-write" ? "from" : "to"
                } ${result.groupName}`
              : `${engineer.upn}'s ${action} for ${result.targetUpn ?? targetUserId} failed (${result.reason})`,
            outcome: result.ok ? "success" : "failure",
            detail: result.detail ?? null,
            responseStatus: result.ok ? 200 : result.reason === "forbidden" ? 403 : result.reason === "not_found" ? 404 : 500,
          });

          if (result.ok) {
            return reply.type("text/html").send(
              landingPage({
                origin,
                returnPath: USERS_PATH,
                tone: "ok",
                title: "PatchPilot — access groups",
                heading: action === "revoke-write" ? "Write access revoked" : "Access granted",
                body:
                  action === "revoke-write"
                    ? `${result.targetUpn} was removed from <strong>${result.groupName}</strong> in the home tenant. Return to PatchPilot and confirm in Settings → Users.`
                    : `${result.targetUpn} was added to <strong>${result.groupName}</strong> in the home tenant. Return to PatchPilot and confirm in Settings → Users.`,
              }),
            );
          }

          if (result.reason === "forbidden") {
            return reply.type("text/html").code(403).send(
              landingPage({
                origin,
                returnPath: USERS_PATH,
                tone: "error",
                title: "PatchPilot — access groups",
                heading: "Couldn't complete — insufficient Microsoft privilege",
                body: `Your Microsoft account needs <strong>Global Administrator</strong> or <strong>Privileged Role Administrator</strong> to manage this group. Ask an Entra admin to add ${
                  result.targetUpn ?? "this user"
                } to <strong>${result.groupName}</strong> manually, or run Deploy-PatchPilot.ps1 again as a Global Administrator.`,
              }),
            );
          }

          if (result.reason === "not_provisioned") {
            return reply.type("text/html").code(400).send(
              landingPage({
                origin,
                returnPath: USERS_PATH,
                tone: "error",
                title: "PatchPilot — access groups",
                heading: "Access group not set up",
                body: `<strong>${result.groupName}</strong> hasn't been provisioned in the home tenant yet. See <a href="${origin}${APP_REGISTRATION_PATH}">App Registration</a> for the setup steps and script to run — if it warns about a missing Entra ID P1/P2 license, that's expected on a tenant without one; a Global Administrator can still manage the home tenant directly without this group.`,
              }),
            );
          }

          return reply.type("text/html").code(result.reason === "not_found" ? 404 : 500).send(
            landingPage({
              origin,
              returnPath: USERS_PATH,
              tone: "error",
              title: "PatchPilot — access groups",
              heading: "Something went wrong",
              body:
                result.reason === "not_found"
                  ? "That user no longer exists in PatchPilot."
                  : `Microsoft returned an error: ${result.detail ?? "unknown error"}. No changes may have been applied — try again from PatchPilot.`,
            }),
          );
        } catch (err) {
          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: accessGroupAuditAction(action),
            resourceType: "user",
            resourceId: targetUserId,
            summary: `${engineer.upn}'s ${action} step-up failed`,
            outcome: "failure",
            detail: err instanceof Error ? err.message : String(err),
            responseStatus: 500,
          });

          return reply.type("text/html").code(500).send(
            landingPage({
              origin,
              returnPath: USERS_PATH,
              tone: "error",
              title: "PatchPilot — access groups",
              heading: "Request failed",
              body: `Microsoft returned an error: ${
                err instanceof Error ? err.message : "unknown error"
              }. No changes may have been applied — try again from PatchPilot.`,
            }),
          );
        }
      }

      // Silent Check Access step-up (hidden iframe, prompt=none) — see
      // routes/check-access.ts's /start route and CheckAccessPanel.tsx's
      // runSilentCheckAccess. Unlike the access-group flows above, this is a
      // pure read (never mutates Entra), so silent applies to both a
      // self-check and an admin checking someone else. Same postMessage-not-
      // landingPage handling as the other hidden-iframe flows, and — unlike
      // every prior silent flow — the postMessage payload carries the actual
      // result (`result: CheckAccessSummary`) so the panel never needs a
      // second round trip on the common path.
      const SILENT_CHECK_ACCESS_STATE_PREFIX = "patchpilot-checkaccess-silent:";
      if (state?.startsWith(SILENT_CHECK_ACCESS_STATE_PREFIX)) {
        const [sessionId, targetUserId, checkTenantId] = state.slice(SILENT_CHECK_ACCESS_STATE_PREFIX.length).split(":");
        const engineer = req.session.engineer;

        if (error || !code || !engineer || !targetUserId || !checkTenantId || sessionId !== req.session.sessionId) {
          // Expected, silent outcome (no SSO session, MFA step-up, a rotated
          // session) — the panel's fallback to the visible flow handles it;
          // no audit needed beyond what that human-driven retry produces.
          return reply.type("text/html").send(postMessagePage({ ok: false }, origin, "patchpilot-check-access"));
        }

        try {
          const stepUp = await redeemStepUpConsentCode(code, `${origin}/auth/callback`, CHECK_ACCESS_SCOPES);

          const [target] = await db.select().from(tables.engineers).where(eq(tables.engineers.id, targetUserId)).limit(1);
          const [tenant] = await db.select().from(tables.tenants).where(eq(tables.tenants.tenantId, checkTenantId)).limit(1);
          if (!target || !tenant) {
            return reply.type("text/html").send(postMessagePage({ ok: false }, origin, "patchpilot-check-access"));
          }

          const result = await assembleCheckAccessSummary(stepUp.accessToken, engineer, target, tenant);

          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: "check-access:run",
            resourceType: "user",
            resourceId: target.id,
            resourceLabel: target.upn,
            summary:
              target.upn === engineer.upn
                ? `${engineer.upn} checked their own access in ${tenant.displayName}`
                : `${engineer.upn} checked ${target.upn}'s access in ${tenant.displayName}`,
            outcome: "success",
            responseStatus: 200,
          });

          return reply.type("text/html").send(postMessagePage({ ok: true, result }, origin, "patchpilot-check-access"));
        } catch (err) {
          // Same reasoning as the other silent flows' failure paths — an
          // expected outcome the panel's own fallback already covers.
          return reply.type("text/html").send(postMessagePage({ ok: false }, origin, "patchpilot-check-access"));
        }
      }

      // Interactive Check Access step-up return (Setup Health -> Check
      // Access), used when the silent attempt above fails (no active SSO
      // session, a Conditional Access step-up). A top-level redirect can't
      // hand back JS data the way postMessage can, so the result is stashed
      // one-shot in Redis (stashCheckAccessResult) and the return link
      // carries its id — CheckAccessPanel.tsx picks it up on mount.
      const CHECK_ACCESS_STATE_PREFIX = "patchpilot-checkaccess:";
      if (code && state?.startsWith(CHECK_ACCESS_STATE_PREFIX)) {
        const [sessionId, targetUserId, checkTenantId] = state.slice(CHECK_ACCESS_STATE_PREFIX.length).split(":");
        const engineer = req.session.engineer;

        if (!engineer || !targetUserId || !checkTenantId || sessionId !== req.session.sessionId) {
          return reply.type("text/html").code(400).send(
            landingPage({
              origin,
              returnPath: CHECK_ACCESS_PATH,
              tone: "error",
              title: "PatchPilot — check access",
              heading: "This link is no longer valid",
              body: "This link doesn't match your current PatchPilot session. Start the request again from Setup Health → Check Access.",
            }),
          );
        }

        try {
          const stepUp = await redeemStepUpConsentCode(code, `${origin}/auth/callback`, CHECK_ACCESS_SCOPES);

          const [target] = await db.select().from(tables.engineers).where(eq(tables.engineers.id, targetUserId)).limit(1);
          const [tenant] = await db.select().from(tables.tenants).where(eq(tables.tenants.tenantId, checkTenantId)).limit(1);
          if (!target || !tenant) {
            return reply.type("text/html").code(404).send(
              landingPage({
                origin,
                returnPath: CHECK_ACCESS_PATH,
                tone: "error",
                title: "PatchPilot — check access",
                heading: "Something went wrong",
                body: "That user or tenant no longer exists in PatchPilot.",
              }),
            );
          }

          const result = await assembleCheckAccessSummary(stepUp.accessToken, engineer, target, tenant);
          const resultId = randomBytes(16).toString("hex");
          await stashCheckAccessResult(resultId, result);

          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: "check-access:run",
            resourceType: "user",
            resourceId: target.id,
            resourceLabel: target.upn,
            summary:
              target.upn === engineer.upn
                ? `${engineer.upn} checked their own access in ${tenant.displayName}`
                : `${engineer.upn} checked ${target.upn}'s access in ${tenant.displayName}`,
            outcome: "success",
            responseStatus: 200,
          });

          return reply.type("text/html").send(
            landingPage({
              origin,
              returnPath: `${CHECK_ACCESS_PATH}&resultId=${resultId}`,
              tone: "ok",
              title: "PatchPilot — check access",
              heading: "Access check complete",
              body: "Return to PatchPilot to see the result.",
            }),
          );
        } catch (err) {
          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: "check-access:run",
            resourceType: "user",
            resourceId: targetUserId,
            summary: `${engineer.upn}'s check-access step-up failed`,
            outcome: "failure",
            detail: err instanceof Error ? err.message : String(err),
            responseStatus: 500,
          });

          return reply.type("text/html").code(500).send(
            landingPage({
              origin,
              returnPath: CHECK_ACCESS_PATH,
              tone: "error",
              title: "PatchPilot — check access",
              heading: "Request failed",
              body: `Microsoft returned an error: ${
                err instanceof Error ? err.message : "unknown error"
              }. Try again from PatchPilot.`,
            }),
          );
        }
      }

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
              returnPath: APP_REGISTRATION_PATH,
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
              returnPath: APP_REGISTRATION_PATH,
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
              returnPath: APP_REGISTRATION_PATH,
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
              returnPath: APP_REGISTRATION_PATH,
              tone: "error",
              title: "PatchPilot — test connection",
              heading: "This link is no longer valid",
              body: "This connection-test link doesn't match your current PatchPilot session. Start the test again from Setup → App Registration.",
            }),
          );
        }

        try {
          const stepUp = await redeemStepUpConsentCode(
            code,
            `${origin}/auth/callback`,
            APP_REGISTRATION_TEST_SCOPES,
          );
          const result = await testAppRegistrationScopes({
            accessToken: stepUp.accessToken,
            clientId: config.ENTRA_CLIENT_ID,
          });

          const value = {
            checkedAt: new Date().toISOString(),
            results: result.results,
            licensing: result.licensing,
          };
          await db
            .insert(tables.settings)
            .values({ key: "entra-scope-status", value })
            .onConflictDoUpdate({ target: tables.settings.key, set: { value, updatedAt: new Date() } });

          const ok = result.results.filter((r) => r.status === "ok").length;
          const skipped = result.results.filter((r) => r.status === "skipped").length;
          const failed = result.results.filter((r) => r.status === "failed").length;
          const missingCapabilities =
            result.licensing.status === "detected"
              ? [
                  !result.licensing.licenses.some((l) => l === "mde-p2" || l === "defender-business-premium") &&
                    "Defender for Endpoint",
                  !result.licensing.licenses.includes("intune") && "Intune",
                ].filter((v): v is string => typeof v === "string")
              : [];
          const licenseNote =
            missingCapabilities.length > 0
              ? ` This tenant isn't licensed for: ${missingCapabilities.join(", ")} — the matching permissions may still show as granted, but the underlying feature won't work.`
              : "";

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
              returnPath: APP_REGISTRATION_PATH,
              tone: failed > 0 ? "error" : "ok",
              title: "PatchPilot — test connection",
              heading: "Connection test complete",
              body: `${ok} permission${ok === 1 ? "" : "s"} OK, ${skipped} skipped, ${failed} failed. Nothing was changed — this was a read-only check. Return to PatchPilot and see Setup → App Registration for the breakdown.${licenseNote}`,
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
              returnPath: APP_REGISTRATION_PATH,
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
        const [sessionId, removalPayload] = state.slice(SYNC_DOMAINS_STATE_PREFIX.length).split(":");
        const engineer = req.session.engineer;
        // Re-derive + re-apply the same protectedUris filter domains.ts's
        // start route already used — this payload rode through the user's
        // browser and Microsoft's redirect, so it's untrusted here regardless
        // of what the start route already excluded. Never trust it alone.
        const protectedUris = new Set(webOrigins.map((o) => `${o}/auth/callback`));
        const removeUris = decodeRedirectUriRemoval(removalPayload).filter((uri) => !protectedUris.has(uri));

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
              returnPath: APP_REGISTRATION_PATH,
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
            removeUris,
          });

          // result.current is the authoritative post-operation Entra state —
          // every pre-existing redirect URI (including any added outside
          // PatchPilot entirely) plus whatever this run just added. Persisting
          // it lets the Application identity card show the real, verified
          // list instead of just this server's own computed guess (see
          // OnboardingReport.liveRedirectUris in routes/onboarding.ts).
          const liveValue = { checkedAt: new Date().toISOString(), redirectUris: result.current };
          await db
            .insert(tables.settings)
            .values({ key: "entra-redirect-uris-live", value: liveValue })
            .onConflictDoUpdate({ target: tables.settings.key, set: { value: liveValue, updatedAt: new Date() } });

          await auditSafe({
            engineer: engineer.upn,
            tenantId: engineer.homeTenantId,
            endpoint: "/auth/callback",
            method: "GET",
            action: "app-registration:domain-sync-success",
            resourceType: "application",
            resourceId: config.ENTRA_CLIENT_ID,
            summary: `${engineer.upn} synced app registration redirect URIs (${result.added.length} added, ${result.removed.length} removed, ${result.alreadyPresent.length} already present)`,
            outcome: "success",
            responseStatus: 200,
          });

          const changed = result.added.length > 0 || result.removed.length > 0;
          const bodyParts: string[] = [];
          if (result.added.length > 0) bodyParts.push(`Added: ${result.added.join(", ")}.`);
          if (result.removed.length > 0) bodyParts.push(`Removed: ${result.removed.join(", ")}.`);
          if (!changed) bodyParts.push("Every active domain's redirect URI was already registered — nothing to change.");

          return reply.type("text/html").send(
            landingPage({
              origin,
              returnPath: APP_REGISTRATION_PATH,
              tone: "ok",
              title: "PatchPilot — sync redirect URIs",
              heading: changed ? "Redirect URIs updated" : "Already up to date",
              body: bodyParts.join(" "),
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
              returnPath: APP_REGISTRATION_PATH,
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
        theme: req.currentUser.theme,
      },
      csrfToken: req.session.csrfToken,
    };
  });

  // Self-service only — an engineer's own display preference, not something an
  // admin sets for someone else (contrast /api/users/:id's receiveJobAlerts).
  // No permission check beyond being signed in: every role may toggle their
  // own theme.
  app.patch<{ Body: { theme?: string } }>("/auth/me/theme", async (req, reply) => {
    if (!req.session.engineer || !req.currentUser) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    const theme = req.body?.theme;
    if (theme !== "light" && theme !== "dark") {
      return reply.code(400).send({ error: "invalid_theme" });
    }

    if (config.DEMO_MODE) {
      const existing = findDemoEngineerByUpn(req.currentUser.upn);
      if (existing) {
        existing.theme = theme;
        existing.updatedAt = new Date().toISOString();
      }
    } else {
      await db
        .update(tables.engineers)
        .set({ theme, updatedAt: new Date() })
        .where(eq(tables.engineers.id, req.currentUser.id));
    }

    return reply.send({ theme });
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
