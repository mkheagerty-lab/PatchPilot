import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCan } from "../../lib/auth";
import { aiApi, type SummarizePage } from "../../lib/ai";
import { ApiError } from "../../lib/api";

interface SummarizeButtonProps {
  page: SummarizePage;
  /** null = all reachable tenants. */
  tenantId: string | null;
  windowDays?: number;
  /** Vulnerabilities/Devices have no all-tenants aggregate to summarize —
   * same reason get_tenant_posture_summary (the chat tool) requires one. When
   * true and tenantId is null, the button is disabled rather than hidden, so
   * switching tenants is the obvious next step rather than the feature
   * silently disappearing. */
  requiresTenant?: boolean;
}

/**
 * Gated by `useCan("ai:use")` and the same `AI_FEATURES_ENABLED` status query
 * ChatWidget uses (cached under the same query key, so mounting this on a
 * page alongside the widget costs no extra request). Renders nothing for a
 * reader role or when the operator hasn't turned AI features on — the
 * summarize button must disappear exactly where the chat widget does.
 */
export function SummarizeButton({ page, tenantId, windowDays, requiresTenant }: SummarizeButtonProps) {
  const canUseAi = useCan("ai:use");
  const status = useQuery({
    queryKey: ["ai", "status"],
    queryFn: aiApi.status,
    staleTime: 60_000,
    enabled: canUseAi,
  });

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!canUseAi || !status.data?.enabled) return null;

  const blocked = Boolean(requiresTenant && !tenantId);

  async function handleClick() {
    if (blocked) return;
    setOpen(true);
    if (loading) return;
    setLoading(true);
    setError(null);
    setSummary(null);
    try {
      const result = await aiApi.summarize({ page, tenantId, windowDays });
      setSummary(result.summary);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't generate a summary.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative print:hidden">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={blocked}
        title={blocked ? "Select a single tenant to summarize this page." : "AI summary of this page"}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <SparkleIcon />
        Summarize
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-2 w-96 rounded-lg border border-slate-200 bg-white p-4 shadow-xl">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">AI Summary</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-slate-400 transition-colors hover:text-slate-700"
                aria-label="Close"
              >
                <CloseIcon />
              </button>
            </div>
            {loading && <p className="text-sm text-slate-400">Thinking…</p>}
            {error && <p className="text-sm text-rose-600">{error}</p>}
            {summary && (
              <>
                <p className="whitespace-pre-wrap text-sm text-slate-700">{summary}</p>
                <p className="mt-3 border-t border-slate-100 pt-2 text-[11px] text-slate-400">
                  AI-generated — verify against the data on this page.
                </p>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
      <path d="M9.25 2.75a.75.75 0 0 1 1.45-.27l.9 2.44a3.5 3.5 0 0 0 2.13 2.13l2.44.9a.75.75 0 0 1 0 1.4l-2.44.9a3.5 3.5 0 0 0-2.13 2.13l-.9 2.44a.75.75 0 0 1-1.4 0l-.9-2.44a3.5 3.5 0 0 0-2.13-2.13l-2.44-.9a.75.75 0 0 1 0-1.4l2.44-.9a3.5 3.5 0 0 0 2.13-2.13l.85-2.17Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
      <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
    </svg>
  );
}
