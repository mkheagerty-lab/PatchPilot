import { resolveCname } from "node:dns/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { getCca, APP_REGISTRATION_SYNC_SCOPES, auditSafe } from "@patchpilot/graph";
import { CUSTOM_DOMAINS_CHANGED_CHANNEL } from "@patchpilot/shared";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import { resolveWebOrigin } from "../auth/origin.js";
import { connection } from "../queue.js";
import { exitAfterReply } from "../restart-after-reply.js";

/**
 * Custom Domain Management for the App Registration page.
 *
 * Lets an admin add either a "<label>.patchpilot365.com" subdomain (DNS
 * created out-of-band by PatchPilot Support after an emailed request — no
 * live Cloudflare API in v1) or a fully custom hostname, verify it's live with a read-only
 * CNAME lookup (never a DNS-provider write), and then push the resulting
 * redirect URI(s) into the real Entra app registration — either via the
 * in-app "sync via browser" step-up consent flow, or by copying the exact
 * Deploy-PatchPilot.ps1 one-liner (that script's redirect-URI merge is
 * already additive/idempotent, confirmed by direct read).
 *
 * A verified/deleted-while-active domain changes the OAuth redirect-origin
 * allowlist (config.EXTRA_WEB_ORIGINS via load-env.ts's loadCustomDomains),
 * which only takes effect on process boot — so both paths publish
 * CUSTOM_DOMAINS_CHANGED_CHANNEL and then self-exit, exactly like the
 * existing onboarding-pairing.ts credential-rotation tail.
 */

type DomainRow = typeof tables.customDomains.$inferSelect;

interface DomainReport {
  id: string;
  hostname: string;
  type: DomainRow["type"];
  status: DomainRow["status"];
  cnameTarget: string;
  createdBy: string;
  createdAt: string;
  activatedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  instructions:
    | { kind: "email-support"; summary: string; supportMailto: string }
    | { kind: "dns-cname"; summary: string; cnameRecord: { name: string; target: string } };
}

interface DomainsReport {
  primaryOrigin: string;
  platformBaseDomain: string;
  cnameTarget: string;
  cnameTargetUsable: boolean;
  domains: DomainReport[];
}

const SUPPORT_EMAIL = "support@patchpilot365.com";

// The CNAME target the create/report endpoints hand out. See config.ts's
// CUSTOM_DOMAIN_CNAME_TARGET doc comment for why this can't just always be
// `new URL(config.PUBLIC_URL).host`.
function resolveCnameTarget(): string {
  return (config.CUSTOM_DOMAIN_CNAME_TARGET || new URL(config.PUBLIC_URL).host).toLowerCase();
}

// True only for something a real DNS provider could actually resolve a
// customer's CNAME through — rules out loopback hosts (a bare "localhost",
// 127.0.0.1, ::1 — always true of a local dev PUBLIC_URL) and single-label
// hostnames (no dot — not a registrable public DNS name). An IP-literal
// target isn't rejected here: some deployments legitimately front the
// instance with a static public IP's PTR-less A record via a CNAME-flattening
// provider, and this is a UX guard against the obviously-broken case, not a
// full DNS-target validator.
function hostIsRoutable(host: string): boolean {
  const bare = host.split(":")[0]!.toLowerCase();
  if (bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare === "0.0.0.0") return false;
  if (!bare.includes(".")) return false;
  return true;
}

function buildSupportMailto(row: { hostname: string; cnameTarget: string; createdBy: string }): string {
  const subject = `DNS request: ${row.hostname}`;
  const body = [
    "Please create a CNAME record:",
    "",
    `  ${row.hostname}  ->  ${row.cnameTarget}`,
    "",
    `Requested by ${row.createdBy}.`,
  ].join("\n");
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function toDomainReport(row: DomainRow): DomainReport {
  const instructions: DomainReport["instructions"] =
    row.type === "subdomain"
      ? {
          kind: "email-support",
          summary: `Email ${SUPPORT_EMAIL} to request this DNS record — PatchPilot Support will create a CNAME pointing ${row.hostname} at ${row.cnameTarget}.`,
          supportMailto: buildSupportMailto(row),
        }
      : {
          kind: "dns-cname",
          summary: `Ask your DNS provider to create a CNAME record for ${row.hostname} pointing at ${row.cnameTarget}, then click Verify.`,
          cnameRecord: { name: row.hostname, target: row.cnameTarget },
        };

  return {
    id: row.id,
    hostname: row.hostname,
    type: row.type,
    status: row.status,
    cnameTarget: row.cnameTarget,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    lastCheckError: row.lastCheckError,
    instructions,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "23505";
}

// A single DNS label: letters/digits/hyphens, 1-63 chars, no leading/trailing hyphen.
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
// A full DNS hostname: at least two labels, each following LABEL_RE's shape.
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const createBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subdomain"), label: z.string().trim().min(1).max(63) }),
  z.object({ type: z.literal("custom"), hostname: z.string().trim().min(1).max(253) }),
]);

