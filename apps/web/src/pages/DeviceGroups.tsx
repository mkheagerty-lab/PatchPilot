import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type LocalDeviceGroup, type LocalDeviceGroupMember } from "../lib/api";
import { useCan } from "../lib/auth";
import { useTenant } from "../lib/tenant";
import { Card, PageHeader } from "../components/ui";
import { NewDeviceGroupModal } from "../components/NewDeviceGroupModal";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-400 focus:outline-none";

/** Every query a group create/rename/delete/membership change can move. */
function invalidateGroupQueries(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: ["device-groups"] });
}

export function DeviceGroups() {
  const { activeTenantId } = useTenant();
  const canWrite = useCan("operations:write");
  const qc = useQueryClient();
  const key = ["device-groups", activeTenantId];

  const { data: groups = [], isLoading } = useQuery<LocalDeviceGroup[]>({
    queryKey: key,
    queryFn: () => api.get<LocalDeviceGroup[]>(`/api/local-device-groups?tenantId=${activeTenantId}`),
    enabled: !!activeTenantId,
  });

  const [createOpen, setCreateOpen] = useState(false);

  const remove = useMutation<void, Error, string>({
    mutationFn: (id) => api.del<void>(`/api/local-device-groups/${id}?tenantId=${activeTenantId}`),
    onSuccess: () => invalidateGroupQueries(qc),
  });

  const [renaming, setRenaming] = useState<LocalDeviceGroup | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameDescription, setRenameDescription] = useState("");

  const rename = useMutation<LocalDeviceGroup, Error>({
    mutationFn: () =>
      api.put<LocalDeviceGroup>(`/api/local-device-groups/${renaming!.id}`, {
        tenantId: activeTenantId,
        name: renameName,
        description: renameDescription.trim() || null,
      }),
    onSuccess: () => {
      setRenaming(null);
      invalidateGroupQueries(qc);
    },
  });

  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: members = [], isLoading: membersLoading } = useQuery<LocalDeviceGroupMember[]>({
    queryKey: ["device-group-members", expanded, activeTenantId],
    queryFn: () =>
      api.get<LocalDeviceGroupMember[]>(`/api/local-device-groups/${expanded}/members?tenantId=${activeTenantId}`),
    enabled: !!expanded && !!activeTenantId,
  });

  const removeMember = useMutation<void, Error, string>({
    mutationFn: (managedDeviceId) =>
      api.del<void>(
        `/api/local-device-groups/${expanded}/members/${managedDeviceId}?tenantId=${activeTenantId}`,
      ),
    onSuccess: () => {
      invalidateGroupQueries(qc);
      qc.invalidateQueries({ queryKey: ["device-group-members", expanded] });
    },
  });

  return (
    <div>
      <PageHeader
        title="Device Groups"
        subtitle="PatchPilot-native groups of devices, used to scope recurring schedules to a subset of the fleet instead of every device. Assign devices to a group from the Devices page."
        actions={
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700"
          >
            New device group
          </button>
        }
      />

      {isLoading ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">Loading device groups…</p>
        </Card>
      ) : groups.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">
            No device groups yet for this tenant. Click "New device group" to create one, then add
            devices to it from the Devices page.
          </p>
        </Card>
      ) : (
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Members</th>
                <th className="px-5 py-3 font-medium">Description</th>
                <th className="px-5 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const isRenaming = renaming?.id === g.id;
                const isExpanded = expanded === g.id;
                return (
                  <Fragment key={g.id}>
                    <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-5 py-3 align-top">
                        {isRenaming ? (
                          <input
                            className={INPUT_CLASS}
                            value={renameName}
                            onChange={(e) => setRenameName(e.target.value)}
                          />
                        ) : (
                          <span className="font-medium text-slate-800">{g.name}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 align-top">
                        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                          {g.memberCount} {g.memberCount === 1 ? "device" : "devices"}
                        </span>
                      </td>
                      <td className="px-5 py-3 align-top text-slate-500">
                        {isRenaming ? (
                          <textarea
                            className={INPUT_CLASS}
                            rows={2}
                            value={renameDescription}
                            onChange={(e) => setRenameDescription(e.target.value)}
                          />
                        ) : (
                          <span className="line-clamp-2">{g.description || "—"}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 align-top">
                        {isRenaming ? (
                          <div className="flex flex-col items-end gap-1">
                            <div className="flex justify-end gap-2">
                              <button
                                onClick={() => setRenaming(null)}
                                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => rename.mutate()}
                                disabled={!renameName.trim() || rename.isPending}
                                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
                              >
                                {rename.isPending ? "Saving…" : "Save"}
                              </button>
                            </div>
                            {rename.isError && (
                              <div className="text-right text-xs text-rose-600">
                                {rename.error.message}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => setExpanded(isExpanded ? null : g.id)}
                              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                            >
                              {isExpanded ? "Hide members" : "View members"}
                            </button>
                            <button
                              onClick={() => {
                                setRenaming(g);
                                setRenameName(g.name);
                                setRenameDescription(g.description ?? "");
                              }}
                              disabled={!canWrite}
                              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
                            >
                              Rename
                            </button>
                            <button
                              onClick={() => {
                                if (isExpanded) setExpanded(null);
                                remove.mutate(g.id);
                              }}
                              disabled={!canWrite || remove.isPending}
                              className="rounded-md border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 transition-colors hover:bg-rose-50 disabled:opacity-50"
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b border-slate-100 last:border-0">
                        <td colSpan={4} className="bg-slate-50 px-5 py-3">
                          {membersLoading ? (
                            <p className="text-xs text-slate-500">Loading members…</p>
                          ) : members.length === 0 ? (
                            <p className="text-xs text-slate-500">
                              No devices in this group yet — add some from the Devices page.
                            </p>
                          ) : (
                            <ul className="max-h-56 divide-y divide-slate-200 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                              {members.map((m) => (
                                <li
                                  key={m.id}
                                  className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                                >
                                  <span className="min-w-0 truncate text-slate-700">
                                    {m.deviceHostname}
                                  </span>
                                  <button
                                    onClick={() => removeMember.mutate(m.managedDeviceId)}
                                    disabled={!canWrite || removeMember.isPending}
                                    className="shrink-0 text-slate-400 transition-colors hover:text-rose-600 disabled:opacity-50"
                                  >
                                    Remove
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <NewDeviceGroupModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        tenantId={activeTenantId}
      />
    </div>
  );
}
