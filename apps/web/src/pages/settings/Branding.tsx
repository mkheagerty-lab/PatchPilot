import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useCan } from "../../lib/auth";
import { Card, PageHeader } from "../../components/ui";

interface Branding {
  productName: string;
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  logoUrl: string | null;
}

const DEFAULTS: Branding = {
  productName: "PatchPilot",
  primary: "#4f46e5",
  secondary: "#0ea5e9",
  accent: "#f59e0b",
  background: "#0b1020",
  logoUrl: null,
};

const COLOR_FIELDS: { key: keyof Branding; label: string }[] = [
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "accent", label: "Accent" },
  { key: "background", label: "Sidebar / background" },
];

export function Branding() {
  const qc = useQueryClient();
  const canWrite = useCan("settings:write");
  const [form, setForm] = useState<Branding>(DEFAULTS);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["settings", "branding"],
    // 404 is fine for a never-set key; fall back to defaults.
    queryFn: async () => {
      try {
        return await api.get<Branding>("/api/settings/branding");
      } catch {
        return DEFAULTS;
      }
    },
  });

  useEffect(() => {
    if (data) setForm({ ...DEFAULTS, ...data });
  }, [data]);

  const mutation = useMutation({
    mutationFn: (b: Branding) => api.put("/api/settings/branding", b),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ["settings", "branding"] });
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const update = (key: keyof Branding, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  return (
    <div>
      <PageHeader
        title="Branding"
        subtitle="White-label the console for your MSP. Ported from the prototype."
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
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card>
            <h3 className="mb-4 text-sm font-semibold text-slate-700">
              Identity
            </h3>
            <label className="mb-4 block">
              <span className="mb-1 block text-sm font-medium text-slate-600">
                Product name
              </span>
              <input
                value={form.productName}
                onChange={(e) => update("productName", e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-600">
                Logo URL
              </span>
              <input
                value={form.logoUrl ?? ""}
                onChange={(e) =>
                  update("logoUrl", e.target.value)
                }
                placeholder="https://…/logo.svg"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <span className="mt-1 block text-xs text-slate-400">
                Palette extraction from an uploaded logo lands in a later phase.
              </span>
            </label>
          </Card>

          <Card>
            <h3 className="mb-4 text-sm font-semibold text-slate-700">
              Colours
            </h3>
            <div className="space-y-3">
              {COLOR_FIELDS.map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between">
                  <span className="text-sm text-slate-600">{label}</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={form[key] as string}
                      onChange={(e) => update(key, e.target.value)}
                      className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm font-mono"
                    />
                    <input
                      type="color"
                      value={form[key] as string}
                      onChange={(e) => update(key, e.target.value)}
                      className="h-9 w-12 cursor-pointer rounded border border-slate-300"
                    />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="lg:col-span-2">
            <h3 className="mb-4 text-sm font-semibold text-slate-700">
              Preview
            </h3>
            <div className="flex overflow-hidden rounded-lg border border-slate-200">
              <div
                className="flex w-48 flex-col gap-2 p-4 text-white"
                style={{ background: form.background }}
              >
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold"
                  style={{ background: form.primary }}
                >
                  {form.productName.slice(0, 2).toUpperCase()}
                </div>
                <span className="text-sm font-semibold">
                  {form.productName}
                </span>
              </div>
              <div className="flex-1 bg-slate-50 p-5">
                <div className="flex gap-2">
                  <span
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
                    style={{ background: form.primary }}
                  >
                    Primary
                  </span>
                  <span
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
                    style={{ background: form.secondary }}
                  >
                    Secondary
                  </span>
                  <span
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
                    style={{ background: form.accent }}
                  >
                    Accent
                  </span>
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
