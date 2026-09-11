import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { useTenant } from "../../lib/tenant";
import { useCan } from "../../lib/auth";
import { PageHeader } from "../../components/ui";
import { FeatureUpdatesTab } from "../windows-updates/FeatureUpdatesTab";
import { QualityUpdatesTab } from "../windows-updates/QualityUpdatesTab";
import { UpdateRingsTab } from "../windows-updates/UpdateRingsTab";
import { DriverUpdatesTab } from "../windows-updates/DriverUpdatesTab";
import { TargetBuildTab } from "../windows-updates/TargetBuildTab";

type Tab = "feature-updates" | "quality-updates" | "update-rings" | "driver-updates" | "target-build";

const TABS: { key: Tab; label: string }[] = [
  { key: "feature-updates", label: "Feature Updates" },
  { key: "quality-updates", label: "Quality Updates" },
  { key: "update-rings", label: "Update Rings" },
  { key: "driver-updates", label: "Driver Updates" },
  { key: "target-build", label: "Target Build" },
];

interface SyncCounts {
  featureUpdates: number;
  expeditePolicies: number;
  qualityUpdatePolicies: number;
  updateRings: number;
  driverUpdates: number;
}

export function WindowsUpdatePolicies() {
  const { activeTenantId, isAllTenants } = useTenant();
  const canWrite = useCan("operations:write");
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const tab = ((params.get("tab") as Tab) || "feature-updates") as Tab;
  const setTab = (next: Tab) =>
    setParams(
      (prev) => {
        const nextParams = new URLSearchParams(prev);
        if (next === "feature-updates") nextParams.delete("tab");
        else nextParams.set("tab", next);
        return nextParams;
      },
      { replace: true },
    );

  const sync = useMutation<{ counts: SyncCounts }, ApiError>({
    mutationFn: () => api.post<{ counts: SyncCounts }>("/api/windows-updates/sync", { tenantId: activeTenantId }),
    onSuccess: ({ counts }) => {
      void queryClient.invalidateQueries({ queryKey: ["feature-update-campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["quality-update-campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["update-ring-profiles"] });
      void queryClient.invalidateQueries({ queryKey: ["driver-update-profiles"] });
      setMessage({
        tone: "ok",
        text: `Synced ${counts.featureUpdates} feature updates, ${counts.expeditePolicies} expedite policies, ${counts.qualityUpdatePolicies} quality update policies, ${counts.updateRings} update rings, ${counts.driverUpdates} driver update profiles.`,
      });
    },
    onError: (err) => {
      setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Sync failed." });
    },
  });

  return (
    <div>
      <PageHeader
        title="Windows Update Policies"
        subtitle="Feature update, quality update, update ring, and driver update policies synced live from Intune, plus this tenant's target build."
        actions={
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending || isAllTenants || !activeTenantId || !canWrite}
            className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-600 dark:text-slate-300 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {sync.isPending ? "Syncing…" : "Sync now"}
          </button>
        }
      />

      {message && (
        <div
          className={`mb-4 rounded-lg border px-3 py-2 text-xs ${
            message.tone === "ok" ? "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="mb-4 flex w-fit items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm" : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "feature-updates" && <FeatureUpdatesTab />}
      {tab === "quality-updates" && <QualityUpdatesTab />}
      {tab === "update-rings" && <UpdateRingsTab />}
      {tab === "driver-updates" && <DriverUpdatesTab />}
      {tab === "target-build" && <TargetBuildTab />}
    </div>
  );
}