// Same shape as createBodySchema, but read from a querystring (GET /api/domains/check)
// instead of a JSON body — every value arrives as a string either way.
const checkQuerySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subdomain"), label: z.string().trim().min(1).max(63) }),
  z.object({ type: z.literal("custom"), hostname: z.string().trim().min(1).max(253) }),
]);

type HostnameInput = z.infer<typeof createBodySchema>;
type HostnameResolution = { ok: true; hostname: string } | { ok: false; error: string };

// Shared by the create route and the pre-flight check route below, so "would
// this be rejected" and "is this actually rejected" can never drift apart.
// Resolves a subdomain label or custom hostname down to the canonical
// lowercase hostname PatchPilot would store, or the exact validation error
// the create route would return for it. Deliberately doesn't touch the
// database — callers decide separately whether the resolved hostname is
// already taken.
function resolveHostname(input: HostnameInput): HostnameResolution {
  if (input.type === "subdomain") {
    const label = input.label.trim().toLowerCase();
    if (!LABEL_RE.test(label)) {
      return { ok: false, error: "invalid subdomain label" };
    }
    return { ok: true, hostname: `${label}.${config.PLATFORM_BASE_DOMAIN}` };
  }

  const hostname = input.hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_RE.test(hostname)) {
    return { ok: false, error: "invalid hostname" };
  }
  const platformSuffix = `.${config.PLATFORM_BASE_DOMAIN}`;
  if (hostname === config.PLATFORM_BASE_DOMAIN.toLowerCase() || hostname.endsWith(platformSuffix)) {
    return { ok: false, error: `use the subdomain option for ${config.PLATFORM_BASE_DOMAIN} hostnames` };
  }
  const primaryHost = new URL(config.PUBLIC_URL).host.toLowerCase();
  if (hostname === primaryHost) {
    return { ok: false, error: "this is already the instance's primary domain" };
  }
  return { ok: true, hostname };
}

