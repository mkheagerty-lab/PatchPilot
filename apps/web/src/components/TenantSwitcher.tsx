import { useEffect, useMemo, useRef, useState } from "react";
import { useTenant, ALL_TENANTS } from "../lib/tenant";

export function TenantSwitcher() {
  const { reachableTenants, activeTenantId, setActiveTenantId, isAllTenants, isLoading } =
    useTenant();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const active = reachableTenants.find((t) => t.tenantId === activeTenantId) ?? null;

  // "All Tenants" matches an empty query or a search containing "all".
  const allMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === "" || "all tenants".includes(q);
  }, [query]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return reachableTenants;
    return reachableTenants.filter(
      (t) =>
        t.displayName.toLowerCase().includes(q) ||
        t.tenantId.toLowerCase().includes(q),
    );
  }, [reachableTenants, query]);

  // Close on outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  if (isLoading) {
    return <div className="text-sm text-slate-400">Loading tenants…</div>;
  }

  function choose(tenantId: string) {
    setActiveTenantId(tenantId);
    setOpen(false);
    setQuery("");
  }

  const triggerLabel = isAllTenants
    ? "All Tenants"
    : active
      ? active.displayName
      : "Select tenant";

  return (
    <div ref={rootRef} className="relative flex min-w-0 items-center gap-2 text-sm">
      <span className="hidden text-slate-500 sm:inline dark:text-slate-400">Tenant</span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-[8rem] items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 sm:min-w-[12rem] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
      >
        <span className="truncate">
          {triggerLabel}
          {!isAllTenants && active?.readOnly ? (
            <span className="text-slate-400 dark:text-slate-500"> (read-only)</span>
          ) : null}
        </span>
        <span aria-hidden className="text-xs text-slate-400 dark:text-slate-500">
          ▾
        </span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-72 rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <div className="p-2">
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tenants…"
              className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:placeholder:text-slate-500"
            />
          </div>
          <ul className="max-h-64 overflow-auto pb-1">
            {allMatches && (
              <li>
                <button
                  type="button"
                  onClick={() => choose(ALL_TENANTS)}
                  className={`flex w-full flex-col items-start border-b border-slate-100 px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800 ${
                    isAllTenants ? "bg-indigo-50 dark:bg-indigo-500/10" : ""
                  }`}
                >
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-200">All Tenants</span>
                  <span className="text-[11px] text-slate-400 dark:text-slate-500">
                    Aggregate across every reachable tenant
                  </span>
                </button>
              </li>
            )}
            {matches.length === 0 && !allMatches ? (
              <li className="px-3 py-2 text-sm text-slate-400 dark:text-slate-500">No matches.</li>
            ) : matches.length === 0 ? (
              <li className="px-3 py-2 text-sm text-slate-400 dark:text-slate-500">
                No reachable tenants yet.
              </li>
            ) : (
              matches.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => choose(t.tenantId)}
                    className={`flex w-full flex-col items-start px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800 ${
                      !isAllTenants && t.tenantId === activeTenantId ? "bg-indigo-50 dark:bg-indigo-500/10" : ""
                    }`}
                  >
                    <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                      {t.displayName}
                      {t.readOnly ? (
                        <span className="font-normal text-slate-400 dark:text-slate-500">
                          {" "}
                          (read-only)
                        </span>
                      ) : null}
                    </span>
                    <span className="font-mono text-[11px] text-slate-400 dark:text-slate-500">
                      {t.tenantId}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
