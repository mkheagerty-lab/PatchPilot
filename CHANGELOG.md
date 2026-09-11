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

## [0.15.0] - 2026-09-11

- New Settings > Server Health page: live CPU/Memory/Disk graphs, PostgreSQL/Redis
  reachability tiles, BullMQ queue depth + worker liveness, and per-schedule
  healthy/stuck status for every enabled recurring schedule. Admins can restart
  the api or worker process directly from the page, each gated behind a
  confirmation dialog (`settings:write` only — visible read-only to every other
  role). A new Containers tab adds confirmed restart actions for individual
  infra containers (caddy, web, api, worker, backup, ollama, postgres, redis)
  and the whole compose stack, queued through the `updater` sidecar the same
  way self-updates already are — also `settings:write` only.
- Windows Update Policies: existing Quality Update, Feature Update, Update
  Ring, and Driver Update rows across all four tabs are now clickable,
  opening a detail drawer with the full policy settings (assignments,
  deferral/reboot windows, deployment options, Intune profile ID, etc.) —
  previously nothing was visible beyond the table's own columns. The "New
  feature-update campaign" modal now matches Intune's own Feature Update
  profile layout more closely: the Optional checkbox sits next to Target
  version, Included/Excluded group pickers moved to the bottom, and the
  removed "Offer starts"/"Offer ends" date pickers are replaced with a
  "Deployment options" section showing (a locked, always-selected) "Make
  update available as soon as possible" — the offer window the backend
  still requires is now computed automatically (now → +365 days) rather
  than picked, since the rollout interval is what actually paces the
  offer.

## [0.14.0] - 2026-09-11

- Catalog coverage (`GET /api/catalog/coverage` and
  `/api/chocolatey-catalog/coverage`) no longer scans the full,
  unfiltered `vulnerabilities` table on every request: `loadVulns()` now
  pushes the tenant filter down into SQL (hitting the existing
  `vulns_tenant_idx`) and shares a 60s TTL cache across both routes,
  invalidated whenever a sync writes new vulnerabilities. The Winget and
  Chocolatey catalog browse tables also cap what's rendered into the DOM
  at 200 rows with a "Show more" control (same pattern as the
  Vulnerabilities CVE table), rather than rendering the full ~14.8k-row
  mirror on every visit — the API responses themselves stay unpaginated
  since Recommendations, Devices, and Vulnerabilities all depend on the
  full catalog list for package lookups.
