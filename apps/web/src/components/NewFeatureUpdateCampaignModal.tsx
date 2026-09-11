import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CLIENT_BUILDS } from "@patchpilot/shared";
import { api, ApiError, type FeatureUpdateCampaign } from "../lib/api";
import { useCan } from "../lib/auth";
import { WizardShell } from "./WizardShell";
import { EntraGroupPicker, type EntraGroupPick } from "./EntraGroupPicker";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-800 dark:text-slate-100 focus:border-slate-400 dark:focus:border-slate-600 focus:outline-none";

// Unique labels in ascending build order — same dedup convention as the
// per-tenant Feature Updates settings page (settings/FeatureUpdates.tsx),
// so "21H2"/"22H2" (shared between Windows 10 and 11 builds) each appear once.
const LABEL_OPTIONS = (() => {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const build of Object.keys(CLIENT_BUILDS).map(Number).sort((a, b) => a - b)) {
    const label = CLIENT_BUILDS[build];
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
})();

// The backend (and the underlying Graph `rolloutSettings` block) still
// requires both ends of an offer window — PatchPilot doesn't yet support a
// scheduled-start campaign, so "Make update available as soon as possible"
// is computed as start = now, end = start + this many days, rather than
// exposed as pickers. A year is effectively "no end": the rollout interval
// below is what actually paces the offer, not this window's length.
const DEFAULT_OFFER_WINDOW_DAYS = 365;

export function NewFeatureUpdateCampaignModal({
  open,
  onClose,
  tenantId,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
}) {
  const canWrite = useCan("operations:write");
  const qc = useQueryClient();

  const [displayName, setDisplayName] = useState("");
  const [targetVersionLabel, setTargetVersionLabel] = useState(LABEL_OPTIONS[LABEL_OPTIONS.length - 1] ?? "");
  const [group, setGroup] = useState<EntraGroupPick | null>(null);
  const [excludeGroup, setExcludeGroup] = useState<EntraGroupPick | null>(null);
  const [intervalDays, setIntervalDays] = useState(7);
  const [optional, setOptional] = useState(false);

  useEffect(() => {
    if (open) {
      setDisplayName("");
      setTargetVersionLabel(LABEL_OPTIONS[LABEL_OPTIONS.length - 1] ?? "");
      setGroup(null);
      setExcludeGroup(null);
      setIntervalDays(7);
      setOptional(false);
    }
  }, [open]);

  const create = useMutation<{ campaign: FeatureUpdateCampaign }, ApiError>({
    mutationFn: () => {
      const start = new Date();
      const end = new Date(start.getTime() + DEFAULT_OFFER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      return api.post<{ campaign: FeatureUpdateCampaign }>("/api/feature-updates/campaigns", {
        tenantId,
        displayName: displayName.trim(),
        targetVersionLabel,
        groupId: group?.id,
        groupName: group?.displayName,
        excludeGroupId: excludeGroup?.id,
        excludeGroupName: excludeGroup?.displayName,
        offerStartDateTimeInUTC: start.toISOString(),
        offerEndDateTimeInUTC: end.toISOString(),
        offerIntervalInDays: intervalDays,
        installFeatureUpdatesOptional: optional,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feature-update-campaigns"] });
      onClose();
    },
  });

  const canCreate =
    canWrite && !!displayName.trim() && !!targetVersionLabel && !!group && intervalDays >= 1 && !create.isPending;

  return (
    <WizardShell
      open={open}
      onClose={onClose}
      title="New feature-update campaign"
      subtitle="A group-targeted, scheduled rollout to a Windows feature-update version. Intune paces the rollout itself across the offer window — this is not a one-time push."
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">Campaign name</label>
          <input
            className={INPUT_CLASS}
            value={displayName}
            placeholder="e.g. 24H2 rollout — Finance"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">Target version</label>
            <select
              className={INPUT_CLASS}
              value={targetVersionLabel}
              onChange={(e) => setTargetVersionLabel(e.target.value)}
            >
              {LABEL_OPTIONS.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={optional}
                onChange={(e) => setOptional(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-700"
              />
              Optional (not enforced at deadline)
            </label>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Rollout interval (days)
          </label>
          <input
            type="number"
            min={1}
            className={INPUT_CLASS}
            value={intervalDays}
            onChange={(e) => setIntervalDays(Math.max(1, Number(e.target.value) || 1))}
          />
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            How often Intune offers the update to another slice of the group within the window.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">Deployment options</label>
          <div className="space-y-2 rounded-lg border border-slate-300 dark:border-slate-700 p-3">
            <label className="flex items-start gap-2.5 rounded-md border border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-500/10 px-3 py-2.5">
              <input
                type="radio"
                checked
                readOnly
                disabled
                className="mt-0.5 h-4 w-4 border-slate-300 dark:border-slate-700"
              />
              <span>
                <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                  Make update available as soon as possible
                </span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  Intune starts offering the update to the assigned group right away, paced by the
                  rollout interval above.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2.5 rounded-md border border-slate-200 dark:border-slate-800 px-3 py-2.5 opacity-50">
              <input type="radio" disabled className="mt-0.5 h-4 w-4 border-slate-300 dark:border-slate-700" />
              <span>
                <span className="block text-sm font-medium text-slate-600 dark:text-slate-400">
                  Make update available on a specific date
                </span>
                <span className="block text-xs text-slate-500 dark:text-slate-500">
                  Not yet supported by PatchPilot.
                </span>
              </span>
            </label>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">Included group</label>
          <EntraGroupPicker
            tenantId={tenantId}
            value={group}
            onChange={setGroup}
            placeholder="Search Entra groups…"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Excluded group (optional)
          </label>
          <EntraGroupPicker
            tenantId={tenantId}
            value={excludeGroup}
            onChange={setExcludeGroup}
            placeholder="Search Entra groups to exclude…"
          />
        </div>

        {!canWrite && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            Your role doesn't include remediation write access.
          </div>
        )}

        {create.isError && (
          <div className="rounded-lg border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-400">
            {create.error.message}
          </div>
        )}

        <button
          onClick={() => create.mutate()}
          disabled={!canCreate}
          className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          {create.isPending ? "Creating…" : "Create campaign"}
        </button>
      </div>
    </WizardShell>
  );
}
