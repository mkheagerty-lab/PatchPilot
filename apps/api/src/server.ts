import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config, corsOrigins } from "./config.js";
import { redisSessionStore } from "./session-store.js";
import { authRoutes } from "./auth/routes.js";
import { resolveCurrentUser } from "./auth/current-user.js";
import { bootstrapAdmin } from "./auth/bootstrap.js";
import { dataRoutes } from "./routes/data.js";
import { statusRoutes } from "./routes/status.js";
import { catalogRoutes } from "./routes/catalog.js";
import { chocolateyCatalogRoutes } from "./routes/chocolatey-catalog.js";
import { readinessRoutes } from "./routes/readiness.js";
import { licensingRoutes } from "./routes/licensing.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { onboardingPairingRoutes } from "./routes/onboarding-pairing.js";
import { preflightRoutes } from "./routes/preflight.js";
import { jobsRoutes } from "./routes/jobs.js";
import { schedulesRoutes } from "./routes/schedules.js";
import { syncRoutes } from "./routes/sync.js";
import { softwareInventoryRoutes } from "./routes/software-inventory.js";
import { manualRemediationsRoutes } from "./routes/manual-remediations.js";
import { scriptCatalogRoutes } from "./routes/script-catalog.js";
import { missingKbRoutes } from "./routes/missing-kbs.js";
import { recommendationsRoutes } from "./routes/recommendations.js";
import { deviceExclusionsRoutes } from "./routes/device-exclusions.js";
import { deviceGroupsRoutes } from "./routes/device-groups.js";
import { auditRoutes } from "./routes/audit.js";
import { remediationHistoryRoutes } from "./routes/remediation-history.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { reportsRoutes } from "./routes/reports.js";
import { usersRoutes } from "./routes/users.js";
import { notificationSettingsRoutes } from "./routes/notification-settings.js";
import { entitlementSettingsRoutes } from "./routes/entitlement-settings.js";
import { aiRoutes } from "./routes/ai.js";
import { intuneAppsRoutes } from "./routes/intune-apps.js";
import { storeAppsRoutes } from "./routes/store-apps.js";
import { featureUpdatesRoutes } from "./routes/feature-updates.js";
import { qualityUpdatesRoutes } from "./routes/quality-updates.js";
import { updateRingsRoutes } from "./routes/update-rings.js";
import { driverUpdatesRoutes } from "./routes/driver-updates.js";
import { windowsUpdatesRoutes } from "./routes/windows-updates.js";
import { groupsRoutes } from "./routes/groups.js";
import { sendAlertEmail } from "@patchpilot/shared/alerting";

