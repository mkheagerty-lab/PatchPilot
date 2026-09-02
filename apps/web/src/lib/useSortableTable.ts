import { useEffect, useMemo, useState } from "react";
import type { SortDir } from "../components/cve";

/**
 * Generalizes the search/sort/select-all state ScriptCatalog.tsx hand-rolls
 * (search useState, filtered/sorted useMemo, selection useState pruned via
 * useEffect, toggleSelectAll/toggleSelect, onSort with per-column default
 * direction). Pulled out because the Windows Updates hub needs the identical
 * bundle of behavior across four tables that otherwise share nothing (cell
 * rendering, columns, and mutations all stay page-specific). CSV export and
 * delete mutations are NOT part of this hook — they need page-specific
 * columns/copy and shouldn't live behind a generic interface.
 */

export interface UseSortableTableOptions<T, K extends string> {
  rows: readonly T[];
  id: (row: T) => string;
  /** Substring match against this row; empty/whitespace search returns every row. */
  searchText: (row: T) => string;
  sortValue: (row: T, key: K) => string | number;
  defaultSortKey: K;
  /** Per-column default direction on first click (e.g. dates default desc, names default asc). */
  defaultDir: Record<K, SortDir>;
  /** Tiebreaker when two rows compare equal on the active sort key; defaults to searchText. */
  tiebreak?: (row: T) => string;
}

export interface UseSortableTableResult<T, K extends string> {
  search: string;
  setSearch: (value: string) => void;
  sortKey: K;
  sortDir: SortDir;
  onSort: (key: K) => void;
  selected: ReadonlySet<string>;
  setSelected: (next: ReadonlySet<string>) => void;
  toggleSelect: (id: string) => void;
  toggleSelectAll: () => void;
  clearSelection: () => void;
  filtered: T[];
  sorted: T[];
  selectedRows: T[];
  allVisibleSelected: boolean;
}

export function useSortableTable<T, K extends string>({
  rows,
  id,
  searchText,
  sortValue,
  defaultSortKey,
  defaultDir,
  tiebreak,
}: UseSortableTableOptions<T, K>): UseSortableTableResult<T, K> {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<K>(defaultSortKey);
  const [sortDir, setSortDir] = useState<SortDir>(defaultDir[defaultSortKey]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [...rows];
    return rows.filter((row) => searchText(row).toLowerCase().includes(q));
  }, [rows, search, searchText]);

  const sorted = useMemo(() => {
    const tie = tiebreak ?? searchText;
    const result = [...filtered];
    result.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av !== bv) {
        const cmp =
          typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      }
      return tie(a).localeCompare(tie(b));
    });
    return result;
  }, [filtered, sortKey, sortDir, sortValue, tiebreak, searchText]);

  // Selection is scoped to ids that still exist so a completed mutation,
  // tenant switch, or refetch can't leave phantom rows "selected".
  useEffect(() => {
    const ids = new Set(rows.map(id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((rowId) => ids.has(rowId)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows, id]);

  const selectedRows = useMemo(() => rows.filter((row) => selected.has(id(row))), [rows, selected, id]);
  const allVisibleSelected = sorted.length > 0 && sorted.every((row) => selected.has(id(row)));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const row of sorted) {
        const rowId = id(row);
        if (allVisibleSelected) next.delete(rowId);
        else next.add(rowId);
      }
      return next;
    });
  }

  function toggleSelect(rowId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  function onSort(key: K) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(defaultDir[key]);
    }
  }

  function clearSelection() {
    setSelected(new Set());
  }

  return {
    search,
    setSearch,
    sortKey,
    sortDir,
    onSort,
    selected,
    setSelected,
    toggleSelect,
    toggleSelectAll,
    clearSelection,
    filtered,
    sorted,
    selectedRows,
    allVisibleSelected,
  };
}
