# PatchPilot

[![CI](https://github.com/mkheagerty-lab/PatchPilot/actions/workflows/ci.yml/badge.svg)](https://github.com/mkheagerty-lab/PatchPilot/actions/workflows/ci.yml)

Self-hostable, multi-tenant **MSP patch management console**. PatchPilot bridges
Microsoft Defender Vulnerability Management (MDVM) findings to actual remediation
via **Winget** (third-party apps) and the **Windows Update Agent** (OS patches),
across many GDAP-linked customer tenants.

> **No Azure. No SharePoint. No Power Platform. No Dataverse.**
> The entire stack runs on infrastructure you control (Docker Compose on a VPS,
> MSP infra, or on-prem). All Microsoft tokens stay **server-side** — the browser
> never sees a Graph access token.

---

## Non-negotiables (architecture invariants)

1. **Fully self-hosted** — Docker Compose; no managed cloud dependency.
2. **Tokens server-side only** — the browser talks exclusively to the PatchPilot
   API on the same origin, carrying a session cookie. No Graph token in the SPA.
3. **Audit everything** — every Graph call is logged (engineer, tenant, endpoint,
   method, payload **hash**, response status, latency, timestamp). Payloads are
   hashed, never stored raw.
4. **Graceful licensing degradation** — never render a button for a feature the
   tenant isn't licensed for.
5. **Per-tenant isolation** — token cache, job queue, and audit log are all keyed
   by tenant.
6. **Read-only first** — every new tenant integration starts read-only; write
   actions are opted in per tenant.
7. **`scripts/Deploy-PatchPilot.ps1` is canonical for first-time app-registration
   creation** — the Entra onboarding artefact. The in-app "Sync permissions"
   action (Setup → App Registration) may refresh scopes/consent on an app the
   script already created, but never creates one.
8. **Secrets in `.env`** with locked-down file permissions.

---

## Monorepo layout

```
apps/
  web/      React 19 + Vite 6 + Tailwind v4 SPA (the console)
  api/      Fastify 5 API — MSAL auth, data routes, audit, token cache
  worker/   BullMQ worker — runs remediation jobs across 4 channels
packages/
  shared/   Domain types, SLA logic, channel routing, script generators (zod)
  db/       Drizzle ORM schema, client, migrations, seed
infra/      Docker Compose, Caddy, nginx, Dockerfiles
scripts/    Deploy-PatchPilot.ps1 + Entra app manifest/scopes (canonical)
```

Tooling: **pnpm workspaces + Turborepo**. PostgreSQL (Drizzle) + Redis (BullMQ).

---

## Quick start — zero-dependency demo

`DEMO_MODE=true` (the default) needs **no Docker, no Postgres, no Redis, and no
Entra app**. Auth is bypassed with a demo engineer and all data is served from
in-memory fixtures, so the console is instantly clickable.

Prereqs: Node 22+, pnpm 9+.

```bash
pnpm install
pnpm dev          # web + api + worker, hot reload, DEMO_MODE on by default
```

- Web: http://localhost:5173 (Vite proxies `/api` + `/auth` to the API)
- API: http://localhost:4000

The demo bypass and in-memory data are gated strictly on `DEMO_MODE` and can
never activate in production (`DEMO_MODE=false`).

---

## Development against real Postgres + Redis

When you want the full DB-backed path (still no Entra — login is stubbed until
Phase 4), run the dev infra and seed it:

```bash
cp .env.example .env        # set secrets, DATABASE_URL, REDIS_URL, DEMO_MODE=false
pnpm infra:dev:up           # docker compose -f infra/docker-compose.dev.yml up -d
pnpm db:migrate
pnpm db:seed                # loads the same demo tenants/devices/vulns fixtures
pnpm dev
```

---

## Production (full self-hosted stack)

```bash
cp .env.example .env        # set PP_DOMAIN, secrets, POSTGRES_PASSWORD, DEMO_MODE=false
docker compose -f infra/docker-compose.yml up -d --build
```

Services: `caddy` (TLS via Let's Encrypt) → `web` (nginx SPA) + `api` (Fastify),
plus `worker`, `postgres`, `redis`, `ollama`. Point `PP_DOMAIN`'s DNS at the host
and Caddy provisions the certificate automatically.

### Deploying to an Azure VM

[`infra/azure/`](infra/azure/) has a one-command Bicep + cloud-init deployment:
`az deployment group create` provisions the network, firewall, a static public
IP (with a free `<label>.<region>.cloudapp.azure.com` hostname, or your own
domain if you have one), and an Ubuntu VM that installs Docker and brings up
this exact stack on first boot — no SSH required for setup or day-to-day
operation. See [`infra/azure/README.md`](infra/azure/README.md) for the full
runbook, including switching to a custom domain later and updating the deploy.

### AI features (summaries, reports, chatbot)

Off by default (`AI_FEATURES_ENABLED=false`). The model runs entirely inside
your own Compose stack — `ollama` has no published port and makes no calls out
to the internet at inference time; the app only ever gives it data it already
serves through its own RBAC-scoped API, never a database connection. See
`packages/shared/src/rbac.ts` for the `ai:use` permission.

To turn it on:

```bash
# 1. Set in .env: AI_FEATURES_ENABLED=true
# 2. Bring the stack up (or restart it) so the ollama container exists
docker compose -f infra/docker-compose.yml up -d
# 3. One-time model pull — needs host internet access for this step only,
#    never again after. Weights persist in the ollama_data volume.
docker compose -f infra/docker-compose.yml exec ollama ollama pull llama3.1:8b
```

`OLLAMA_MODEL` defaults to `llama3.1:8b` (Meta, USA — Llama Community License,
reliable native tool-calling in Ollama). Deliberately not a PRC-origin model
(e.g. Qwen): this box handles MSP client security data, and vendor provenance
for the model weights matters independently of the network-isolation
guarantees above, per US/AU vendor-trust requirements. On beefier hardware,
pull `llama3.1:70b` instead and set `OLLAMA_MODEL` to match for higher
quality — no code change needed. Minimum recommended: 8 vCPU / 16GB RAM for
the 8B model; a GPU is strongly recommended for the 70B model.

One Ollama instance serializes compute across every engineer's chat/summary/
report request at once — there's no per-request isolation. `OLLAMA_NUM_PARALLEL`
(an Ollama env var, set on the `ollama` service in the compose file) raises how
many requests it batches concurrently, at the cost of proportionally more
RAM/VRAM per slot; on a single machine this has a ceiling, not a fix. For an
MSP team of a handful of concurrent engineers the default is normally fine —
treat slow responses under concurrent use as a scaling signal to raise
`OLLAMA_NUM_PARALLEL` (with matching hardware) or move to the 70B model's
dedicated GPU box, not a bug.

### Reports (branded PDFs, CSV exports)

`GET /reports` (gate: `operations:read`, so every role that can read posture data
can generate reports) — Executive Summary and Compliance/SLA today, more types are
a registry entry away (`packages/shared/src/reports.ts`). Each run renders a
branded, chart-and-table PDF in the worker via headless Chromium (`playwright-core`)
and is stored as a `reports` row (metadata + PDF bytes), so history, re-download and
retention don't depend on Redis/BullMQ still holding the job. Five CSV metric
exports (SLA compliance, device compliance, software exposure, time-to-remediate,
posture trend) are generated server-side under the same gate.

AI narration is a separate, additive toggle — needs `ai:use` **and**
`AI_FEATURES_ENABLED=true`. With it off, every section still renders from the
registry's deterministic captions; with it on but Ollama unreachable, a report
still completes (`narrated=false`, a skipped-reason on the cover) rather than
failing — see "AI features" above for why the model runs where it does.

Env vars (all in `.env.example`, already commented with defaults):

- `REPORT_RETENTION_DAYS` (90) — a report's `expires_at` is stamped once at
  creation; the worker sweeps expired rows on a 6h timer. Lowering this later
  does not retroactively delete reports that were promised a longer life.
- `REPORT_RETENTION_MAX_PER_ENGINEER` (50) — a hard per-engineer cap enforced
  after every write, oldest first, independent of age.
- `REPORT_BROWSER_EXECUTABLE_PATH` / `REPORT_BROWSER_CHANNEL` — how the worker
  finds a Chromium/Edge binary. The container image installs Alpine `chromium`
  and points `REPORT_BROWSER_EXECUTABLE_PATH` at it directly.
- `REPORT_PDF_TIMEOUT_MS` / `REPORT_JOB_TIMEOUT_MS` / `REPORT_CONCURRENCY` /
  `REPORT_MAX_BYTES` — rendering timeouts, one-job-at-a-time concurrency (Chromium
  plus a possibly-shared Ollama on one box), and an output size guard.

**Windows dev:** there's no separate browser to install — set
`REPORT_BROWSER_CHANNEL=msedge` in `.env` and Playwright drives your existing Edge
install. Leave `REPORT_BROWSER_EXECUTABLE_PATH` unset in that case.

**If Alpine Chromium ever breaks** (a `Protocol error` from Chromium inside
`docker compose`, typically after a base-image bump — Alpine's Chromium package
lags upstream and occasionally regresses under headless PDF rendering), switch
`infra/Dockerfile.worker` to a Debian base and let Playwright manage its own
browser instead of the system package:

```dockerfile
FROM node:22-bookworm-slim
# ...
RUN npx playwright install --with-deps chromium
```

and unset `REPORT_BROWSER_EXECUTABLE_PATH` so Playwright uses the browser it just
installed. Launch args are entirely env-configured for exactly this reason — the
fix is a Dockerfile change, not a code change.

### How login never touches Graph (handled by the deploy script)

PatchPilot never lets the engineer's session token touch Graph directly. At login
it requests a token for **its own API**, then exchanges that (server-side, via the
On-Behalf-Of flow) for short-lived, least-privilege Graph/Defender tokens per
tenant — so the engineer's delegated permissions and GDAP roles always apply, but
a leaked session token can't call Microsoft APIs on its own.

That requires the app to expose a delegated scope. **`Deploy-PatchPilot.ps1` does
this for you** — it sets the Application ID URI to `api://<client-id>`, adds the
`access_as_user` scope, and pre-authorizes the app to call itself, so there are
**no portal clicks**. `ENTRA_API_SCOPE` then defaults to
`api://<client-id>/access_as_user` (the script's generated `.env` leaves it unset);
override it only if you chose a custom Application ID URI. The MSP admin consent
granted for the Graph/Defender permissions covers the OBO exchange.

---

## Testing with real Entra login

There are two ways to run PatchPilot, and only the second needs hosting:

- **UI / onboarding flow only** — stay in `DEMO_MODE=true` (the
  [Quick start](#quick-start--zero-dependency-demo) above). Auth is bypassed, no
  Entra app, no hosting. Best for clicking through the console.
- **Real login + On-Behalf-Of token exchange** — run the deploy script and bring
  up the stack with `DEMO_MODE=false`. This needs a reachable OAuth **redirect
  URI**, which is what the hosting question below is really about.

### The redirect URI rules

Entra requires the redirect URI to be **HTTPS** and to **match exactly** what's
registered in the app and written in your `.env`
(`AUTH_REDIRECT_URI` / `PUBLIC_URL` / `CORS_ORIGINS`). The one exception:
`http://localhost` is allowed for development. Pass your chosen callback URL to the
script with `-RedirectUri https://<host>/auth/callback` — it flows straight into
the app registration and the generated `.env`.

> **GitHub Pages (and any static host) will NOT work.** PatchPilot completes the
> OAuth code-for-token exchange **server-side** using the client secret, which
> must never reach the browser. A static host can only serve the SPA shell — login
> would be broken and there's no server to hold the secret. You need a host that
> runs the Node/Docker stack.

### Where to host for testing

| Option | Public URL? | Cost | When to use |
| --- | --- | --- | --- |
| **Localhost** | No (your browser only) | Free | Solo testing against **your own MSP tenant**. Register `http://localhost:<port>/auth/callback`. Can't send consent links to a separate customer tenant — localhost isn't reachable by them. |
| **Tunnel** (Cloudflare Tunnel / ngrok) | Yes | Free | Run the stack locally, expose a public HTTPS URL. Lets you test the **real multi-tenant GDAP consent flow** with a separate test customer tenant. Use a **stable hostname** (Cloudflare Tunnel on a domain you own) — ngrok's free random subdomain changes on restart, forcing you to re-edit the app registration + `.env` each time. |
| **VPS + domain** | Yes | ~few $/mo | Closest to production. Point DNS at the host and `docker compose -f infra/docker-compose.yml up -d --build`; Caddy auto-provisions the TLS cert. |

**Recommendation:** validate the UI on `DEMO_MODE=true` first; use **localhost** for
single-tenant login/OBO testing; reach for **Cloudflare Tunnel** when you need to
exercise the real customer-consent path without renting a server.

**Running the worker/api long enough to matter (localhost):** `pnpm dev` (`tsx
watch`) restarts on a file save, but not if the process dies on its own — an
uncaught error there leaves it dead until you notice and restart it by hand,
which for the worker means every remediation job sits stuck in `queued`
forever. `infra/docker-compose.yml` already recovers from this (`restart:
unless-stopped`), but plain localhost usage doesn't. `pnpm --filter
@patchpilot/worker dev:resilient` (and the same for `@patchpilot/api`) runs the
same source under a small crash-restart supervisor (`scripts/run-resilient.mjs`)
instead — no file-watch hot reload, but it comes back on its own if it crashes.

---

## Useful scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run web + api + worker with hot reload (Turbo) |
| `pnpm build` | Build all packages |
| `pnpm typecheck` | Type-check every package |
| `pnpm test` | Run vitest suites (SLA, channel routing, script generators) |
| `pnpm infra:dev:up` / `:down` | Start/stop dev Postgres + Redis |
| `pnpm db:generate` | Generate Drizzle migration from schema |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:seed` | Seed demo tenants/devices/vulns |

---

## Remediation channels (core IP)

PatchPilot routes each fix to the fastest channel the tenant is licensed for:

| Channel | Latency | Use |
| --- | --- | --- |
| Defender Live Response | seconds | Ad-hoc script on a single device |
| On-demand Intune Remediation | 1–5 min | Targeted script across a group |
| Win32 app + sync | 5–15 min | Packaged Winget upgrade at scale |
| Expedited Quality Update | hours | OS quality patches |

Routing lives in [`packages/shared/src/channels.ts`](packages/shared/src/channels.ts);
the Winget/WUA PowerShell generators are in
[`packages/shared/src/scripts.ts`](packages/shared/src/scripts.ts).

---

## Roadmap

- **Phase 1 (this scaffold)** — monorepo, app shell + IA, SLA/branding/tenants,
  demo-seeded data, Docker Compose. ✅
- **Phase 2** — live read-only Graph/Defender probes, "Test connection",
  Winget catalog mapping, readiness/pre-flight checks. ✅
- **Phase 3** — remediation framework (4 channels), jobs, schedules, pre-flight —
  with execution _simulated_ (no Microsoft write). ✅
- **Phase 4** — GDAP multi-tenant On-Behalf-Of token exchange, per-tenant consent
  URLs, licensing detection; complete `Deploy-PatchPilot.ps1` API-permissions step. ✅
- **Phase 5** — real remediation execution: shared `@patchpilot/graph` package so the
  BullMQ worker resolves a delegated token itself at execution time (home → OBO,
  customer → Secure Application Model), with the read-only-first gate re-checked when
  each job actually runs; live winget catalog mirror + version-gating; write scopes
  opt-in (`Deploy-PatchPilot.ps1 -EnableRemediationWriteScopes`). Also grew to cover
  RBAC (Users & Roles), the remediation catalog/history views, Windows Update rings/
  quality/feature-update campaigns, branded PDF/CSV reports, a pre-ship security/
  hardening pass (CSRF protection, session-fixation fix, CI pipeline), and an
  admin-configurable SMTP relay for job/sync failure alerts; a multi-tenant
  onboarding-pairing + vendor entitlement/licensing system; dynamic OAuth
  redirect origins and semi-automated custom-domain management for the app
  registration. Merged to `main`. ✅
