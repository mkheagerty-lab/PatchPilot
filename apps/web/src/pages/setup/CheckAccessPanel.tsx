import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ROLE_LABELS,
  AREA_ACCESS_LABELS,
  type CheckAccessSummary,
  type AreaAccess,
} from "@patchpilot/shared";
import { api, type User } from "../../lib/api";
import { useEngineer, useCan } from "../../lib/auth";
import { useTenant } from "../../lib/tenant";
import { Card } from "../../components/ui";

const ACCESS_STYLES: Record<AreaAccess, string> = {
  readwrite: "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  readonly: "bg-sky-100 dark:bg-sky-500/15 text-sky-700 dark:text-sky-300",
  none: "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400",
};

function AccessPill({ access }: { access: AreaAccess }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${ACCESS_STYLES[access]}`}
    >
      {AREA_ACCESS_LABELS[access]}
    </span>
  );
}

function HeldPill({ held }: { held: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        held ? "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
      }`}
    >
      {held ? "Held" : "Not held"}
    </span>
  );
}

/**
 * Runs a Check Access step-up silently: loads
 * /api/check-access/start?...&silent=1 in a hidden iframe (prompt=none)
 * instead of a top-level redirect. Structural copy of Users.tsx's
 * runSilentAddReadonly — see apps/api/src/auth/routes.ts's
 * SILENT_CHECK_ACCESS_STATE_PREFIX branch for what runs on the other end.
 * Unlike that flow, a successful round trip carries the full result back
 * (not just ok:true) since there's no other cheap way to hand data through
 * a cross-origin redirect chain.
 */
function runSilentCheckAccess(
  targetUserId: string | null,
  tenantId: string,
  onSettled: (ok: boolean, result?: CheckAccessSummary) => void,
): void {
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.setAttribute("aria-hidden", "true");

  let settled = false;
  const finish = (ok: boolean, result?: CheckAccessSummary) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    window.removeEventListener("message", onMessage);
    iframe.remove();
    onSettled(ok, result);
  };

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as { source?: string; ok?: boolean; result?: CheckAccessSummary } | null;
    if (!data || data.source !== "patchpilot-check-access") return;
    finish(data.ok === true, data.result);
  };

  // Same generous-but-bounded timeout as the other silent flows — a real
  // prompt=none round trip is normally under a second.
  const timer = window.setTimeout(() => finish(false), 8000);

  window.addEventListener("message", onMessage);
  const params = new URLSearchParams({ tenantId, silent: "1" });
  if (targetUserId) params.set("userId", targetUserId);
  iframe.src = `/api/check-access/start?${params.toString()}`;
  document.body.appendChild(iframe);
}

function visibleFallbackUrl(targetUserId: string | null, tenantId: string): string {
  const params = new URLSearchParams({ tenantId });
  if (targetUserId) params.set("userId", targetUserId);
  return `/api/check-access/start?${params.toString()}`;
}

