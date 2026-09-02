# PatchPilot onboarding & multi-MSP productization design

Status: **design of record**. Phases A, B, and C are implemented.

This document captures the decision to ship PatchPilot as a purchasable multi-tenant
app/service for arbitrary MSPs, the GDAP identity model behind it, and the phased
path to get there. It complements [live-smoke-test.md](./live-smoke-test.md).

---

## The core finding

Customer-tenant access currently uses **On-Behalf-Of** (`acquireTokenForTenant` in
`apps/api/src/auth/msal.ts`), exchanging the engineer's *home-tenant* session token
against each *customer-tenant* authority. OBO can only redeem an assertion **against
the tenant that issued it**. A home-tenant assertion cannot be OBO-exchanged into a
foreign GDAP customer tenant — so the call fails for every customer except those
where the engineer has direct access (the home tenant plus a few guest/consented
ones). This is the root cause of the observed "145 discovered, 139 licensing failed":
not a licensing bug, but the wrong token flow for GDAP.

No amount of admin-consent or callback polish fixes this. The customer-tenant access
path itself must change (Phase B).

---

## Decision: GDAP identity model → delegated Secure Application Model per customer tenant

For reaching **customer** tenants, PatchPilot uses the **delegated Secure Application
Model**: the signed-in engineer's cached refresh token is redeemed silently against
each customer-tenant authority (`https://login.microsoftonline.com/{tenantId}`, scope
`https://graph.microsoft.com/.default` / Defender equivalent). The resulting delegated
token inherits the engineer's GDAP roles in that customer.

> **Why not app-only.** An earlier draft of this decision chose **app-only
> client-credentials** per customer tenant. That is **not supported under GDAP** for
> third-party apps: per Microsoft's GDAP + Secure Application Model guidance, "explicit
> application-only consent to a customer tenant isn't supported," and Entra roles can
> no longer be granted to an *application* via relationships or security-group
> membership. App-only tokens therefore carry **no** GDAP roles into a customer tenant
> (and usually can't even be minted — `AADSTS7000229`, the app SP isn't provisioned
> there). Delegated SAM is the only Microsoft-supported path. See the Phase B section.

Rationale against the architecture invariants:

| Concern | Verdict |
|---|---|
| **GDAP support (decisive)** | Only delegated "app + user" access carries GDAP roles into a customer tenant. App-only is unsupported, so this isn't a trade-off — it's the only working option. |
| **Audit everything (engineer)** | Honoured natively. The token *is* the engineer's, and PatchPilot also records the engineer on every Graph call (`graphGet` → `audit(...)`). |
| **Least privilege per engineer** | Preserved. Each token carries one engineer's GDAP roles; Entra enforces per-engineer privilege, reinforced by PatchPilot's own RBAC + read-only-first + per-tenant write opt-in. |
| **Scale to 145+ tenants** | One cached refresh token per engineer redeems silently per customer authority — no interactive prompt per tenant after login. |
| **Background / scheduled sync** | Not a limitation in practice: the engineer's refresh token is *persisted* (encrypted, in Redis) and self-renews on every silent redemption, so it can be redeemed headlessly with no live request or session behind it. Phase 4's `auto-sync.ts` and `apps/worker`'s schedules run on exactly this — see decision 3 below. |

**Login stays delegated.** The engineer's OIDC Auth Code + PKCE login into PatchPilot
itself (home-tenant authority, audience = PatchPilot's own API) is unchanged. It now
also requests `offline_access`, so MSAL caches the refresh token the customer-tenant
flow redeems.

**Setup requirement:** the app's **delegated** Graph/Defender scopes are admin-consented
**once** in the partner tenant. There is no per-customer SP provisioning and no
security-group membership — an engineer reaches a customer the moment they hold an
active GDAP role for it.

---

## Seamless onboarding for a purchasing MSP

What was done by hand (portal app registration + manual admin consent + PowerShell)
becomes three guided clicks:

1. **Register & consent** — the purchasing MSP runs `Deploy-PatchPilot.ps1` in their
   own tenant (Phase C decision 1). It creates the MSP's own multi-tenant app
   registration + secret, then opens the partner-tenant admin-consent URL **once** to
   consent PatchPilot's **delegated** Graph + Defender permissions. (Phase A fixes the
   callback landing that previously dead-ended on `missing_code`.)
2. **Sign in** — an engineer signs into PatchPilot (Auth Code + PKCE, `offline_access`).
   That single login caches the engineer's refresh token, which the Secure Application
   Model redeems per customer tenant. There is **no** "grant customer access" write
   step — an engineer reaches a customer the moment they hold an active GDAP role for
   it (GDAP forbids granting roles to the application itself).
