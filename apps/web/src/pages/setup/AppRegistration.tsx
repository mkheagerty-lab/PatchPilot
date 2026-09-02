import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type OnboardingReport,
  type SyncTenantsResult,
  type CustomDomain,
  type DomainsReport,
  type DomainType,
} from "../../lib/api";
import { Card, PageHeader } from "../../components/ui";
import { useCan } from "../../lib/auth";

const CONSENT_STYLES: Record<string, string> = {
  consented: "bg-emerald-100 text-emerald-700",
  pending: "bg-amber-100 text-amber-700",
  expired: "bg-rose-100 text-rose-700",
};

// Reachability is the honest "can PatchPilot actually call Graph" signal, distinct
// from the GDAP relationship/consent status. Reseller-only and unlicensed tenants
// render as calm informational rows here, never as errors (invariant #4 — graceful
// degradation). label + style per value, mirroring the Tenants page.
const REACH_META: Record<string, { label: string; style: string }> = {
  reachable: { label: "Reachable", style: "bg-emerald-100 text-emerald-700" },
  "consent-needed": { label: "Needs access", style: "bg-amber-100 text-amber-700" },
  throttled: { label: "Throttled", style: "bg-sky-100 text-sky-700" },
  unreachable: { label: "Unreachable", style: "bg-slate-100 text-slate-600" },
  unknown: { label: "Not probed", style: "bg-slate-100 text-slate-500" },
};

// Total under noUncheckedIndexedAccess — the object-literal fallback keeps a bare
// REACH_META[x] (which is `| undefined`) from leaking into the render.
function reachMeta(reachability: string): { label: string; style: string } {
  return REACH_META[reachability] ?? { label: "Not probed", style: "bg-slate-100 text-slate-500" };
}

/**
 * Builds a mailto: draft a customer's Global Admin can act on in one click. The
 * URL is the only action the customer ever takes — admin consent must happen in
 * their own tenant and can't be automated away (a Microsoft security boundary).
 */
function consentMailto(displayName: string, consentUrl: string): string {
  const subject = "Action required: authorize PatchPilot for your tenant";
  const body = [
    `Hi ${displayName} team,`,
    "",
    "To let us manage patching for your tenant, please have a Global Administrator",
    "open the link below and approve the requested access. It opens in your own",
    "Microsoft sign-in — no software is installed.",
    "",
    consentUrl,
    "",
    "Thanks,",
    "Your IT team",
  ].join("\n");
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard unavailable (e.g. insecure context); silently ignore
        }
      }}
      className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

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

