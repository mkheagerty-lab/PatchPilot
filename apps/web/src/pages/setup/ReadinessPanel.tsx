import { useQuery } from "@tanstack/react-query";
import {
  api,
  type CheckStatus,
  type ReadinessReport,
} from "../../lib/api";
import { useTenant } from "../../lib/tenant";
import { Card, KpiCard } from "../../components/ui";

const STATUS_STYLES: Record<CheckStatus, string> = {
  pass: "bg-emerald-100 text-emerald-700",
  warn: "bg-amber-100 text-amber-700",
  fail: "bg-rose-100 text-rose-700",
  pending: "bg-slate-100 text-slate-500",
};

const STATUS_LABELS: Record<CheckStatus, string> = {
  pass: "Pass",
  warn: "Warn",
  fail: "Fail",
  pending: "Pending",
};

function StatusChip({ status }: { status: CheckStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

export function ReadinessPanel() {
  const { activeTenantId, activeTenant } = useTenant();

  const { data: report, isLoading } = useQuery<ReadinessReport>({
    queryKey: ["readiness", activeTenantId],
    queryFn: () =>
      api.get<ReadinessReport>(`/api/readiness?tenantId=${activeTenantId}`),
    enabled: !!activeTenantId,
  });

  return (
    <div>
      <p className="mb-4 text-sm text-slate-500">
        Whether PatchPilot is wired up to operate against this tenant —
        consent, licensing, write posture, and GDAP. Remediation stays
        disabled until a tenant is ready and write actions are opted in.
      </p>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard
          label="Read access"
          value={report?.ready ? "Ready" : "Not ready"}
          hint={activeTenant?.displayName ?? "—"}
          tone={report?.ready ? "good" : "critical"}
        />
        <KpiCard
          label="Remediation"
          value={report?.canRemediate ? "Enabled" : "Disabled"}
          hint={
            report?.canRemediate
              ? "Write actions opted in"
              : "Read-only or not ready"
          }
          tone={report?.canRemediate ? "good" : "warn"}
        />
        <KpiCard
          label="Licensed channels"
          value={report?.enabledChannels.length ?? 0}
          hint="Remediation channels available"
        />
      </div>

      <div className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Checks</h2>
        <Card className="p-0">
          {isLoading ? (
            <div className="p-5 text-sm text-slate-500">Loading…</div>
          ) : !report ? (
            <div className="p-5 text-sm text-slate-500">
              Select a tenant to assess readiness.
            </div>
          ) : (
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
          )}
        </Card>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">
          Enabled channels
        </h2>
        <Card>
          {report && report.enabledChannels.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {report.enabledChannels.map((ch) => (
                <span
                  key={ch}
                  className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600"
                >
                  {ch}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              No remediation channels licensed for this tenant — read-only only.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
