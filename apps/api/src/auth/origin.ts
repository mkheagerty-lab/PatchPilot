import type { FastifyRequest } from "fastify";
import { config, webOrigins } from "../config.js";

/**
 * The web origin this request actually arrived through, for building a
 * same-origin AUTH_REDIRECT_URI and post-login redirect. Without this, an
 * OAuth round trip started from an allow-listed alternate origin (e.g. a
 * cloudflared tunnel hostname) would always bounce back to config.PUBLIC_URL
 * instead — landing on a different origin than the one the pre-login session
 * cookie was set on, which the /auth/callback state check then (correctly)
 * rejects as a session mismatch.
 *
 * In dev, apps/web's Vite proxy rewrites the Host header it forwards to this
 * API (changeOrigin: true), so the browser's real Host survives only via the
 * X-Forwarded-Host header the proxy's `configure` hook sets explicitly (see
 * apps/web/vite.config.ts). In production there is no proxy — apps/api serves
 * the built SPA itself — so req.headers.host is already the real one.
 *
 * The candidate is checked against `webOrigins` (config.PUBLIC_URL plus
 * EXTRA_WEB_ORIGINS) before use: an unrecognized Host header must never be
 * trusted to build a redirect URI, even though Entra would separately reject
 * any redirect_uri it doesn't have registered — this is defense in depth, not
 * the only guard.
 */
export function resolveWebOrigin(req: FastifyRequest): string {
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = typeof forwardedHost === "string" ? forwardedHost.split(",")[0]!.trim() : req.headers.host;
  if (!host) return config.PUBLIC_URL;

  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = typeof forwardedProto === "string" ? forwardedProto.split(",")[0]!.trim() : "http";
  const candidate = `${proto}://${host}`;

  return webOrigins.includes(candidate) ? candidate : config.PUBLIC_URL;
}
