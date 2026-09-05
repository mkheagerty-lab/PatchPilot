import { z } from "zod";

/**
 * Environment configuration.
 *
 * In DEMO_MODE (the default) the app must boot with NO real secrets, NO
 * database, and NO Microsoft wiring — so the console is instantly runnable for
 * development and demos. Sensitive fields are therefore optional here and given
 * safe local placeholders below.
 *
 * When DEMO_MODE=false (production), the placeholders are rejected: every
 * secret, the database URL, and the Entra app registration MUST be set for real.
 */
const EnvSchema = z.object({
  PUBLIC_URL: z.string().url().default("http://localhost:5173"),
  AUTH_REDIRECT_URI: z.string().url().default("http://localhost:5173/auth/callback"),
  // Comma-separated additional origins (scheme://host[:port], no path) allowed
  // to complete the Entra OAuth round trip — e.g. a cloudflared tunnel
  // hostname used to reach a local dev instance externally. Each one must
  // ALSO be registered as its own Redirect URI (origin + "/auth/callback") in
  // the Entra app registration, or Microsoft rejects the auth request outright.
  // See auth/origin.ts.
  EXTRA_WEB_ORIGINS: z.string().default(""),
  // The zone PatchPilot Support hands out <label>.<this> subdomains from
  // (routes/domains.ts "subdomain" custom-domain type). Not itself a redirect
  // origin — only active rows in the custom_domains table (see load-env.ts)
  // become one.
  PLATFORM_BASE_DOMAIN: z.string().default("patchpilot365.com"),
  // The hostname routes/domains.ts tells admins to CNAME a new custom domain
  // at. Defaults to PUBLIC_URL's own host, which is correct for the normal
  // "one VM, one public hostname" deployment (infra/Caddyfile) — but PUBLIC_URL
  // is routinely something a customer's DNS provider can't target at all
  // (http://localhost:5173 in local dev, or a tunnel/internal hostname in a
  // staging setup). Set this explicitly when PUBLIC_URL's host isn't the
  // instance's real public-facing name — e.g. to a Cloudflare tunnel hostname
  // while iterating locally. See domains.ts's hostIsRoutable() guard, which
  // refuses to hand out a CNAME target that isn't a real DNS name.
  CUSTOM_DOMAIN_CNAME_TARGET: z.string().optional(),
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  // The delegated scope the app exposes on itself ("Expose an API"). Requested at
  // login so the engineer's session token is audience=PatchPilot, which is then
  // used as the OBO assertion. Defaults to api://{clientId}/access_as_user.
  ENTRA_API_SCOPE: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  API_PORT: z.coerce.number().default(4000),
  CORS_ORIGINS: z.string().default(""),
  // How often the API background-syncs reachable customer tenants (devices +
  // vulnerabilities) without an engineer clicking "Sync Data". 0 disables the
  // scheduler. Ignored in DEMO_MODE (the loop never starts). See graph/auto-sync.ts.
  AUTO_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(60),
  // How often the API refreshes the winget package catalog from the public
  // winget mirror (a CDN read; the only writes land in our own winget_catalog).
  // 0 disables the scheduler. Ignored in DEMO_MODE. See catalog/auto-refresh.ts.
  WINGET_REFRESH_INTERVAL_HOURS: z.coerce.number().int().min(0).default(24),
  // Same idea for the Chocolatey community-repository mirror. See
  // catalog/chocolatey-auto-refresh.ts.
  CHOCOLATEY_REFRESH_INTERVAL_HOURS: z.coerce.number().int().min(0).default(24),
  // How often the API records a posture snapshot per tenant — the only source of
  // history the Dashboard trend charts have, since every posture table is
  // current-state. 0 disables it (the trend then only fills from post-sync
  // captures). Ignored in DEMO_MODE. See posture/auto-snapshot.ts.
  POSTURE_SNAPSHOT_INTERVAL_HOURS: z.coerce.number().int().min(0).default(24),
  // How often the API polls GitHub Releases for a newer PatchPilot version
  // (Settings > Updates). 0 disables the scheduler. Deliberately NOT ignored
  // in DEMO_MODE — it's a harmless public read, and "an update is available"
  // is a legitimate thing to show in a demo. See updates/auto-check.ts.
  UPDATE_CHECK_INTERVAL_HOURS: z.coerce.number().int().min(0).default(6),
  // Overridable so tests/local runs can point the version check at a stub
  // JSON server instead of the real, unauthenticated GitHub API.
  GITHUB_RELEASES_URL: z
    .string()
    .url()
    .default("https://api.github.com/repos/mkheagerty-lab/PatchPilot/releases/latest"),
  DEMO_MODE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.string().default("info"),
  // Kill switch for the whole AI feature set (summaries, reports, chatbot).
  // Default off: an operator opts in rather than a fresh deploy silently
  // pulling up a multi-GB Ollama container nobody asked for. Independent of
  // DEMO_MODE — evaluating AI in demo mode, or running production without it,
  // are both legitimate combinations. See packages/ai.
  AI_FEATURES_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Reaches the ollama container by its Compose service name in Docker; the
  // localhost default is for a host-run `pnpm dev` api process talking to the
  // dev compose file's published port. Never a public URL — the model must
  // never be reachable from, or reach out to, anything but this app.
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  // Meta (USA), Llama Community License, reliable native Ollama tool-calling
  // — see AI plan. Chosen over Qwen2.5 (Alibaba/China) for US/AU vendor-trust
  // requirements: this box holds MSP client security data that must never
  // touch a PRC-origin model, self-hosted or not. Swap to llama3.1:70b on
  // beefier hardware for higher quality; no code change needed either way.
  OLLAMA_MODEL: z.string().default("llama3.1:8b"),
  OLLAMA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180_000),
  // How long a generated report is kept before the worker's retention sweep
  // deletes it. Stamped onto `reports.expires_at` at INSERT and never
  // recomputed, so lowering this affects future reports only — an engineer told
  // a report would be kept for 90 days keeps it for 90 days. The worker parses
  // the same variable for its sweep interval; see apps/worker/src/reports.
  REPORT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  // Ceiling on a stored PDF. A branded 8-page report lands at 150-600 KB, so
  // this only ever fires on a runaway render (an unbounded table, a giant
  // embedded logo) — which is exactly the case worth failing loudly rather than
  // writing 200 MB into Postgres. The worker enforces it after page.pdf().
  REPORT_MAX_BYTES: z.coerce.number().int().min(1).default(25 * 1024 * 1024),
  // Seeds/promotes this UPN to an active admin at every startup (see
  // auth/bootstrap.ts). Also the lockout recovery hatch: set it, restart, sign
  // in. Optional even in production — a deployment that already has an admin
  // row doesn't need it, but a fresh one with nothing set gets a loud warning.
  // Normalized here (trim + lower-case) so every consumer gets it pre-cleaned,
  // same as the UPN normalization users.ts applies on write.
  BOOTSTRAP_ADMIN_UPN: z
    .string()
    .trim()
    .toLowerCase()
    .optional(),
});

