import { useQuery } from "@tanstack/react-query";
import { api, type ServerHealthSchedulers } from "../../lib/api";
import { Card } from "../../components/ui";

const POLL_INTERVAL_MS = 15_000;

function StatusPill({ stuck }: { stuck: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        stuck
          ? "bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400"
          : "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
      }`}
    >
      {stuck ? "Stuck" : "Healthy"}
    </span>
  );
}

function formatNextFire(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/**
 * Settings > Server Health > Schedulers — every enabled recurring schedule's
 * BullMQ scheduler state, joined against `schedules` by id for a friendly
 * name. "Stuck" uses the exact same MISSED_FIRE_GRACE_MS definition
 * apps/worker/src/scheduler.ts's own reconciler uses, so this tab never
 * disagrees with what the worker itself would do about a lost fire.
 */
export function SchedulersPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["server-health", "schedulers"],
    queryFn: () => api.get<ServerHealthSchedulers>("/api/server-health/schedulers"),
    refetchInterval: POLL_INTERVAL_MS,
  });

  if (isLoading && !data) {
    return (
      <Card>
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <p className="text-sm text-rose-600 dark:text-rose-400">Could not load scheduler status.</p>
      </Card>
    );
  }

  return (
    <div>
      {data.demoMode && (
        <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Demo mode: no real BullMQ connection is dialled — no schedulers to show.
        </div>
      )}

      <Card className="p-0">
        {data.schedulers.length === 0 ? (
          <div className="p-5 text-sm text-slate-500 dark:text-slate-400">
            No enabled recurring schedules.
          </div>
        ) : (
          <ul>
            {data.schedulers.map((s) => (
              <li
                key={s.scheduleId}
                className="flex items-start justify-between gap-4 border-b border-slate-100 dark:border-slate-800 px-5 py-4 last:border-0"
              >
                <div>
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{s.name}</div>
                  <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {s.cron ?? "—"} {s.timezone ? `(${s.timezone})` : ""} · next fire{" "}
                    {formatNextFire(s.nextFireAt)}
                  </div>
                </div>
                <StatusPill stuck={s.stuck} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
