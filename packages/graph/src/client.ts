import { audit, type API_CALL_HOSTS } from "./audit.js";
import { sha256Hex } from "./crypto.js";
import { getToken, storeToken, type TokenSlot } from "./token-store.js";
import { acquireTokenForTenant, acquireTokenForCustomerTenant, refreshLoginToken } from "./msal.js";

/**
 * Minimal Microsoft API client.
 *
 * Every call is audited (non-negotiable #3) and the browser never sees a token
 * (non-negotiable #2) — callers pass the engineer identity, this module reads
 * the encrypted server-side token cache.
 *
 * Reads go through `graphGet` (GET-only, used by sync). Writes go through the
 * explicit `graphWrite` (POST/PATCH, used by the remediation worker). Keeping
 * them separate preserves the read-only-first invariant for sync paths: a sync
 * literally cannot issue a write because it only ever holds `graphGet`.
 *
 * Tenant token model: the engineer's login token is an assertion for PatchPilot's
 * own API, never Graph. Downstream Graph/Defender tokens are minted on demand per
 * resource (`.default`) and cached per (engineer, tenant, resource). Both tenant
 * flows are **delegated** — GDAP only supports delegated ("app + user") access to
 * customer tenants, so app-only is not used anywhere:
 *
 * - **Home (MSP) tenant** — On-Behalf-Of (`acquireTokenForTenant`). The engineer's
 *   session assertion is exchanged against their own home tenant.
 * - **GDAP customer tenants** — Secure Application Model
 *   (`acquireTokenForCustomerTenant`). The engineer's cached refresh token is
 *   redeemed silently against the customer-tenant authority; the delegated token
 *   inherits the engineer's GDAP roles in that customer. Per-engineer, like home.
 *
 * Because the customer flow is a silent refresh-token redemption (no live request
 * context), the worker can resolve a token at execution time — hours or days after
 * a remediation was scheduled — which is exactly why this layer is shared between
 * api and worker rather than living in the request-bound api process.
 *
 * Either way the engineer is recorded on every audited call (invariant #3).
 */

const HOSTS = {
  graph: "https://graph.microsoft.com/v1.0",
  // Same service/resource as `graph`, the beta surface. Used sparingly for
  // properties not yet GA on v1.0 (e.g. `managedDevice.skuFamily`); callers
  // must degrade gracefully if a beta read fails, never depend on it.
  beta: "https://graph.microsoft.com/beta",
  defender: "https://api.securitycenter.microsoft.com/api",
} as const;

export type GraphHost = keyof typeof HOSTS;

/**
 * Compile-time guard: every host below builds an `${host}:${path}` audit
 * endpoint, so the audit writer's API_CALL_HOSTS list has to cover all of them
 * or that host's raw traffic gets filed as a domain action. Adding a host here
 * without adding it there is now a type error, not a silent reporting bug.
 */
type _AllHostsClassified = GraphHost extends (typeof API_CALL_HOSTS)[number] ? true : never;
const _hostsClassified: _AllHostsClassified = true;
void _hostsClassified;

/**
 * Resource identifiers used to request a `.default` OBO scope per host. `graph`
 * and `beta` are the same resource (graph.microsoft.com), so a token minted for
 * one is valid for the other — they just live under separate cache keys.
 */
const HOST_RESOURCE: Record<GraphHost, string> = {
  graph: "https://graph.microsoft.com",
  beta: "https://graph.microsoft.com",
  defender: "https://api.securitycenter.microsoft.com",
};

/**
 * Token-cache slot per host. `beta` deliberately reuses the `graph` slot: it's
 * the same resource/audience, so one minted token serves both and we avoid a
 * redundant OBO round-trip when a sync touches v1.0 and beta in the same run.
 */
const HOST_SLOT: Record<GraphHost, TokenSlot> = {
  graph: "graph",
  beta: "graph",
  defender: "defender",
};

export interface GraphCallOptions {
  /** Engineer UPN — used for the token-cache lookup and the audit record. */
  engineer: string;
  /** The engineer's MSP home tenant. */
  homeTenantId: string;
  /** The tenant being targeted. The home tenant uses OBO; customers use the SAM refresh-token flow. */
  tenantId: string;
  host?: GraphHost;
  method?: "GET";
  /** Resource path, e.g. "/organization" or "/vulnerabilities". */
  path: string;
  /** Extra request headers, e.g. `ConsistencyLevel: eventual` for advanced Graph queries. */
  headers?: Record<string, string>;
}

export interface GraphResult<T = unknown> {
  ok: boolean;
  status: number;
  latencyMs: number;
  data: T | null;
  /**
   * Raw response body text on a non-ok write response (bounded to
   * ERROR_BODY_MAX_CHARS), or null on success / when the body couldn't be
   * read. Populated by graphWrite only — a failed write's actual reason
   * (e.g. Defender's `ActiveRequestAlreadyExists`) used to be discarded
   * entirely, so every non-2xx status collapsed into the same generic
   * "may be disabled in Advanced Features" guess regardless of what Defender
   * actually said.
   */
  errorBody?: string | null;
}

