import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "./env.js";

/**
 * AES-256-GCM at rest for cached Microsoft tokens. The key is derived from
 * TOKEN_ENCRYPTION_KEY so rotating the env var invalidates old ciphertext.
 */
const key = createHash("sha256").update(env.TOKEN_ENCRYPTION_KEY).digest();

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed ciphertext");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** SHA-256 hex of a payload — used for audit log payload hashes (never store raw). */
export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

/**
 * SHA-256 hex of raw content (string or bytes). Used for the Live Response library
 * file name (content-addressed, so an unchanged script keeps the same name) and for
 * the audit descriptor of an upload (we hash the bytes, never store them raw).
 */
export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
