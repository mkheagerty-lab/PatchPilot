import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type OnboardingReport,
  type CustomDomain,
  type DomainsReport,
  type DomainType,
  type DomainAvailability,
} from "../../lib/api";
import { GRAPH_WRITE_GATED_SCOPES, DEFENDER_WRITE_GATED_SCOPES } from "@patchpilot/shared";
import { Card, PageHeader, CopyButton } from "../../components/ui";
import { ScopeList } from "../../components/ScopeList";
import { useCan } from "../../lib/auth";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700">
          {value}
        </code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

/**
 * One numbered step in the "Get started" panel. The circled index keeps the
 * three setup actions visually ordered the way an MSP works through them.
 */
function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  /** Shows a green "Completed" tag next to the title — for a step whose
   * completion is inferred from server state rather than tracked directly
   * (see GettingStarted's callers), so re-running the step's own action
   * (re-registering, rotating a secret) stays available either way. */
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3.5">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium text-slate-800">{title}</div>
          {done && (
            <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
              Completed
            </span>
          )}
        </div>
        <div className="mt-1.5 text-sm text-slate-500">{children}</div>
      </div>
    </li>
  );
}

/**
 * Guided four-step onboarding for a freshly-deployed MSP. Steps 1 and 2 —
 * creating the app registration and granting Partner tenant admin consent for
 * its read-only permissions — are both normally completed automatically in
 * the same run of the Step 1 pairing script (Deploy-PatchPilot.ps1 grants
 * consent programmatically right after creating the service principal); the
 * button in Step 2 is the fallback for the rare case where that run warned it
 * couldn't auto-consent. Step 3 is optional and NOT part of pairing — it's
 * the only place remediation WRITE scopes ever get requested. Step 4 (tenant
 * discovery) is also never run automatically, by pairing or the script — it
 * only ever prints "run Discover" as a manual instruction, so an engineer
 * always has to click through it here themselves. Hidden entirely in demo
 * mode, where nothing here could authorize or discover anything real.
 */
