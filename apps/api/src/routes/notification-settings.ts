import nodemailer from "nodemailer";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, tables, eq } from "@patchpilot/db";
import { audit, encrypt, decrypt } from "@patchpilot/graph";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import { demoSettings } from "./settings-store.js";

/**
 * Settings -> Notifications: the admin-configurable SMTP relay that backs
 * job/sync failure alerts (see packages/shared/src/alerting.ts). A dedicated
 * route rather than the generic `/api/settings/:key` in data.ts because the
 * relay password needs encryption at rest and must never round-trip to the
 * client in cleartext — logic the generic route doesn't have. find-my-way
 * (Fastify's router) matches this static path ahead of the generic
 * parameterized one, so both coexist safely.
 *
 * Whether alerts actually go out to a given engineer is a separate opt-in on
 * their own row (`engineers.receive_job_alerts`, see routes/users.ts) — this
 * page only configures the relay itself, which is entirely optional: leaving
 * it disabled (the default) makes alerting a permanent no-op, same as an
 * unconfigured SMTP_HOST env var before this feature existed.
 */

const SETTINGS_KEY = "smtp";

interface SmtpSettingsStored {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  passEncrypted: string | null;
  secure: boolean;
  from: string;
}

interface SmtpSettingsPublic {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  hasPassword: boolean;
  secure: boolean;
  from: string;
}

const DEFAULTS: SmtpSettingsStored = {
  enabled: false,
  host: "",
  port: 587,
  user: "",
  passEncrypted: null,
  secure: false,
  from: "",
};

function toPublic(stored: SmtpSettingsStored): SmtpSettingsPublic {
  return {
    enabled: stored.enabled,
    host: stored.host,
    port: stored.port,
    user: stored.user,
    hasPassword: stored.passEncrypted !== null,
    secure: stored.secure,
    from: stored.from,
  };
}

const putBodySchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().max(255),
  port: z.coerce.number().int().positive().max(65535),
  user: z.string().trim().max(255),
  // Blank/omitted = keep the existing stored password. The GET response never
  // returns the real password, so "leave blank to keep it" is the only way to
  // edit the other fields without re-entering credentials every time.
  pass: z.string().max(500).optional(),
  secure: z.boolean(),
  from: z.string().trim().max(255),
});

const testBodySchema = putBodySchema.extend({
  testRecipient: z.string().trim().email(),
});

async function loadStored(): Promise<SmtpSettingsStored> {
  if (config.DEMO_MODE) {
    return { ...DEFAULTS, ...(demoSettings[SETTINGS_KEY] as Partial<SmtpSettingsStored> | undefined) };
  }
  const [row] = await db.select().from(tables.settings).where(eq(tables.settings.key, SETTINGS_KEY));
  return { ...DEFAULTS, ...((row?.value as Partial<SmtpSettingsStored> | undefined) ?? {}) };
}

async function saveStored(next: SmtpSettingsStored): Promise<void> {
  const value = next as unknown as Record<string, unknown>;
  if (config.DEMO_MODE) {
    demoSettings[SETTINGS_KEY] = value;
    return;
  }
  await db
    .insert(tables.settings)
    .values({ key: SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: tables.settings.key, set: { value, updatedAt: new Date() } });
}

export async function notificationSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("settings:read"));

  app.get("/api/settings/smtp", async () => {
    return toPublic(await loadStored());
  });

  app.put(
    "/api/settings/smtp",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      const parsed = putBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      const body = parsed.data;
      const existing = await loadStored();
      const next: SmtpSettingsStored = {
        enabled: body.enabled,
        host: body.host,
        port: body.port,
        user: body.user,
        passEncrypted: body.pass ? encrypt(body.pass) : existing.passEncrypted,
        secure: body.secure,
        from: body.from,
      };
      await saveStored(next);

      // Payload is hashed, never stored raw (see audit()/payloadHash), so the
      // password can be included safely — only its hash contributes to the
      // stored audit row.
      await audit({
        engineer: req.session.engineer!.upn,
        endpoint: "/api/settings/smtp",
        method: "PUT",
        action: "setting:update",
        resourceType: "setting",
        resourceId: SETTINGS_KEY,
        resourceLabel: SETTINGS_KEY,
        summary: `Updated the SMTP relay settings (now ${next.enabled ? "enabled" : "disabled"})`,
        outcome: "success",
        payload: body,
        responseStatus: 200,
      });

      return toPublic(next);
    },
  );

  app.post(
    "/api/settings/smtp/test",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      const parsed = testBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      const body = parsed.data;
      if (!body.host) {
        return reply.code(400).send({ error: "host is required to send a test email" });
      }

      // Lets an admin test unsaved edits, and also test right after saving
      // without retyping a password that's already encrypted at rest.
      const existing = await loadStored();
      const pass = body.pass || (existing.passEncrypted ? decrypt(existing.passEncrypted) : undefined);

      const transport = nodemailer.createTransport({
        host: body.host,
        port: body.port,
        secure: body.secure,
        auth: body.user && pass ? { user: body.user, pass } : undefined,
      });

      try {
        await transport.sendMail({
          from: body.from || body.user || "patchpilot@localhost",
          to: body.testRecipient,
          subject: "[PatchPilot] Test alert email",
          text: "This is a test email from PatchPilot's Settings > Notifications page. If you received this, your SMTP relay settings are working.",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: `Could not send test email: ${message}` });
      }

      return { sent: true };
    },
  );
}
