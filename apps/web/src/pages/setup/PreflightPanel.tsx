import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  api,
  type Device,
  type PreflightReport,
  type PreflightStatus,
  type Vulnerability,
} from "../../lib/api";
import { useTenant } from "../../lib/tenant";
import { Card } from "../../components/ui";

const CHANNELS: { id: string; label: string; hint: string }[] = [
  { id: "live-response", label: "Defender Live Response", hint: "seconds · app + OS" },
  { id: "intune-remediation", label: "On-demand Intune Remediation", hint: "1-5 min · app" },
  { id: "win32-app", label: "Intune (Win32 app)", hint: "5-15 min · app" },
  {
    id: "expedited-quality-update",
    label: "Expedited Quality Update",
    hint: "hours · OS",
  },
];

const STATUS_STYLES: Record<PreflightStatus, string> = {
  pass: "bg-emerald-100 text-emerald-700",
  warn: "bg-amber-100 text-amber-700",
  fail: "bg-rose-100 text-rose-700",
};

const STATUS_LABELS: Record<PreflightStatus, string> = {
  pass: "Pass",
  warn: "Warn",
  fail: "Fail",
};

function StatusChip({ status }: { status: PreflightStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

const SELECT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-400 focus:outline-none";

export function PreflightPanel() {
  const { activeTenantId } = useTenant();

  const { data: vulns = [] } = useQuery<Vulnerability[]>({
    queryKey: ["vulnerabilities", activeTenantId],
    queryFn: () =>
      api.get<Vulnerability[]>(`/api/vulnerabilities?tenantId=${activeTenantId}`),
    enabled: !!activeTenantId,
  });

  const { data: devices = [] } = useQuery<Device[]>({
    queryKey: ["devices", activeTenantId],
    queryFn: () => api.get<Device[]>(`/api/devices?tenantId=${activeTenantId}`),
    enabled: !!activeTenantId,
  });

  const [vulnId, setVulnId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [channel, setChannel] = useState(CHANNELS[1]!.id);

  // Reset selections when the tenant changes so we never pre-flight a stale pair.
  useEffect(() => {
    setVulnId("");
    setDeviceId("");
  }, [activeTenantId]);

  const run = useMutation<PreflightReport, Error>({
    mutationFn: () =>
      api.post<PreflightReport>("/api/preflight", {
        tenantId: activeTenantId,
        vulnId,
        deviceId,
        channel,
      }),
  });

  const report = run.data;
  const canRun = !!vulnId && !!deviceId && !!channel;

  return (
    <div>
      <p className="mb-4 text-sm text-slate-500">
        Dry-run the last safety gate before a write action: licensing,
        consent, read-only posture, channel fit and device reachability for
        one specific fix. No changes are made.
      </p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
        <Card>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Finding
              </label>
              <select
                className={SELECT_CLASS}
                value={vulnId}
                onChange={(e) => setVulnId(e.target.value)}
              >
                <option value="">Select a finding…</option>
                {vulns.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.cveId} — {v.software} ({v.severity})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Device
              </label>
              <select
                className={SELECT_CLASS}
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
              >
                <option value="">Select a device…</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.hostname} — {d.os}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Channel
              </label>
              <select
                className={SELECT_CLASS}
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              >
                {CHANNELS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} — {c.hint}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={() => run.mutate()}
              disabled={!canRun || run.isPending}
              className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
            >
              {run.isPending ? "Running…" : "Run pre-flight"}
            </button>
          </div>
        </Card>

        <div>
          {run.isError && (
            <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {run.error.message}
            </div>
          )}

          {!report ? (
            <Card className="border-dashed">
              <p className="text-sm text-slate-500">
                Pick a finding, device and channel, then run the pre-flight to
                see whether this remediation could proceed.
              </p>
            </Card>
          ) : (
            <>
              <div
                className={`mb-4 rounded-lg border px-4 py-3 text-sm font-medium ${
                  report.canProceed
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-rose-200 bg-rose-50 text-rose-700"
                }`}
              >
                {report.canProceed
                  ? "Cleared — this remediation could proceed (no blocking checks)."
                  : "Blocked — at least one check failed. This remediation cannot proceed."}
              </div>

              <Card className="p-0">
                <ul>
                  {report.checks.map((c) => (
                    <li
                      key={c.id}
                      className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 last:border-0"
                    >
                      <div>
                        <div className="text-sm font-medium text-slate-800">
                          {c.label}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {c.detail}
                        </div>
                      </div>
                      <StatusChip status={c.status} />
                    </li>
                  ))}
                </ul>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
