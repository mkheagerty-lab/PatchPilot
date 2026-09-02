import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CLIENT_BUILDS } from "@patchpilot/shared";
import { api, ApiError, type FeatureUpdateCampaign } from "../lib/api";
import { useCan } from "../lib/auth";
import { WizardShell } from "./WizardShell";
import { EntraGroupPicker, type EntraGroupPick } from "./EntraGroupPicker";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-400 focus:outline-none";

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

/** Local datetime-input value (no timezone) → an ISO string for the API. */
function toIso(localDateTime: string): string | null {
  if (!localDateTime) return null;
  const d = new Date(localDateTime);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

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
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [intervalDays, setIntervalDays] = useState(7);
  const [optional, setOptional] = useState(false);

  useEffect(() => {
    if (open) {
      setDisplayName("");
      setTargetVersionLabel(LABEL_OPTIONS[LABEL_OPTIONS.length - 1] ?? "");
      setGroup(null);
      setExcludeGroup(null);
      setStart("");
      setEnd("");
      setIntervalDays(7);
      setOptional(false);
    }
  }, [open]);

  const startIso = useMemo(() => toIso(start), [start]);
  const endIso = useMemo(() => toIso(end), [end]);

  const create = useMutation<{ campaign: FeatureUpdateCampaign }, ApiError>({
    mutationFn: () =>
      api.post<{ campaign: FeatureUpdateCampaign }>("/api/feature-updates/campaigns", {
        tenantId,
        displayName: displayName.trim(),
        targetVersionLabel,
        groupId: group?.id,
        groupName: group?.displayName,
        excludeGroupId: excludeGroup?.id,
        excludeGroupName: excludeGroup?.displayName,
        offerStartDateTimeInUTC: startIso,
        offerEndDateTimeInUTC: endIso,
        offerIntervalInDays: intervalDays,
        installFeatureUpdatesOptional: optional,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feature-update-campaigns"] });
      onClose();
    },
  });

  const canCreate =
    canWrite &&
    !!displayName.trim() &&
    !!targetVersionLabel &&
    !!group &&
    !!startIso &&
    !!endIso &&
    intervalDays >= 1 &&
    !create.isPending;

  return (
    <WizardShell
      open={open}
      onClose={onClose}
      title="New feature-update campaign"
      subtitle="A group-targeted, scheduled rollout to a Windows feature-update version. Intune paces the rollout itself across the offer window — this is not a one-time push."
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">Campaign name</label>
          <input
            className={INPUT_CLASS}
            value={displayName}
            placeholder="e.g. 24H2 rollout — Finance"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Target version</label>
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
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Included group</label>
            <EntraGroupPicker
              tenantId={tenantId}
              value={group}
              onChange={setGroup}
              placeholder="Search Entra groups…"
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">
            Excluded group (optional)
          </label>
          <EntraGroupPicker
            tenantId={tenantId}
            value={excludeGroup}
            onChange={setExcludeGroup}
            placeholder="Search Entra groups to exclude…"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Offer starts</label>
            <input
              type="datetime-local"
              className={INPUT_CLASS}
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Offer ends</label>
            <input
              type="datetime-local"
              className={INPUT_CLASS}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              Rollout interval (days)
            </label>
            <input
              type="number"
              min={1}
              className={INPUT_CLASS}
              value={intervalDays}
              onChange={(e) => setIntervalDays(Math.max(1, Number(e.target.value) || 1))}
            />
            <p className="mt-1 text-[11px] text-slate-500">
              How often Intune offers the update to another slice of the group within the window.
            </p>
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={optional}
                onChange={(e) => setOptional(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Optional (not enforced at deadline)
            </label>
          </div>
        </div>

        {!canWrite && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Your role doesn't include remediation write access.
          </div>
        )}

        {create.isError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
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
