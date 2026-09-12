import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../../components/ui";
import { ResourcesPanel } from "./ResourcesPanel";
import { ServicesPanel } from "./ServicesPanel";
import { WorkersPanel } from "./WorkersPanel";
import { SchedulersPanel } from "./SchedulersPanel";
import { ContainersPanel } from "./ContainersPanel";

type Tab = "resources" | "workers" | "containers";

const TABS: { id: Tab; label: string }[] = [
  { id: "resources", label: "Resources" },
  { id: "workers", label: "Workers & Schedulers" },
  { id: "containers", label: "Services & Containers" },
];

/**
 * Settings > Server Health — operational visibility into PatchPilot's own
 * production infrastructure (host resources, DB/Redis, queues/workers,
 * recurring schedules), plus confirmed restart actions for the api/worker
 * processes (Phase 1), individual infra containers, and the whole compose
 * stack (Phase 2). Tab-bar shell modeled on SetupHealth.tsx.
 */
export function ServerHealth() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const tab: Tab = TABS.some((t) => t.id === requested) ? (requested as Tab) : "resources";

  return (
    <div>
      <PageHeader
        title="Server Health"
        subtitle="Live resource usage, service/queue/scheduler status, and confirmed restart actions for this PatchPilot instance."
      />

      <div className="mb-6 flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSearchParams({ tab: t.id }, { replace: true })}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border-slate-900 text-slate-900 dark:text-slate-100"
                : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "resources" && <ResourcesPanel />}
      {tab === "workers" && (
        <div className="space-y-8">
          <WorkersPanel />
          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              Schedules
            </h3>
            <SchedulersPanel />
          </div>
        </div>
      )}
      {tab === "containers" && (
        <div className="space-y-8">
          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              Services
            </h3>
            <ServicesPanel />
          </div>
          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              Containers
            </h3>
            <ContainersPanel />
          </div>
        </div>
      )}
    </div>
  );
}
