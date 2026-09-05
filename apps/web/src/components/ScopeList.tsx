/**
 * Shared "requested API permissions" pill list — colour-coded by live status,
 * tagged "Delegated" (PatchPilot never requests Application/app-only
 * permissions) and "write" (scopes only published/consented when write
 * scopes are included). Originally built for the App Registration page's
 * Get Started > Step 3; also used by Setup Health > Connections so both
 * surfaces show the exact same pill styling for the exact same scopes
 * rather than drifting apart.
 */

export type ScopeStatus = "ok" | "skipped" | "failed";

// Colour-codes a scope pill by its last "Test Connection" result — green/OK,
// amber/skipped (published but not yet granted), rose/failed (not published
// on the resource's own service principal at all). Untested scopes (no
// status lookup hit) fall back to the original neutral slate pill.
export const SCOPE_STATUS_STYLES: Record<ScopeStatus, string> = {
  ok: "border border-emerald-200 bg-emerald-50 text-emerald-700",
  skipped: "border border-amber-200 bg-amber-50 text-amber-700",
  failed: "border border-rose-200 bg-rose-50 text-rose-700",
};
export const SCOPE_STATUS_LABELS: Record<ScopeStatus, string> = {
  ok: "OK — granted and live",
  skipped: "Skipped — published but not yet granted; run Add API Permissions",
  failed: "Failed — not published on this resource's service principal",
};

export function ScopeList({
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
                  title="Only published and consented when 'Include remediation write scopes' is checked while running Add API Permissions — it's listed here either way since this panel always shows every scope PatchPilot could ever request."
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