function ScopeList({ title, scopes }: { title: string; scopes: string[] }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {title}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {scopes.map((s) => (
          <span
            key={s}
            className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600"
          >
            {s}
          </span>
        ))}
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
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3.5">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-800">{title}</div>
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
  const canWrite = useCan("settings:write");
  return (
    <Card className="border-slate-900/10 bg-gradient-to-br from-slate-50 to-white">
      <h2 className="mb-1 text-sm font-semibold text-slate-800">Get started</h2>
      <p className="mb-4 text-sm text-slate-500">
        Three one-time steps connect PatchPilot to your MSP tenant.
      </p>
      <ol className="space-y-5">
        <Step n={1} title="Deploy the app registration">
          Run the installer once as a Global Administrator. It creates the Entra
          app, configures the read-only permissions below, and either writes your{" "}
          <code className="font-mono text-xs">.env</code> (self-hosted) or pairs
          directly with this instance (hosted).
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
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
              Download personalized installer
            </a>
            <span className="text-xs text-slate-400">
              Pre-fills the pairing token — this instance restarts automatically
              once it runs.
            </span>
          </div>
          <p className="mt-2.5 text-xs text-slate-400">
            Prefer to run it unmodified and hand-edit{" "}
            <code className="font-mono text-xs">.env</code> yourself? Copy this
            into an elevated PowerShell from the repo root instead:
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600">
              {deployCmd}
            </code>
            <CopyButton value={deployCmd} />
          </div>
        </Step>

        <Step n={2} title="Grant MSP tenant admin consent (Global Administrator)">
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
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
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
 * The one narrow exception to "the in-app console never writes to Entra" — see
 * README invariant #7. Reuses the app's existing /auth/callback redirect to run
 * a one-time step-up consent (apps/api/src/routes/onboarding.ts +
 * apps/api/src/auth/routes.ts), applying whatever scopes.ts currently requests
 * to an *already-existing* app registration. First-time creation still needs
 * Deploy-PatchPilot.ps1 — hidden entirely in demo mode, where nothing here
 * could authorize anything real.
 */
function SyncPermissionsCard({ demoMode }: { demoMode: boolean }) {
  const canWrite = useCan("settings:write");
  const [confirming, setConfirming] = useState(false);
  const [includeWriteScopes, setIncludeWriteScopes] = useState(false);

  if (demoMode) return null;

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Sync permissions</h2>
          <p className="mt-1 text-sm text-slate-500">
            Already ran the installer once? Refresh this app registration&apos;s
            requested permissions and admin consent to match the list above,
            without re-running Deploy-PatchPilot.ps1.
          </p>
        </div>
        <button
          type="button"
          disabled={!canWrite}
          title={!canWrite ? "Your role doesn't include settings write access." : undefined}
          onClick={() => setConfirming(true)}
          className="shrink-0 rounded-md bg-slate-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Sync permissions
        </button>
      </div>

      {!canWrite && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Your role doesn&apos;t include settings write access.
        </div>
      )}

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
                Include Phase 5 remediation write scopes
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
 * registration — either via the same step-up browser consent SyncPermissionsCard
 * uses, or by copying the PowerShell one-liner above. Hidden in demo mode,
 * where nothing here could resolve or authorize anything real.
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

              {d.status === "active" && (
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Registration command
                  </div>
                  <RegistrationCommand domainId={d.id} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {hasActive && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-sm font-semibold text-slate-700">Update app registration</h3>
          <p className="mt-1 text-sm text-slate-500">
            Push every active domain&apos;s redirect URI into the real Entra
            app registration in one pass. Additive only — already-registered
            URIs are left untouched, nothing is ever duplicated.
          </p>
          <button
            type="button"
            disabled={!canWrite}
            title={!canWrite ? "Your role doesn't include settings write access." : undefined}
            onClick={() => {
              window.location.href = "/api/domains/sync-registration/start";
            }}
            className="mt-2.5 rounded-md bg-slate-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Update via browser
          </button>
          <p className="mt-1.5 text-xs text-slate-400">
            Or copy a domain&apos;s registration command above and run it from
            an elevated PowerShell instead.
          </p>
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

type ConsentSortKey = "name" | "reachability" | "consent";

export function AppRegistration() {
  const qc = useQueryClient();
  const { data: report, isLoading } = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.get<OnboardingReport>("/api/onboarding"),
  });

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<ConsentSortKey>("name");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  // Flipped when the engineer opens a consent tab; the next window focus
  // re-probes so the row's reachability/consent status stops being stale.
  const pendingRecheck = useRef(false);
  const demoMode = report?.demoMode ?? false;

  const recheck = useMutation({
    mutationFn: () => api.post<SyncTenantsResult>("/api/sync/tenants", {}),
    onSuccess: (res) => {
      const { reachable, consentNeeded, throttled, unreachable, licensingUnavailable } =
        res.summary;
      const parts = [`${reachable} reachable`];
      if (consentNeeded) parts.push(`${consentNeeded} need consent`);
      if (throttled) parts.push(`${throttled} throttled`);
      if (unreachable) parts.push(`${unreachable} unreachable`);
      // Licensing is a separate, best-effort read: a reachable tenant whose SKU
      // read is blocked (needs Organization.Read.All) is NOT an access failure.
      const note = licensingUnavailable
        ? ` Licensing unread for ${licensingUnavailable} reachable tenant(s) — access is fine; SKU detail needs Organization.Read.All.`
        : "";
      setMessage({
        tone: "ok",
        text: `Re-probed ${res.probed} tenant(s): ${parts.join(", ")}.${note}`,
      });
      void qc.invalidateQueries({ queryKey: ["onboarding"] });
      void qc.invalidateQueries({ queryKey: ["tenants"] });
    },
    onError: (err) =>
      setMessage({
        tone: "error",
        text: err instanceof ApiError ? err.message : "Re-check failed.",
      }),
  });

  // After returning from an admin-consent tab, re-probe access automatically so
  // the row reflects the freshly granted (or still-missing) access.
  useEffect(() => {
    function onFocus() {
      if (!pendingRecheck.current) return;
      pendingRecheck.current = false;
      if (demoMode || recheck.isPending) return;
      setMessage({ tone: "ok", text: "Re-checking access after consent…" });
      recheck.mutate();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [demoMode, recheck]);

  const visibleTargets = useMemo(() => {
    const targets = report?.consentTargets ?? [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? targets.filter(
          (t) =>
            t.displayName.toLowerCase().includes(q) ||
            t.tenantId.toLowerCase().includes(q),
        )
      : targets;
    const keyOf = (t: (typeof targets)[number]) =>
      sortKey === "reachability"
        ? reachMeta(t.reachability).label.toLowerCase()
        : sortKey === "consent"
          ? t.consentStatus.toLowerCase()
          : t.displayName.toLowerCase();
    return [...filtered].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  }, [report, search, sortKey]);

  return (
    <div>
      <PageHeader
        title="App Registration"
        subtitle="The multi-tenant Entra app PatchPilot runs as, and the per-tenant admin-consent links that authorize GDAP access. Consent URLs carry only the public client id — never a secret."
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

          <Card>
            <h2 className="mb-4 text-sm font-semibold text-slate-700">
              Requested API permissions
            </h2>
            <div className="space-y-4">
              <ScopeList title="Microsoft Graph" scopes={report.scopes.graph} />
              <ScopeList
                title="Defender for Endpoint"
                scopes={report.scopes.defender}
              />
              <ScopeList
                title="Partner Center"
                scopes={report.scopes.partnerCenter}
              />
            </div>
          </Card>

          <SyncPermissionsCard demoMode={report.demoMode} />

          <CustomDomainsCard demoMode={report.demoMode} />

          {!report.demoMode && (
            <Card className="border-slate-200 bg-slate-50">
              <h2 className="mb-2 text-sm font-semibold text-slate-700">
                Deployment prerequisites
              </h2>
              <p className="text-sm text-slate-500">
                Customer access is granted by the installer, not from this page —
                PatchPilot stays read-only at runtime. When you run{" "}
                <code className="font-mono text-xs text-slate-600">
                  scripts/Deploy-PatchPilot.ps1
                </code>{" "}
                it idempotently:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-500">
                <li>
                  admin-consents PatchPilot&apos;s read-only application
                  permissions in your tenant, and
                </li>
                <li>
                  adds PatchPilot&apos;s service principal to your GDAP security
                  group(s), so app-only customer tokens inherit the granted roles.
                </li>
              </ul>
              <p className="mt-2 text-sm text-slate-500">
                A customer showing{" "}
                <span className="font-medium text-amber-700">Needs access</span>{" "}
                below means tokens mint but Graph returns 403 — re-run the
                installer to (re)grant access, then click{" "}
                <span className="font-medium text-slate-600">Discover</span> on
                the Tenants page to re-probe.
              </p>
            </Card>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-700">
                Per-tenant admin consent
              </h2>
              {!demoMode && report.consentTargets.length > 0 && (
                <button
                  type="button"
                  disabled={recheck.isPending}
                  onClick={() => {
                    setMessage(null);
                    recheck.mutate();
                  }}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Re-probe every tenant's access and consent status."
                >
                  {recheck.isPending ? "Re-checking…" : "Re-check access"}
                </button>
              )}
            </div>

            {message && (
              <Card
                className={`mb-3 ${
                  message.tone === "ok"
                    ? "border-emerald-200 bg-emerald-50"
                    : "border-rose-200 bg-rose-50"
                }`}
              >
                <p
                  className={`text-sm ${
                    message.tone === "ok" ? "text-emerald-700" : "text-rose-700"
                  }`}
                >
                  {message.text}
                </p>
              </Card>
            )}

            <Card className="p-0">
              {report.consentTargets.length === 0 ? (
                <div className="p-5 text-sm text-slate-500">
                  No customer tenants to consent yet.
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:items-center">
                    <input
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search by name or tenant ID…"
                      className="flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                    <label className="flex items-center gap-2 text-xs text-slate-500">
                      Sort
                      <select
                        value={sortKey}
                        onChange={(e) => setSortKey(e.target.value as ConsentSortKey)}
                        className="rounded-md border border-slate-200 px-2 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      >
                        <option value="name">Name</option>
                        <option value="reachability">Reachability</option>
                        <option value="consent">Consent status</option>
                      </select>
                    </label>
                  </div>
                  {visibleTargets.length === 0 ? (
                    <div className="p-5 text-sm text-slate-500">
                      No tenants match “{search}”.
                    </div>
                  ) : (
                <ul>
                  {visibleTargets.map((t) => (
                    <li
                      key={t.tenantId}
                      className="border-b border-slate-100 px-5 py-4 last:border-0"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-800">
                            {t.displayName}
                          </div>
                          <div className="font-mono text-xs text-slate-400">
                            {t.tenantId}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                              reachMeta(t.reachability).style
                            }`}
                            title="Whether PatchPilot can actually call Graph for this tenant (probed via Discover)."
                          >
                            {reachMeta(t.reachability).label}
                          </span>
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
                              CONSENT_STYLES[t.consentStatus] ??
                              CONSENT_STYLES.pending
                            }`}
                          >
                            {t.consentStatus}
                          </span>
                        </div>
                      </div>

                      {t.reachability === "consent-needed" && (
                        <p className="mt-2 text-xs text-amber-700">
                          App-only tokens mint but Graph returns 403. Re-run{" "}
                          <code className="font-mono">Deploy-PatchPilot.ps1</code>{" "}
                          to grant customer access (adds the SP to the GDAP group),
                          then Discover to re-probe.
                        </p>
                      )}
                      {t.reachability === "reachable" &&
                        t.licenses.length === 0 && (
                          <p className="mt-2 text-xs text-slate-400">
                            Reachable, but no managed licenses detected
                            (reseller-only or unlicensed) — informational only, no
                            action needed.
                          </p>
                        )}
                      <div className="mt-2 flex items-center gap-2">
                        <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600">
                          {t.consentUrl}
                        </code>
                        <CopyButton value={t.consentUrl} />
                        <a
                          href={consentMailto(t.displayName, t.consentUrl)}
                          className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
                        >
                          Email
                        </a>
                        <a
                          href={t.consentUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => {
                            pendingRecheck.current = true;
                          }}
                          className="shrink-0 rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-slate-700"
                        >
                          Open
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
                  )}
                </>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
