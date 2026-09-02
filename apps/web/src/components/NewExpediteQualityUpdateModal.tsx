import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type QualityUpdateCampaign, type QualityUpdateCatalogRelease } from "../lib/api";
import { useCan } from "../lib/auth";
import { WizardShell } from "./WizardShell";
import { EntraGroupPicker, type EntraGroupPick } from "./EntraGroupPicker";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-400 focus:outline-none";

const REBOOT_OPTIONS: { value: 0 | 1 | 2; label: string }[] = [
  { value: 0, label: "0 days — reboot as soon as installed" },
  { value: 1, label: "1 day grace period" },
  { value: 2, label: "2 day grace period" },
];

/**
 * Standalone "Create → Expedite policy" flow for the Quality Updates tab —
 * a release picker (no Missing KB required first, unlike
 * MissingKbFixAllModal's KB-first flow), backed by GET
 * /api/quality-updates/catalog (newest B/OOB item per cadence).
 */
export function NewExpediteQualityUpdateModal({
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
  const [catalogItemId, setCatalogItemId] = useState("");
  const [group, setGroup] = useState<EntraGroupPick | null>(null);
  const [excludeGroup, setExcludeGroup] = useState<EntraGroupPick | null>(null);
  const [daysUntilForcedReboot, setDaysUntilForcedReboot] = useState<0 | 1 | 2>(0);

  useEffect(() => {
    if (open) {
      setDisplayName("");
      setCatalogItemId("");
      setGroup(null);
      setExcludeGroup(null);
      setDaysUntilForcedReboot(0);
    }
  }, [open]);

  const { data: releases = [], isLoading: releasesLoading } = useQuery<QualityUpdateCatalogRelease[]>({
    queryKey: ["quality-updates-catalog", tenantId],
    queryFn: async () => {
      const { releases } = await api.get<{ releases: QualityUpdateCatalogRelease[] }>(
        `/api/quality-updates/catalog?tenantId=${tenantId}`,
      );
      return releases;
    },
    enabled: open && !!tenantId,
  });

  const selectedRelease = releases.find((r) => r.id === catalogItemId) ?? null;

  const create = useMutation<{ campaign: QualityUpdateCampaign }, ApiError>({
    mutationFn: () =>
      api.post<{ campaign: QualityUpdateCampaign }>("/api/quality-updates/campaigns", {
        tenantId,
        displayName: displayName.trim(),
        catalogItemId,
        releaseLabel: selectedRelease?.displayName ?? "",
        daysUntilForcedReboot,
        groupId: group?.id,
        groupName: group?.displayName,
        excludeGroupId: excludeGroup?.id,
        excludeGroupName: excludeGroup?.displayName,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quality-update-campaigns"] });
      onClose();
    },
  });

  const canCreate =
    canWrite &&
    !!displayName.trim() &&
    !!catalogItemId &&
    !!group &&
    !create.isPending;

  return (
    <WizardShell
      open={open}
      onClose={onClose}
      title="New expedite policy"
      subtitle="Pushes a specific Windows quality update to a group ahead of the normal servicing schedule. This is a direct Intune write, paced by daysUntilForcedReboot, not a job dispatch."
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">Policy name</label>
          <input
            className={INPUT_CLASS}
            value={displayName}
            placeholder="e.g. August OOB — Finance"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Release</label>
            <select
              className={INPUT_CLASS}
              value={catalogItemId}
              onChange={(e) => setCatalogItemId(e.target.value)}
              disabled={releasesLoading}
            >
              <option value="" disabled>
                {releasesLoading ? "Loading releases…" : "Select a release…"}
              </option>
              {releases.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.displayName} ({r.cadence})
                </option>
              ))}
            </select>
            {!releasesLoading && releases.length === 0 && (
              <p className="mt-1 text-[11px] text-amber-600">
                No expeditable releases found for this tenant right now.
              </p>
            )}
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

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">
            Forced reboot grace period
          </label>
          <select
            className={INPUT_CLASS}
            value={daysUntilForcedReboot}
            onChange={(e) => setDaysUntilForcedReboot(Number(e.target.value) as 0 | 1 | 2)}
          >
            {REBOOT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
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
          {create.isPending ? "Creating…" : "Create policy"}
        </button>
      </div>
    </WizardShell>
  );
}
