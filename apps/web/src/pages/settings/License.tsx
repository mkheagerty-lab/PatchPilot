import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type EntitlementView, type OnboardingReport } from "../../lib/api";
import { useCan } from "../../lib/auth";
import { Card, PageHeader } from "../../components/ui";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-slate-400 focus:outline-none";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

/**
 * An active trial has the exact same write shape as a real Pro token — fixed
 * tenant/device limits instead of Pro's license-key-defined ones — so it's
 * labeled "Pro (Trial)" rather than "Free" to avoid implying the two are
 * different capability tiers. The underlying `tier` value stays "free"
 * everywhere else (it drives the free-tier sync cap and fallback logic) —
 * this is a display-only distinction.
 */
function tierLabel(tier: string, trialActive: boolean): string {
  if (tier === "free") return trialActive ? "Pro (Trial)" : "Free";
  if (tier === "pro") return "Pro";
  if (tier === "unlimited") return "Unlimited";
  return tier;
}

function daysRemaining(expiresAtIso: string): number {
  return Math.max(0, Math.ceil((new Date(expiresAtIso).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
}

/**
 * Settings > License — PatchPilot's three tiers (see packages/graph/src/
 * entitlement.ts + write-gate.ts): free (default fallback — read-only above
 * a tenant cap, unless the one-time 30-day trial is active), pro (same shape
 * as an active trial but populated entirely by a license key), and unlimited
 * (no numeric cap at all). Distinct from each tenant's own read-only toggle
 * on Settings > Tenants: that's the customer opting a tenant IN to writes,
 * this is the tier allowing the instance to write at all, plus the total
 * size of the instance-wide Live Response device pool. How that pool is
 * divided across tenants is this MSP's own call, set per-tenant on Settings
 * → Tenants, not here.
 *
 * Hidden entirely in demo mode — a demo instance has no real entitlement
 * state and behaves as fully unlimited (see write-gate.ts's DEMO_MODE
 * short-circuit), so this page would have nothing honest to show.
 */
export function License() {
  const qc = useQueryClient();
  const canWrite = useCan("settings:write");
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [devicesAssigned, setDevicesAssigned] = useState(false);

  const { data: report } = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.get<OnboardingReport>("/api/onboarding"),
  });
  const demoMode = report?.demoMode ?? false;

  const { data, isLoading } = useQuery({
    queryKey: ["settings", "entitlement"],
    queryFn: () => api.get<EntitlementView>("/api/settings/entitlement"),
    enabled: !demoMode,
  });

  const mutation = useMutation({
    mutationFn: (t: string) => api.put<EntitlementView>("/api/settings/entitlement", { token: t }),
    onSuccess: () => {
      setSaved(true);
      setToken("");
      qc.invalidateQueries({ queryKey: ["settings", "entitlement"] });
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const trialMutation = useMutation({
    mutationFn: () => api.post<EntitlementView>("/api/settings/entitlement/trial/start", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "entitlement"] });
    },
  });

  const autoAssignMutation = useMutation({
    mutationFn: () => api.post<EntitlementView>("/api/settings/entitlement/auto-assign-devices", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "entitlement"] });
      setDevicesAssigned(true);
      setTimeout(() => setDevicesAssigned(false), 2000);
    },
  });

  if (demoMode) return null;

  const canSave = canWrite && token.trim().length > 0 && !mutation.isPending;

  return (
    <div>
      <PageHeader
        title="License"
        subtitle="PatchPilot's vendor license key — gates whether this instance can write at all, and the size of the Live Response device pool your tenants share."
        actions={
          <button
            onClick={() => mutation.mutate(token.trim())}
            disabled={!canSave}
            title={!canWrite ? "Your role doesn't include settings write access." : undefined}
            className="rounded-md bg-[var(--pp-primary)] px-4 py-2 text-sm font-medium text-white transition hover:brightness-90 disabled:opacity-50"
          >
            {mutation.isPending ? "Saving…" : saved ? "Saved ✓" : data?.hasEntitlement ? "Rotate" : "Save"}
          </button>
        }
      />

      {!canWrite && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Your role doesn't include settings write access.
        </div>
      )}

      {isLoading ? (
        <Card>
          <p className="text-sm text-slate-500">Loading…</p>
        </Card>
      ) : (
        <>
          <Card className="mb-5 max-w-lg">
            <div className="mb-1 text-sm font-medium text-slate-700">License key</div>
            <p className="mb-3 text-xs text-slate-500">
              Paste the license key PatchPilot Support issued for this instance. The stored key is
              never shown again — only the decoded summary below.
            </p>
            <textarea
              className={`${INPUT_CLASS} h-24 font-mono text-xs`}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={!canWrite}
              placeholder="eyJhbGciOi..."
            />
            {mutation.isError && (
              <p className="mt-2 text-xs text-rose-600">
                {mutation.error instanceof ApiError
                  ? mutation.error.message
                  : "Could not save this license key."}
              </p>
            )}
          </Card>

          <Card className="mb-5 max-w-lg">
            <div className="mb-3 text-sm font-medium text-slate-700">Current plan</div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Tier</span>
                <span className="font-medium text-slate-700">
                  {tierLabel(data?.tier ?? "free", data?.trialActive ?? false)}
                </span>
              </div>
              {data?.hasEntitlement && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Status</span>
                  <span className={data.valid ? "font-medium text-emerald-600" : "font-medium text-rose-600"}>
                    {data.valid ? "Valid" : (data.invalidReason ?? "Invalid")}
                  </span>
                </div>
              )}
              {data?.hasEntitlement && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Instance ID</span>
                  <span className="font-mono text-xs text-slate-700">{data.instanceId ?? "—"}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-slate-500">Writes enabled</span>
                <span className="text-slate-700">{data?.writeEnabled ? "Yes" : "No"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Tenant limit</span>
                <span className="text-slate-700">
                  {data?.unlimited ? "Unlimited" : (data?.tenantLimit ?? 0)} (consented: {data?.consentedTenantCount ?? 0})
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Live Response device pool</span>
                <span className="text-slate-700">
                  {data?.deviceLicenseAllocated ?? 0} / {data?.unlimited ? "Unlimited" : (data?.deviceLicensePool ?? 0)} allocated
                </span>
              </div>
              {data?.hasEntitlement && (
                <>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Issued</span>
                    <span className="text-slate-700">{formatDate(data.issuedAt)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Expires</span>
                    <span className="text-slate-700">{formatDate(data.expiresAt)}</span>
                  </div>
                </>
              )}
            </div>
            {data?.tier === "free" && (
              <p className="mt-3 text-xs text-slate-500">
                Discovering and consenting tenants is always unlimited on the free tier — this
                limit only applies to writes and syncing tenant data.
              </p>
            )}
          </Card>

          {data?.tier === "free" && (
            <Card className="mb-5 max-w-lg">
              <div className="mb-1 text-sm font-medium text-slate-700">Free trial</div>
              {data.trialActive && data.trialExpiresAt ? (
                <p className="text-sm text-slate-600">
                  Trial active — {daysRemaining(data.trialExpiresAt)} day
                  {daysRemaining(data.trialExpiresAt) === 1 ? "" : "s"} remaining. Writes and up
                  to {data.deviceLicensePool ?? 30} pooled Live Response devices are enabled for
                  your first {data.tenantLimit ?? 5} tenant(s) until it expires on{" "}
                  {formatDate(data.trialExpiresAt)}.
                </p>
              ) : data.trialAvailable ? (
                <>
                  <p className="mb-3 text-sm text-slate-500">
                    Try full write access and a 30-device Live Response pool, free for 30 days
                    across your first 5 tenants. No license key required.
                  </p>
                  <button
                    onClick={() => trialMutation.mutate()}
                    disabled={!canWrite || trialMutation.isPending}
                    title={!canWrite ? "Your role doesn't include settings write access." : undefined}
                    className="rounded-md bg-[var(--pp-primary)] px-4 py-2 text-sm font-medium text-white transition hover:brightness-90 disabled:opacity-50"
                  >
                    {trialMutation.isPending ? "Starting…" : "Start 30-day trial"}
                  </button>
                  {trialMutation.isError && (
                    <p className="mt-2 text-xs text-rose-600">
                      {trialMutation.error instanceof ApiError
                        ? trialMutation.error.message
                        : "Could not start the trial."}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-slate-500">
                  Your free trial has ended — this instance is read-only until a license key is
                  uploaded below.
                </p>
              )}
            </Card>
          )}

          {data && (data.valid || data.trialActive) && data.perTenantDeviceUsage.length > 0 && (
            <Card className="max-w-lg">
              <div className="mb-1 flex items-start justify-between gap-3">
                <div className="text-sm font-medium text-slate-700">
                  Live Response device usage by tenant
                </div>
                {!data.unlimited && (data.deviceLicensePool ?? 0) > 0 && (
                  <button
                    onClick={() => autoAssignMutation.mutate()}
                    disabled={!canWrite || autoAssignMutation.isPending}
                    title={
                      !canWrite
                        ? "Your role doesn't include settings write access."
                        : "Evenly splits the pool across every write-enabled tenant and sets read-only tenants to 0. Overwrites any manual per-tenant allocation set on Settings → Tenants."
                    }
                    className="shrink-0 rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                  >
                    {autoAssignMutation.isPending ? "Assigning…" : "Auto-assign"}
                  </button>
                )}
              </div>
              <p className="mb-3 text-xs text-slate-500">
                Each tenant's allocation is your own split of the pool above — adjust one tenant at
                a time under <span className="font-medium text-slate-600">Settings → Tenants</span>,
                or use <span className="font-medium text-slate-600">Auto-assign</span> to split the
                whole pool evenly across every write-enabled tenant (read-only tenants are set to 0
                — they have no Live Response dispatch path to use a device on).
              </p>
              {autoAssignMutation.isError && (
                <p className="mb-3 text-xs text-rose-600">
                  {autoAssignMutation.error instanceof ApiError
                    ? autoAssignMutation.error.message
                    : "Could not auto-assign device licenses."}
                </p>
              )}
              {devicesAssigned && (
                <p className="mb-3 text-xs text-emerald-600">Devices re-assigned ✓</p>
              )}
              <div className="space-y-2">
                {data.perTenantDeviceUsage.map((t) => (
                  <div key={t.tenantId} className="flex items-center justify-between text-sm">
                    <span className="text-slate-600">{t.displayName}</span>
                    <span className={t.used >= t.limit ? "font-medium text-rose-600" : "text-slate-700"}>
                      {t.used} / {t.limit}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
