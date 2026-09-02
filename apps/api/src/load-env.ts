import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createDecipheriv, createHash } from "node:crypto";

/**
 * Loads the repo-root `.env` into process.env BEFORE any config is read.
 *
 * Host dev (`pnpm dev`) runs each app with its own cwd and injects no
 * environment, so without this the root `.env` is never seen and the app
 * silently falls back to DEMO_MODE. Docker Compose injects env directly (and the
 * file may be absent in the container), hence the existence guard. Node does not
 * overwrite already-set vars, so shell/Compose values take precedence over the
 * file. Import this FIRST in the process entrypoint, before `./config.js`.
 *
 * Also injects a paired Entra app registration if one exists (see
 * routes/onboarding-pairing.ts) — this is what lets a hosted instance with no
 * filesystem access to the customer's box receive its Entra credentials over
 * the "phone home" pairing flow instead of a local `.env` write. Precedence:
 * paired DB row > ENTRA_* env/`.env` values > config.ts's demo placeholders.
 */
function loadRootEnv(): void {
  let dir = process.cwd();
  // Walk up to the workspace root (marked by pnpm-workspace.yaml), then load its .env.
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      const envPath = join(dir, ".env");
      if (existsSync(envPath)) {
        (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(envPath);
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

loadRootEnv();

// AES-256-GCM decrypt, duplicated from packages/graph/src/crypto.ts (must stay
// byte-compatible with its encrypt()) rather than imported: that package's
// env.ts validates ENTRA_* eagerly at import time and would throw on a freshly
// paired instance's first boot, before this module has had a chance to set
// them below. @patchpilot/db is safe to import here — its connection pool is
// lazy (packages/db/src/client.ts) and touches no env until a query runs.
function decryptPairedSecret(payload: string, keySource: string): string {
  const key = createHash("sha256").update(keySource).digest();
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

async function loadPairedEntraCredentials(): Promise<void> {
  // Mirrors config.ts's own DEMO_MODE parsing (default true) without importing
  // it — config.ts must not be imported before this function has run.
  if ((process.env.DEMO_MODE ?? "true") !== "false") return;

  try {
    const { db, tables, eq } = await import("@patchpilot/db");
    const [row] = await db
      .select()
      .from(tables.settings)
      .where(eq(tables.settings.key, "entra-app-registration"));
    if (!row) return;

    const value = row.value as { clientId: string; tenantId: string; clientSecretEncrypted: string };
    const tokenKey = process.env.TOKEN_ENCRYPTION_KEY ?? "demo-encryption-key-not-for-production-0";
    process.env.ENTRA_CLIENT_ID = value.clientId;
    process.env.ENTRA_TENANT_ID = value.tenantId;
    process.env.ENTRA_CLIENT_SECRET = decryptPairedSecret(value.clientSecretEncrypted, tokenKey);
  } catch (err) {
    // Boot must not hard-fail on a transient DB hiccup here — config.ts's own
    // validation below still runs, and will reject the boot if no usable
    // ENTRA_* credentials are available from any source.
    console.error("[load-env] failed to load paired Entra credentials:", err);
  }
}

/**
 * Folds every activated custom-domain row (routes/domains.ts) into
 * EXTRA_WEB_ORIGINS before config.ts parses it, so resolveWebOrigin
 * (auth/origin.ts) accepts logins started from them. Additive onto whatever
 * EXTRA_WEB_ORIGINS already holds from env/`.env` — same "DB augments, never
 * silently overrides" precedence as loadPairedEntraCredentials above. A
 * process restart is required to pick this up (see CUSTOM_DOMAINS_CHANGED_CHANNEL
 * in routes/domains.ts), same tradeoff the pairing flow already accepts.
 */
async function loadCustomDomains(): Promise<void> {
  if ((process.env.DEMO_MODE ?? "true") !== "false") return;

  try {
    const { db, tables, eq } = await import("@patchpilot/db");
    const rows = await db
      .select({ hostname: tables.customDomains.hostname })
      .from(tables.customDomains)
      .where(eq(tables.customDomains.status, "active"));
    if (rows.length === 0) return;

    const existing = (process.env.EXTRA_WEB_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const active = rows.map((r) => `https://${r.hostname}`);
    process.env.EXTRA_WEB_ORIGINS = Array.from(new Set([...existing, ...active])).join(",");
  } catch (err) {
    console.error("[load-env] failed to load active custom domains:", err);
  }
}

await loadPairedEntraCredentials();
await loadCustomDomains();