export async function domainsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("settings:read"));

  app.get("/api/domains", async (): Promise<DomainsReport> => {
    const primaryOrigin = config.PUBLIC_URL;
    const platformBaseDomain = config.PLATFORM_BASE_DOMAIN;
    const cnameTarget = resolveCnameTarget();
    const cnameTargetUsable = hostIsRoutable(cnameTarget);
    if (config.DEMO_MODE) {
      return { primaryOrigin, platformBaseDomain, cnameTarget, cnameTargetUsable, domains: [] };
    }
    const rows = await db.select().from(tables.customDomains).orderBy(desc(tables.customDomains.createdAt));
    return { primaryOrigin, platformBaseDomain, cnameTarget, cnameTargetUsable, domains: rows.map(toDomainReport) };
  });

  // Pre-flight availability check for the "Check" button next to Add domain —
  // resolves the same way the create route would and reports whether the
  // resulting hostname is free, without creating anything. Never a substitute
  // for the create route's own validation (a hostname can go from available
  // to taken between the two calls), just a fast, cheap way to give the
  // engineer feedback before they submit.
  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/api/domains/check",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(400).send({ error: "not_available_in_demo_mode" });
      }
      const parsed = checkQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid query" });
      }

      const resolved = resolveHostname(parsed.data);
      if (!resolved.ok) {
        return reply.send({ hostname: null, available: false, reason: resolved.error });
      }

      const [existing] = await db
        .select({ id: tables.customDomains.id })
        .from(tables.customDomains)
        .where(eq(tables.customDomains.hostname, resolved.hostname));

      return reply.send({
        hostname: resolved.hostname,
        available: !existing,
        reason: existing ? "a domain with this hostname already exists" : undefined,
      });
    },
  );

  app.get<{ Params: { id: string } }>("/api/domains/:id/registration-command", async (req, reply) => {
    const [row] = await db
      .select()
      .from(tables.customDomains)
      .where(eq(tables.customDomains.id, req.params.id));
    if (!row) return reply.code(404).send({ error: "domain not found" });

    const command = `.\\Deploy-PatchPilot.ps1 -MspTenantId ${config.ENTRA_TENANT_ID} -RedirectUri https://${row.hostname}/auth/callback`;
    return { command };
  });

  app.post(
    "/api/domains",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      const parsed = createBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      if (config.DEMO_MODE) {
        return reply.code(400).send({ error: "not_available_in_demo_mode" });
      }

      const cnameTarget = resolveCnameTarget();
      if (!hostIsRoutable(cnameTarget)) {
        return reply.code(400).send({
          error: `This instance's public hostname ("${cnameTarget}") isn't a real DNS name a customer's DNS provider can point a CNAME at. Set PUBLIC_URL (or CUSTOM_DOMAIN_CNAME_TARGET) to the instance's actual public hostname before adding a custom domain.`,
        });
      }

      const resolved = resolveHostname(parsed.data);
      if (!resolved.ok) {
        return reply.code(400).send({ error: resolved.error });
      }
      const hostname = resolved.hostname;

      const actor = req.session.engineer!;

      let row: DomainRow;
      try {
        const [inserted] = await db
          .insert(tables.customDomains)
          .values({
            hostname,
            type: parsed.data.type,
            cnameTarget,
            createdBy: actor.upn,
          })
          .returning();
        row = inserted!;
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: "a domain with this hostname already exists" });
        }
        throw err;
      }

      await auditSafe({
        engineer: actor.upn,
        tenantId: actor.homeTenantId,
        endpoint: "/api/domains",
        method: "POST",
        action: "custom-domain:created",
        resourceType: "application",
        resourceId: row.id,
        resourceLabel: row.hostname,
        summary: `${actor.upn} added ${parsed.data.type === "subdomain" ? "subdomain" : "custom domain"} ${row.hostname}`,
        outcome: "success",
        responseStatus: 201,
      });

      return reply.code(201).send(toDomainReport(row));
    },
  );

  // The one live check, and it's read-only: resolves the hostname's CNAME and
  // compares it to the stored target. Never calls a DNS provider's API to
  // create anything — only ever reads — so it stays inside the "manual
  // subdomain DNS" boundary for both domain types alike.
  app.post<{ Params: { id: string } }>(
    "/api/domains/:id/verify",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(400).send({ error: "not_available_in_demo_mode" });
      }
      const [row] = await db
        .select()
        .from(tables.customDomains)
        .where(eq(tables.customDomains.id, req.params.id));
      if (!row) return reply.code(404).send({ error: "domain not found" });

      const actor = req.session.engineer!;
      const wantTarget = row.cnameTarget.toLowerCase().replace(/\.$/, "");
      let verified = false;
      let checkError: string | null = null;
      try {
        const records = await resolveCname(row.hostname);
        verified = records.some((r) => r.toLowerCase().replace(/\.$/, "") === wantTarget);
        if (!verified) {
          checkError = `CNAME resolved to ${records.length ? records.join(", ") : "no records"}, expected ${row.cnameTarget}`;
        }
      } catch (err) {
        // An unpropagated or not-yet-created record is an expected retryable
        // state here, not a server error — this route always replies 200.
        checkError = err instanceof Error ? err.message : String(err);
      }

      const now = new Date();
      const [updated] = await db
        .update(tables.customDomains)
        .set({
          status: verified ? "active" : row.status,
          activatedAt: verified ? now : row.activatedAt,
          lastCheckedAt: now,
          lastCheckError: verified ? null : checkError,
        })
        .where(eq(tables.customDomains.id, row.id))
        .returning();

      await auditSafe({
        engineer: actor.upn,
        tenantId: actor.homeTenantId,
        endpoint: `/api/domains/${row.id}/verify`,
        method: "POST",
        action: verified ? "custom-domain:activated" : "custom-domain:verify-failed",
        resourceType: "application",
        resourceId: row.id,
        resourceLabel: row.hostname,
        summary: verified
          ? `${actor.upn} verified and activated ${row.hostname}`
          : `${actor.upn}'s verification of ${row.hostname} found no matching CNAME yet`,
        outcome: verified ? "success" : "failure",
        detail: checkError ?? undefined,
        responseStatus: 200,
      });

      if (verified) {
        // Newly active — EXTRA_WEB_ORIGINS only picks this up on next boot.
        await connection.publish(CUSTOM_DOMAINS_CHANGED_CHANNEL, "activated").catch(() => undefined);
        reply.send({ verified, domain: toDomainReport(updated!) });
        exitAfterReply(reply);
        return;
      }
      return reply.send({ verified, domain: toDomainReport(updated!) });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/domains/:id",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(400).send({ error: "not_available_in_demo_mode" });
      }
      const [row] = await db
        .delete(tables.customDomains)
        .where(eq(tables.customDomains.id, req.params.id))
        .returning();
      if (!row) return reply.code(404).send({ error: "domain not found" });

      const actor = req.session.engineer!;
      await auditSafe({
        engineer: actor.upn,
        tenantId: actor.homeTenantId,
        endpoint: `/api/domains/${row.id}`,
        method: "DELETE",
        action: "custom-domain:deleted",
        resourceType: "application",
        resourceId: row.id,
        resourceLabel: row.hostname,
        summary: `${actor.upn} removed ${row.type === "subdomain" ? "subdomain" : "custom domain"} ${row.hostname}`,
        outcome: "success",
        responseStatus: 200,
      });

      if (row.status === "active") {
        // An origin is being removed from the allowlist — same restart need as activation.
        await connection.publish(CUSTOM_DOMAINS_CHANGED_CHANNEL, "deleted").catch(() => undefined);
        reply.send({ deleted: true });
        exitAfterReply(reply);
        return;
      }
      return reply.send({ deleted: true });
    },
  );

  // Starts the one-time "sync redirect URIs" step-up consent redirect (see
  // packages/graph/src/app-registration-sync.ts's updateAppRegistrationRedirectUris
  // for what it does once the callback in apps/api/src/auth/routes.ts redeems
  // the code). Structurally identical to onboarding.ts's sync-permissions/start.
  app.get(
    "/api/domains/sync-registration/start",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(400).send({ error: "not_available_in_demo_mode" });
      }

      const origin = resolveWebOrigin(req);
      const state = `patchpilot-syncdomains:${req.session.sessionId}`;
      const url = await getCca().getAuthCodeUrl({
        scopes: APP_REGISTRATION_SYNC_SCOPES,
        redirectUri: `${origin}/auth/callback`,
        state,
      });

      await auditSafe({
        engineer: req.session.engineer!.upn,
        tenantId: req.session.engineer!.homeTenantId,
        endpoint: "/api/domains/sync-registration/start",
        method: "GET",
        action: "app-registration:domain-sync-start",
        resourceType: "application",
        resourceId: config.ENTRA_CLIENT_ID,
        summary: `${req.session.engineer!.upn} started a redirect URI sync`,
        outcome: "success",
        responseStatus: 302,
      });

      return reply.redirect(url);
    },
  );
}

