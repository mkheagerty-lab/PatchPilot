import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type SmtpSettings } from "../../lib/api";
import { useCan } from "../../lib/auth";
import { Card, PageHeader } from "../../components/ui";

const DEFAULTS: SmtpSettings = {
  enabled: false,
  host: "",
  port: 587,
  user: "",
  hasPassword: false,
  secure: false,
  from: "",
};

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-slate-400 focus:outline-none";

/**
 * Settings > Notifications — the SMTP relay used for job/sync failure alert
 * emails (see packages/shared/src/alerting.ts). Entirely optional: nothing
 * sends until this is filled in and enabled, and even then only to the
 * people who've opted in on Settings > Users (or are admins, on by default).
 *
 * The password field never round-trips the real secret — the GET only ever
 * reports `hasPassword`, and an empty Password field on save means "keep
 * what's already stored" (see apps/api/src/routes/notification-settings.ts).
 */
export function Notifications() {
  const qc = useQueryClient();
  const canWrite = useCan("settings:write");
  const [form, setForm] = useState<SmtpSettings & { pass: string }>({ ...DEFAULTS, pass: "" });
  const [saved, setSaved] = useState(false);
  const [testRecipient, setTestRecipient] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["settings", "smtp"],
    queryFn: async () => {
      try {
        return await api.get<SmtpSettings>("/api/settings/smtp");
      } catch {
        return DEFAULTS;
      }
    },
  });

  useEffect(() => {
    if (data) setForm({ ...DEFAULTS, ...data, pass: "" });
  }, [data]);

  const mutation = useMutation({
    mutationFn: (t: SmtpSettings & { pass: string }) =>
      api.put<SmtpSettings>("/api/settings/smtp", {
        enabled: t.enabled,
        host: t.host,
        port: t.port,
        user: t.user,
        pass: t.pass || undefined,
        secure: t.secure,
        from: t.from,
      }),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ["settings", "smtp"] });
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const testMutation = useMutation({
    mutationFn: () =>
      api.post<{ sent: boolean }>("/api/settings/smtp/test", {
        enabled: form.enabled,
        host: form.host,
        port: form.port,
        user: form.user,
        pass: form.pass || undefined,
        secure: form.secure,
        from: form.from,
        testRecipient: testRecipient.trim(),
      }),
    onSuccess: () => setTestResult({ ok: true, message: "Test email sent — check the inbox." }),
    onError: (err) =>
      setTestResult({
        ok: false,
        message: err instanceof ApiError ? err.message : "Could not send the test email.",
      }),
  });

  const canSendTest = canWrite && !!form.host && !!testRecipient.trim() && !testMutation.isPending;

  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle="SMTP relay for job and sync failure alert emails. Optional — nothing sends until this is enabled."
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
        <>
          <Card className="mb-5 max-w-lg">
            <label className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                disabled={!canWrite}
                className="rounded border-slate-300"
              />
              Enable alert emails
            </label>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">SMTP host</label>
                <input
                  className={INPUT_CLASS}
                  value={form.host}
                  onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
                  disabled={!canWrite}
                  placeholder="smtp.office365.com"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Port</label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    className={INPUT_CLASS}
                    value={form.port}
                    onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) || 587 }))}
                    disabled={!canWrite}
                  />
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      checked={form.secure}
                      onChange={(e) => setForm((f) => ({ ...f, secure: e.target.checked }))}
                      disabled={!canWrite}
                      className="rounded border-slate-300"
                    />
                    Use TLS (implicit, e.g. port 465)
                  </label>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Username</label>
                <input
                  className={INPUT_CLASS}
                  value={form.user}
                  onChange={(e) => setForm((f) => ({ ...f, user: e.target.value }))}
                  disabled={!canWrite}
                  placeholder="alerts@yourdomain.com"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Password</label>
                <input
                  type="password"
                  className={INPUT_CLASS}
                  value={form.pass}
                  onChange={(e) => setForm((f) => ({ ...f, pass: e.target.value }))}
                  disabled={!canWrite}
                  placeholder={form.hasPassword ? "•••••••• (leave blank to keep current)" : ""}
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">From address</label>
                <input
                  className={INPUT_CLASS}
                  value={form.from}
                  onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))}
                  disabled={!canWrite}
                  placeholder="patchpilot@yourdomain.com"
                />
              </div>
            </div>
          </Card>

          <Card className="max-w-lg">
            <div className="mb-1 text-sm font-medium text-slate-700">Send a test email</div>
            <p className="mb-3 text-xs text-slate-500">
              Sends using the settings above (including any unsaved changes) — use it to confirm the
              relay works before saving.
            </p>
            <div className="flex items-center gap-2">
              <input
                type="email"
                className={INPUT_CLASS}
                value={testRecipient}
                onChange={(e) => setTestRecipient(e.target.value)}
                disabled={!canWrite}
                placeholder="you@yourdomain.com"
              />
              <button
                type="button"
                onClick={() => testMutation.mutate()}
                disabled={!canSendTest}
                className="shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {testMutation.isPending ? "Sending…" : "Send test"}
              </button>
            </div>
            {testResult && (
              <p className={`mt-2 text-xs ${testResult.ok ? "text-emerald-600" : "text-rose-600"}`}>
                {testResult.message}
              </p>
            )}
          </Card>

          <Card className="mt-5 max-w-lg border-dashed">
            <p className="text-sm text-slate-500">
              Who actually receives these emails is controlled per-person on{" "}
              <span className="font-medium text-slate-600">Settings &gt; Users</span> — admins are
              opted in by default, everyone else opts in individually.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
