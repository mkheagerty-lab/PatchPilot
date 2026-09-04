import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { encrypt, sha256Hex, auditSafe } from "@patchpilot/graph";
import { SYSTEM_ACTORS, can, CREDENTIALS_ROTATED_CHANNEL, currentScopeBaseline } from "@patchpilot/shared";
import { config } from "../config.js";
import { connection } from "../queue.js";
import { exitAfterReply } from "../restart-after-reply.js";

/**
 * The pairing flow's two routes, deliberately isolated in their own hook-free
 * plugin rather than folded into routes/onboarding.ts. That file's
 * `onboardingRoutes` installs a blanket `session.engineer` + `settings:read`
 * preHandler hook; Fastify applies a plugin's hooks to every route in its
 * encapsulation context regardless of declaration order, so a route that
 * sometimes (or always) needs to be public cannot share a plugin with those
 * hooks. Both routes here do their own auth check inline instead.
 *
 * POST /api/onboarding/pair is ALWAYS public — a single-use, short-TTL,
 * cryptographically random token is its entire authentication, by design (see
 * the CSRF exemption comment in server.ts). GET /api/onboarding/pairing-script
 * is public only while this instance has never been paired (config.ENTRA_CONFIGURED
 * === false); once paired, issuing a fresh pairing script means re-registering
 * against Entra, which is a deliberate admin action gated on settings:write.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
// Same relative depth from apps/api/src/routes and apps/api/dist/routes to the
// repo root, so this path is correct for both `tsx watch src/index.ts` (dev)
// and `node dist/index.js` (prod) without an env var or build-time copy step.
const DEPLOY_SCRIPT_PATH = join(__dirname, "../../../../scripts/Deploy-PatchPilot.ps1");

const PAIRING_TOKEN_TTL_MS = 30 * 60 * 1000;

const pairBodySchema = z.object({
  token: z.string().min(1),
  clientId: z.string().min(1),
  tenantId: z.string().min(1),
  clientSecret: z.string().min(1),
  // Optional: the UPN Deploy-PatchPilot.ps1 was signed in to Microsoft Graph
  // as when it created the app registration ($context.Account — see the
  // script's Connect-MgGraph section). Lets a fresh pairing self-provision
  // its first admin with no separate manual .env edit + restart, the same
  // "zero manual typing" goal the rest of this flow already has. Optional
  // because older scripts and any non-script pairing caller won't send it.
  // .nullish() (not just .optional()): the script omits this key entirely
  // when it can't determine the UPN (see its own comment on $adminUpn), but
  // this field must never be the reason the WHOLE pairing request 400s —
  // an older/different caller sending an explicit `"adminUpn": null` should
  // degrade to "not provided", not fail credentials that are otherwise
  // valid. Live-observed regression: a device-code Graph sign-in leaves
  // $context.Account empty, which an earlier version of the script sent
  // through verbatim as JSON null, and z.string().min(1).optional() rejects
  // null (it only accepts undefined) — 400ing pairing entirely.
  adminUpn: z.string().min(1).nullish(),
});

export async function onboardingPairingRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/onboarding/pair",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(400).send({ error: "not_available_in_demo_mode" });
      }

      const parsed = pairBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      const body = parsed.data;

      // Single atomic conditional UPDATE: the WHERE clause IS the single-use
      // gate (consumed_at is null, not expired). No separate read-then-write —
      // that would race two concurrent POSTs for the same token.
      const [tokenRow] = await db
        .update(tables.onboardingPairingTokens)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(tables.onboardingPairingTokens.tokenHash, sha256Hex(body.token)),
            isNull(tables.onboardingPairingTokens.consumedAt),
            gt(tables.onboardingPairingTokens.expiresAt, new Date()),
          ),
        )
        .returning();

      if (!tokenRow) {
        // Deliberately generic — expired, already used, and never-existed all
        // look identical from the outside. No oracle for probing.
        return reply.code(400).send({ error: "invalid_or_expired_token" });
      }

      const value = {
        clientId: body.clientId,
        tenantId: body.tenantId,
        clientSecretEncrypted: encrypt(body.clientSecret),
        pairedAt: new Date().toISOString(),
        pairedBy: SYSTEM_ACTORS.onboardingPairing,
      };
      await db
        .insert(tables.settings)
        .values({ key: "entra-app-registration", value })
        .onConflictDoUpdate({
          target: tables.settings.key,
          set: { value, updatedAt: new Date() },
        });

      // Best-effort, additive only: never overwrite an admin UPN a previous
      // pairing (or a manual BOOTSTRAP_ADMIN_UPN in .env) already established.
      // load-env.ts's loadBootstrapAdminUpn() treats an explicit local
      // env/.env value as the operator's own override and leaves it alone —
      // this row is only ever a *fallback* default, so re-pairing (e.g. a
      // client secret rotation) can't silently reassign who bootstraps as
      // admin just because a different person happened to run the script.
      //
      // Shape-checked, not just non-empty: Deploy-PatchPilot.ps1 now filters
      // this itself (see its own comment on $adminUpn), but a live-observed
      // failure mode is worth guarding here too — Get-AzContext's Account.Id
      // came back as the literal string "MSI@50342" (Az PowerShell's
      // placeholder for a Managed Identity login) on at least one Cloud
      // Shell session. Writing that as the sole bootstrap admin
      // (auth/bootstrap.ts) locks the real signed-in admin out entirely,
      // which is worse than leaving this row unwritten.
      if (body.adminUpn && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.adminUpn)) {
        await db
          .insert(tables.settings)
          .values({
            key: "bootstrap-admin",
            value: { upn: body.adminUpn, source: "onboarding-pairing", pairedAt: new Date().toISOString() },
          })
          .onConflictDoNothing({ target: tables.settings.key });
      }

      // Stamps the drift baseline routes/onboarding.ts compares against for
      // "Sync permissions" needed hint. Deploy-PatchPilot.ps1 is only ever
      // reached here after being downloaded live from THIS instance's own
      // /api/onboarding/pairing-script (see that route below), byte-identical
      // to the currently-deployed script — so whatever scopes.ts requests
      // right now is exactly what the script that produced this pairing just
      // requested. Always read-only (false): a fresh/rotated pairing never
      // carries the write-scopes opt-in, which is a "Sync permissions"-only
      // checkbox — see EnableRemediationWriteScopes in the script itself for
      // the equivalent switch on a manual run.
      await db
        .insert(tables.settings)
        .values({ key: "entra-scopes-baseline", value: { includeWriteScopes: false, ...currentScopeBaseline(false) } })
        .onConflictDoUpdate({
          target: tables.settings.key,
          set: { value: { includeWriteScopes: false, ...currentScopeBaseline(false) }, updatedAt: new Date() },
        });

      await auditSafe({
        engineer: SYSTEM_ACTORS.onboardingPairing,
        actorType: "system",
        tenantId: body.tenantId,
        endpoint: "/api/onboarding/pair",
        method: "POST",
        action: "onboarding:paired",
        resourceType: "application",
        resourceId: body.clientId,
        summary: "Instance paired with a customer-supplied Entra app registration",
        outcome: "success",
        responseStatus: 200,
      });

      // Tell every other process (and this one, on its next boot) to pick up
      // the freshly paired credentials. Compose's restart policy brings the
      // process back; load-env.ts reads the settings row we just wrote on the
      // way in.
      await connection.publish(CREDENTIALS_ROTATED_CHANNEL, "paired").catch(() => undefined);

      reply.send({ paired: true });
      exitAfterReply(reply);
    },
  );

  app.get("/api/onboarding/pairing-script", async (req, reply) => {
    if (config.DEMO_MODE) {
      return reply.code(400).send({ error: "not_available_in_demo_mode" });
    }

    // Once paired, re-issuing a personalized installer is an authenticated
    // admin action (rotating/re-registering an existing app registration) —
    // mirrors requirePermission("settings:write") inline, since this plugin
    // has no hooks to hang that on for the still-unpaired (public) case below.
    let issuedBy: string = SYSTEM_ACTORS.onboardingPairing;
    if (config.ENTRA_CONFIGURED) {
      if (!req.currentUser) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      if (!can(req.currentUser.role, "settings:write")) {
        return reply.code(403).send({ error: "forbidden", required: "settings:write" });
      }
      issuedBy = req.currentUser.upn;
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + PAIRING_TOKEN_TTL_MS);
    await db.insert(tables.onboardingPairingTokens).values({
      tokenHash: sha256Hex(token),
      redirectUri: config.AUTH_REDIRECT_URI,
      createdBy: issuedBy,
      expiresAt,
    });

    // Strip a leading UTF-8 BOM defensively (node's readFileSync("utf8") does
    // not do this itself, unlike PowerShell's own .ps1 file loader). A BOM
    // survives harmlessly when this script is downloaded and run as a file,
    // but the Cloud Shell one-liner (irm ... | [scriptblock]::Create(...))
    // feeds the fetched text straight into the parser as a raw string, where
    // the BOM becomes a literal leading character. PowerShell then no longer
    // sees [CmdletBinding()]/param() as the block's first statement — which
    // both attributes require — and fails with a "position sensitive" parse
    // error. Source-of-truth fix is keeping scripts/Deploy-PatchPilot.ps1
    // itself saved without a BOM; this is a defensive backstop in case some
    // future editor resaves it with one.
    const template = readFileSync(DEPLOY_SCRIPT_PATH, "utf8").replace(/^\uFEFF/, "");
    const script = template
      .replace(/\{\{INSTANCE_URL\}\}/g, config.PUBLIC_URL)
      .replace(/\{\{PAIRING_TOKEN\}\}/g, token)
      .replace(/\{\{REDIRECT_URI\}\}/g, config.AUTH_REDIRECT_URI);

    await auditSafe({
      engineer: issuedBy,
      endpoint: "/api/onboarding/pairing-script",
      method: "GET",
      action: "onboarding:pairing-token-issued",
      resourceType: "application",
      summary: `Pairing script downloaded (expires ${expiresAt.toISOString()})`,
      outcome: "success",
      responseStatus: 200,
    });

    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("content-disposition", 'attachment; filename="Deploy-PatchPilot.ps1"')
      .header("cache-control", "no-store, private")
      .send(script);
  });
}