- App Registration's PowerShell instructions (Step 1, Step 3, and client
  secret rotation) now show a single Windows PowerShell command each,
  instead of a redundant `pwsh` variant above it — the `pwsh` line assumed
  a locally-installed PowerShell 7, while every command here is meant to
  run the script downloaded from Step 1, which Windows PowerShell can
  already execute. The remaining command also no longer assumes a
  `scripts\` subfolder relative to the current directory, matching how the
  downloaded file is actually laid out.
- App Registration and Architecture now document that Defender for
  Endpoint's Live Response and its unsigned-script execution are gated
  behind two "Advanced features" toggles in the Microsoft 365 Defender
  portal that no API permission or PowerShell cmdlet can set — a Global
  Administrator has to enable them by hand, once per tenant, with basic
  steps included on both pages.
- Rename "Windows Updates" to "Windows Update Policies" and move it out of
  Operations into Settings — every tab on it (Feature Updates, Quality
  Updates, Update Rings, Driver Updates) manages Intune policy objects, not
  a live per-device work queue, so it belonged with the rest of the
  tenant-configuration pages, not alongside act-now pages like Devices and
  Jobs. The old name also collided in spirit with the Devices page's
  actual patch-status view. The standalone Settings > Target Build page is
  now a fifth tab on this page instead of a separate nav item, since it
  configures the same tenant's Windows-build target the Feature Updates
  tab's campaigns roll out. Old `/windows-updates` and
  `/settings/feature-updates` URLs redirect to the new location.

## [0.13.0] - 2026-09-11

- Fix the Jobs page's "Delete selected" (and per-row "Delete") doing nothing.
  Both were gated on a native `window.confirm()`, which silently returns
  false — with no dialog and no feedback — whenever the browser suppresses
  page dialogs (Chrome's "prevent this page from creating additional
  dialogs", automation, some embedded contexts). They now use the same
  in-app confirmation modal the rest of the app already uses for destructive
  actions. Archive was unaffected because it never prompted.
- Jobs page readability: the Job Name is now bold, a batch's top-level row
  is tinted to stand out from its expanded per-device rows, and the whole
  table (rows, filters, status pills, the bulk-action bar, the detail
  drawer) now has proper dark-mode styling instead of near-black text on a
  dark background.
- The schedule timezone picker and the Schedules table now show each zone's
  current GMT offset alongside its name (e.g. `Australia/Brisbane (GMT+10)`),
  so the intended fire time is unambiguous without cross-referencing the IANA
  name.
- Fix dark mode text/background/chip contrast across the rest of the app
  (tables, modals, badges, and settings/setup pages) — the pass that fixed
  Jobs only covered that one page; this extends the same `dark:` pairings
  to every other page and shared component, including several files (e.g.
  Windows Updates' parent page, Setup Pairing, and a handful of status
  chips) that had never received any dark-mode treatment before, and adds
  missing `dark:` variants for the `orange`/`red`/`violet` color families
  that earlier passes only covered for `rose`/`amber`/etc.

## [0.12.0] - 2026-09-10

- Fix recurring schedules missing their fire. The worker's 30s reconcile
  loop re-registered every BullMQ job-scheduler on every pass; because
  `upsertJobScheduler` runs with `override: true` (which deletes the
  pending next-fire job and recomputes from now), any worker restart while
  a fire was overdue-but-unrun — credential rotation, a deploy, a
  self-update — silently skipped that occurrence. A weekly schedule then
  missed almost every week. The reconciler now leaves an unchanged
  job-scheduler alone, and only re-arms one whose cron/timezone changed or
  whose pending fire was genuinely lost (missing or more than 10 minutes
  overdue).
- Recurring schedules now fire in a chosen timezone instead of always
  UTC. The schedule form captures the creating engineer's browser zone
  (editable, full IANA list), stored on a new `schedules.timezone` column
  and passed straight through to BullMQ; existing rows default to `UTC`,
  which is the behaviour they already had.

## [0.11.1] - 2026-09-10

- Fix tenant sync failing with `MAX_PARAMETERS_EXCEEDED` on larger tenants:
  the per-tenant device, software, CVE, vulnerability-link, missing-KB, and
  remediation-event writes each built a single multi-row INSERT that
  exceeded PostgreSQL's 65534 bind-parameter cap once a tenant had enough
  devices. Those inserts are now batched via a shared `insertInChunks`
  helper.

## [0.11.0] - 2026-09-07

- Add a self-service "Enable Demo Mode" button to the Pairing Page so a
  prospect or evaluator can turn an unpaired instance into a fully
  interactive sandbox with one click, no redeploy or real tenant
  connection required. Demo mode now also has proper mock data and
  simulated create/edit/delete actions for Windows Updates and the Script
  Catalog, and Reports serves a real sample PDF instead of a dead end.
  Fictional demo data no longer reuses the MSP's own branding.

## [0.10.0] - 2026-09-07

- Add a Check Access tab to Setup Health so an engineer (or an admin, on
  another user's behalf) can see exactly where they stand across
  PatchPilot's role, home-tenant Entra roles, and per-customer-tenant GDAP
  roles, instead of guessing which of the three is blocking them.
- App Registration Step 1 now offers Windows PowerShell cmdlet variants
  alongside the existing pwsh ones; Step 3's "Add API Permissions" moved
  into a new "Option 1: Browser" action, with "Option 2: PowerShell"
  gaining matching manual cmdlets.

## [0.9.0] - 2026-09-07

- Deploy-PatchPilot.ps1 now detects a missing Entra ID P1/P2 license before
  attempting to create the home-tenant access groups (a tenant-wide licensing
  gate, independent of the connected account's own Global Administrator
  role) and gives an actionable warning instead of a misleading "likely
  missing Global Administrator" message. Settings > Users and the
  Architecture page now document the licensing prerequisite and confirm that
  a Global Administrator can still manage the home tenant directly without
  either access group.

## [0.8.0] - 2026-09-06

- Add home-tenant access groups so a PatchPilot user's real Microsoft write
  privilege in the MSP's own tenant is granted and revoked from Settings >
  Users, instead of depending on whatever Entra role they happen to already
  hold; every new user gets read-only access automatically, and write access
  is an explicit, Global-Administrator-confirmed toggle. Architecture page
  now documents both tenants' prerequisites and the Entra role -> API
  permission mapping behind them.

## [0.7.0] - 2026-09-05

- Fix Settings > Branding's "Match colours to logo" actually applying the
  saved primary/secondary/accent/sidebar colours app-wide, not just saving
  them; add the default PatchPilot logo to the device pairing page.
- Setup Health > Connections now reuses App Registration's permission pill
  styling and failed-scope error banners for a consistent look between the
  two pages.
- Add an "Auto-assign" button to Settings > License that evenly splits the
  Live Response device pool across every write-enabled tenant (zeroing
  read-only ones), instead of setting each tenant's allocation by hand.

## [0.6.0] - 2026-09-05

- Make the sidebar collapsible (persisted across reloads) with a slide-in
  drawer for narrow screens, and alphabetize/regroup its nav items — the
  former Operations category now splits actionable pages from a new
  "Reports & Records" group (Reports, Remediation History, Audit Log,
  Inventories).
- Fix the app header, floating chat widget, and page search bars clipping
  or overflowing on phone-width screens.
- Add a shared `ResponsiveTable` component (a real table at tablet width and
  up, stacked cards below it) and migrate every list page — Schedules,
  Audit Log, Software Inventory, Remediation History, Devices,
  Vulnerabilities, Recommendations, and Users — onto it, making those pages
  usable on mobile.

## [0.5.0] - 2026-09-05

- Add a branded login splash page (PatchPilot365 logo, a single "Sign in
  with Microsoft 365" button using the official 4-color Microsoft squares
  mark) shown whenever an already-paired instance has no active session,
  replacing the previous instant, unbranded redirect straight to Microsoft.
  Signing out now returns to this screen instead of bouncing straight back
  into Microsoft's login page.

## [0.4.2] - 2026-09-05

- Fix the self-update sidecar leaving a run permanently stuck at "running"
  when its captured build output happened to get byte-truncated mid
  UTF-8-character — the update itself could succeed while the DB write-back
  recording that success failed. Output is now sanitized to ASCII before
  being written back, with a status-only retry as a second line of defense.

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
- Added PatchPilot365 branding from all user-facing support,
  (`support@patchpilot365.com`).
