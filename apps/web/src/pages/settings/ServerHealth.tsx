import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../../components/ui";
import { ResourcesPanel } from "./ResourcesPanel";
import { ServicesPanel } from "./ServicesPanel";
import { WorkersPanel } from "./WorkersPanel";
import { SchedulersPanel } from "./SchedulersPanel";

type Tab = "resources" | "services" | "workers" | "schedulers";

const TABS: { id: Tab; label: string }[] = [
  { id: "resources", label: "Resources" },
  { id: "services", label: "Services" },
  { id: "workers", label: "Workers" },
  { id: "schedulers", label: "Schedulers" },
];

/**
 * Settings > Server Health — operational visibility into PatchPilot's own
 * production infrastructure (host resources, DB/Redis, queues/workers,
 * recurring schedules), plus confirmed restart actions for the api and
 * worker processes. Tab-bar shell modeled on SetupHealth.tsx.
 *
 * Phase 1 only (see the Server Health plan): everything here is read via
 * mechanisms that already exist, and the only mutations are self/cross-process
 * restarts. Restarting individual infra containers or the whole compose stack
 * needs the `updater` sidecar's Docker socket access and is a deliberate
 * Phase 2 fast-follow, not built here.
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
      {tab === "services" && <ServicesPanel />}
      {tab === "workers" && <WorkersPanel />}
      {tab === "schedulers" && <SchedulersPanel />}
    </div>
  );
}
