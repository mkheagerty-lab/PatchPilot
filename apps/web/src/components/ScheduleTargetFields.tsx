import type { LocalDeviceGroup, LocalDeviceGroupMember } from "../lib/api";

export const CHANNELS: { id: string; label: string }[] = [
  { id: "live-response", label: "Defender Live Response" },
  { id: "intune-remediation", label: "On-demand Intune Remediation" },
  { id: "win32-app", label: "Intune (Win32 app)" },
  { id: "expedited-quality-update", label: "Expedited Quality Update" },
];

export const CHANNEL_LABELS: Record<string, string> = Object.fromEntries(
  CHANNELS.map((c) => [c.id, c.label]),
);

const SEVERITIES = ["", "none", "low", "medium", "high", "critical"] as const;
const SEVERITY_LABELS: Record<(typeof SEVERITIES)[number], string> = {
  "": "Any severity",
  none: "None — also sweeps software with no CVE",
  low: "Low+",
  medium: "Medium+",
  high: "High+",
  critical: "Critical only",
};
const PATCH_TYPES: { id: "" | "app" | "os"; label: string }[] = [
  { id: "", label: "App fixes & OS updates" },
  { id: "app", label: "App fixes only" },
  { id: "os", label: "OS updates only" },
];

export const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-400 focus:outline-none";

/** The `target` jsonb this UI reads/writes — mirrors ScheduleTarget in packages/shared. */
export interface Target {
  severity?: string;
  patchType?: "app" | "os";
  deviceGroupId?: string;
  excludedManagedDeviceIds?: string[];
  /** Set only by RunNowModal's Automated tab — locks the schedule to one software title. Not editable here. */
  software?: string;
}

export function summarizeTarget(target: Record<string, unknown>, groups: LocalDeviceGroup[]): string {
  const t = target as Target;
  const parts: string[] = [];
  if (t.software) parts.push(`only "${t.software}"`);
  if (t.deviceGroupId) {
    const g = groups.find((g) => g.id === t.deviceGroupId);
    parts.push(g ? `group "${g.name}"` : "an unknown/deleted group");
  } else {
    parts.push("all devices");
  }
  if (t.excludedManagedDeviceIds?.length) {
    parts.push(`${t.excludedManagedDeviceIds.length} excluded`);
  }
  if (t.severity === "none") parts.push("none (includes non-CVE software)");
  else if (t.severity) parts.push(`${t.severity}+ severity`);
  if (t.patchType) parts.push(t.patchType === "app" ? "app fixes only" : "OS updates only");
  return parts.join(" · ");
}

/** Target editor shared by the create-schedule popout and the per-row "Edit targeting" expand. */
export function ScheduleTargetFields({
  target,
  onChange,
  groups,
  members,
  onGroupChange,
}: {
  target: Target;
  onChange: (next: Target) => void;
  groups: LocalDeviceGroup[];
  /** Members of the currently-selected group, for the exclude multi-select. Empty when "All devices." */
  members: LocalDeviceGroupMember[];
  onGroupChange: (groupId: string) => void;
}) {
  return (
    <div className="space-y-3">
      {target.software && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Locked to <span className="font-medium">"{target.software}"</span> — this
          schedule was created from a Fix Now dialog and only ever targets
          that software. The scope below narrows devices, patch type, and
          severity on top of it.
        </div>
      )}
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-600">Device group</label>
        <select
          className={INPUT_CLASS}
          value={target.deviceGroupId ?? ""}
          onChange={(e) => onGroupChange(e.target.value)}
        >
          <option value="">All devices</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.memberCount})
            </option>
          ))}
        </select>
      </div>

      {target.deviceGroupId && members.length > 0 && (
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">
            Exclude from this schedule
          </label>
          <div className="max-h-32 overflow-y-auto rounded-lg border border-slate-300 bg-white">
            {members.map((m) => {
              const excluded = target.excludedManagedDeviceIds?.includes(m.managedDeviceId) ?? false;
              return (
                <label
                  key={m.id}
                  className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-xs text-slate-700 last:border-0"
                >
                  <input
                    type="checkbox"
                    checked={excluded}
                    onChange={(e) => {
                      const current = target.excludedManagedDeviceIds ?? [];
                      const next = e.target.checked
                        ? [...current, m.managedDeviceId]
                        : current.filter((id) => id !== m.managedDeviceId);
                      onChange({ ...target, excludedManagedDeviceIds: next.length ? next : undefined });
                    }}
                  />
                  {m.deviceHostname}
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs font-medium text-slate-600">Minimum severity level</label>
        <select
          className={INPUT_CLASS}
          value={target.severity ?? ""}
          onChange={(e) => onChange({ ...target, severity: e.target.value || undefined })}
        >
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {SEVERITY_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-slate-600">Patch type</label>
        <select
          className={INPUT_CLASS}
          value={target.patchType ?? ""}
          onChange={(e) =>
            onChange({ ...target, patchType: (e.target.value || undefined) as Target["patchType"] })
          }
        >
          {PATCH_TYPES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
