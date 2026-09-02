import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Severity } from "../../lib/api";
import { useCan } from "../../lib/auth";
import { Card, PageHeader, SeverityChip } from "../../components/ui";

type Thresholds = Record<Severity, number> & { verifiedExploit: number };

const DEFAULTS: Thresholds = {
  critical: 7,
  high: 14,
  medium: 30,
  low: 90,
  verifiedExploit: 3,
};

const ORDER: Severity[] = ["critical", "high", "medium", "low"];

export function Sla() {
  const qc = useQueryClient();
  const canWrite = useCan("settings:write");
  const [form, setForm] = useState<Thresholds>(DEFAULTS);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["settings", "sla"],
    queryFn: async () => {
      try {
        return await api.get<Thresholds>("/api/settings/sla");
      } catch {
        return DEFAULTS;
      }
    },
  });

  useEffect(() => {
    if (data) setForm({ ...DEFAULTS, ...data });
  }, [data]);

  const mutation = useMutation({
    mutationFn: (t: Thresholds) => api.put("/api/settings/sla", t),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ["settings", "sla"] });
      qc.invalidateQueries({ queryKey: ["vulnerabilities"] });
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <div>
      <PageHeader
        title="Compliance SLA"
        subtitle="Remediation deadlines per severity. Drives the SLA chips across the console."
        actions={
          <button
            onClick={() => mutation.mutate(form)}
            disabled={!canWrite || mutation.isPending}
            title={!canWrite ? "Your role doesn't include settings write access." : undefined}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
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

      {isLoading ? (
        <Card>
          <p className="text-sm text-slate-500">Loading…</p>
        </Card>
      ) : (
        <Card className="max-w-lg">
          <div className="space-y-4">
            {ORDER.map((sev) => (
              <div
                key={sev}
                className="flex items-center justify-between gap-4"
              >
                <SeverityChip severity={sev} />
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={form[sev]}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        [sev]: Math.max(1, Number(e.target.value) || 1),
                      }))
                    }
                    className="w-24 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <span className="text-sm text-slate-500">days</span>
                </div>
              </div>
            ))}

            <div className="border-t border-slate-200 pt-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-slate-800">Verified exploit override</p>
                  <p className="text-xs text-slate-500">
                    Findings where Defender confirms active exploitation must be
                    remediated within this many days, regardless of severity —
                    whichever deadline is shorter wins.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={form.verifiedExploit}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        verifiedExploit: Math.max(1, Number(e.target.value) || 1),
                      }))
                    }
                    className="w-24 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <span className="text-sm text-slate-500">days</span>
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
