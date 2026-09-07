import type { FastifyInstance } from "fastify";
import { db, tables } from "@patchpilot/db";
import { auditSafe } from "@patchpilot/graph";
import { SYSTEM_ACTORS, CREDENTIALS_ROTATED_CHANNEL } from "@patchpilot/shared";
import { config } from "../config.js";
import { connection } from "../queue.js";
import { exitAfterReply } from "../restart-after-reply.js";

/**
 * The Pairing Page's other option: instead of connecting a real Microsoft
 * 365 tenant, flip this fresh, unpaired instance into DEMO_MODE so it can be
 * clicked through with fictional sample data — see
 * apps/web/src/pages/setup/SetupPairing.tsx.
 *
 * Deliberately its own file, not folded into onboarding-pairing.ts: same
 * "no session yet" public-route shape (see that file's own top-of-file
 * comment for why a route like this can't share a plugin with
 * routes/onboarding.ts's blanket auth hooks), but a different resource
 * entirely — this never touches the `entra-app-registration` settings row,
 * and unlike /pair it needs no request body or single-use token at all: an
 * unpaired instance has nothing worth protecting yet, and the only thing
 * this route can ever do is turn ITSELF into a harmless sandbox with no
 * real tenant data reachable from it.
 *
 * Gated on `!config.ENTRA_CONFIGURED` — the exact condition under which
 * <SetupPairing> is the only thing an unauthenticated visitor can reach in
 * the first place (see lib/auth.tsx's AuthGate). Once paired for real, or
 * once already in demo mode (config.ts:218 forces ENTRA_CONFIGURED=true
 * whenever DEMO_MODE=true), this 400s — there is no in-app way back out of
 * demo mode today, matching pairing's own one-way nature.
 */
export async function onboardingDemoModeRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/onboarding/enable-demo-mode",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (config.ENTRA_CONFIGURED) {
        return reply.code(400).send({ error: "already_configured" });
      }

      const value = { enabled: true, enabledAt: new Date().toISOString(), enabledBy: SYSTEM_ACTORS.onboardingDemoMode };
      await db
        .insert(tables.settings)
        .values({ key: "demo-mode-enabled", value })
        .onConflictDoUpdate({
          target: tables.settings.key,
          set: { value, updatedAt: new Date() },
        });

      await auditSafe({
        engineer: SYSTEM_ACTORS.onboardingDemoMode,
        actorType: "system",
        endpoint: "/api/onboarding/enable-demo-mode",
        method: "POST",
        action: "onboarding:demo-mode-enabled",
        resourceType: "application",
        summary: "Instance switched into demo mode from the pairing screen",
        outcome: "success",
        responseStatus: 200,
      });

      // Same restart signal the pairing flow publishes on a real pairing —
      // any other process sharing this Redis instance restarts too, and
      // this process's own restart-after-reply below picks the flag straight
      // out of the DB on its next boot (see load-env.ts's
      // loadDemoModeOverride).
      await connection.publish(CREDENTIALS_ROTATED_CHANNEL, "demo-mode-enabled").catch(() => undefined);

      reply.send({ enabled: true });
      exitAfterReply(reply);
    },
  );
}
