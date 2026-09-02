import { z } from "zod";

/**
 * Slim environment reader for the shared graph/auth layer.
 *
 * Both `apps/api` (which has its own richer `config.ts`) and `apps/worker` (which
 * has no config module at all) import this package, so the Microsoft-API plumbing
 * needs its own minimal view of the environment. It reads the SAME `process.env`
 * and MUST keep its demo defaults and production guard identical to
 * apps/api/src/config.ts to avoid drift — only the field set is narrower (just
 * what auth + the Graph/Defender client need).
 */
const EnvSchema = z.object({
  AUTH_REDIRECT_URI: z.string().url().default("http://localhost:5173/auth/callback"),
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  ENTRA_API_SCOPE: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  REDIS_URL: z.string().optional(),
  DEMO_MODE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export interface GraphEnv {
  AUTH_REDIRECT_URI: string;
  ENTRA_TENANT_ID: string;
  ENTRA_CLIENT_ID: string;
  ENTRA_CLIENT_SECRET: string;
  ENTRA_API_SCOPE: string;
  TOKEN_ENCRYPTION_KEY: string;
  REDIS_URL: string;
  DEMO_MODE: boolean;
  /** See the identically-named field on apps/api/src/config.ts's Config — kept
   * in lockstep for the same reason the rest of this file is. */
  ENTRA_CONFIGURED: boolean;
}

// Identical to apps/api/src/config.ts DEMO_DEFAULTS for the overlapping fields —
// keep these in lockstep so the two env readers never disagree in demo mode.
const DEMO_DEFAULTS = {
  ENTRA_TENANT_ID: "demo-tenant",
  ENTRA_CLIENT_ID: "demo-client",
  ENTRA_CLIENT_SECRET: "demo-secret",
  TOKEN_ENCRYPTION_KEY: "demo-encryption-key-not-for-production-0",
  REDIS_URL: "redis://demo-redis:6379",
} as const;

function loadEnv(): GraphEnv {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(
      "[graph-env] invalid environment:\n",
      JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
    );
    throw new Error("Invalid environment configuration");
  }
  const env = parsed.data;

  if (env.DEMO_MODE) {
    const clientId = env.ENTRA_CLIENT_ID ?? DEMO_DEFAULTS.ENTRA_CLIENT_ID;
    return {
      AUTH_REDIRECT_URI: env.AUTH_REDIRECT_URI,
      ENTRA_TENANT_ID: env.ENTRA_TENANT_ID ?? DEMO_DEFAULTS.ENTRA_TENANT_ID,
      ENTRA_CLIENT_ID: clientId,
      ENTRA_CLIENT_SECRET: env.ENTRA_CLIENT_SECRET ?? DEMO_DEFAULTS.ENTRA_CLIENT_SECRET,
      ENTRA_API_SCOPE: env.ENTRA_API_SCOPE ?? `api://${clientId}/access_as_user`,
      TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY ?? DEMO_DEFAULTS.TOKEN_ENCRYPTION_KEY,
      REDIS_URL: env.REDIS_URL ?? DEMO_DEFAULTS.REDIS_URL,
      DEMO_MODE: true,
      ENTRA_CONFIGURED: true,
    };
  }

  // Production: require real values, reject demo placeholders. ENTRA_* is the
  // one exception — see the matching comment in apps/api/src/config.ts. A
  // fresh, never-paired instance boots with these blank and ENTRA_CONFIGURED
  // false; every Microsoft-facing call in this package already hard-blocks in
  // DEMO_MODE, and callers must check ENTRA_CONFIGURED the same way outside it.
  const required: Array<keyof typeof DEMO_DEFAULTS> = ["TOKEN_ENCRYPTION_KEY", "REDIS_URL"];
  const problems: string[] = [];
  for (const k of required) {
    const v = env[k];
    if (!v) problems.push(`${k} is required when DEMO_MODE=false`);
    else if (v === DEMO_DEFAULTS[k]) problems.push(`${k} still uses the demo placeholder`);
  }
  const entraFields = ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET"] as const;
  const entraSetCount = entraFields.filter((k) => env[k]).length;
  if (entraSetCount > 0 && entraSetCount < entraFields.length) {
    problems.push("ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET must be set together, or not at all");
  }
  for (const k of entraFields) {
    if (env[k] && env[k] === DEMO_DEFAULTS[k]) problems.push(`${k} still uses the demo placeholder`);
  }
  if ((env.TOKEN_ENCRYPTION_KEY?.length ?? 0) < 16) {
    problems.push("TOKEN_ENCRYPTION_KEY must be >= 16 chars");
  }
  if (problems.length) {
    console.error("[graph-env] production configuration errors:\n - " + problems.join("\n - "));
    throw new Error("Invalid production configuration");
  }

  return {
    AUTH_REDIRECT_URI: env.AUTH_REDIRECT_URI,
    ENTRA_TENANT_ID: env.ENTRA_TENANT_ID ?? "",
    ENTRA_CLIENT_ID: env.ENTRA_CLIENT_ID ?? "",
    ENTRA_CLIENT_SECRET: env.ENTRA_CLIENT_SECRET ?? "",
    ENTRA_API_SCOPE: env.ENTRA_API_SCOPE ?? `api://${env.ENTRA_CLIENT_ID ?? ""}/access_as_user`,
    TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY!,
    REDIS_URL: env.REDIS_URL!,
    DEMO_MODE: false,
    ENTRA_CONFIGURED: entraSetCount === entraFields.length,
  };
}

export const env = loadEnv();
