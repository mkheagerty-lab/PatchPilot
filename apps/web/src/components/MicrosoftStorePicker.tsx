import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type StoreAppResult } from "../lib/api";

/** A resolved Store search result locked in as this run's package. */
export interface StoreAppPick {
  packageId: string;
  name: string;
  publisher: string;
}

/**
 * The Microsoft Store catalog search sub-UI for Catalog = "Microsoft Store app
 * (new)" — mirrors WingetPicker/ChocolateyPicker's locked-pick-summary-card +
 * live-search shape (RunNowModal.tsx), but self-contained: unlike those two,
 * there's no CVE-stored auto-match to lock in on open (manifestSearch is a
 * live external lookup, not a mirrored catalog table), so the debounce +
 * useQuery live entirely in this component instead of the parent.
 */
export function MicrosoftStorePicker({
  pick,
  setPick,
  query,
  setQuery,
}: {
  pick: StoreAppPick | null;
  setPick: (p: StoreAppPick | null) => void;
  query: string;
  setQuery: (q: string) => void;
}) {
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data: results = [], isLoading: searching } = useQuery<StoreAppResult[]>({
    queryKey: ["store-app-search", debounced],
    queryFn: () =>
      api.get<StoreAppResult[]>(
        `/api/store-apps/search?q=${encodeURIComponent(debounced)}&limit=8`,
      ),
    enabled: !pick && debounced.length >= 2,
  });

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
      {pick ? (
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-slate-800">
              {pick.packageId}
            </div>
            <div className="truncate text-[11px] text-slate-500">
              {pick.name}
              {pick.publisher ? ` · ${pick.publisher}` : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setPick(null)}
            className="shrink-0 text-[11px] font-medium text-slate-500 hover:text-slate-800"
          >
            Clear
          </button>
        </div>
      ) : (
        <>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the Microsoft Store…"
            className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
          />
          {searching ? (
            <div className="mt-1.5 text-[11px] text-slate-400">
              Searching…
            </div>
          ) : results.length > 0 ? (
            <ul className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-slate-200 bg-white">
              {results.map((p) => (
                <li key={p.packageIdentifier}>
                  <button
                    type="button"
                    onClick={() =>
                      setPick({
                        packageId: p.packageIdentifier,
                        name: p.name,
                        publisher: p.publisher,
                      })
                    }
                    className="flex w-full items-center justify-between gap-2 border-b border-slate-100 px-2.5 py-1.5 text-left last:border-0 hover:bg-slate-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-slate-800">
                        {p.packageIdentifier}
                      </span>
                      <span className="block truncate text-[11px] text-slate-500">
                        {p.name}
                        {p.publisher ? ` · ${p.publisher}` : ""}
                      </span>
                    </span>
                    {p.version && (
                      <span className="shrink-0 text-[10px] text-slate-400">
                        v{p.version}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : debounced.length >= 2 ? (
            <div className="mt-1.5 text-[11px] text-slate-400">
              No Microsoft Store match for "{debounced}".
            </div>
          ) : null}
          <p className="mt-1.5 text-[11px] leading-tight text-slate-500">
            Live Microsoft Store lookup — no auto-match. Search by app name
            (e.g. "Mozilla Firefox").
          </p>
        </>
      )}
    </div>
  );
}
