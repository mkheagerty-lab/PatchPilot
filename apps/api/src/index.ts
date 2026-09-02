import "./load-env.js"; // MUST be first: populates process.env from the root .env before config is read.
import { sendAlertEmail } from "@patchpilot/shared/alerting";
import { CREDENTIALS_ROTATED_CHANNEL } from "@patchpilot/shared";
import { buildServer } from "./server.js";
import { config } from "./config.js";
import { connection } from "./queue.js";
import { startAutoSync } from "./graph/auto-sync.js";
import { startCatalogRefresh } from "./catalog/auto-refresh.js";
import { startChocolateyCatalogRefresh } from "./catalog/chocolatey-auto-refresh.js";
import { startPostureSnapshots } from "./posture/auto-snapshot.js";
import { registerAlertingResolver } from "./alerting-config.js";

registerAlertingResolver();

// A crash past this point should alert-then-exit rather than keep serving
// requests in an unknown state (Node's own guidance on uncaughtException),
// and the process manager is what restarts it. sendAlertEmail is awaited here
// specifically so the email has a chance to leave before the process exits.
process.on("uncaughtException", (err) => {
  console.error("[api] uncaughtException:", err);
  void sendAlertEmail("api", {
    key: "uncaughtException",
    subject: "Uncaught exception — API exiting",
    body: `${err.stack ?? err.message}\n\nThe API process is exiting; it should be restarted by its process manager.`,
  }).finally(() => process.exit(1));
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error("[api] unhandledRejection:", err);
  void sendAlertEmail("api", {
    key: "unhandledRejection",
    subject: "Unhandled promise rejection — API exiting",
    body: `${err.stack ?? err.message}\n\nThe API process is exiting; it should be restarted by its process manager.`,
  }).finally(() => process.exit(1));
});

const app = await buildServer();

try {
  await app.listen({ host: "0.0.0.0", port: config.API_PORT });
  app.log.info(`PatchPilot API listening on :${config.API_PORT} (demoMode=${config.DEMO_MODE})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Background auto-sync of reachable customer tenants. No-op in DEMO_MODE or when
// AUTO_SYNC_INTERVAL_MINUTES=0; otherwise it mints each consented engineer's
// delegated customer-tenant tokens (no live session needed) and refreshes data.
const stopAutoSync = startAutoSync();

// Background winget catalog refresh. No-op in DEMO_MODE or when
// WINGET_REFRESH_INTERVAL_HOURS=0; otherwise it periodically pulls the public
// winget source mirror and upserts winget_catalog (a CDN read, no tenant).
const stopCatalogRefresh = startCatalogRefresh();

// Background Chocolatey catalog refresh — same shape, targeting the
// Chocolatey community repository instead of the winget mirror.
const stopChocolateyCatalogRefresh = startChocolateyCatalogRefresh();

// Daily posture snapshot per tenant — the only history the Dashboard trend
// charts have, since every posture table is current-state. No-op in DEMO_MODE
// (the demo trend is a fixture) or when POSTURE_SNAPSHOT_INTERVAL_HOURS=0.
const stopPostureSnapshots = startPostureSnapshots();

// Restart on pairing: POST /api/onboarding/pair (routes/onboarding-pairing.ts)
// publishes here once it has stored a fresh Entra app registration, so this
// process (which may not be the one that served that request) picks up the
// new credentials via load-env.ts on its next boot instead of waiting for an
// unrelated restart. A dedicated duplicate() connection is required — once a
// client calls .subscribe() it enters subscriber mode and can no longer issue
// the ordinary commands `connection` also backs (BullMQ's queues). Skipped in
// DEMO_MODE, which never pairs and must touch no Redis at all (see queue.ts).
if (!config.DEMO_MODE) {
  const credentialsSubscriber = connection.duplicate();
  credentialsSubscriber.on("error", (err) =>
    console.error("[api] credentials subscriber error:", err.message),
  );
  await credentialsSubscriber.subscribe(CREDENTIALS_ROTATED_CHANNEL);
  credentialsSubscriber.on("message", (channel) => {
    if (channel !== CREDENTIALS_ROTATED_CHANNEL) return;
    app.log.info("credentials rotated — exiting so the process manager restarts us with them");
    process.exit(0);
  });
}

// Graceful shutdown: stop the scheduler timer, then close Fastify so in-flight
// requests drain before the process exits.
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} received — shutting down`);
    stopAutoSync();
    stopCatalogRefresh();
    stopChocolateyCatalogRefresh();
    stopPostureSnapshots();
    app
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error(err);
        process.exit(1);
      });
  });
}