export async function buildServer() {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
  });

  // Fastify's default handler already logs and replies; this only adds an
  // alert for genuine unexpected 5xx (a route that validated its input and
  // still threw) — a 4xx is a client mistake, not an operational failure
  // worth waking anyone up over.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const statusCode = err.statusCode ?? 500;
    const routePath = req.routeOptions.url ?? req.url;
    if (statusCode >= 500) {
      void sendAlertEmail("api", {
        key: `route-error:${req.method}:${routePath}`,
        subject: `API error: ${req.method} ${routePath}`,
        body: err.stack ?? err.message,
      });
    }
    reply.send(err);
  });

  await app.register(cors, {
    origin: corsOrigins.length ? corsOrigins : true,
    credentials: true,
  });

  // Registered globally-off: this app has had no inbound rate limiting at all
  // until now. The only route that opts in is POST /api/onboarding/pair (see
  // routes/onboarding-pairing.ts) — the one genuinely unauthenticated POST in
  // the app, where a short-TTL random token is the only barrier to guessing.
  await app.register(rateLimit, { global: false });
  await app.register(cookie);
  await app.register(session, {
    secret: config.SESSION_SECRET,
    cookie: {
      secure: config.PUBLIC_URL.startsWith("https://"),
      httpOnly: true,
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000, // 8h engineer shift
    },
    // DEMO_MODE keeps the plugin's default in-memory store so a demo boot
    // touches no Redis at all (see config.ts's DEMO_MODE contract); every
    // other mode is Redis-backed so sessions survive an api restart and are
    // shared across processes. See session-store.ts.
    store: config.DEMO_MODE ? undefined : redisSessionStore,
  });

  // DEMO_MODE: inject a demo engineer on every request so the console is
  // fully usable with no Entra login. This bypass is gated strictly on
  // config.DEMO_MODE and can never run in production (DEMO_MODE=false).
  if (config.DEMO_MODE) {
    app.log.warn("DEMO_MODE is ON — auth is bypassed and data is served from in-memory fixtures. Do NOT use in production.");
    app.addHook("preHandler", async (req) => {
      if (!req.session.engineer) {
        req.session.engineer = {
          upn: "demo.engineer@blackiron.example",
          displayName: "Demo Engineer",
          homeTenantId: "msp-root",
        };
      }
    });
  }

  // Resolve session -> PatchPilot role on every request, before any route
  // plugin runs. See auth/current-user.ts for why this isn't part of the
  // session cookie itself.
  app.addHook("preHandler", resolveCurrentUser);

  // CSRF (double-submit token): every mutating request must echo, in a
  // header, the token GET /auth/me handed the frontend for this session (see
  // auth/routes.ts). SameSite=Lax already stops the session cookie riding
  // along on a cross-site fetch/XHR, but it still attaches on a cross-site
  // top-level GET navigation — this header check closes the rest of the gap
  // for POST/PUT/PATCH/DELETE, which a cross-origin page has no way to read
  // the token to reproduce. Skipped for safe methods (nothing to protect)
  // and for DEMO_MODE, which has no real session or Microsoft-backed
  // identity to forge in the first place.
  if (!config.DEMO_MODE) {
    const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
    // The one deliberate exception: POST /api/onboarding/pair has no session
    // to carry a CSRF token in the first place (it's the route a genuinely
    // fresh, never-paired instance uses to receive its Entra credentials —
    // see routes/onboarding-pairing.ts). Its actual authentication is a
    // single-use, 30-minute-TTL, cryptographically random token in the body,
    // which is a stronger guarantee than the double-submit cookie this hook
    // otherwise enforces.
    const CSRF_EXEMPT_PATHS = new Set(["/api/onboarding/pair"]);
    app.addHook("preHandler", async (req, reply) => {
      if (CSRF_SAFE_METHODS.has(req.method)) return;
      if (CSRF_EXEMPT_PATHS.has(req.routeOptions.url ?? req.url)) return;
      const expected = req.session.csrfToken;
      const provided = req.headers["x-csrf-token"];
      if (!expected || provided !== expected) {
        return reply.code(403).send({ error: "csrf_token_mismatch" });
      }
    });
  }

  // Idempotent: provisions/restores BOOTSTRAP_ADMIN_UPN as an active admin.
  // No-op in DEMO_MODE. Awaited so the very first request never races it.
  await bootstrapAdmin(app.log);

  await app.register(authRoutes);
  await app.register(statusRoutes);
  await app.register(dataRoutes);
  await app.register(catalogRoutes);
  await app.register(chocolateyCatalogRoutes);
  await app.register(readinessRoutes);
  await app.register(licensingRoutes);
  await app.register(onboardingRoutes);
  await app.register(onboardingPairingRoutes);
  await app.register(preflightRoutes);
  await app.register(jobsRoutes);
  await app.register(schedulesRoutes);
  await app.register(syncRoutes);
  await app.register(softwareInventoryRoutes);
  await app.register(manualRemediationsRoutes);
  await app.register(scriptCatalogRoutes);
  await app.register(missingKbRoutes);
  await app.register(recommendationsRoutes);
  await app.register(deviceExclusionsRoutes);
  await app.register(deviceGroupsRoutes);
  await app.register(auditRoutes);
  await app.register(remediationHistoryRoutes);
  await app.register(dashboardRoutes);
  await app.register(reportsRoutes);
  await app.register(usersRoutes);
  await app.register(notificationSettingsRoutes);
  await app.register(entitlementSettingsRoutes);
  await app.register(aiRoutes);
  await app.register(intuneAppsRoutes);
  await app.register(storeAppsRoutes);
  await app.register(featureUpdatesRoutes);
  await app.register(qualityUpdatesRoutes);
  await app.register(updateRingsRoutes);
  await app.register(driverUpdatesRoutes);
  await app.register(windowsUpdatesRoutes);
  await app.register(groupsRoutes);

  return app;
}
