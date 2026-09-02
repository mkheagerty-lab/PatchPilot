import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useTenant } from "../lib/tenant";
import { useCan } from "../lib/auth";
import { PageHeader } from "../components/ui";
import { FeatureUpdatesTab } from "./windows-updates/FeatureUpdatesTab";
import { QualityUpdatesTab } from "./windows-updates/QualityUpdatesTab";
import { UpdateRingsTab } from "./windows-updates/UpdateRingsTab";
import { DriverUpdatesTab } from "./windows-updates/DriverUpdatesTab";

type Tab = "feature-updates" | "quality-updates" | "update-rings" | "driver-updates";

const TABS: { key: Tab; label: string }[] = [
  { key: "feature-updates", label: "Feature Updates" },
  { key: "quality-updates", label: "Quality Updates" },
  { key: "update-rings", label: "Update Rings" },
  { key: "driver-updates", label: "Driver Updates" },
];

interface SyncCounts {
  featureUpdates: number;
  expeditePolicies: number;
  qualityUpdatePolicies: number;
  updateRings: number;
  driverUpdates: number;
}

export function WindowsUpdates() {
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
        title="Windows Updates"
        subtitle="Feature updates, quality updates, update rings, and driver updates synced live from Intune."
        actions={
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending || isAllTenants || !activeTenantId || !canWrite}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            {sync.isPending ? "Syncing…" : "Sync now"}
          </button>
        }
      />

      {message && (
        <div
          className={`mb-4 rounded-lg border px-3 py-2 text-xs ${
            message.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="mb-4 flex w-fit items-center gap-1 rounded-lg bg-slate-100 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
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
    </div>
  );
}