export interface Config {
  PUBLIC_URL: string;
  AUTH_REDIRECT_URI: string;
  EXTRA_WEB_ORIGINS: string;
  PLATFORM_BASE_DOMAIN: string;
  CUSTOM_DOMAIN_CNAME_TARGET?: string;
  ENTRA_TENANT_ID: string;
  ENTRA_CLIENT_ID: string;
  ENTRA_CLIENT_SECRET: string;
  ENTRA_API_SCOPE: string;
  /**
   * True once a real Entra app registration is in place (env/`.env` or a
   * paired settings row — see load-env.ts), false on a genuinely fresh
   * DEMO_MODE=false instance that has never been paired. A fresh instance
   * MUST still boot in this state — the pairing flow (routes/onboarding-pairing.ts)
   * is the only way it can ever become true, and the server has to be up and
   * listening for that flow to run at all. Engineer login (auth/routes.ts) and
   * every Microsoft-facing call are meaningless while this is false, but they
   * fail at call time (a normal, already-handled error path), not at boot.
   */
  ENTRA_CONFIGURED: boolean;
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  API_PORT: number;
  CORS_ORIGINS: string;
  AUTO_SYNC_INTERVAL_MINUTES: number;
  WINGET_REFRESH_INTERVAL_HOURS: number;
  CHOCOLATEY_REFRESH_INTERVAL_HOURS: number;
  POSTURE_SNAPSHOT_INTERVAL_HOURS: number;
  UPDATE_CHECK_INTERVAL_HOURS: number;
  GITHUB_RELEASES_URL: string;
  DEMO_MODE: boolean;
  LOG_LEVEL: string;
  BOOTSTRAP_ADMIN_UPN?: string;
  AI_FEATURES_ENABLED: boolean;
  OLLAMA_BASE_URL: string;
  OLLAMA_MODEL: string;
  OLLAMA_REQUEST_TIMEOUT_MS: number;
  REPORT_RETENTION_DAYS: number;
  REPORT_MAX_BYTES: number;
}

// Local placeholders used only when DEMO_MODE=true. None of these touch a real
// service: MSAL is never invoked, Postgres/Redis are never queried in demo mode.
const DEMO_DEFAULTS = {
  ENTRA_TENANT_ID: "demo-tenant",
  ENTRA_CLIENT_ID: "demo-client",
  ENTRA_CLIENT_SECRET: "demo-secret",
  SESSION_SECRET: "demo-session-secret-not-for-production",
  TOKEN_ENCRYPTION_KEY: "demo-encryption-key-not-for-production-0",
  DATABASE_URL: "postgres://demo:demo@localhost:5432/demo",
  // Must stay obviously-fake: the production guard rejects any value equal to this
  // placeholder, so a real localhost Redis (redis://localhost:6379) has to differ.
  REDIS_URL: "redis://demo-redis:6379",
} as const;

