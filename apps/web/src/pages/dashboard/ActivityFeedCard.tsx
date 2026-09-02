import { isSystemActor, systemActorLabel, type AuditOutcome } from "@patchpilot/shared";
import { Link, useNavigate } from "react-router-dom";
import type { AuditRecord } from "../../lib/api";
import { Card } from "../../components/ui";
import { relativeTime } from "./TenantHealthStrip";
import { toAudit, toAuditResource } from "./links";

const OUTCOME_DOT: Record<AuditOutcome, string> = {
  success: "bg-emerald-500",
  failure: "bg-rose-500",
  partial: "bg-amber-500",
  skipped: "bg-slate-400",
};

function actorLabel(record: AuditRecord): string {
  return isSystemActor(record.actorType) ? systemActorLabel(record.actorType) : record.engineer;
}

export function ActivityFeedCard({
  activity,
  isLoading,
}: {
  activity: AuditRecord[];
  isLoading: boolean;
}) {
  const nav = useNavigate();
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Recent activity</h2>
        <Link
          to={toAudit()}
          className="text-xs font-medium text-slate-500 transition-colors hover:text-slate-800"
        >
          View all →
        </Link>
      </div>
      <Card className="p-0">
        {isLoading ? (
          <div className="p-5 text-sm text-slate-500">Loading…</div>
        ) : activity.length === 0 ? (
          <div className="p-5 text-sm text-slate-500">No recent activity.</div>
        ) : (
          <ul>
            {activity.map((record) => {
              const href = record.resourceId ? toAuditResource(record.resourceId) : toAudit();
              return (
              <li
                key={record.id}
                tabIndex={0}
                role="button"
                onClick={() => nav(href)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") nav(href);
                }}
                className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-5 py-3 text-sm outline-none last:border-0 hover:bg-slate-50 focus-visible:bg-slate-50"
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    record.outcome ? OUTCOME_DOT[record.outcome] : "bg-slate-300"
                  }`}
                />
                <span className="w-32 shrink-0 truncate font-medium text-slate-700">
                  {actorLabel(record)}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-600">
                  {record.summary ?? record.resourceLabel ?? record.action ?? record.endpoint}
                </span>
                <span className="shrink-0 text-xs text-slate-400">{relativeTime(record.at)}</span>
              </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}
