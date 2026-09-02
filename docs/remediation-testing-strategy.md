# Remediation testing strategy — Live Response + Winget, real tenant (redacted)

Manual testing strategy for every remediation dispatch entry point (Fix Now / Fix All /
Run Now) across Vulnerabilities, Security Recommendations, Devices, and Inventories.
There is no e2e/UI test framework in this repo (Vitest only covers domain logic in
`apps/api` and `packages/shared`), so this is the checklist a human runs in the browser.
Sibling to [`live-smoke-test.md`](./live-smoke-test.md), which covers tenant sync, not
remediation.

**Scope this round:** the **Defender Live Response** channel dispatching a **Winget**
package, against **app-type (CVE) findings**, on a real (non-demo) tenant
(`DEMO_MODE=false`; tenant/device names below are placeholders — substitute your own
when re-running this). Missing-KB/OS Live Response is
named as a secondary scenario (same channel, no winget package involved). Everything
else — Chocolatey, Win32 App, Intune Remediation, Expedited Quality Update, Script
Catalog, manual remediation, and `Devices.tsx`'s device-level "Fix all" — is out of
scope; see [Out of scope](#out-of-scope-this-round).

## Safety model

- **Dry-run is the default and, for this pass, the only mode that runs to completion.**
  Every test case stops at a green **Preview & checks** (preflight) panel. Nothing is
  dispatched — `tenants.readOnly` stays whatever it currently is, no job is queued.
- **A separate, narrow Phase 2** (below) covers real dispatch against 1-2 already-covered
  cases. Each one requires an explicit go-ahead in chat before clicking anything that
  fires a job — this mirrors the standing rule that no remediation gets dispatched
  against a real device without per-instance confirmation.
- `DEMO_MODE=false` in the running dev environment, so nothing here is simulated —
  Preview & checks hits the real preflight route (`POST /api/preflight`), and Phase 2
  dispatch would hit real Microsoft Graph / Defender Live Response.
- If `tenants.readOnly` is `true` for this tenant (Settings → Tenants), Fix Now buttons
  disable and preflight reports read-only — that's expected, not a bug, until it's
  intentionally toggled off for Phase 2.

## Preconditions (check once before starting)

- [ ] Tenant read-only posture matches what you intend to test (on for dry-run-only, off
      before Phase 2). Settings → Tenants.
- [ ] Live Response is enabled under Defender's **Advanced features** for this tenant —
      preflight does **not** check this; a false-green preview can still fail at dispatch.
- [ ] Candidate devices (below) are online/recently checked in — preflight only warns on
      staleness, it doesn't confirm current reachability.
- [ ] Signed in as an MSP engineer against the real tenant, not the demo engineer.

## Test candidates

**Primary — Google Chrome** (CVE finding, winget package `Google.Chrome`, auto-matched):
installed on 4 devices tenant-wide; exposed/outdated on 2 — **DESKTOP-01**
(151.0.7922.72) and **WKS-02** (150.0.7871.187) — latest is 151.0.7922.76.
- Single-device cases → **DESKTOP-01**.
- Multi-device cases → **{DESKTOP-01, WKS-02}**.

**Secondary — Missing KB (non-winget)**: **KB5066835** (October 2025 Security Updates)
on device **LAPTOP-03**, single device, 0 CVEs.

If Chrome's data has since drifted (versions patched, device list changed), re-derive
from Inventories → Google Chrome row → drill-down panel, and Vulnerabilities → Missing
KBs tab for the KB candidate.

## What Preview & checks validates — and what it doesn't

Preflight (`apps/api/src/routes/preflight.ts`) **blocks** on: consent, tenant read-only
posture, licensing, patch-type fit, device-target-id presence, winget/alt-source package
mapping presence, manual-remediation blocklist. It only **warns** on: device last-seen
staleness, install-scope per-user caveats. It does **not** check: Live Response Advanced
Features enablement, device online/reachability right now, winget match confidence or
method (auto-matched vs. manual override isn't surfaced beyond a boolean badge),
concurrent Live Response sessions against the same device, or the signed-in-user
precondition for per-user installs. Treat a green preflight as "correctly configured,"
not "guaranteed to succeed" — the manual checks above still matter.

## Test case template

Each case below follows this shape:

- **Steps** — how to reach the modal and what to select (Remediation Option: Patch;
  Catalog: Winget; Method: Live Response).
- **Expected** — preflight/preview panel shows a valid plan: correct device(s), correct
  package (`Google.Chrome` or the KB), no blocking errors.
- **Stop here** — close the modal without clicking Dispatch/Fix.

## Test cases (in scope)

| # | Entry point | Steps | Expected |
|---|---|---|---|
| 1 | Vulnerabilities → By CVE / By software → Run now (`Vulnerabilities.tsx:1596`) | Find the Chrome CVE row, click Run now, select Winget/Live Response | Preflight green for DESKTOP-01 + WKS-02 (multi) or either alone (single) |
| 3 | Security Recommendations → Run now (`Recommendations.tsx:1354`) | Find the Chrome recommendation, click Run now | Same as #1, from the recommendation-driven target |
| 4 | Devices → DESKTOP-01 → Findings → Fix Now (`Devices.tsx:2393`) | Select DESKTOP-01, find the Chrome finding, Fix Now | Preflight green, device locked to DESKTOP-01 |
| 7 | Devices → DESKTOP-01 → Inventories tab → Fix Now (`Devices.tsx:2525`) | Same device, Inventories tab, Chrome row, Fix Now | Preflight green, `softwareId` inventory mode, locked device |
| 8 | Devices → DESKTOP-01 → Inventories tab → Fix all (`Devices.tsx:2555`, `SoftwareInventoryFixAllModal`) | Fix all button on the tab | Older dialog — confirm it still lists Chrome with a valid winget package id per device; no full preflight panel here (expected) |
| 9 | Inventories → Google Chrome row → Fix Now (`SoftwareInventory.tsx:402`) | Table row Fix Now — opens locked to whichever device the row targets | Preflight green |
| 10 | Inventories → Google Chrome drill-down → Fix all (`SoftwareInventory.tsx:417`) | Click into the Chrome row, "Fix all" in the panel | Preflight green, device checklist shows DESKTOP-01 + WKS-02 with "Select all" |
| 11 | Inventories → Google Chrome row → "Fix Now" (multi-device) (`SoftwareInventory.tsx:435`) | Table row's other trigger (multi-device despite the label) | Same as #10 |
| 12 | Winget Catalog → Google Chrome → Run Now (`Catalog.tsx:567`) | Catalog page, Chrome entry, Run Now | Preflight green, catalog-initiated target matches #1 |

## Secondary scenario — Missing KB (non-winget, still Live Response)

| # | Entry point | Steps | Expected |
|---|---|---|---|
| 2 | Vulnerabilities → Missing KBs tab → Fix now (`Vulnerabilities.tsx:1584`, `MissingKbFixNowModal`) | Find KB5066835, device LAPTOP-03, Fix now | Modal shows the WUA/KB script target, not a winget package — confirms this path is live and distinct from #1-#12 |
| 5 | Devices → LAPTOP-03 → Missing KB → Fix Now (`Devices.tsx:2414`) | Same KB from the device view | Same confirmation, device-locked |

## Phase 2 — real dispatch (explicit go-ahead required per case)

Only after all dry-run cases above pass. Recommended minimal set:

1. **Single-device**: case #9 (Inventories → Chrome → Fix Now → DESKTOP-01). Confirm in
   chat before clicking Dispatch.
2. **Multi-device**: case #1 or #10 (Chrome → {DESKTOP-01, WKS-02}). Confirm in chat
   before clicking Dispatch — this fires two Live Response sessions.

After each dispatch: watch the **Jobs** page for the job's transcript/exit code, and the
**Audit Log** for the recorded action. A successful run ends with the script's
`PatchPilot-Exit: 0` sentinel in the transcript (Defender's own exit code is ignored by
design — see `apps/worker/src/live-response.ts`). Expect up to ~4 minutes before a
timeout would indicate the device didn't respond (`POLL_TIMEOUT_MS`).

## Out of scope this round

Chocolatey Catalog Run Now (#13), Win32 App channel, Intune Remediation channel,
Expedited Quality Update channel, Script Catalog, manual remediation, and
`Devices.tsx`'s device-level "Fix all" (`FixAllModal`, #6 — channel-agnostic, multi-
finding, would need its own pass). Named here so a future round can pick them up without
re-deriving the entry-point map.