function GettingStarted({ report }: { report: OnboardingReport }) {
  const deployCmd = "pwsh ./scripts/Deploy-PatchPilot.ps1";
  const cloudShellCommand = `& ([scriptblock]::Create((irm "${window.location.origin}/api/onboarding/pairing-script")))`;
  const canWrite = useCan("settings:write");
  return (
    <Card className="border-slate-900/10 bg-gradient-to-br from-slate-50 to-white">
      <h2 className="mb-1 text-sm font-semibold text-slate-800">Get started</h2>
      <p className="mb-4 text-sm text-slate-500">
        Four steps connect PatchPilot to your MSP tenant — the first two are
        normally already done for you by the time pairing finishes.
      </p>
      <ol className="space-y-5">
        <Step
          n={1}
          title="Deploy the app registration"
          // Reaching this authenticated page in non-demo mode already proves
          // config.ENTRA_CONFIGURED is true — an app registration exists and
          // this instance is paired to it. No separate live check needed.
          done
        >
          Run the installer once as a Global Administrator. It creates the Entra
          app, configures the read-only permissions below, grants Partner tenant
          admin consent for them (Step 2), and either writes your{" "}
          <code className="font-mono text-xs">.env</code> (self-hosted) or pairs
          directly with this instance (hosted) — all in this one run. Choose
          whichever matches how you're set up:

          <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50/50 p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
              Option 1: Azure Cloud Shell
              <span className="inline-flex items-center rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                Recommended
              </span>
            </p>
            <p className="mt-1 text-xs text-slate-500">
              No local PowerShell needed, and your tenant ID is detected
              automatically from the signed-in session. Paste this:
            </p>
            <div className="mt-1.5 flex items-start gap-2">
              <code className="flex-1 whitespace-pre-wrap break-all rounded bg-slate-100 px-2 py-1.5 font-mono text-[11px] text-slate-600">
                {cloudShellCommand}
              </code>
              <CopyButton value={cloudShellCommand} />
            </div>
            <a
              href="https://shell.azure.com/powershell"
              target="_blank"
              rel="noreferrer"
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-md bg-[#0078d4] px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#106ebe]"
            >
              Open Azure Cloud Shell ↗
            </a>
          </div>

          <div className="mt-2.5 rounded-lg border border-slate-200 bg-slate-50/50 p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
              Option 2: PowerShell
              <span className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                Manual
              </span>
            </p>
            <p className="mt-1 text-xs text-slate-500">
              For local machines or instances that aren't hosted in Azure.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <a
                href="/api/onboarding/pairing-script"
                download
                title={
                  !canWrite ? "Your role doesn't include settings write access." : undefined
                }
                onClick={(e) => {
                  if (!canWrite) e.preventDefault();
                }}
                aria-disabled={!canWrite}
                className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-slate-900"
              >
                Download PowerShell Script
              </a>
              <span className="text-xs text-slate-400">
                Pre-fills the pairing token — this instance restarts
                automatically once it runs.
              </span>
            </div>
            <p className="mt-2.5 text-xs text-slate-400">
              Prefer to run it unmodified and hand-edit{" "}
              <code className="font-mono text-xs">.env</code> yourself? Copy
              this into an elevated PowerShell from the repo root instead:
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600">
                {deployCmd}
              </code>
              <CopyButton value={deployCmd} />
            </div>
          </div>
        </Step>

        <Step
          n={2}
          title="Grant Partner tenant admin consent (Read-only)"
          done={report.homeTenantConsented}
        >
          Normally already granted for you — Step 1&apos;s pairing script
          approves PatchPilot&apos;s read-only access in your own tenant
          programmatically in that same run. Only use the button below if that
          run warned it couldn&apos;t auto-consent, or you need to (re-)approve
          by hand. This is what lets the first discovery succeed — without it,
          tenant reads come back <span className="font-medium text-amber-700">403</span>.
          Must be approved by a Global Administrator account.
          <div className="mt-2.5">
            <a
              href={report.homeConsentUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700"
            >
              Grant admin consent
              <span aria-hidden>↗</span>
            </a>
          </div>
          <p className="mt-1.5 text-xs text-slate-400">
            Opens the Microsoft admin-consent prompt for tenant{" "}
            <code className="font-mono">{report.tenantId}</code> in a new tab.
          </p>
        </Step>

        <Step n={3} title="Add write API permissions (optional)">
          <p>
            Read-only permissions should already be applied — from pairing
            (Step 1) or a manual Step 2 grant. Come back here only if you need
            write-capable remediation (Live Response, Intune device
            management, Windows Update).
          </p>
          <p className="mt-1.5">
            Check{" "}
            <span className="font-medium text-slate-600">
              Include remediation write scopes
            </span>
            , click{" "}
            <span className="font-medium text-slate-600">Add API Permissions</span>
            , and approve as a Global Administrator. Then run{" "}
            <span className="font-medium text-slate-600">Test Connection</span>{" "}
            to confirm each permission below is actually live.
          </p>
          <div className="mt-3">
            <RequestedPermissionsStep report={report} />
          </div>
        </Step>

        <Step n={4} title="Discover your tenants">
          Pull in your home tenant and any GDAP customers, then probe access and
          licensing. Unlike the steps above, this one is never run
          automatically — it always needs a manual click here.
          <div className="mt-2.5">
            <Link
              to="/settings/tenants"
              className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700"
            >
              Go to Tenants → Discover
            </Link>
          </div>
        </Step>
      </ol>
    </Card>
  );
}

/**
 * The body of Get Started's Step 3 ("Add write API permissions"). This is
 * the one narrow exception to "the in-app console never writes to Entra" —
 * see README invariant #7. "Add API Permissions" reuses the app's existing
 * /auth/callback redirect to run a one-time step-up consent
 * (apps/api/src/routes/onboarding.ts + apps/api/src/auth/routes.ts), applying
 * whatever scopes.ts currently requests to an *already-existing* app
 * registration. "Test Connection" is the read-only counterpart (same step-up
 * mechanics, calls testAppRegistrationScopes instead) — it never mutates
 * anything, just reports each scope's live status as a colour-coded pill,
 * which also drives the failed-scope banners below (a "failed" status means
 * the scope isn't published on the resource's own service principal at all —
 * for Partner Center that's almost always a GDAP misconfiguration; for
 * Defender/Graph it usually just means Deploy-PatchPilot.ps1/Sync hasn't run
 * yet). Licensing is a separate, genuine question a "failed" status can't
 * answer — a resource's delegated-permission catalog ships identically to
 * every tenant regardless of subscription tier, so a Defender/Intune scope
 * can be published *and* granted (an "ok" pill) on a tenant with no matching
 * license at all. That real answer comes from checkTenantLicensing's
 * `/organization` assignedPlans read, riding along on the same Test
 * Connection run, and renders as the separate amber "Not licensed" banner
 * below when it finds a gap. First-time creation still needs
 * Deploy-PatchPilot.ps1. In demo mode neither action could authorize or check
 * anything real, so this falls back to a plain read-only list.
 */
/**
 * Runs "Test Connection" without leaving the page: loads
 * /api/onboarding/test-connection/start?silent=1 in a hidden iframe, which
 * requests prompt=none instead of the normal interactive redirect (see
 * apps/api/src/routes/onboarding.ts + auth/routes.ts's
 * SILENT_TEST_CONN_STATE_PREFIX). If the engineer still has an active
 * Microsoft SSO session — true for almost every case now that Sync grants
 * these scopes tenant-wide — the hidden callback postMessages `{ok: true}`
 * back here and this just re-fetches the report in place. If it can't
 * complete silently (no SSO session, a Conditional Access step-up) the
 * callback posts `{ok: false}`, or nothing arrives at all before the
 * timeout — either way this falls back to today's visible full-page redirect
 * rather than leaving the button looking like it did nothing.
 */
function runSilentTestConnection(onSettled: (ok: boolean) => void): void {
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.setAttribute("aria-hidden", "true");

  let settled = false;
  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    window.removeEventListener("message", onMessage);
    iframe.remove();
    onSettled(ok);
  };

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as { source?: string; ok?: boolean } | null;
    if (!data || data.source !== "patchpilot-test-connection") return;
    finish(data.ok === true);
  };

  // Generous but bounded: a real prompt=none round trip is normally under a
  // second, but this accounts for a slow tenant/network before giving up and
  // falling back to the visible redirect.
  const timer = window.setTimeout(() => finish(false), 8000);

  window.addEventListener("message", onMessage);
  iframe.src = "/api/onboarding/test-connection/start?silent=1";
  document.body.appendChild(iframe);
}

