# Changelog

All notable changes to PatchPilot are recorded here, grouped by development
phase. This project does not yet follow semantic versioning (no tagged
releases exist) — entries are ordered oldest-first within each phase, matching
commit order.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Once
this ships as a versioned product, new entries should move to an "Unreleased"
section at the top and get cut into dated version sections on release.

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