export class GraphError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

/**
 * Every outbound fetch carries this bound so a Graph/Defender outage can never
 * hang a caller (e.g. the remediation worker) indefinitely — an unbounded fetch
 * here was the root cause of jobs parking at `status: "running"` forever.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** Bounds how much of a failed write's response body graphWrite keeps as
 *  GraphResult.errorBody — a diagnostic string, not something ever parsed. */
const ERROR_BODY_MAX_CHARS = 4000;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** Statuses Microsoft's own Graph throttling guidance treats as transient —
 *  safe to retry because the request was rejected before being processed,
 *  never because it's ambiguous whether it landed. */
const RETRYABLE_STATUSES = (status: number) => status === 429 || status >= 500;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
/** Ceiling applied both to computed backoff and to a server's `Retry-After` —
 *  a misbehaving/adversarial upstream must never be able to park a worker for
 *  an unbounded amount of time via that header. */
const RETRY_MAX_DELAY_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Accepts delta-seconds ("120") or an HTTP-date, per RFC 9110 §10.2.3. */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

function backoffDelayMs(attempt: number): number {
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
  // Full jitter: spreads out concurrent callers hitting the same throttled
  // tenant/host instead of retrying in lockstep.
  return Math.random() * exp;
}

/**
 * `fetch` with retry-with-backoff on 429/5xx, honouring `Retry-After` when the
 * server sends one. Bounded to MAX_RETRY_ATTEMPTS extra tries so a persistently
 * unavailable host still fails rather than parking a caller indefinitely — the
 * remediation worker in particular must eventually give up and report failure
 * rather than hang a scheduled job. A fresh timeout signal is created per
 * attempt so retries don't inherit an already-elapsed deadline.
 */
async function fetchWithRetry(url: string, init: Omit<RequestInit, "signal">): Promise<Response> {
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!RETRYABLE_STATUSES(res.status) || attempt >= MAX_RETRY_ATTEMPTS) {
      return res;
    }
    const delayMs = Math.min(parseRetryAfterMs(res.headers.get("retry-after")) ?? backoffDelayMs(attempt), RETRY_MAX_DELAY_MS);
    await sleep(delayMs);
    attempt += 1;
  }
}

/** Treat a token as usable only if it has at least 60s of life left. */
const TOKEN_SKEW_MS = 60_000;

/**
 * Resolves the bearer token for a (tenant, resource).
 *
 * Both tenant flows are delegated and per-engineer. The home (MSP) tenant uses a
 * delegated On-Behalf-Of token minted from the engineer's login token (audience =
 * PatchPilot API). GDAP customer tenants use the Secure Application Model: the
 * engineer's cached refresh token is redeemed silently against the customer
 * authority. Either way a fresh cached token for the tenant+resource is reused
 * first; a per-resource `.default` scope honours exactly the consented/GDAP-granted
 * permissions; no standing Graph token is ever held.
 */
async function resolveToken(
  engineer: string,
  homeTenantId: string,
  tenantId: string,
  host: GraphHost,
): Promise<string> {
  const isHomeTenant = tenantId === homeTenantId;
  // Both home (OBO) and customer (SAM) tokens are delegated and carry the
  // engineer's identity, so every token caches per-engineer.
  const cacheOwner = engineer;
  // Cache by resource, not host: beta shares graph's slot (same audience).
  const slot = HOST_SLOT[host];

  // Reuse a previously-minted token for this tenant+resource while fresh.
  const cached = await getToken(cacheOwner, tenantId, slot);
  if (cached && cached.expiresAt > Date.now() + TOKEN_SKEW_MS) {
    return cached.accessToken;
  }

  const scope = `${HOST_RESOURCE[host]}/.default`;
  let minted: { accessToken: string; expiresOn?: Date | null; scopes?: string[] };

  if (isHomeTenant) {
    // Delegated OBO: the engineer's login token is the assertion (audience =
    // PatchPilot API), redeemed against the engineer's own home tenant. That
    // login token is normally minted once, at /auth/callback, and its own
    // lifetime (~60-90min) is far shorter than a PatchPilot session — so it's
    // refreshed here whenever it's missing or stale, rather than reusing an
    // expired assertion (which OBO rejects with AADSTS500133 on every call
    // until the engineer fully re-authenticates).
    let assertion = await getToken(engineer, homeTenantId, "login");
    if (!assertion || assertion.expiresAt <= Date.now() + TOKEN_SKEW_MS) {
      const refreshed = await refreshLoginToken(engineer, homeTenantId);
      if (!refreshed) {
        throw new GraphError(401, `No session token for ${engineer} — re-authentication required`);
      }
      assertion = {
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresOn?.getTime() ?? Date.now() + 3_600_000,
        scopes: refreshed.scopes,
      };
      await storeToken(engineer, homeTenantId, assertion, "login");
    }
    minted = await acquireTokenForTenant(assertion.accessToken, tenantId, [scope]);
  } else {
    // Secure Application Model: redeem the engineer's cached refresh token against
    // the customer authority. The delegated token inherits the engineer's GDAP roles.
    minted = await acquireTokenForCustomerTenant(engineer, tenantId, [scope]);
  }

  await storeToken(
    cacheOwner,
    tenantId,
    {
      accessToken: minted.accessToken,
      expiresAt: minted.expiresOn?.getTime() ?? Date.now() + 3_600_000,
      scopes: minted.scopes ?? [scope],
    },
    slot,
  );
  return minted.accessToken;
}

