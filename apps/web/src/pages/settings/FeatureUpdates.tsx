import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CLIENT_BUILDS, latestClientBuild } from "@patchpilot/shared";
import { api } from "../../lib/api";
import { useCan } from "../../lib/auth";
import { useTenant } from "../../lib/tenant";
import { Card, PageHeader } from "../../components/ui";

/** Sentinel <select> value for "use the default" — maps to null on save. */
const DEFAULT_VALUE = "__default__";

// Unique labels in ascending build order, first occurrence wins for any label
// shared by a Windows 10 and Windows 11 build (e.g. "21H2", "22H2") — matches
// resolveTargetBuild()'s own first-match resolution exactly, so what an
// engineer picks here is what a device comparison will actually resolve to.
const LABEL_OPTIONS = (() => {
  const seen = new Set<string>();
  const options: { build: number; label: string }[] = [];
  for (const build of Object.keys(CLIENT_BUILDS).map(Number).sort((a, b) => a - b)) {
    const label = CLIENT_BUILDS[build];
    if (!label || seen.has(label)) continue;
    seen.add(label);
    options.push({ build, label });
  }
  return options;
})();

const DEFAULT_LABEL = CLIENT_BUILDS[latestClientBuild()];

export function FeatureUpdates() {
  const qc = useQueryClient();
  const canWrite = useCan("settings:write");
  const { activeTenant, activeTenantId, isAllTenants } = useTenant();

  const [selected, setSelected] = useState<string>(DEFAULT_VALUE);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSelected(activeTenant?.featureUpdateTargetVersion ?? DEFAULT_VALUE);
  }, [activeTenant?.featureUpdateTargetVersion]);

  const mutation = useMutation({
    mutationFn: (targetVersionLabel: string | null) =>
      api.patch(`/api/tenants/${activeTenantId}`, { featureUpdateTargetVersion: targetVersionLabel }),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ["tenants"] });
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const dirty = (activeTenant?.featureUpdateTargetVersion ?? DEFAULT_VALUE) !== selected;

  return (
    <div>
      <PageHeader
        title="Target Build"
        subtitle="The Windows feature-update version this tenant's fleet should be on. Devices behind this build show as “Behind” on the Devices page. Not the same as the Windows Updates page's Feature Updates tab, which manages actual Intune rollout policies."
        actions={
          <button
            onClick={() => mutation.mutate(selected === DEFAULT_VALUE ? null : selected)}
            disabled={!canWrite || !activeTenant || !dirty || mutation.isPending}
            title={!canWrite ? "Your role doesn't include settings write access." : undefined}
            className="rounded-md bg-[var(--pp-primary)] px-4 py-2 text-sm font-medium text-white transition hover:brightness-90 disabled:opacity-50"
          >
            {mutation.isPending ? "Saving…" : saved ? "Saved ✓" : "Save"}
          </button>
        }
      />

      {!canWrite && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Your role doesn't include settings write access.
        </div>
      )}

      {isAllTenants || !activeTenant ? (
        <Card className="max-w-lg">
          <p className="text-sm text-slate-500">
            Select a single tenant from the switcher above to set its feature-update target.
          </p>
        </Card>
      ) : (
        <Card className="max-w-lg">
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-800">
                Target version
              </label>
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                disabled={!canWrite}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
              >
                <option value={DEFAULT_VALUE}>Use default (latest: {DEFAULT_LABEL})</option>
                {LABEL_OPTIONS.map(({ label }) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-slate-500">
                A device is flagged “Behind” once its installed build is older than this target.
                Leave on default to always track the latest known release.
              </p>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