3. **Discover & sync** — enumerate GDAP relationships, classify each, and call Graph
   only where the engineer's delegated access is real.

`scripts/Deploy-PatchPilot.ps1` is the **per-MSP** registration artifact, run once by
each purchasing MSP in their own tenant (Phase C decision 1).

---

## Phases

### Phase A — make consent + discovery honest — done

Low-risk, unblocks live testing, and turns the discovery results into a classified,
per-tenant reachability breakdown — the diagnostic that exposed the wrong token flow
and motivated the Phase B switch to the delegated Secure Application Model.

- **Consent callback** (`apps/api/src/auth/routes.ts`): handle `admin_consent` / `error`
  query params on `/auth/callback` and render a clean "PatchPilot authorized" landing
  instead of `{"error":"missing_code"}`.
- **Non-throwing, classified licensing** (`apps/api/src/graph/licensing.ts`):
  `detectLicenses` returns a per-tenant probe (`reachable` / `consent-needed` /
  `throttled` / `unreachable`) with the real HTTP status instead of throwing. This turns
  "139 failed" into a meaningful breakdown and reveals *why* each tenant fails.
- **Concurrency + persistence** (`apps/api/src/routes/sync.ts`): probe licensing with a
  bounded concurrency limit (throttle mitigation) and persist a `reachability` status per
  tenant.
- **Honest UI** (`apps/web/src/pages/settings/Tenants.tsx`): split the misleading
  "Consent" badge into *Relationship* (GDAP status) vs *Reachability* (can PatchPilot
  actually call Graph), and replace the alarming failure count with a status summary.

### Phase B — switch customer access to the delegated Secure Application Model (the real fix) — done

