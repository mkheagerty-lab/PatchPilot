import nodemailer, { type Transporter } from "nodemailer";
import { z } from "zod";

/**
 * Best-effort email alerting for unattended failures (job crashes, sync
 * outages, uncaught exceptions) — closes the pre-ship review's highest-leverage
 * gap, where a failed 2am patch job previously surfaced only if someone opened
 * the Dashboard. Deliberately plain SMTP via nodemailer rather than a
 * third-party alerting dashboard, per this project's own no-third-party-tool
 * decision.
 *
 * Lives in packages/shared rather than apps/api/src/config.ts because
 * apps/worker does not import that file at all — both processes need this
 * independently. This module cannot import @patchpilot/db directly (db
 * depends on shared, not the other way round), so where the config actually
 * comes from is injected: each app calls `configureAlerting()` once at
 * startup with a resolver that reads its own DB-backed settings (see
 * apps/api/src/index.ts and apps/worker/src/index.ts). Unconfigured — no
 * resolver registered, or the resolver returns null (relay disabled, or no
 * engineer has opted in) — is a supported, silent no-op so a bare `pnpm dev`
 * never fails for lack of SMTP credentials.
 *
 * SMTP_* env vars are kept as a fallback beneath the resolver, purely so
 * apps/worker's and apps/api's own unit tests (which never call
 * configureAlerting) can still exercise a configured path.
 */

const AlertEnvSchema = z.object({
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  SMTP_FROM: z.string().min(1).optional(),
  ALERT_EMAIL_TO: z.string().min(1).optional(),
});

export interface AlertConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  secure: boolean;
  from: string;
  to: string[];
}

export type AlertConfigResolver = () => Promise<AlertConfig | null>;

let configResolver: AlertConfigResolver | null = null;

/** Called once at startup by each app — see the module doc above. */
export function configureAlerting(resolver: AlertConfigResolver): void {
  configResolver = resolver;
}

function resolveFromEnv(): AlertConfig | null {
  // Re-read process.env on every call (not cached at module load) so tests
  // that mutate env after import still take effect.
  const parsed = AlertEnvSchema.safeParse(process.env);
  const env: Partial<z.infer<typeof AlertEnvSchema>> = parsed.success ? parsed.data : {};
  if (!env.SMTP_HOST || !env.ALERT_EMAIL_TO) return null;

  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    secure: env.SMTP_SECURE ?? false,
    from: env.SMTP_FROM || env.SMTP_USER || "patchpilot@localhost",
    to: env.ALERT_EMAIL_TO.split(",")
      .map((addr) => addr.trim())
      .filter(Boolean),
  };
}

async function resolveConfig(): Promise<AlertConfig | null> {
  if (configResolver) {
    try {
      return await configResolver();
    } catch (err) {
      console.error("[alerting] config resolver threw:", err);
      return null;
    }
  }
  return resolveFromEnv();
}

/** Lets startup logs note once whether alerting is live, instead of every unconfigured send silently doing nothing. */
export async function isAlertingConfigured(): Promise<boolean> {
  return (await resolveConfig()) !== null;
}

let transport: Transporter | undefined;
// Keyed by the fields that actually change the connection — `to` varies
// with who's currently opted in and must not force a transport rebuild.
let transportKey: string | undefined;

function getTransport(config: AlertConfig): Transporter {
  const key = JSON.stringify({
    host: config.host,
    port: config.port,
    user: config.user,
    pass: config.pass,
    secure: config.secure,
  });
  if (transport && transportKey === key) return transport;
  transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
  });
  transportKey = key;
  return transport;
}

// A crash-looping worker would otherwise send one email per failure, flooding
// the inbox (and likely tripping the SMTP relay's own rate limit). Dedup is
// per-process and in-memory: each api/worker instance only needs to ping once
// per distinct failure per window, not coordinate with its siblings.
const COOLDOWN_MS = 15 * 60_000;
const lastSentAt = new Map<string, number>();

export type AlertSource = "api" | "worker";

export interface SendAlertEmailOptions {
  /** Dedup key — a repeat of the same key within the cooldown window is dropped. */
  key: string;
  subject: string;
  body: string;
}

/**
 * Sends a failure alert email. Never rejects — an alerting outage must not
 * become a second incident on top of the one it's trying to report. Returns a
 * promise only so callers that need the send to finish before exiting (e.g. an
 * uncaughtException handler about to call process.exit) can await it; every
 * other call site can leave it unawaited.
 */
export async function sendAlertEmail(source: AlertSource, opts: SendAlertEmailOptions): Promise<void> {
  const config = await resolveConfig();
  if (!config || config.to.length === 0) return;

  const now = Date.now();
  const last = lastSentAt.get(opts.key);
  if (last !== undefined && now - last < COOLDOWN_MS) return;
  lastSentAt.set(opts.key, now);

  return getTransport(config)
    .sendMail({
      from: config.from,
      to: config.to,
      subject: `[PatchPilot/${source}] ${opts.subject}`,
      text: opts.body,
    })
    .then(() => undefined)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[alerting] failed to send alert email (${opts.key}):`, message);
    });
}
