# Changelog

All notable changes to PatchPilot are recorded here. Phase 0-5 entries below
are grouped by development phase, ordered oldest-first, from before this
project had tagged releases. From here on, changes land under "Unreleased"
and get cut into a dated "## [X.Y.Z]" section by `pnpm release <version>`
(`scripts/release.mjs`) when a version is released; `.github/workflows/release.yml`
then publishes that section as the GitHub Release body (see
Settings > Updates for how a running instance picks up a new release).

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

## [0.4.1] - 2026-09-05

- Fix the self-update sidecar bind-mounting the repo checkout at a path
  (`/repo`) that didn't match its real location on the host (`/opt/patchpilot`)
  — this broke `caddy`/`backup`'s own bind mounts on the next self-update,
  taking the whole site down. The sidecar's checkout now mounts at the same
  path on both sides.

## [0.4.0] - 2026-09-05

- Branding — default PatchPilot365 shield logo and favicon, a locked product
  name (enforced server-side too), drag-and-drop/browse logo upload, and a
  "Match colours to logo" button that derives a theme palette from an
  uploaded logo's pixels.

## [0.2.0] - 2026-09-05

- Settings > Updates — GitHub Releases polling, an in-app update-available
  banner, and a self-update sidecar to run/schedule applying a new release.

## Phase 0 — Scaffold

- Zero-dependency demo mode scaffold.

## Phase 2 + 3 — Read-only surfaces, then remediation execution

- Read-only tenant/device/vulnerability surfaces.
- First real remediation execution paths.

## Phase 4 — Multi-tenant GDAP, licensing, live ingestion

- API-audience and GDAP multi-tenant on-behalf-of (OBO) auth, consent URLs.
- Scripted Entra onboarding and admin-consent flows.
- Live tenant ingestion from real customer environments.
- Licensing detection derived from `/organization` `assignedPlans`.
- Background auto-sync and an All-Tenants multi-tenant view.
- Per-device CVE drill-down, consolidated recommendations, sync hardening.

## Phase 5 — Remediation catalog, RBAC, reporting, hardening

Merged to `main` — see [README.md](README.md)'s Roadmap section.

- Remediation catalog, alternate sources (winget, Chocolatey, Microsoft
  Store), and recurring schedule dispatch.
- Live Response, Win32/Intune app deployment, Missing KBs remediation, and
  Windows Update rings/quality/feature-update campaigns.
- Users & Roles — in-app user management and RBAC.
- Remediation History — an attributed ledger of every closed finding.
- Reports v2 — branded PDF reports, AI narration, CSV metric exports.
- Self-hosted AI layer — chat assistant, page summaries, report generation.
- Redis-backed sessions and MSAL background-access lifecycle fixes.
- Setup Health consolidation and an Architecture topology page.
- Dashboard overhaul: charts, posture trends, CVE trend, SLA compliance
  heatmap, exclusion/exception banners.
- Device exclusion and Defender-parity enforcement.
- Script Catalog: types, upload, bulk actions, export.
- Fix for Live Response KB jobs always reporting failure.

### Pre-ship gap review (this pass)

Following an internal scope audit (see the project's gap-analysis notes),
the following were added to close gaps found before a wider production
rollout:

- GitHub Actions CI running typecheck/test/build on every PR.
- Real ESLint configuration replacing the placeholder `lint` script.
- Outbound throttling/backoff for Microsoft Graph/Defender calls.
- Automated Postgres backup script and documented restore procedure.
- Query-level tenant filtering for the AI assistant (previously filtered
  post-fetch).
- `apps/web` Playwright end-to-end coverage for schedule create/edit and
  Fix Now/Fix All dispatch.
- Automated migration execution as part of the deploy path.
- Structured (`pino`) logging in `apps/worker`, replacing raw `console.log`.
- `GET /api/health` now checks Postgres/Redis reachability instead of being
  a liveness-only stub.
- CSRF protection for mutating routes.
- `session.regenerate()` on login to close a session-fixation gap.
- Consistent "(preview)" labeling for remediation channels that don't
  dispatch for real yet (Microsoft Store, Script Catalog, Intune
  remediation scripts), across every channel that lists them.
- `CONTRIBUTING.md`, `LICENSE`, and this changelog.
- An in-app Help page (`/help`), replacing a bare access-denied placeholder
  as the only in-app reference surface.
- Integration test suite (`pnpm --filter @patchpilot/api test:integration`)
  exercising real Postgres/Redis against an isolated `patchpilot_test`
  database and Redis logical DB 15 — never the databases real tenant data
  lives in.

## Phase 5 — Onboarding pairing, vendor entitlement/licensing, custom domains

Merged to `main` alongside the rest of Phase 5.

- Fix for license tenant-count using the wrong consent signal.
- Vendor entitlement/licensing system — a signed entitlement token verified
  against a published public key, gating write scopes and Live Response
  quota by plan.
- Onboarding-pairing flow for provisioning a customer's app registration
  without a manual Entra walkthrough.
- Dynamic OAuth redirect origin resolution (`webOrigins`, replacing a single
  hardcoded `AUTH_REDIRECT_URI`) plus semi-automated custom-domain
  management on the App Registration page — add a `<label>.patchpilot365.com`
  subdomain or a fully custom hostname, verify it via a read-only CNAME
  check, and push the resulting redirect URI(s) into the real Entra app
  registration with one click.
- Templated Azure VM deployment (Bicep + cloud-init, no SSH).
- Removed "BITG"/"Black Iron" branding from all user-facing support,
  instructions, and app-registration text in favor of "PatchPilot Support"
  (`support@patchpilot365.com`).
