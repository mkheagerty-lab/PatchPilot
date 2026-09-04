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
} from "../../lib/api";
import { GRAPH_WRITE_GATED_SCOPES, DEFENDER_WRITE_GATED_SCOPES } from "@patchpilot/shared";
import { Card, PageHeader, CopyButton } from "../../components/ui";
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

type ScopeStatus = "ok" | "skipped" | "failed";

// Colour-codes a scope pill by its last "Test Connection" result — green/OK,
// amber/skipped (published but not yet granted), rose/failed (not published
// on the resource's own service principal at all). Untested scopes (no
// status lookup hit) fall back to the original neutral slate pill.
const SCOPE_STATUS_STYLES: Record<ScopeStatus, string> = {
  ok: "border border-emerald-200 bg-emerald-50 text-emerald-700",
  skipped: "border border-amber-200 bg-amber-50 text-amber-700",
  failed: "border border-rose-200 bg-rose-50 text-rose-700",
};
const SCOPE_STATUS_LABELS: Record<ScopeStatus, string> = {
  ok: "OK — granted and live",
  skipped: "Skipped — published but not yet granted; run Sync API Permissions",
  failed: "Failed — not published on this resource's service principal",
};

function ScopeList({
  title,
  scopes,
  resource,
  statusFor,
  writeGatedScopes,
}: {
  title: string;
  scopes: string[];
  /** Omit for demo mode / no live status available — pills render neutral. */
  resource?: "graph" | "defender" | "partnerCenter";
  statusFor?: (resource: string, scope: string) => ScopeStatus | undefined;
  /** Scopes in this list that are only ever published/consented when
   * "Include remediation write scopes" is checked on a Sync run — this list
   * always shows every scope PatchPilot could ever ask for (see
   * /api/onboarding), so a scope appearing here doesn't mean it's active.
   * Tagged so it's clear which pills the checkbox actually controls. */
  writeGatedScopes?: readonly string[];
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
          {title}
        </span>
        <span
          title="PatchPilot only ever requests Delegated (signed-in user) permissions, never Application (app-only) ones — GDAP doesn't support app-only access to customer tenants, and it keeps every action attributable to an engineer. If this same permission name shows a different 'Application' type in the Entra portal, that grant isn't the one PatchPilot's delegated tokens actually use."
          className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500"
        >
          Delegated
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {scopes.map((s) => {
          const status = resource && statusFor ? statusFor(resource, s) : undefined;
          const isWriteGated = writeGatedScopes?.includes(s) ?? false;
          return (
            <span
              key={s}
              title={status ? SCOPE_STATUS_LABELS[status] : "Not yet tested"}
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[11px] ${
                status ? SCOPE_STATUS_STYLES[status] : "bg-slate-100 text-slate-600"
              }`}
            >
              {s}
              {isWriteGated && (
                <span
                  title="Only published and consented when 'Include remediation write scopes' is checked on a Sync run — it's listed here either way since this panel always shows every scope PatchPilot could ever request."
                  className="rounded-full bg-blue-100 px-1.5 font-sans text-[9px] font-medium text-blue-700"
                >
                  write
                </span>
              )}
            </span>
          );
        })}
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
 * Guided three-step onboarding for a freshly-deployed MSP. The pivotal action is
 * Step 2: a Global Administrator grants admin consent for PatchPilot in the MSP's
 * OWN (home) tenant — without it the first "Discover tenants" fails with 403. The
 * button is the same /adminconsent flow used per-customer, just pointed at the
 * home tenant, and carries only the public client id (no secret ever leaves the
 * server). Hidden in demo mode, where the link can't authorize anything.
 */
function GettingStarted({ report }: { report: OnboardingReport }) {
  const deployCmd = "pwsh ./scripts/Deploy-PatchPilot.ps1";
  const cloudShellCommand = `& ([scriptblock]::Create((irm "${window.location.origin}/api/onboarding/pairing-script")))`;
  // Deploy-PatchPilot.ps1 is idempotent by default (re-running deployCmd/
  // cloudShellCommand as-is just reuses the existing app registration), so
  // "re-register" needs no separate command — only rotating the secret does,
  // via the script's own -RotateClientSecret switch (see its param() block).
  const rotateSecretCmd = `${deployCmd} -RotateClientSecret`;
  const rotateSecretCloudShellCommand = `${cloudShellCommand} -RotateClientSecret`;
  const canWrite = useCan("settings:write");
  return (
    <Card className="border-slate-900/10 bg-gradient-to-br from-slate-50 to-white">
      <h2 className="mb-1 text-sm font-semibold text-slate-800">Get started</h2>
      <p className="mb-4 text-sm text-slate-500">
        Three one-time steps connect PatchPilot to your MSP tenant.
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
          app, configures the read-only permissions below, and either writes your{" "}
          <code className="font-mono text-xs">.env</code> (self-hosted) or pairs
          directly with this instance (hosted). Choose whichever matches how
          you're set up:

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

          <p className="mt-3 border-t border-slate-200 pt-2.5 text-xs text-slate-400">
            Client secret expired or leaked? Add{" "}
            <code className="font-mono text-xs">-RotateClientSecret</code> to
            reuse this same app registration and only replace the secret — no
            new consent needed, and re-pairing restarts this instance the same
            way as a first-time install:
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600">
              {rotateSecretCmd}
            </code>
            <CopyButton value={rotateSecretCmd} />
          </div>
          <div className="mt-1.5 flex items-start gap-2">
            <code className="flex-1 whitespace-pre-wrap break-all rounded bg-slate-100 px-2 py-1.5 font-mono text-[11px] text-slate-600">
              {rotateSecretCloudShellCommand}
            </code>
            <CopyButton value={rotateSecretCloudShellCommand} />
          </div>
        </Step>

        <Step
          n={2}
          title="Grant MSP tenant admin consent (Global Administrator)"
          done={report.homeTenantConsented}
        >
          Approve PatchPilot&apos;s read-only access in your own tenant. This is
          what lets the first discovery succeed — without it, tenant reads come
          back <span className="font-medium text-amber-700">403</span>.
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
            Must be approved by a Global Administrator.
          </p>
        </Step>

        <Step n={3} title="Discover your tenants">
          Pull in your home tenant and any GDAP customers, then probe access and
          licensing.
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
 * Merges the "Requested API permissions" display with the one narrow
 * exception to "the in-app console never writes to Entra" — see README
 * invariant #7. "Sync API Permissions" reuses the app's existing
 * /auth/callback redirect to run a one-time step-up consent
 * (apps/api/src/routes/onboarding.ts + apps/api/src/auth/routes.ts), applying
 * whatever scopes.ts currently requests to an *already-existing* app
 * registration. "Test Connection" is the read-only counterpart (same step-up
 * mechanics, calls testAppRegistrationScopes instead) — it never mutates
 * anything, just reports each scope's live status as a colour-coded pill.
 * First-time creation still needs Deploy-PatchPilot.ps1. In demo mode neither
 * action could authorize or check anything real, so the card falls back to a
 * plain read-only list.
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

function RequestedPermissionsCard({ report }: { report: OnboardingReport }) {
  const canWrite = useCan("settings:write");
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [includeWriteScopes, setIncludeWriteScopes] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);

  if (report.demoMode) {
    return (
      <Card>
        <h2 className="mb-4 text-sm font-semibold text-slate-700">
          Requested API permissions
        </h2>
        <div className="space-y-4">
          <ScopeList title="Microsoft Graph" scopes={report.scopes.graph} />
          <ScopeList title="Defender for Endpoint" scopes={report.scopes.defender} />
          <ScopeList title="Partner Center" scopes={report.scopes.partnerCenter} />
        </div>
      </Card>
    );
  }

  const statusMap = new Map(
    (report.scopeStatus?.results ?? []).map((r) => [`${r.resource}:${r.scope}`, r.status]),
  );
  const statusFor = (resource: string, scope: string) => statusMap.get(`${resource}:${scope}`);
  const scopesSyncNeeded = report.scopesSyncNeeded;

  return (
    <Card className={scopesSyncNeeded ? "border-amber-300" : undefined}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-700">
              Requested API permissions
            </h2>
            {scopesSyncNeeded && (
              <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                Sync needed
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-slate-500">
            What PatchPilot asks this app registration for. Run{" "}
            <span className="font-medium text-slate-600">Test Connection</span>{" "}
            to colour-code each one by its live status below.
          </p>
          {scopesSyncNeeded && (
            <p className="mt-1.5 text-xs text-amber-700">
              PatchPilot now requests different permissions than this app
              registration was last synced to — likely a recent upgrade. Run a
              sync to bring it up to date.
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
            Sync API Permissions
          </button>
        </div>
      </div>

      {!canWrite && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Your role doesn&apos;t include settings write access.
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
              Sync app registration permissions?
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
    </Card>
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
 * registration — either via the same step-up browser consent
 * RequestedPermissionsCard uses, or by copying the PowerShell one-liner
 * below. Hidden in demo mode, where nothing here could resolve or authorize
 * anything real.
 */
function CustomDomainsCard({ demoMode }: { demoMode: boolean }) {
  const qc = useQueryClient();
  const canWrite = useCan("settings:write");
  const [type, setType] = useState<DomainType>("subdomain");
  const [label, setLabel] = useState("");
  const [hostname, setHostname] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

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
      setMessage({ tone: "ok", text: `Added ${row.hostname} — follow the instructions below to activate it.` });
      void qc.invalidateQueries({ queryKey: ["domains"] });
    },
    onError: (err) =>
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Failed to add domain." }),
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
  const hasActive = domains.some((d) => d.status === "active");
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
              onChange={() => setType("subdomain")}
            />
            PatchPilot subdomain
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={type === "custom"} onChange={() => setType("custom")} />
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
                  onChange={(e) => setLabel(e.target.value)}
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
                onChange={(e) => setHostname(e.target.value)}
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
              addDomain.isPending ||
              (type === "subdomain" ? !label.trim() : !hostname.trim())
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

      {hasActive && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-700">
                Update app registration domains
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Push every active domain&apos;s redirect URI into the real
                Entra app registration in one pass. Additive only —
                already-registered URIs are left untouched, nothing is ever
                duplicated.
              </p>
            </div>
            <button
              type="button"
              disabled={!canWrite}
              title={!canWrite ? "Your role doesn't include settings write access." : undefined}
              onClick={() => {
                window.location.href = "/api/domains/sync-registration/start";
              }}
              className="shrink-0 rounded-md bg-slate-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Update via browser
            </button>
          </div>

          <div className="mt-4 border-t border-slate-200 pt-3">
            <div className="flex items-center gap-2">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Registration command
              </div>
              <span className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                Manual
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Same effect as &quot;Update via browser&quot; above, run by hand
              instead — for an elevated PowerShell on a machine that isn&apos;t
              hosted in Azure. Additive/idempotent, so re-running an
              already-registered domain&apos;s command is always safe.
            </p>
            <div className="mt-2 space-y-2">
              {domains
                .filter((d) => d.status === "active")
                .map((d) => (
                  <div key={d.id}>
                    <div className="font-mono text-xs text-slate-500">{d.hostname}</div>
                    <RegistrationCommand domainId={d.id} />
                  </div>
                ))}
            </div>
          </div>
        </div>
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

export function AppRegistration() {
  const { data: report, isLoading } = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.get<OnboardingReport>("/api/onboarding"),
  });

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

          <Card>
            <h2 className="mb-4 text-sm font-semibold text-slate-700">
              Application identity
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Client ID" value={report.clientId} />
              <Field label="Home tenant ID" value={report.tenantId} />
              <div className="sm:col-span-2">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Redirect URIs
                </div>
                <div className="mt-1 space-y-1.5">
                  {report.redirectUris.map((uri) => (
                    <div key={uri} className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700">
                        {uri}
                      </code>
                      <CopyButton value={uri} />
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-slate-400">
                  Every origin this instance currently accepts an OAuth callback from — the primary origin plus any
                  active custom domain below. Reflects this server&apos;s own allowlist, not a live read of the real
                  Entra app registration; use Custom domains&apos; &quot;Update via browser&quot; (or the PowerShell
                  command) to push a newly-active domain into the real app registration.
                </p>
              </div>
            </div>
          </Card>

          <RequestedPermissionsCard report={report} />

          <CustomDomainsCard demoMode={report.demoMode} />
        </div>
      )}
    </div>
  );
}