/**
 * Caddy's on-demand TLS "ask" endpoint (infra/Caddyfile's `on_demand_tls`
 * block). Deliberately its own hook-free plugin — domainsRoutes above applies
 * a blanket session+settings:read hook to every route registered inside it,
 * and Fastify applies a plugin's hooks to everything in its encapsulation
 * context regardless of declaration order (see onboarding-pairing.ts's
 * identical reasoning for why its routes are isolated too).
 *
 * Safe unauthenticated only because infra/docker-compose.yml publishes no
 * host port for `api` — this is reachable exclusively from `caddy`/`worker`
 * on the internal Compose network. If `api` ever gains a published host port,
 * this route must be revisited.
 */
export async function domainsInternalRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { domain?: string } }>("/internal/domains/ask", async (req, reply) => {
    const domain = req.query.domain?.toLowerCase().trim();
    if (!domain) return reply.code(400).send();
    if (config.DEMO_MODE) return reply.code(404).send();

    const primaryHost = new URL(config.PUBLIC_URL).host.toLowerCase();
    if (domain === primaryHost) return reply.code(200).send();

    const [row] = await db
      .select()
      .from(tables.customDomains)
      .where(and(eq(tables.customDomains.hostname, domain), eq(tables.customDomains.status, "active")));

    return row ? reply.code(200).send() : reply.code(404).send();
  });
}