export function CheckAccessPanel() {
  const engineer = useEngineer();
  const canCheckOthers = useCan("users:manage");
  const { activeTenant, isAllTenants } = useTenant();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // null = self. Only meaningful when canCheckOthers — the picker is hidden
  // otherwise, and the backend would 403 a non-admin trying to target anyone
  // but themselves anyway.
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const { data: users } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<User[]>("/api/users"),
    enabled: canCheckOthers,
  });

  const tenantId = activeTenant?.tenantId ?? null;

  const { data: summary, isLoading } = useQuery({
    queryKey: ["check-access-summary", selectedUserId, tenantId],
    queryFn: () => {
      const params = new URLSearchParams({ tenantId: tenantId! });
      if (selectedUserId) params.set("userId", selectedUserId);
      return api.get<CheckAccessSummary>(`/api/check-access/summary?${params.toString()}`);
    },
    enabled: !!tenantId,
  });

  // Categories 2/3, filled in once the step-up round trip completes. Reset
  // whenever the target user or tenant changes so a stale result never
  // lingers under a different selection.
  const [liveResult, setLiveResult] = useState<CheckAccessSummary | null>(null);
  const [stepUpState, setStepUpState] = useState<"idle" | "checking" | "failed">("idle");
  useEffect(() => {
    setLiveResult(null);
    setStepUpState("idle");
  }, [selectedUserId, tenantId]);

  // Interactive-fallback hydration: a resultId in the URL means we're back
  // from a full-page step-up redirect (auth/routes.ts's
  // CHECK_ACCESS_STATE_PREFIX branch). Fetch it once, then strip the param —
  // SetupHealth.tsx's tab click replaces the whole query string, but this
  // has to happen on mount, independent of any click.
  const resultId = searchParams.get("resultId");
  const consumedResultId = useRef<string | null>(null);
  useEffect(() => {
    if (!resultId || consumedResultId.current === resultId) return;
    consumedResultId.current = resultId;
    void api
      .get<CheckAccessSummary>(`/api/check-access/result/${encodeURIComponent(resultId)}`)
      .then((result) => setLiveResult(result))
      .catch(() => setStepUpState("failed"))
      .finally(() => {
        const next = new URLSearchParams(searchParams);
        next.delete("resultId");
        setSearchParams(next, { replace: true });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultId]);

  const runCheck = () => {
    if (!tenantId) return;
    setStepUpState("checking");
    runSilentCheckAccess(selectedUserId, tenantId, (ok, result) => {
      if (ok && result) {
        setLiveResult(result);
        setStepUpState("idle");
      } else {
        // Silent prompt=none failed (no active Microsoft SSO session, or a
        // conditional-access step-up is required) — fall back to a visible,
        // interactive redirect. Refresh Category 1 while we're at it in
        // case something changed underneath.
        void queryClient.invalidateQueries({ queryKey: ["check-access-summary"] });
        window.location.href = visibleFallbackUrl(selectedUserId, tenantId);
      }
    });
  };

  if (isAllTenants || !tenantId) {
    return (
      <Card className="border-dashed">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Select a specific tenant above to check access — Check Access is scoped to one
          tenant at a time.
        </p>
      </Card>
    );
  }

  const displaySummary = liveResult ?? summary;
  const targetLabel =
    selectedUserId == null
      ? "your own access"
      : `${users?.find((u) => u.id === selectedUserId)?.displayName ?? "this user"}'s access`;

  return (
    <div>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Where {targetLabel} actually stands across PatchPilot's three independent access
        layers, for <span className="font-medium text-slate-700 dark:text-slate-200">{activeTenant?.displayName}</span>.
      </p>

      {canCheckOthers && (
        <div className="mb-6 flex items-center gap-2">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-200" htmlFor="check-access-user">
            Check access for
          </label>
          <select
            id="check-access-user"
            value={selectedUserId ?? ""}
            onChange={(e) => setSelectedUserId(e.target.value || null)}
            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm text-slate-800 dark:text-slate-100 focus:border-slate-400 focus:outline-none"
          >
            <option value="">Myself ({engineer.displayName})</option>
            {users
              ?.filter((u) => u.upn !== engineer.upn)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} ({u.upn})
                </option>
              ))}
          </select>
        </div>
      )}

      {/* Category 1 — PatchPilot role/permissions. No Graph call needed, so
          this renders as soon as the summary query resolves. */}
      <div className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">1. PatchPilot</h2>
        <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
          Role, tenant write posture, and page-level access enforced by PatchPilot itself.
        </p>
        <Card>
          {isLoading || !displaySummary ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-4">
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Role</div>
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                    {ROLE_LABELS[displaySummary.patchPilot.role]}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Tenant write-enabled?</div>
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                    {displaySummary.patchPilot.tenantWriteEnabled ? "Yes" : "No"}
                  </div>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      <th className="py-2 pr-4 font-medium">Area</th>
                      <th className="py-2 pr-4 font-medium">Description</th>
                      <th className="py-2 font-medium">Access</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displaySummary.patchPilot.scopes.map((s) => (
                      <tr key={s.area} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                        <td className="py-2 pr-4 whitespace-nowrap font-medium text-slate-700 dark:text-slate-200">
                          {s.label}
                        </td>
                        <td className="py-2 pr-4 text-slate-500 dark:text-slate-400">{s.description}</td>
                        <td className="py-2">
                          <AccessPill access={s.access} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      </div>

      {/* Categories 2/3 need a step-up Graph read against the target's Entra
          identity — not fetched until the engineer asks for it. */}
      {displaySummary?.demoMode ? (
        <Card className="mb-6 border-dashed">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Entra Roles and GDAP Roles aren't available in Demo Mode — there's no real Entra
            tenant to check against.
          </p>
        </Card>
      ) : !liveResult && stepUpState !== "checking" ? (
        <Card className="mb-6">
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
            Checking Entra and GDAP roles requires a one-time Microsoft sign-in prompt to read
            {selectedUserId == null ? " your own" : " this user's"} role assignments.
          </p>
          <button
            onClick={runCheck}
            disabled={!tenantId}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
          >
            Check Entra &amp; GDAP roles
          </button>
          {stepUpState === "failed" && (
            <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">
              That check didn't complete — the link may have expired. Try again.
            </p>
          )}
        </Card>
      ) : stepUpState === "checking" ? (
        <Card className="mb-6">
          <p className="text-sm text-slate-500 dark:text-slate-400">Checking… this may briefly redirect through Microsoft sign-in.</p>
        </Card>
      ) : null}

      {liveResult && (
        <>
          <div className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">2. Entra Roles (Direct)</h2>
            <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
              Entra directory roles assigned directly to this account in{" "}
              {activeTenant?.displayName} — expected to be blank outside the home tenant.
            </p>
            <Card>
              {!liveResult.entraDirect.applicable ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Not applicable — only shown for the home tenant. Customer-tenant users aren't
                  guest users there and hold no direct roles.
                </p>
              ) : liveResult.entraDirect.roles.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">No directly assigned roles.</p>
              ) : (
                <RoleTable roles={liveResult.entraDirect.roles} />
              )}
            </Card>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">3. GDAP Roles (Partner Centre)</h2>
            <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
              Roles granted via this tenant's Admin Relationship, cross-checked against the
              target's actual security-group membership.
            </p>
            <Card>
              {!liveResult.gdapRoles.applicable ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Not applicable — only shown for a customer tenant.
                </p>
              ) : !liveResult.gdapRoles.relationshipFound ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  No GDAP relationship found for this tenant.
                </p>
              ) : (
                <RoleTable roles={liveResult.gdapRoles.roles} />
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function RoleTable({ roles }: { roles: { role: string; held: boolean }[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-200 dark:border-slate-800 text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <th className="py-2 pr-4 font-medium">Entra role</th>
          <th className="py-2 font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {roles.map((r) => (
          <tr key={r.role} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
            <td className="py-2 pr-4 font-medium text-slate-700 dark:text-slate-200">{r.role}</td>
            <td className="py-2">
              <HeldPill held={r.held} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
