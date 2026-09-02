import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../../components/ui";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { ReadinessPanel } from "./ReadinessPanel";
import { PreflightPanel } from "./PreflightPanel";

type Tab = "connections" | "readiness" | "preflight";

const TABS: { id: Tab; label: string }[] = [
  { id: "connections", label: "Connections" },
  { id: "readiness", label: "Readiness" },
  { id: "preflight", label: "Pre-flight" },
];

export function SetupHealth() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const tab: Tab = TABS.some((t) => t.id === requested)
    ? (requested as Tab)
    : "connections";

  return (
    <div>
      <PageHeader
        title="Setup Health"
        subtitle="Is PatchPilot wired up to operate — at the MSP level, for this tenant, and for one specific remediation."
      />

      <div className="mb-6 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSearchParams({ tab: t.id }, { replace: true })}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "connections" && <ConnectionsPanel />}
      {tab === "readiness" && <ReadinessPanel />}
      {tab === "preflight" && <PreflightPanel />}
    </div>
  );
}