function RequestedPermissionsStep({ report }: { report: OnboardingReport }) {
  const canWrite = useCan("settings:write");
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [includeWriteScopes, setIncludeWriteScopes] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);

  if (report.demoMode) {
    return (
      <div className="space-y-4">
        <ScopeList title="Microsoft Graph" scopes={report.scopes.graph} />
        <ScopeList title="Defender for Endpoint" scopes={report.scopes.defender} />
        <ScopeList title="Partner Center" scopes={report.scopes.partnerCenter} />
      </div>
    );
  }

  const statusMap = new Map(
    (report.scopeStatus?.results ?? []).map((r) => [`${r.resource}:${r.scope}`, r.status]),
  );
  const statusFor = (resource: string, scope: string) => statusMap.get(`${resource}:${scope}`);
  const scopesSyncNeeded = report.scopesSyncNeeded;

  const failedByResource: Record<"graph" | "defender" | "partnerCenter", string[]> = {
    graph: [],
    defender: [],
    partnerCenter: [],
  };
  for (const r of report.scopeStatus?.results ?? []) {
    if (r.status === "failed" && r.resource in failedByResource) {
      failedByResource[r.resource as keyof typeof failedByResource].push(r.scope);
    }
  }
  const failedBanners: { key: string; label: string; scopes: string[]; hint?: string }[] = [
    { key: "graph", label: "Microsoft Graph", scopes: failedByResource.graph },
    {
      key: "defender",
      label: "Defender for Endpoint",
      scopes: failedByResource.defender,
      hint: "Check licensing.",
    },
    {
      key: "partnerCenter",
      label: "Partner Center",
      scopes: failedByResource.partnerCenter,
      hint: "Check GDAP configuration.",
    },
  ].filter((b) => b.scopes.length > 0);

  // Real licensing signal (checkTenantLicensing, packages/graph/src/app-registration-sync.ts) —
  // independent of the scope-publish/grant checks above, which can't see licensing
  // at all: a Defender/Intune scope can be published and granted (no "failed"
  // banner) yet still be backed by no license. "unavailable" (no result yet, or
  // the read couldn't run) never renders anything here — only a real "this
  // tenant doesn't hold that license" answer does.
  const licensing = report.scopeStatus?.licensing;
  const missingCapabilities: string[] =
    licensing?.status === "detected"
      ? [
          !licensing.licenses.some((l) => l === "mde-p2" || l === "defender-business-premium") &&
            "Defender for Endpoint",
          !licensing.licenses.includes("intune") && "Intune",
        ].filter((v): v is string => typeof v === "string")
      : [];

  return (
    <div className={scopesSyncNeeded ? "rounded-lg border border-amber-300 p-3" : undefined}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            {scopesSyncNeeded && (
              <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                Sync needed
              </span>
            )}
          </div>
          {scopesSyncNeeded && (
            <p className="mt-1.5 text-xs text-amber-700">
              PatchPilot now requests different permissions than this app
              registration was last synced to — likely a recent upgrade. Run
              Add API Permissions to bring it up to date.
            </p>
          )}
          {report.scopeStatus && (
            <p className="mt-1.5 text-xs text-slate-400">
              Last tested {new Date(report.scopeStatus.checkedAt).toLocaleString()}.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={testingConnection}
            onClick={() => {
              setTestingConnection(true);
              runSilentTestConnection((ok) => {
                if (ok) {
                  setTestingConnection(false);
                  void qc.invalidateQueries({ queryKey: ["onboarding"] });
                } else {
                  // Couldn't complete silently — fall back to the visible
                  // redirect, which always works (it's today's flow).
                  window.location.href = "/api/onboarding/test-connection/start";
                }
              });
            }}
            title="Read-only — checks each permission's live status without changing anything."
            className="rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-wait disabled:opacity-70"
          >
            {testingConnection ? "Testing…" : "Test Connection"}
          </button>
          <button
            type="button"
            disabled={!canWrite}
            title={!canWrite ? "Your role doesn't include settings write access." : undefined}
            onClick={() => setConfirming(true)}
            className="rounded-md bg-slate-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add API Permissions
          </button>
        </div>
      </div>

      {!canWrite && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Your role doesn&apos;t include settings write access.
        </div>
      )}

      {failedBanners.map((b) => (
        <div
          key={b.key}
          className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
        >
          <span className="font-medium">{b.label}:</span> {b.scopes.length} permission
          {b.scopes.length === 1 ? "" : "s"} not found on the resource — {b.scopes.join(", ")}.
          {b.hint && <span className="font-medium"> {b.hint}</span>}
        </div>
      ))}

      {missingCapabilities.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="font-medium">Not licensed:</span> this tenant&apos;s{" "}
          <code className="font-mono text-[11px]">/organization</code> record shows no{" "}
          {missingCapabilities.join(" and ")} entitlement. The matching permissions above can
          still show as granted — a scope being published and consented doesn&apos;t require a
          license, only actually using the feature does — so remediation through{" "}
          {missingCapabilities.join(" or ")} won&apos;t work here until this tenant is licensed
          for it.
        </div>
      )}

      <div className="mt-4 space-y-4">
        <ScopeList
          title="Microsoft Graph"
          scopes={report.scopes.graph}
          resource="graph"
          statusFor={statusFor}
          writeGatedScopes={GRAPH_WRITE_GATED_SCOPES}
        />
        <ScopeList
          title="Defender for Endpoint"
          scopes={report.scopes.defender}
          resource="defender"
          statusFor={statusFor}
          writeGatedScopes={DEFENDER_WRITE_GATED_SCOPES}
        />
        <ScopeList
          title="Partner Center"
          scopes={report.scopes.partnerCenter}
          resource="partnerCenter"
          statusFor={statusFor}
        />
      </div>

      {confirming && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setConfirming(false)}
            aria-hidden
          />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-slate-900">
              Add app registration permissions?
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              You&apos;ll be sent to a Microsoft sign-in to approve two one-time,
              elevated permissions (
              <code className="font-mono text-xs">Application.ReadWrite.All</code>,{" "}
              <code className="font-mono text-xs">
                DelegatedPermissionGrant.ReadWrite.All
              </code>
              ). They&apos;re used once to update the requested scopes above and
              refresh admin consent, then discarded — PatchPilot&apos;s normal
              day-to-day access is unchanged. Must be approved by a Global
              Administrator.
            </p>
            <label className="mt-4 flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={includeWriteScopes}
                onChange={(e) => setIncludeWriteScopes(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Include remediation write scopes
                <span className="block text-xs text-slate-400">
                  Adds the Intune/Windows Update write permissions used for
                  in-app remediation dispatch. Leave unchecked to stay
                  read-only.
                </span>
              </span>
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  window.location.href = `/api/onboarding/sync-permissions/start?includeWriteScopes=${includeWriteScopes}`;
                }}
                className="rounded-md bg-slate-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
              >
                Continue to Microsoft
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const DOMAIN_STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  active: "bg-emerald-100 text-emerald-700",
};

