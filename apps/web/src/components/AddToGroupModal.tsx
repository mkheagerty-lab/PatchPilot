import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Device, type LocalDeviceGroup } from "../lib/api";
import { useCan } from "../lib/auth";
import { SlideOver } from "./ui";

const NEW_GROUP = "__new__";

/**
 * Bulk-assigns the selected devices to a PatchPilot-native device group,
 * offering both "pick an existing group" and "create a new group" in one
 * flow — mirrors the bulk exclude action's shape (DeviceExclusionModal), but
 * the underlying operation is additive (group membership) rather than a
 * status change, so there's no "already a member" warning to show up front;
 * the add-members endpoint silently skips existing members.
 */
export function AddToGroupModal({
  open,
  onClose,
  tenantId,
  devices,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  /** One device for the row action, many for the bulk action bar. */
  devices: Device[];
}) {
  const queryClient = useQueryClient();
  const canWrite = useCan("operations:write");
  const isBulk = devices.length > 1;

  const { data: groups = [] } = useQuery<LocalDeviceGroup[]>({
    queryKey: ["device-groups", tenantId],
    queryFn: () => api.get<LocalDeviceGroup[]>(`/api/local-device-groups?tenantId=${tenantId}`),
    enabled: open && !!tenantId,
  });

  const [selection, setSelection] = useState<string>(NEW_GROUP);
  const [newGroupName, setNewGroupName] = useState("");

  useEffect(() => {
    if (!open) return;
    setSelection(NEW_GROUP);
    setNewGroupName("");
    submit.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, devices.map((d) => d.id).join(",")]);

  const submit = useMutation<{ added: number; skipped: number; groupName: string }, Error>({
    mutationFn: async () => {
      let groupId = selection;
      let groupName = groups.find((g) => g.id === selection)?.name ?? "";

      if (selection === NEW_GROUP) {
        const created = await api.post<LocalDeviceGroup>("/api/local-device-groups", {
          tenantId,
          name: newGroupName,
        });
        groupId = created.id;
        groupName = created.name;
      }

      const result = await api.post<{ added: number; skipped: number }>(
        `/api/local-device-groups/${groupId}/members`,
        { tenantId, managedDeviceIds: devices.map((d) => d.managedDeviceId) },
      );
      return { ...result, groupName };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["device-groups"] });
      queryClient.invalidateQueries({ queryKey: ["device-group-members"] });
    },
  });

  const canSubmit =
    canWrite &&
    !submit.isPending &&
    !submit.data &&
    !!tenantId &&
    devices.length > 0 &&
    (selection !== NEW_GROUP || !!newGroupName.trim());

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title={isBulk ? "Add devices to group" : "Add device to group"}
      subtitle={isBulk ? `${devices.length} devices selected` : (devices[0]?.hostname ?? "")}
      elevated
    >
      {submit.data ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-relaxed text-emerald-700">
            Added {submit.data.added} {submit.data.added === 1 ? "device" : "devices"} to "
            {submit.data.groupName}".
          </div>
          {submit.data.skipped > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {submit.data.skipped} {submit.data.skipped === 1 ? "device was" : "devices were"}{" "}
              already in this group.
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700"
          >
            Done
          </button>
        </div>
      ) : (
        <div className="space-y-5">
          {isBulk && (
            <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200 bg-white">
              {devices.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 last:border-0"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                    {d.hostname}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{d.os}</span>
                </div>
              ))}
            </div>
          )}

          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Group
            </label>
            <select
              value={selection}
              onChange={(e) => setSelection(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            >
              <option value={NEW_GROUP}>+ Create new group</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.memberCount})
                </option>
              ))}
            </select>
          </div>

          {selection === NEW_GROUP && (
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                New group name
              </label>
              <input
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
                value={newGroupName}
                placeholder="e.g. Finance workstations"
                onChange={(e) => setNewGroupName(e.target.value)}
              />
            </div>
          )}

          {!canWrite && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Your role doesn't include write access.
            </div>
          )}

          {submit.isError && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {submit.error.message}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              onClick={() => submit.mutate()}
              disabled={!canSubmit}
              className="flex-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
            >
              {submit.isPending
                ? "Saving…"
                : isBulk
                  ? `Add ${devices.length} devices`
                  : "Add device"}
            </button>
          </div>
        </div>
      )}
    </SlideOver>
  );
}
