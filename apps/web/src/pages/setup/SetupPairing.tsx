import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { CopyButton } from "../../components/ui";
import { DEFAULT_LOGO_URL, PRODUCT_NAME } from "../../lib/branding";

/**
 * Shown by <AuthGate> instead of the normal login redirect when the instance
 * has never been paired (config.ENTRA_CONFIGURED === false — see
 * apps/api/src/config.ts). A fresh hosted instance has no Entra app
 * registration yet, so /auth/login would send the browser into a Microsoft
 * error page (blank client_id) — there is nobody to sign in as until this
 * screen's download completes and the customer's Global Admin runs it.
 *
 * Deliberately outside the authenticated app shell: no session exists yet,
 * and none is needed. The only capability this screen has is downloading a
 * personalized copy of Deploy-PatchPilot.ps1, whose actual authority is the
 * single-use pairing token baked into it — see
 * apps/api/src/routes/onboarding-pairing.ts.
 *
 * The two-option layout below (Cloud Shell recommended, PowerShell manual)
 * deliberately mirrors Get Started > Step 1 on the authenticated App
 * Registration page (apps/web/src/pages/setup/AppRegistration.tsx) — same
 * buttons, same order — since this screen runs the exact same script for
 * the exact same reason, just before a session exists to reach that page.
 */
export function SetupPairing() {
  const queryClient = useQueryClient();
  const cloudShellCommand = `& ([scriptblock]::Create((irm "${window.location.origin}/api/onboarding/pairing-script")))`;

  // Once the customer's admin runs the script, POST /api/onboarding/pair
  // restarts the api process (see onboarding-pairing.ts) with real Entra
  // credentials loaded. Poll /auth/me so this tab notices without the admin
  // having to manually reload — a real restart is a handful of seconds.
  const { data } = useQuery({
    queryKey: ["auth", "me", "setup-poll"],
    queryFn: () => api.get<{ authenticated: boolean; entraConfigured?: boolean }>("/auth/me"),
    retry: false,
    refetchInterval: 5_000,
  });

  useEffect(() => {
    if (data?.entraConfigured) {
      void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    }
  }, [data?.entraConfigured, queryClient]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-10">
      <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <img
            src={DEFAULT_LOGO_URL}
            alt={PRODUCT_NAME}
            className="h-10 w-10 rounded-xl object-contain"
          />
          <span className="text-base font-semibold text-slate-900">{PRODUCT_NAME}</span>
        </div>
        <h1 className="text-lg font-semibold text-slate-900">Pair this instance</h1>
        <p className="mt-2 text-sm text-slate-500">
          This PatchPilot instance hasn&apos;t been connected to a Microsoft 365
          tenant yet. Run the installer once as a Global Administrator — it
          creates the Entra app, configures read-only permissions, grants
          admin consent for them, and pairs directly with this instance, all
          in one run. Choose whichever matches how you&apos;re set up:
        </p>

        <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50/50 p-3">
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
            For local machines or instances that aren&apos;t hosted in Azure.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <a
              href="/api/onboarding/pairing-script"
              download
              className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700"
            >
              Download PowerShell Script
            </a>
            <span className="text-xs text-slate-400">
              Pre-fills the pairing token — this instance restarts
              automatically once it runs.
            </span>
          </div>
        </div>

        <p className="mt-4 text-xs text-slate-400">
          This page updates automatically once pairing completes — no need to
          reload.
        </p>

        <div className="mt-6 border-t border-slate-200 pt-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Or, to explore without connecting a tenant
          </p>
          <div className="mt-2.5">
            <EnableDemoModeAction />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The Pairing Page's other option: instead of connecting a real tenant, flip
 * this fresh, unpaired instance into DEMO_MODE — see
 * apps/api/src/routes/onboarding-demo-mode.ts. Confirm-modal pattern mirrors
 * AddApiPermissionsAction (apps/web/src/pages/setup/AppRegistration.tsx).
 *
 * No new polling logic needed: the same 5-second /auth/me poll above already
 * notices `entraConfigured: true` the moment the restarted process comes back
 * up in demo mode (config.ts forces ENTRA_CONFIGURED=true whenever
 * DEMO_MODE=true) and hands off to the normal app shell.
 */
function EnableDemoModeAction() {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post<{ enabled: boolean }>("/api/onboarding/enable-demo-mode", {});
      // The api process restarts itself right after replying (see
      // exitAfterReply in the route) — nothing left to do here but wait for
      // the poll above to notice. Leave the modal up with a "restarting"
      // message rather than closing it, so the admin isn't left staring at
      // an unchanged screen wondering if the click registered.
    } catch (err) {
      setSubmitting(false);
      setError(err instanceof Error ? err.message : "Failed to enable demo mode.");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
      >
        Enable Demo Mode
      </button>

      {confirming && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => !submitting && setConfirming(false)}
            aria-hidden
          />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-slate-900">
              Enable demo mode?
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              This instance will restart in a few seconds, filled with
              fictional sample tenants, devices, and vulnerabilities — no
              Microsoft 365 tenant is connected, and no real data is ever
              involved. This is one-way, the same as pairing: there&apos;s no
              in-app way to switch back afterward.
            </p>
            {error && (
              <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setConfirming(false)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleConfirm()}
                className="rounded-md bg-slate-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? "Restarting…" : "Enable Demo Mode"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
