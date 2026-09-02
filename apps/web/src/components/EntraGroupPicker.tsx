import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type EntraGroupResult } from "../lib/api";

/** A resolved Entra group locked in as an assignment target. */
export interface EntraGroupPick {
  id: string;
  displayName: string;
}

/**
 * Searchable Entra security-group picker — mirrors MicrosoftStorePicker.tsx's
 * locked-pick-summary-card + live-search shape, backed by GET
 * /api/groups/search (live Graph `$filter=startswith(displayName,...)`,
 * security-enabled/non-mail groups only — the same set Intune itself accepts
 * as an assignment target). Replaces the old free-text "Exact Entra group
 * display name" input everywhere a Win32/Store app, Feature Update campaign
 * or Expedited Quality Update campaign needs to target a group.
 */
export function EntraGroupPicker({
  tenantId,
  value,
  onChange,
  disabled,
  placeholder = "Search Entra groups…",
}: {
  tenantId: string | null;
  value: EntraGroupPick | null;
  onChange: (pick: EntraGroupPick | null) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const {
    data: results = [],
    isLoading: searching,
    isError,
    error,
  } = useQuery<EntraGroupResult[]>({
    queryKey: ["entra-group-search", tenantId, debounced],
    queryFn: () =>
      api
        .get<{ groups: EntraGroupResult[] }>(
          `/api/groups/search?tenantId=${encodeURIComponent(tenantId!)}&q=${encodeURIComponent(debounced)}`,
        )
        .then((res) => res.groups),
    enabled: !value && !!tenantId && debounced.length >= 2,
  });

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
      {value ? (
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 truncate text-xs font-medium text-slate-800">
            {value.displayName}
          </div>
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={disabled}
            className="shrink-0 text-[11px] font-medium text-slate-500 hover:text-slate-800 disabled:opacity-50"
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
            placeholder={tenantId ? placeholder : "Select a tenant first"}
            disabled={disabled || !tenantId}
            className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none disabled:opacity-50"
          />
          {searching ? (
            <div className="mt-1.5 text-[11px] text-slate-400">Searching…</div>
          ) : isError ? (
            <div className="mt-1.5 text-[11px] text-rose-600">
              {error instanceof Error ? error.message : "Group search failed."}
            </div>
          ) : results.length > 0 ? (
            <ul className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-slate-200 bg-white">
              {results.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => onChange({ id: g.id, displayName: g.displayName })}
                    className="block w-full truncate border-b border-slate-100 px-2.5 py-1.5 text-left text-xs font-medium text-slate-800 last:border-0 hover:bg-slate-50"
                  >
                    {g.displayName}
                  </button>
                </li>
              ))}
            </ul>
          ) : debounced.length >= 2 ? (
            <div className="mt-1.5 text-[11px] text-slate-400">
              No group matches "{debounced}".
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
