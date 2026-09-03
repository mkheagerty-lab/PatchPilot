import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { CopyButton } from "../../components/ui";

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
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Pair this instance</h1>
        <p className="mt-2 text-sm text-slate-500">
          This PatchPilot instance hasn&apos;t been connected to a Microsoft 365
          tenant yet. Download the personalized setup script below and have a
          Global Administrator run it once, from an elevated PowerShell
          prompt, against your own tenant.
        </p>

        <a
          href="/api/onboarding/pairing-script"
          download
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700"
        >
          Download Deploy-PatchPilot.ps1
        </a>

        <p className="mt-4 text-xs text-slate-400">
          The script creates a read-only Entra app registration in your
          tenant, then sends the resulting credentials directly to this
          instance. This page updates automatically once pairing completes —
          no need to reload.
        </p>

        <div className="mt-6 border-t border-slate-100 pt-5">
          <h2 className="text-sm font-semibold text-slate-800">Or run in Azure Cloud Shell</h2>
          <p className="mt-1.5 text-xs text-slate-500">
            Skip the download — paste this one-liner into an Azure Cloud Shell
            (PowerShell) session. Your tenant ID is detected automatically
            from the signed-in Cloud Shell session.
          </p>
          <div className="mt-2.5 flex items-start gap-2">
            <code className="flex-1 whitespace-pre-wrap break-all rounded bg-slate-100 px-2 py-1.5 font-mono text-[11px] text-slate-700">
              {cloudShellCommand}
            </code>
            <CopyButton value={cloudShellCommand} />
          </div>
          <a
            href="https://shell.azure.com/powershell"
            target="_blank"
            rel="noreferrer"
            className="mt-2.5 inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700"
          >
            Open Azure Cloud Shell ↗
          </a>
        </div>
      </div>
    </div>
  );
}
