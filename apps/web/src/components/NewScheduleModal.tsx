import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type LocalDeviceGroup, type LocalDeviceGroupMember, type Schedule } from "../lib/api";
import { useCan } from "../lib/auth";
import { WizardShell } from "./WizardShell";
import {
  cronToRecurrence,
  defaultRecurrence,
  RecurrencePicker,
  toCron,
  type Recurrence,
} from "./RecurrencePicker";
import {
  CHANNELS,
  INPUT_CLASS,
  ScheduleTargetFields,
  type Target,
} from "./ScheduleTargetFields";

export function NewScheduleModal({
  open,
  onClose,
  tenantId,
  groups,
  schedule,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  groups: LocalDeviceGroup[];
  /** When set, the modal edits this schedule in place (PUT) instead of creating one (POST). */
  schedule?: Schedule | null;
}) {
  const canWrite = useCan("operations:write");
  const qc = useQueryClient();
  const isEdit = !!schedule;

  const [name, setName] = useState("");
  const [recurrence, setRecurrence] = useState<Recurrence>(defaultRecurrence());
  const [channel, setChannel] = useState(CHANNELS[0]!.id);
  const [target, setTarget] = useState<Target>({});

  useEffect(() => {
    if (open) {
      setName(schedule?.name ?? "");
      // Falls back to the default recurrence if the stored cron doesn't match
      // one of the three shapes the picker can express — see cronToRecurrence.
      setRecurrence(
        (schedule?.cron ? cronToRecurrence(schedule.cron) : null) ?? defaultRecurrence(),
      );
      setChannel(schedule?.channel ?? CHANNELS[0]!.id);
      setTarget((schedule?.target as Target) ?? {});
    }
    // Re-seed whenever a different schedule is opened for editing, not just on open/close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, schedule?.id]);

  const { data: groupMembers = [] } = useQuery<LocalDeviceGroupMember[]>({
    queryKey: ["device-group-members", target.deviceGroupId, tenantId],
    queryFn: () =>
      api.get<LocalDeviceGroupMember[]>(
        `/api/local-device-groups/${target.deviceGroupId}/members?tenantId=${tenantId}`,
      ),
    enabled: !!target.deviceGroupId && !!tenantId,
  });

  const save = useMutation<Schedule, Error>({
    mutationFn: () => {
      const cron = toCron(recurrence);
      return isEdit
        ? api.put<Schedule>(`/api/schedules/${schedule!.id}`, { name, cron, channel, target })
        : api.post<Schedule>("/api/schedules", { tenantId, name, cron, channel, target });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      onClose();
    },
  });

  const canSave = canWrite && !!name.trim() && !save.isPending;

  return (
    <WizardShell
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit schedule" : "New schedule"}
      subtitle="Recurring remediation run for this tenant, re-checked against the same pre-flight gate every time it fires."
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">Name</label>
          <input
            className={INPUT_CLASS}
            value={name}
            placeholder="e.g. Nightly critical app patching"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">Recurrence</label>
          <RecurrencePicker value={recurrence} onChange={setRecurrence} />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">Channel</label>
          <select
            className={INPUT_CLASS}
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          >
            {CHANNELS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className="border-t border-slate-100 pt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Target</p>
          <ScheduleTargetFields
            target={target}
            onChange={setTarget}
            groups={groups}
            members={groupMembers}
            onGroupChange={(groupId) =>
              setTarget({
                ...target,
                deviceGroupId: groupId || undefined,
                excludedManagedDeviceIds: undefined,
              })
            }
          />
        </div>

        {!canWrite && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Your role doesn't include remediation write access.
          </div>
        )}

        {save.isError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {save.error.message}
          </div>
        )}

        <button
          onClick={() => save.mutate()}
          disabled={!canSave}
          className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : isEdit ? "Save changes" : "Create schedule"}
        </button>
      </div>
    </WizardShell>
  );
}
