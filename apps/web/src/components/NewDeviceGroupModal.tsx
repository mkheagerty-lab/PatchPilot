import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type LocalDeviceGroup } from "../lib/api";
import { useCan } from "../lib/auth";
import { WizardShell } from "./WizardShell";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-800 dark:text-slate-100 focus:border-slate-400 dark:focus:border-slate-600 focus:outline-none";

export function NewDeviceGroupModal({
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
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
    }
  }, [open]);

  const create = useMutation<LocalDeviceGroup, Error>({
    mutationFn: () =>
      api.post<LocalDeviceGroup>("/api/local-device-groups", {
        tenantId,
        name,
        description: description.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["device-groups"] });
      onClose();
    },
  });

  const canCreate = canWrite && !!name.trim() && !create.isPending;

  return (
    <WizardShell
      open={open}
      onClose={onClose}
      title="New device group"
      subtitle="PatchPilot-native group of devices, used to scope recurring schedules to a subset of the fleet."
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">Name</label>
          <input
            className={INPUT_CLASS}
            value={name}
            placeholder="e.g. Finance workstations"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Description (optional)
          </label>
          <textarea
            className={INPUT_CLASS}
            value={description}
            rows={3}
            placeholder="What this group is for"
            onChange={(e) => setDescription(e.target.value)}
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
          {create.isPending ? "Creating…" : "Create group"}
        </button>
      </div>
    </WizardShell>
  );
}
