import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type QualityUpdateRelease } from "../lib/api";
import { EntraGroupPicker, type EntraGroupPick } from "./EntraGroupPicker";

export interface QualityUpdateOptionsValue {
  displayName: string;
  catalogItemId: string;
  /** The chosen release's displayName, frozen at selection time — carried
   *  alongside `catalogItemId` because the group-campaign route needs a
   *  human-readable label without re-deriving it server-side. */
  releaseLabel: string;
  daysUntilForcedReboot: 0 | 1 | 2;
  /** Fix All only: an Entra group. Empty groupId = fix the checked devices
   *  individually (unchanged); set = create a group-targeted Intune campaign
   *  instead. Ignored by Fix Now. */
  groupId: string;
  groupName: string;
  excludeGroupId: string;
  excludeGroupName: string;
}

export function defaultQualityUpdateOptions(seed?: { kbId?: string }): QualityUpdateOptionsValue {
  return {
    displayName: seed?.kbId ? `PatchPilot Expedited Update - KB${seed.kbId}` : "",
    catalogItemId: "",
    releaseLabel: "",
    daysUntilForcedReboot: 2,
    groupId: "",
    groupName: "",
    excludeGroupId: "",
    excludeGroupName: "",
  };
}

const REBOOT_OPTIONS: { days: 0 | 1 | 2; label: string }[] = [
  { days: 0, label: "Force restart immediately after install" },
  { days: 1, label: "Force restart after 1 day" },
  { days: 2, label: "Force restart after 2 days (Intune default)" },
];

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none";

function cadenceGroupLabel(cadence: QualityUpdateRelease["cadence"]): string {
  if (cadence === "B") return "Monthly (B) releases";
  if (cadence === "OOB") return "Out-of-band releases";
  return "Other releases";
}

/**
 * Controlled fields for configuring an Expedited Quality Update profile —
 * mirrors Win32DeployOptionsPanel/StoreAppDeployOptionsPanel's shape: the
 * parent owns the value, the dispatch call, and validation. Fetches the
 * tenant's real Intune quality-update catalog for the release picker rather
 * than trusting whatever single item the KB happened to auto-match, since the
 * real Intune wizard lets an engineer pick any release, not just the matched
 * one.
 *
 * `showAssignments` is Fix All-only — Fix Now always targets exactly one
 * device via the existing per-device assignment filter, so it never needs a
 * group name.
 */
export function QualityUpdateOptionsPanel({
  value,
  onChange,
  tenantId,
  missingKbId,
  disabled,
  showAssignments = false,
}: {
  value: QualityUpdateOptionsValue;
  onChange: (value: QualityUpdateOptionsValue) => void;
  tenantId: string;
  /** A `missing_kbs` row id for this KB — any device's row works, since the
   *  release list and KB match are tenant+KB scoped, not device scoped. */
  missingKbId: string;
  disabled?: boolean;
  showAssignments?: boolean;
}) {
  const set = <K extends keyof QualityUpdateOptionsValue>(key: K, v: QualityUpdateOptionsValue[K]) =>
    onChange({ ...value, [key]: v });

  const { data, isLoading, isError, error, refetch } = useQuery<{ releases: QualityUpdateRelease[] }>({
    queryKey: ["quality-update-releases", tenantId, missingKbId],
    queryFn: () =>
      api.get<{ releases: QualityUpdateRelease[] }>(
        `/api/missing-kbs/${missingKbId}/quality-update-releases?tenantId=${encodeURIComponent(tenantId)}`,
      ),
    enabled: !!tenantId && !!missingKbId,
    retry: 1,
  });
  const releases = (data?.releases ?? []).filter((r) => r.isExpeditable);

  // Auto-select the release that matches this KB (mirrors the executor's
  // prior "just match by KB" default) as soon as the catalog loads, but only
  // if nothing's been chosen yet — never overrides an engineer's pick.
  useEffect(() => {
    if (value.catalogItemId || releases.length === 0) return;
    const match = releases.find((r) => r.matchesKbId) ?? releases[0]!;
    onChange({ ...value, catalogItemId: match.id, releaseLabel: match.displayName });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, value.catalogItemId]);

  const grouped = new Map<string, QualityUpdateRelease[]>();
  for (const r of releases) {
    const key = cadenceGroupLabel(r.cadence);
    const list = grouped.get(key);
    if (list) list.push(r);
    else grouped.set(key, [r]);
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Profile Name
        </label>
        <input
          className={INPUT_CLASS}
          value={value.displayName}
          onChange={(e) => set("displayName", e.target.value)}
          disabled={disabled}
        />
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Quality update release
        </label>
        {isLoading ? (
          <p className="text-xs text-slate-500">Loading releases from Intune…</p>
        ) : isError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <p>Failed to load releases from Intune{error instanceof Error ? `: ${error.message}` : ""}.</p>
            <button
              type="button"
              className="mt-1 font-semibold underline"
              onClick={() => refetch()}
            >
              Retry
            </button>
          </div>
        ) : releases.length === 0 ? (
          <p className="text-xs text-slate-500">
            No expeditable releases found in this tenant's Intune quality-update catalog.
          </p>
        ) : (
          <select
            className={INPUT_CLASS}
            value={value.catalogItemId}
            onChange={(e) => {
              const release = releases.find((r) => r.id === e.target.value);
              onChange({
                ...value,
                catalogItemId: e.target.value,
                releaseLabel: release?.displayName ?? "",
              });
            }}
            disabled={disabled}
          >
            <option value="">Select a release…</option>
            {[...grouped.entries()].map(([label, items]) => (
              <optgroup key={label} label={label}>
                {items.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName}
                    {r.matchesKbId ? " (matches this KB)" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Reboot enforcement
        </label>
        <select
          className={INPUT_CLASS}
          value={value.daysUntilForcedReboot}
          onChange={(e) => set("daysUntilForcedReboot", Number(e.target.value) as 0 | 1 | 2)}
          disabled={disabled}
        >
          {REBOOT_OPTIONS.map((o) => (
            <option key={o.days} value={o.days}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {showAssignments && (
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Assignments (optional)
          </label>
          <EntraGroupPicker
            tenantId={tenantId}
            value={value.groupId ? { id: value.groupId, displayName: value.groupName } : null}
            onChange={(pick: EntraGroupPick | null) =>
              onChange({ ...value, groupId: pick?.id ?? "", groupName: pick?.displayName ?? "" })
            }
            disabled={disabled}
            placeholder="Search Entra groups to include…"
          />
          <p className="mt-1 text-[11px] leading-tight text-slate-500">
            Leave blank to fix only the checked devices below. Set a group to create one
            group-targeted Intune campaign instead — Intune paces delivery to the whole group
            itself, replacing the device checklist below.
          </p>
          {value.groupId && (
            <>
              <div className="mt-3">
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Excluded group (optional)
                </label>
                <EntraGroupPicker
                  tenantId={tenantId}
                  value={
                    value.excludeGroupId
                      ? { id: value.excludeGroupId, displayName: value.excludeGroupName }
                      : null
                  }
                  onChange={(pick: EntraGroupPick | null) =>
                    onChange({
                      ...value,
                      excludeGroupId: pick?.id ?? "",
                      excludeGroupName: pick?.displayName ?? "",
                    })
                  }
                  disabled={disabled}
                  placeholder="Search Entra groups to exclude…"
                />
              </div>
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                Requires the Group.Read.All scope. Tenants onboarded before this feature shipped need
                re-consent before group assignment works here.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