> **Course correction.** An earlier iteration of Phase B used **app-only client
> credentials** for customer tenants. That is **not supported under GDAP**:
> per Microsoft's GDAP + Secure Application Model guidance, "explicit application-only
> consent to a customer tenant isn't supported for third-party application developers
> who use GDAP," and Entra roles can no longer be granted to an *application* via
> relationships or security-group membership. App-only tokens therefore carry **no**
> GDAP roles into a customer tenant (and frequently can't even be minted —
> `AADSTS7000229`, the app SP isn't provisioned there). The only Microsoft-supported
> path is **delegated** "app + user" access via the Secure Application Model, below.

- `acquireTokenForCustomerTenant(engineerUpn, customerTenantId, scopes)` in
  `apps/api/src/auth/msal.ts`: redeems the **engineer's cached refresh token**
  (Secure Application Model) silently against the per-customer authority
  (`https://login.microsoftonline.com/{tenantId}`) via `acquireTokenSilent`. The
  resulting delegated token inherits the signed-in engineer's GDAP roles in that
  customer. **DEMO_MODE hard-blocked** as a backstop, exactly like OBO.
- The refresh token is seeded at login: `redeemLoginCode` (called from
  `/auth/callback`) serializes MSAL's token cache and persists it **encrypted, per
  engineer** in Redis (`pp:msalcache:{upn}`, 90-day TTL) via an `ICachePlugin`. MSAL
  rotates/re-persists the RT on each silent acquisition. `LOGIN_SCOPES` includes
  `offline_access` to obtain it. Logout clears the cache (`clearMsalCache`).
- `resolveToken` in `apps/api/src/graph/client.ts` branches on
  `tenantId === homeTenantId`: the **home tenant** uses the delegated OBO path;
  **customer tenants** use the SAM refresh-token path. Both are delegated and carry
  the engineer's identity, so **every** minted token now caches **per engineer**
  (the old shared `@app-only` principal is gone).
- `graphGet` still audits the real engineer regardless of which flow minted the
  token (invariant #3 intact). All other call sites (licensing probe, sync) flow
  through `graphGet` unchanged, so Phase A's reachability classification now
  reflects real delegated outcomes.

**Deployment prerequisite (gates real-tenant success, not the code):** the app
registration needs its **delegated** Graph/Defender permissions admin-consented in
the MSP (partner) tenant *once* — no per-customer admin consent and no per-customer
SP provisioning. The signed-in engineer must hold the relevant GDAP roles for each
customer relationship; the delegated token inherits them. If the engineer lacks the
role (or the relationship lapses), Graph returns 403 — which Phase A surfaces
honestly as `consent-needed`.

### Phase C — productize onboarding — done

Three decisions, settled, shape the implementation:

**1. Distribution model: per-MSP app registration (NOT a shared publisher app).**
Each purchasing MSP runs `Deploy-PatchPilot.ps1` in their *own* tenant; the script
creates that MSP's own app registration, client secret, and `.env`. The app is still
`AzureADMultipleOrgs` (multi-tenant) so the single per-MSP app reaches that MSP's many
GDAP *customer* tenants — but the **identity is per-MSP, not shared**.

Why not a shared publisher app: PatchPilot is a confidential client, so the client
secret must live wherever the OBO / refresh-token exchange runs — i.e. inside each
MSP's self-hosted API. A single publisher app would force the publisher's secret into
every MSP's `.env`; one leaked `.env` would compromise the publisher identity across
*all* MSPs at once. That violates the self-hosted / secrets-in-`.env` / per-tenant
isolation invariants (#2, #5, #8) and isn't fixable by rotation without breaking
everyone. Entra also won't let a customer attach their own credential to the
publisher's app object, so the "hybrid" variant collapses back to per-MSP anyway.
"Seamless" is delivered by polishing the installer + an in-app status surface, **not**
by centralizing identity.

**2. Grant customer access: delegated GDAP, consented once — no per-customer writes.**
Customer access flows through the engineer's GDAP roles via the Secure Application
Model (Phase B). There is **no** scripted SP-into-security-group step and **no**
per-customer admin consent: that approach is unsupported under GDAP (see the Phase B
course-correction). The MSP admin consents to PatchPilot's **delegated** Graph/Defender
permissions **once** in the partner tenant when running `Deploy-PatchPilot.ps1`. From
then on, any engineer who holds the GDAP role for a customer gets a delegated token for
it automatically. The app stays **read-only-first** (invariant #6) and never modifies
directory objects at runtime.

**3. Background/scheduled sync: engineer-credentialed, not engineer-triggered.**
Discover + first sync stay engineer-triggered (they need a live login-token exchange),
but the delegated model does not require a live session for every subsequent run: MSAL
persists each engineer's refresh token (encrypted, in Redis, `packages/graph/src/msal.ts`)
and it self-renews on every silent redemption. Phase 4's `apps/api/src/graph/auto-sync.ts`
redeems that cache headlessly on an hourly loop, and `apps/worker`'s cron schedules do
the same per schedule owner — no separately designed service identity was needed.

The one thing this required getting right: sign-out must not destroy that persisted
cache, since ending a browser session and revoking background access are different
actions. `/auth/logout` used to conflate them (clearing the cache on every sign-out),
which silently broke auto-sync and schedules once the owning engineer logged out.
Sign-out now only clears short-lived derived tokens; real revocation is an explicit
admin action (Settings > Users > "Revoke access") or an automatic side effect of
disabling/deleting the account.

The **in-app onboarding surface is a guided status/verification view, not a write tool**
(`apps/web/src/pages/setup/AppRegistration.tsx`): it shows the one-time partner-tenant
consent link and each customer's Phase A `reachability`, telling the operator which
tenants are reachable vs. need a GDAP role granted/renewed. Graceful degradation
(invariant #4) lives here: reseller-only and unlicensed tenants render as calm
informational rows, never errors or dead buttons.

One deliberate, narrow exception: the **"Sync permissions" action** on that same page
(`packages/graph/src/app-registration-sync.ts`, wired through
`apps/api/src/routes/onboarding.ts` and a state-discriminated branch of
`/auth/callback` in `apps/api/src/auth/routes.ts`) does write to Entra — it applies
`scopes.ts`'s current requested Graph/Defender/Partner Center scopes to an
**already-existing** app registration and refreshes its admin consent, replacing a
manual `Deploy-PatchPilot.ps1` re-run whenever a scope is added. It stays consistent
with the "not a write tool" framing above for three reasons: it operates on an app
the script already created (first-time creation is still the script's job, invariant
#7); it authenticates with a separate, one-time step-up consent scoped to exactly
`Application.ReadWrite.All` + `DelegatedPermissionGrant.ReadWrite.All` — never a
standing credential, never persisted to Redis or an engineer's MSAL cache; and it's
gated behind `settings:write` plus an explicit in-app confirmation before the
Microsoft redirect ever fires. This was a deliberate, scoped addition, not an
erosion of the boundary — a new class of Entra write belongs back in this document,
not slipped in silently.

---

## Settled / deferred items

- **Delegated GDAP role inheritance** is the access mechanism: a customer-tenant token
  is minted from the signed-in engineer's refresh token and inherits that engineer's
  GDAP roles. No SP-into-security-group step exists (it's unsupported under GDAP).
  Phase A's per-tenant reachability output remains the cheapest way to confirm access
  against live GDAP tenants after deployment.
- **Scheduled/background sync** ships as of Phase 4 (decision 3 above), running on each
  engineer's persisted, self-renewing MSAL cache rather than a separate service identity.
- Partner Center: the reseller relationship is real, but reseller-only ≠ API access.
  Partner Center API stays relevant only for relationship metadata, not customer data —
  such tenants degrade to an informational row, never a dead Sync button.