/**
 * Lazily fetches and displays the exact `Deploy-PatchPilot.ps1` one-liner for
 * one domain row — a plain GET, so it needs no confirm step. The script's
 * redirect-URI merge is already additive/idempotent (confirmed by direct
 * read of Merge-RedirectUris), so running it again is always safe even if
 * the redirect URI is already registered.
 */
function RegistrationCommand({ domainId }: { domainId: string }) {
  const { data } = useQuery({
    queryKey: ["domains", domainId, "registration-command"],
    queryFn: () => api.get<{ command: string }>(`/api/domains/${domainId}/registration-command`),
  });
  if (!data) return null;
  return (
    <div className="mt-2 flex items-center gap-2">
      <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600">
        {data.command}
      </code>
      <CopyButton value={data.command} />
    </div>
  );
}

/**
 * Semi-automated custom-domain onboarding for the app registration's OAuth
 * redirect origin allowlist. An admin adds a "<label>.patchpilot365.com"
 * subdomain (PatchPilot Support creates the DNS record out-of-band — no live
 * Cloudflare API in v1) or a fully custom hostname, verifies it with a read-only CNAME
 * lookup (apps/api/src/routes/domains.ts never writes a DNS record itself),
 * and then pushes the resulting redirect URI(s) into the real Entra app
 * registration — either via Application identity's "Sync redirect URIs"
 * button below (same step-up browser consent RequestedPermissionsStep
 * uses), or via the PowerShell one-liner in that same card's "Registration
 * command" section. Hidden in demo mode, where nothing here could resolve or
 * authorize anything real.
 */