export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(
      "[config] invalid environment:\n",
      JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
    );
    throw new Error("Invalid environment configuration");
  }
  const env = parsed.data;

  if (env.DEMO_MODE) {
    const clientId = env.ENTRA_CLIENT_ID ?? DEMO_DEFAULTS.ENTRA_CLIENT_ID;
    return {
      ...env,
      ENTRA_TENANT_ID: env.ENTRA_TENANT_ID ?? DEMO_DEFAULTS.ENTRA_TENANT_ID,
      ENTRA_CLIENT_ID: clientId,
      ENTRA_CLIENT_SECRET: env.ENTRA_CLIENT_SECRET ?? DEMO_DEFAULTS.ENTRA_CLIENT_SECRET,
      ENTRA_API_SCOPE: env.ENTRA_API_SCOPE ?? `api://${clientId}/access_as_user`,
      ENTRA_CONFIGURED: true,
      SESSION_SECRET: env.SESSION_SECRET ?? DEMO_DEFAULTS.SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY ?? DEMO_DEFAULTS.TOKEN_ENCRYPTION_KEY,
      DATABASE_URL: env.DATABASE_URL ?? DEMO_DEFAULTS.DATABASE_URL,
      REDIS_URL: env.REDIS_URL ?? DEMO_DEFAULTS.REDIS_URL,
    };
  }

  // Production: require real values for everything EXCEPT the Entra app
  // registration, and reject demo placeholders on whatever IS set.
  //
  // ENTRA_TENANT_ID/CLIENT_ID/CLIENT_SECRET are deliberately not in this list:
  // a hosted SaaS instance boots with none of them, and only gets them later
  // via the pairing flow (routes/onboarding-pairing.ts, load-env.ts). Refusing
  // to boot without them would make that flow unreachable — the pairing route
  // needs a running, listening server to POST credentials to in the first
  // place. See ENTRA_CONFIGURED below and the doc comment on the Config field.
  const required: Array<keyof typeof DEMO_DEFAULTS> = [
    "SESSION_SECRET",
    "TOKEN_ENCRYPTION_KEY",
    "DATABASE_URL",
    "REDIS_URL",
  ];
  const problems: string[] = [];
  for (const k of required) {
    const v = env[k];
    if (!v) problems.push(`${k} is required when DEMO_MODE=false`);
    else if (v === DEMO_DEFAULTS[k]) problems.push(`${k} still uses the demo placeholder`);
  }
  // Entra fields are optional, but if any is set they must ALL be set (a
  // half-configured registration is a config bug, not an unpaired instance),
  // and none may be the demo placeholder.
  //
  // TEMPLATE_PLACEHOLDERS below are .env.example's old non-blank defaults
  // (00000000-... GUIDs, "replace-me") from before it shipped these fields
  // blank. Treated as unset rather than a hard config error — unlike the
  // DEMO_DEFAULTS check above, an unpaired instance booting successfully
  // into the pairing screen IS the correct behavior, not a problem to reject.
  // This also self-heals any instance whose .env still has these values from
  // its first boot (cloud-init copies .env.example once and never touches
  // these fields again — see cloud-init.yaml) without requiring anyone to
  // hand-edit .env.
  const entraFields = ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET"] as const;
  const TEMPLATE_PLACEHOLDERS: Record<(typeof entraFields)[number], string> = {
    ENTRA_TENANT_ID: "00000000-0000-0000-0000-000000000000",
    ENTRA_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
    ENTRA_CLIENT_SECRET: "replace-me",
  };
  const entraSetCount = entraFields.filter(
    (k) => env[k] && env[k] !== TEMPLATE_PLACEHOLDERS[k],
  ).length;
  if (entraSetCount > 0 && entraSetCount < entraFields.length) {
    problems.push("ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET must be set together, or not at all");
  }
  for (const k of entraFields) {
    if (env[k] && env[k] === DEMO_DEFAULTS[k]) problems.push(`${k} still uses the demo placeholder`);
  }
  if ((env.SESSION_SECRET?.length ?? 0) < 16) problems.push("SESSION_SECRET must be >= 16 chars");
  if ((env.TOKEN_ENCRYPTION_KEY?.length ?? 0) < 16) problems.push("TOKEN_ENCRYPTION_KEY must be >= 16 chars");
  if (problems.length) {
    console.error("[config] production configuration errors:\n - " + problems.join("\n - "));
    throw new Error("Invalid production configuration");
  }

  const entraConfigured = entraSetCount === entraFields.length;
  return {
    ...(env as Config),
    ENTRA_TENANT_ID: env.ENTRA_TENANT_ID ?? "",
    ENTRA_CLIENT_ID: env.ENTRA_CLIENT_ID ?? "",
    ENTRA_CLIENT_SECRET: env.ENTRA_CLIENT_SECRET ?? "",
    ENTRA_API_SCOPE: env.ENTRA_API_SCOPE ?? `api://${env.ENTRA_CLIENT_ID ?? ""}/access_as_user`,
    ENTRA_CONFIGURED: entraConfigured,
  };
}

export const config = loadConfig();

export const corsOrigins = config.CORS_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// PUBLIC_URL plus every EXTRA_WEB_ORIGINS entry, normalized (no trailing
// slash) so an exact match against `${proto}://${host}` works — see
// auth/origin.ts's resolveWebOrigin, the only consumer of this list.
export const webOrigins = [config.PUBLIC_URL, ...config.EXTRA_WEB_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)].map(
  (o) => o.replace(/\/+$/, ""),
);