/**
 * Performs a read-only GET against Graph or the Defender API, auditing the call.
 * Read-only is enforced: only GET is accepted. The home tenant uses a delegated
 * OBO token; GDAP customer tenants use the delegated Secure Application Model
 * refresh-token flow (see resolveToken). The engineer is audited either way.
 */
export async function graphGet<T = unknown>(opts: GraphCallOptions): Promise<GraphResult<T>> {
  const { engineer, homeTenantId, tenantId, path } = opts;
  const host = opts.host ?? "graph";
  const method = opts.method ?? "GET";

  if (method !== "GET") {
    throw new GraphError(405, "graphGet is read-only — only GET is supported");
  }

  const accessToken = await resolveToken(engineer, homeTenantId, tenantId, host);

  const url = `${HOSTS[host]}${path}`;
  const startedAt = Date.now();
  let status = 0;

  try {
    const res = await fetchWithRetry(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...opts.headers,
      },
    });
    status = res.status;
    if (res.ok) {
      const data = (await res.json()) as T;
      return { ok: true, status, latencyMs: Date.now() - startedAt, data };
    }
    // Same rationale as graphWrite's errorBody capture below — a bare status
    // code collapses every 400 into the same unhelpful message regardless of
    // which $select/$expand field Graph actually rejected.
    const errorBody = await res.text().then(
      (t) => (t ? t.slice(0, ERROR_BODY_MAX_CHARS) : null),
      () => null,
    );
    return { ok: false, status, latencyMs: Date.now() - startedAt, data: null, errorBody };
  } catch (err) {
    if (isAbortError(err)) {
      throw new GraphError(408, `${host}:${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    // Audit fires whether the call succeeded or threw. Endpoint is host-qualified
    // so the audit log distinguishes Graph from Defender probes.
    await audit({
      engineer,
      tenantId,
      endpoint: `${host}:${path}`,
      method,
      // Pinned rather than inferred from the endpoint prefix, so a future change
      // to the endpoint format can't silently reclassify this traffic as an action.
      category: "api_call",
      responseStatus: status || undefined,
      latencyMs: Date.now() - startedAt,
    });
  }
}

export interface GraphWriteOptions {
  /** Engineer UPN — used for the token-cache lookup and the audit record. */
  engineer: string;
  /** The engineer's MSP home tenant. */
  homeTenantId: string;
  /** The tenant being targeted. The home tenant uses OBO; customers use the SAM refresh-token flow. */
  tenantId: string;
  host?: GraphHost;
  /** State-changing verbs. DELETE exists solely for explicit, user-initiated removal of a resource PatchPilot itself created or is displaying (e.g. a feature-update campaign) — not for the remediation worker's dispatch paths, which only ever POST/PATCH. */
  method: "POST" | "PATCH" | "DELETE";
  /** Resource path, e.g. "/deviceManagement/managedDevices/{id}/syncDevice". */
  path: string;
  /** JSON request body. Audited as a payload HASH (never stored raw). */
  body?: unknown;
}

/**
 * Performs a state-changing POST/PATCH/DELETE against Graph or the Defender
 * API and audits it WITH the payload (hashed — never raw, invariant #3). This
 * is the single write primitive the remediation worker uses; reads cannot
 * reach it.
 *
 * The caller is responsible for the read-only gate: a write must only ever be
 * issued for a tenant whose `readOnly` flag is false. This function never
 * inspects or flips that flag — it is the executor's job to refuse a write for a
 * read-only tenant before calling here (read-only-first, invariant #11).
 *
 * Token resolution is identical to reads (delegated OBO for home, SAM for
 * customers), so a worker running a scheduled job mints a fresh token at
 * execution time even if the original request's token has long expired.
 */
export async function graphWrite<T = unknown>(opts: GraphWriteOptions): Promise<GraphResult<T>> {
  const { engineer, homeTenantId, tenantId, path, body } = opts;
  const host = opts.host ?? "graph";
  const method = opts.method;

  if (method !== "POST" && method !== "PATCH" && method !== "DELETE") {
    throw new GraphError(405, "graphWrite only supports POST, PATCH, or DELETE");
  }

  const accessToken = await resolveToken(engineer, homeTenantId, tenantId, host);

  const url = `${HOSTS[host]}${path}`;
  const startedAt = Date.now();
  let status = 0;
  let data: T | null = null;

  try {
    const res = await fetchWithRetry(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    status = res.status;
    // Write endpoints commonly return 200/201 with a body or 202/204 with none.
    if (res.ok && res.status !== 204) {
      const text = await res.text();
      data = text ? (JSON.parse(text) as T) : null;
      return { ok: true, status, latencyMs: Date.now() - startedAt, data };
    }
    if (!res.ok) {
      // Best-effort: a body-read failure here must never mask the original
      // HTTP status as a thrown error — errorBody is a diagnostic extra, not
      // load-bearing for the ok/status result callers already handle.
      const errorBody = await res.text().then(
        (t) => (t ? t.slice(0, ERROR_BODY_MAX_CHARS) : null),
        () => null,
      );
      return { ok: false, status, latencyMs: Date.now() - startedAt, data: null, errorBody };
    }
    return { ok: res.ok, status, latencyMs: Date.now() - startedAt, data };
  } catch (err) {
    if (isAbortError(err)) {
      throw new GraphError(408, `${host}:${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    await audit({
      engineer,
      tenantId,
      endpoint: `${host}:${path}`,
      method,
      category: "api_call",
      payload: body ?? null,
      responseStatus: status || undefined,
      latencyMs: Date.now() - startedAt,
    });
  }
}

export interface GraphUploadFile {
  /** File name as stored server-side, e.g. "PatchPilot-Winget-<hash>.ps1". */
  fileName: string;
  /** File content — text scripts pass a string; binaries a Uint8Array. */
  content: string | Uint8Array;
  /** MIME type; defaults to application/octet-stream. */
  contentType?: string;
}

export interface GraphUploadOptions {
  /** Engineer UPN — used for the token-cache lookup and the audit record. */
  engineer: string;
  /** The engineer's MSP home tenant. */
  homeTenantId: string;
  /** The tenant being targeted. The home tenant uses OBO; customers use SAM. */
  tenantId: string;
  host?: GraphHost;
  /** Resource path, e.g. "/libraryfiles". */
  path: string;
  /** The file part of the multipart body. */
  file: GraphUploadFile;
  /** Extra text form fields (e.g. Description, OverrideIfExists, HasParameters). */
  fields?: Record<string, string>;
}

/**
 * Performs a multipart/form-data POST — the one shape `graphWrite` (JSON-only)
 * can't express. Its sole use today is uploading a script to the Defender Live
 * Response library (`POST /libraryfiles`), so the remediation channel can
 * auto-provision its parameterized winget script into a tenant rather than
 * requiring a manual Defender-portal upload.
 *
 * Auditing follows invariant #3 but never records the raw bytes: the payload is a
 * descriptor — file name, content SHA-256, and the text fields — so the audit log
 * proves *what* was uploaded (by content hash) without storing the script body.
 * `fetch` sets the multipart Content-Type + boundary from the FormData itself.
 */
export async function graphUpload<T = unknown>(opts: GraphUploadOptions): Promise<GraphResult<T>> {
  const { engineer, homeTenantId, tenantId, path, file, fields } = opts;
  const host = opts.host ?? "defender";

  const accessToken = await resolveToken(engineer, homeTenantId, tenantId, host);

  const form = new FormData();
  for (const [key, value] of Object.entries(fields ?? {})) {
    form.append(key, value);
  }
  const bytes =
    typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content;
  form.append(
    "file",
    new Blob([bytes], { type: file.contentType ?? "application/octet-stream" }),
    file.fileName,
  );

  const url = `${HOSTS[host]}${path}`;
  const startedAt = Date.now();
  let status = 0;
  let data: T | null = null;

  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      body: form,
    });
    status = res.status;
    if (res.ok && res.status !== 204) {
      const text = await res.text();
      data = text ? (JSON.parse(text) as T) : null;
    }
    return { ok: res.ok, status, latencyMs: Date.now() - startedAt, data };
  } catch (err) {
    if (isAbortError(err)) {
      throw new GraphError(408, `${host}:${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    await audit({
      engineer,
      tenantId,
      endpoint: `${host}:${path}`,
      method: "POST",
      category: "api_call",
      // Descriptor only — never the raw file bytes (invariant #3).
      payload: { fileName: file.fileName, sha256: sha256Hex(bytes), fields: fields ?? {} },
      responseStatus: status || undefined,
      latencyMs: Date.now() - startedAt,
    });
  }
}