function CustomDomainsCard({ demoMode }: { demoMode: boolean }) {
  const qc = useQueryClient();
  const canWrite = useCan("settings:write");
  const [type, setType] = useState<DomainType>("subdomain");
  const [label, setLabel] = useState("");
  const [hostname, setHostname] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  // Result of the last "Check" click — cleared on any edit to type/label/hostname
  // below so it can never be shown (or gate Add domain) against a value the
  // engineer has since changed away from.
  const [checkResult, setCheckResult] = useState<DomainAvailability | null>(null);

  const { data: report } = useQuery({
    queryKey: ["domains"],
    queryFn: () => api.get<DomainsReport>("/api/domains"),
    enabled: !demoMode,
  });

  const addDomain = useMutation({
    mutationFn: () =>
      api.post<CustomDomain>(
        "/api/domains",
        type === "subdomain" ? { type, label: label.trim() } : { type, hostname: hostname.trim() },
      ),
    onSuccess: (row) => {
      setLabel("");
      setHostname("");
      setCheckResult(null);
      setMessage({ tone: "ok", text: `Added ${row.hostname} — follow the instructions below to activate it.` });
      void qc.invalidateQueries({ queryKey: ["domains"] });
    },
    onError: (err) =>
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Failed to add domain." }),
  });

  const checkDomain = useMutation({
    mutationFn: (vars: { type: DomainType; value: string }) => {
      const params = new URLSearchParams({ type: vars.type });
      params.set(vars.type === "subdomain" ? "label" : "hostname", vars.value);
      return api.get<DomainAvailability>(`/api/domains/check?${params.toString()}`);
    },
    onSuccess: (res, vars) => {
      // The field the check was for may have changed while the request was
      // in flight — a result for stale input is worse than no result.
      const stillCurrent = vars.type === type && vars.value === (type === "subdomain" ? label.trim() : hostname.trim());
      if (stillCurrent) setCheckResult(res);
    },
    onError: (err, vars) => {
      const stillCurrent = vars.type === type && vars.value === (type === "subdomain" ? label.trim() : hostname.trim());
      if (stillCurrent) {
        setCheckResult({
          hostname: null,
          available: false,
          reason: err instanceof ApiError ? err.message : "Check failed.",
        });
      }
    },
  });

  const verifyDomain = useMutation({
    mutationFn: (id: string) => api.post<{ verified: boolean; domain: CustomDomain }>(`/api/domains/${id}/verify`, {}),
    onSuccess: (res) => {
      setMessage(
        res.verified
          ? {
              tone: "ok",
              text: `${res.domain.hostname} is active — this instance is restarting to pick it up as a valid login origin.`,
            }
          : {
              tone: "error",
              text: `${res.domain.hostname} isn't resolving to the right target yet${
                res.domain.lastCheckError ? ` (${res.domain.lastCheckError})` : ""
              }. DNS changes can take a while to propagate — try again shortly.`,
            },
      );
      void qc.invalidateQueries({ queryKey: ["domains"] });
    },
    onError: (err) =>
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Verification failed." }),
  });

  const deleteDomain = useMutation({
    mutationFn: (id: string) => api.del<{ deleted: boolean }>(`/api/domains/${id}`),
    onSuccess: () => {
      setPendingDeleteId(null);
      setMessage({ tone: "ok", text: "Domain removed." });
      void qc.invalidateQueries({ queryKey: ["domains"] });
    },
    onError: (err) => {
      setPendingDeleteId(null);
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Failed to remove domain." });
    },
  });

  if (demoMode) return null;

  const domains = report?.domains ?? [];
  const previewHostname =
    type === "subdomain" ? `${label.trim() || "<label>"}.${report?.platformBaseDomain ?? "patchpilot365.com"}` : hostname.trim() || "<hostname>";
  const previewCnameTarget = report?.cnameTarget ?? "";
  const cnameTargetUsable = report?.cnameTargetUsable ?? true;
  const pendingDeleteDomain = domains.find((d) => d.id === pendingDeleteId) ?? null;

  return (
    <Card>
      <h2 className="text-sm font-semibold text-slate-700">Custom domains</h2>
      <p className="mt-1 text-sm text-slate-500">
        Add a PatchPilot subdomain or your own hostname as an additional OAuth
        login origin. Both the existing origin and every active domain below
        stay valid at once — nothing is replaced.
      </p>

      {message && (
        <div
          className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
            message.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-rose-200 bg-rose-50 text-rose-700"
          }`}
        >
          {message.text}
        </div>
      )}

      {!canWrite && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Your role doesn&apos;t include settings write access.
        </div>
      )}

      {report && !cnameTargetUsable && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          This instance&apos;s public hostname (<code className="font-mono">{report.cnameTarget}</code>) isn&apos;t a
          real DNS name, so a CNAME can&apos;t point at it yet. Set <code className="font-mono">PUBLIC_URL</code> (or{" "}
          <code className="font-mono">CUSTOM_DOMAIN_CNAME_TARGET</code>) to the instance&apos;s actual public
          hostname before adding a custom domain.
        </div>
      )}

      <div className="mt-4 rounded-lg border border-slate-200 p-4">
        <div className="flex flex-wrap gap-4 text-sm text-slate-700">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={type === "subdomain"}
              onChange={() => {
                setType("subdomain");
                setCheckResult(null);
              }}
            />
            PatchPilot subdomain
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={type === "custom"}
              onChange={() => {
                setType("custom");
                setCheckResult(null);
              }}
            />
            Custom domain
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          {type === "subdomain" ? (
            <div className="flex-1">
              <label className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Label
              </label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  value={label}
                  onChange={(e) => {
                    setLabel(e.target.value);
                    setCheckResult(null);
                  }}
                  placeholder="acme"
                  className="w-40 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
                <span className="font-mono text-xs text-slate-400">.{report?.platformBaseDomain ?? "patchpilot365.com"}</span>
              </div>
            </div>
          ) : (
            <div className="flex-1">
              <label className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Hostname
              </label>
              <input
                value={hostname}
                onChange={(e) => {
                  setHostname(e.target.value);
                  setCheckResult(null);
                }}
                placeholder="patching.acme.com"
                className="mt-1 w-full max-w-xs rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              />
            </div>
          )}
          <button
            type="button"
            disabled={
              !canWrite ||
              !cnameTargetUsable ||
              checkDomain.isPending ||
              (type === "subdomain" ? !label.trim() : !hostname.trim())
            }
            onClick={() => {
              setMessage(null);
              checkDomain.mutate({ type, value: type === "subdomain" ? label.trim() : hostname.trim() });
            }}
            className="shrink-0 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checkDomain.isPending ? "Checking…" : "Check"}
          </button>
          <button
            type="button"
            disabled={
              !canWrite ||
              !cnameTargetUsable ||
              addDomain.isPending ||
              (type === "subdomain" ? !label.trim() : !hostname.trim()) ||
              (checkResult !== null && !checkResult.available)
            }
            onClick={() => {
              setMessage(null);
              addDomain.mutate();
            }}
            className="shrink-0 rounded-md bg-slate-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {addDomain.isPending ? "Adding…" : "Add domain"}
          </button>
        </div>
        {checkResult && (
          <p className={`mt-2 text-xs font-medium lowercase ${checkResult.available ? "text-emerald-600" : "text-rose-600"}`}>
            {checkResult.available ? "available" : `not available (${checkResult.reason ?? "already in use"})`}
          </p>
        )}
        <p className="mt-2 text-xs text-slate-400">
          Will resolve as{" "}
          <code className="font-mono">{previewHostname}</code>, pointed at{" "}
          <code className="font-mono">{previewCnameTarget || "…"}</code> via CNAME.
        </p>
      </div>

      {domains.length > 0 && (
        <ul className="mt-4 space-y-3">
          {domains.map((d) => (
            <li key={d.id} className="rounded-lg border border-slate-200 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-mono text-sm text-slate-800">{d.hostname}</div>
                  <div className="text-xs text-slate-400">
                    {d.type === "subdomain" ? "PatchPilot subdomain" : "Custom domain"} · added by {d.createdBy}
                  </div>
                </div>
                <span
                  className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
                    DOMAIN_STATUS_STYLES[d.status] ?? DOMAIN_STATUS_STYLES.pending
                  }`}
                >
                  {d.status}
                </span>
              </div>

              {d.instructions.kind === "dns-cname" ? (
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="CNAME name" value={d.instructions.cnameRecord.name} />
                  <Field label="Points to" value={d.instructions.cnameRecord.target} />
                </div>
              ) : (
                <div className="mt-3 flex items-start gap-2">
                  <p className="flex-1 text-xs text-slate-500">{d.instructions.summary}</p>
                  <a
                    href={d.instructions.supportMailto}
                    className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
                  >
                    Email support
                  </a>
                </div>
              )}

              {d.lastCheckError && d.status === "pending" && (
                <p className="mt-2 text-xs text-amber-700">Last check: {d.lastCheckError}</p>
              )}

              <div className="mt-3 flex items-center gap-2">
                {d.status === "pending" && (
                  <button
                    type="button"
                    disabled={!canWrite || verifyDomain.isPending}
                    onClick={() => {
                      setMessage(null);
                      verifyDomain.mutate(d.id);
                    }}
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {verifyDomain.isPending ? "Checking…" : "Verify"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={!canWrite}
                  onClick={() => setPendingDeleteId(d.id)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Delete
                </button>
              </div>

            </li>
          ))}
        </ul>
      )}

      {pendingDeleteDomain && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setPendingDeleteId(null)}
            aria-hidden
          />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-slate-900">Remove this domain?</h2>
            <p className="mt-2 text-sm text-slate-600">
              <code className="font-mono text-xs">{pendingDeleteDomain.hostname}</code>{" "}
              {pendingDeleteDomain.status === "active"
                ? "is an active login origin — removing it restarts this instance, and logins through that hostname will stop working."
                : "hasn't been activated yet — this just discards the pending request."}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDeleteId(null)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleteDomain.isPending}
                onClick={() => deleteDomain.mutate(pendingDeleteDomain.id)}
                className="rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleteDomain.isPending ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * The per-domain "Registration command" fallback for Application identity's
 * "Sync redirect URIs" button above — same redirect-URI push, run by hand
 * instead, for an elevated PowerShell on a machine that isn't hosted in
 * Azure. Shares CustomDomainsCard's ["domains"] query key, so react-query
 * dedupes the fetch rather than issuing a second request for the same data.
 * Hidden in demo mode, and while no domain is active yet — there's nothing
 * to push.
 */
function RegistrationCommands({ demoMode }: { demoMode: boolean }) {
  const { data: report } = useQuery({
    queryKey: ["domains"],
    queryFn: () => api.get<DomainsReport>("/api/domains"),
    enabled: !demoMode,
  });

  if (demoMode) return null;
  const active = (report?.domains ?? []).filter((d) => d.status === "active");
  if (active.length === 0) return null;

  return (
    <div className="sm:col-span-2 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Registration command
        </div>
        <span className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
          Manual
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Same effect as &quot;Sync redirect URIs&quot; above, run by hand
        instead — for an elevated PowerShell on a machine that isn&apos;t
        hosted in Azure. Additive/idempotent, so re-running an
        already-registered domain&apos;s command is always safe.
      </p>
      <div className="mt-2 space-y-2">
        {active.map((d) => (
          <div key={d.id}>
            <div className="font-mono text-xs text-slate-500">{d.hostname}</div>
            <RegistrationCommand domainId={d.id} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Client-secret rotation for Application identity — reuses this same app
 * registration and only replaces the secret; no new consent needed, and
 * re-pairing restarts this instance the same way as a first-time install.
 * Lives here rather than in Get Started's Step 1 since it's an ongoing
 * maintenance action on the identity above, not a one-time setup step.
 * Hidden in demo mode, where nothing here could authorize anything real.
 */
function RotateClientSecretSection({ demoMode }: { demoMode: boolean }) {
  if (demoMode) return null;

  const deployCmd = "pwsh ./scripts/Deploy-PatchPilot.ps1";
  const cloudShellCommand = `& ([scriptblock]::Create((irm "${window.location.origin}/api/onboarding/pairing-script")))`;
  const rotateSecretCmd = `${deployCmd} -RotateClientSecret`;
  const rotateSecretCloudShellCommand = `${cloudShellCommand} -RotateClientSecret`;

  return (
    <div className="sm:col-span-2 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
        Client secret expired or leaked?
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Add <code className="font-mono text-xs">-RotateClientSecret</code> to
        reuse this same app registration and only replace the secret — no new
        consent needed, and re-pairing restarts this instance the same way as
        a first-time install:
      </p>

      <p className="mt-2.5 text-xs font-semibold text-slate-600">PowerShell (manual)</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600">
          {rotateSecretCmd}
        </code>
        <CopyButton value={rotateSecretCmd} />
      </div>

      <p className="mt-2.5 text-xs font-semibold text-slate-600">Azure Cloud Shell</p>
      <div className="mt-1 flex items-start gap-2">
        <code className="flex-1 whitespace-pre-wrap break-all rounded bg-slate-100 px-2 py-1.5 font-mono text-[11px] text-slate-600">
          {rotateSecretCloudShellCommand}
        </code>
        <CopyButton value={rotateSecretCloudShellCommand} />
      </div>
    </div>
  );
}

export function AppRegistration() {
  const canWrite = useCan("settings:write");
  const { data: report, isLoading } = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.get<OnboardingReport>("/api/onboarding"),
  });

  // "Orphaned" = live in the real Entra app registration but not one this
  // instance itself expects (report.redirectUris, the webOrigins-derived
  // list) — the only URIs ever offered for removal. A URI this instance
  // relies on to log in is never rendered as a checkbox in the first place;
  // the server re-derives and re-enforces the same filter regardless (see
  // apps/api/src/routes/domains.ts's protectedUris).
  const live = report?.liveRedirectUris ?? null;
  const orphaned = live ? live.redirectUris.filter((uri) => !(report?.redirectUris ?? []).includes(uri)) : [];
  const [selectedRemovals, setSelectedRemovals] = useState<Set<string>>(new Set());
  const [confirmingSync, setConfirmingSync] = useState(false);

  function toggleRemoval(uri: string) {
    setSelectedRemovals((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  }

  function startSync() {
    if (selectedRemovals.size > 0) {
      setConfirmingSync(true);
      return;
    }
    window.location.href = "/api/domains/sync-registration/start";
  }

  function confirmSyncWithRemovals() {
    const remove = Array.from(selectedRemovals)
      .map((uri) => encodeURIComponent(uri))
      .join(",");
    window.location.href = `/api/domains/sync-registration/start?remove=${remove}`;
  }

  return (
    <div>
      <PageHeader
        title="App Registration"
        subtitle="The multi-tenant Entra app PatchPilot runs as, its requested permissions, and its OAuth redirect origins. Per-tenant admin consent now lives on the Tenants page."
      />

      {report?.demoMode && (
        <Card className="mb-5 border-dashed border-amber-300 bg-amber-50">
          <p className="text-sm text-amber-800">
            <span className="font-semibold">Demo mode.</span> These identifiers
            and consent links are generated from demo fixtures and won&apos;t
            authorize anything. Deploy with{" "}
            <code className="font-mono text-xs">DEMO_MODE=false</code> and a real
            app registration to use them.
          </p>
        </Card>
      )}

      {isLoading || !report ? (
        <Card>
          <p className="text-sm text-slate-500">Loading…</p>
        </Card>
      ) : (
        <div className="space-y-5">
          {!report.demoMode && <GettingStarted report={report} />}

          <CustomDomainsCard demoMode={report.demoMode} />

          <Card>
            <h2 className="mb-4 text-sm font-semibold text-slate-700">
              Application identity
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Client ID" value={report.clientId} />
              <Field label="Home tenant ID" value={report.tenantId} />
              <div className="sm:col-span-2">
                <div className="flex items-center gap-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Redirect URIs
                  </div>
                  {report.liveRedirectUris && (
                    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                      Verified live in Entra
                    </span>
                  )}
                </div>
                {(() => {
                  const shown = live ? live.redirectUris : report.redirectUris;
                  const pending = live
                    ? report.redirectUris.filter((uri) => !live.redirectUris.includes(uri))
                    : [];
                  return (
                    <>
                      <div className="mt-1 space-y-1.5">
                        {shown.map((uri) => (
                          <div key={uri} className="flex items-center gap-2">
                            <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700">
                              {uri}
                            </code>
                            <CopyButton value={uri} />
                          </div>
                        ))}
                      </div>
                      {live ? (
                        <>
                          <p className="mt-1.5 text-xs text-slate-400">
                            Read directly from the Entra app registration by the last
                            &quot;Sync redirect URIs&quot; run, {new Date(live.checkedAt).toLocaleString()}.
                          </p>
                          {pending.length > 0 && (
                            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                              This instance also expects{" "}
                              {pending.map((uri) => (
                                <code key={uri} className="mx-0.5 font-mono">
                                  {uri}
                                </code>
                              ))}
                              , not confirmed in Entra yet — run Sync redirect URIs below to push{" "}
                              {pending.length === 1 ? "it" : "them"} in.
                            </div>
                          )}
                          {orphaned.length > 0 && (
                            <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
                              <p className="text-xs font-medium text-rose-700">
                                Live in Entra but not expected by this instance — check any that are stale
                                to delete them from the app registration on the next sync:
                              </p>
                              <div className="mt-1.5 space-y-1">
                                {orphaned.map((uri) => (
                                  <label key={uri} className="flex items-center gap-2 text-xs text-rose-700">
                                    <input
                                      type="checkbox"
                                      checked={selectedRemovals.has(uri)}
                                      disabled={!canWrite}
                                      onChange={() => toggleRemoval(uri)}
                                    />
                                    <code className="flex-1 truncate font-mono">{uri}</code>
                                  </label>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="mt-1.5 text-xs text-slate-400">
                          This server&apos;s own computed allowlist — the primary origin plus any active
                          custom domain below. Not yet verified against the real Entra app registration; run
                          Sync redirect URIs below to check and push it in.
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
              {!report.demoMode && (
                <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">
                    Reads the real redirect URIs from the Entra app registration, then additively pushes
                    in anything this instance expects that&apos;s missing. Already-registered URIs are left
                    untouched unless you&apos;ve checked one above as an orphaned URI to remove.
                  </p>
                  <button
                    type="button"
                    disabled={!canWrite}
                    title={!canWrite ? "Your role doesn't include settings write access." : undefined}
                    onClick={startSync}
                    className={`shrink-0 rounded-md px-3.5 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      selectedRemovals.size > 0 ? "bg-rose-600 hover:bg-rose-500" : "bg-slate-900 hover:bg-slate-700"
                    }`}
                  >
                    {selectedRemovals.size > 0
                      ? `Sync & remove ${selectedRemovals.size} selected`
                      : "Sync redirect URIs"}
                  </button>
                </div>
              )}
              <RegistrationCommands demoMode={report.demoMode} />
              <RotateClientSecretSection demoMode={report.demoMode} />
            </div>
          </Card>

          {report.demoMode && (
            <Card>
              <h2 className="mb-4 text-sm font-semibold text-slate-700">
                Requested API permissions
              </h2>
              <RequestedPermissionsStep report={report} />
            </Card>
          )}
        </div>
      )}

      {confirmingSync && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setConfirmingSync(false)}
            aria-hidden
          />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-slate-900">
              Remove {selectedRemovals.size} redirect {selectedRemovals.size === 1 ? "URI" : "URIs"}?
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              This deletes the following directly from the live Entra app registration, in the same
              step as the sync. This can&apos;t be undone from here — only by adding it back manually
              in Azure Portal or here.
            </p>
            <div className="mt-2 space-y-1">
              {Array.from(selectedRemovals).map((uri) => (
                <code
                  key={uri}
                  className="block truncate rounded bg-rose-50 px-2 py-1 font-mono text-xs text-rose-700"
                >
                  {uri}
                </code>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingSync(false)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmSyncWithRemovals}
                className="rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-rose-500"
              >
                Remove &amp; sync
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
