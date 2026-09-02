import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { csvRow } from "@patchpilot/shared";
import { api, type ScriptCatalogEntry, type ScriptType } from "../lib/api";
import { useCan } from "../lib/auth";
import { useTenant } from "../lib/tenant";
import { Card, PageHeader, Placeholder } from "../components/ui";
import { SortIcon, type SortDir } from "../components/cve";
import {
  EXT_TO_SCRIPT_TYPE,
  SCRIPT_TYPES,
  SCRIPT_TYPE_LABELS,
  scriptTypeExt,
} from "../lib/scripts";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-slate-400 focus:outline-none";

/** Refuse pathologically large files rather than posting megabytes of JSON. */
const MAX_UPLOAD_BYTES = 1_000_000;

function formatDate(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Filename-safe slug for the per-row Download, e.g. "Remove legacy Java" -> "remove-legacy-java". */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "script";
}

/** Triggers a browser download of `text` without a server round-trip. */
function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Name/type/scope/engineer read best A→Z; the upload date reads best
// newest-first — same per-column convention as SoftwareInventory.
type SortKey = "name" | "type" | "scope" | "createdBy" | "createdAt";

const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  type: "asc",
  scope: "asc",
  createdBy: "asc",
  createdAt: "desc",
};

function sortValue(entry: ScriptCatalogEntry, key: SortKey): string | number {
  switch (key) {
    case "name":
      return entry.name.toLowerCase();
    case "type":
      return SCRIPT_TYPE_LABELS[entry.scriptType].toLowerCase();
    case "scope":
      return entry.tenantId ? "this tenant" : "global";
    case "createdBy":
      return entry.createdBy.toLowerCase();
    case "createdAt":
      return new Date(entry.createdAt).getTime();
  }
}

/** A clickable script-table column header that sorts by `sortKey`. */
function SortableTh({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === activeKey;
  return (
    <th className="px-4 py-2.5 font-medium">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
        className="group inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-slate-700"
      >
        {label}
        <SortIcon active={active} dir={dir} />
      </button>
    </th>
  );
}

function TypeBadge({ type }: { type: ScriptType }) {
  return (
    <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
      {SCRIPT_TYPE_LABELS[type]}
    </span>
  );
}

/**
 * Engineer-uploaded scripts for the Remediation Options "Manual -> dispatch"
 * and Catalog = Script flows. Preview quality — dispatch only happens through
 * the Intune (Platform/Remediation Script) Method, which today always reports
 * `notPerformed` in the worker (no deviceHealthScripts provisioning yet).
 *
 * Unlike Catalog.tsx, there's no coverage/sync concept here: these are
 * hand-authored, not mirrored from a package repo, so this is CRUD over a
 * searchable/sortable/exportable table.
 *
 * `scriptType` is organisational only — Intune's deviceHealthScripts accepts
 * PowerShell alone, so cmd/bash scripts can be stored, downloaded and exported
 * but RunNowModal's picker disables them for dispatch.
 */
export function ScriptCatalog() {
  const { activeTenantId, activeTenant, isAllTenants } = useTenant();
  const qc = useQueryClient();
  const canWriteRole = useCan("catalog:write");

  const tenantReadOnly = activeTenant?.readOnly ?? false;
  const canWrite = canWriteRole && !tenantReadOnly;

  const [showArchived, setShowArchived] = useState(false);

  // The archived flag is part of the key: RunNowModal's ScriptPicker shares
  // the "script-catalog" prefix but always wants active-only, so without the
  // discriminator the two would serve each other stale/over-broad lists.
  const { data: scripts = [], isLoading } = useQuery<ScriptCatalogEntry[]>({
    queryKey: ["script-catalog", activeTenantId, showArchived],
    queryFn: () =>
      api.get<ScriptCatalogEntry[]>(
        `/api/script-catalog?tenantId=${encodeURIComponent(activeTenantId ?? "")}&includeArchived=${showArchived}`,
      ),
    enabled: !!activeTenantId && !isAllTenants,
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scriptType, setScriptType] = useState<ScriptType>("powershell");
  const [scriptContent, setScriptContent] = useState("");
  const [global, setGlobal] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<ScriptCatalogEntry[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["script-catalog"] });
  }

  const upload = useMutation<ScriptCatalogEntry, Error>({
    mutationFn: () =>
      api.post<ScriptCatalogEntry>("/api/script-catalog", {
        tenantId: global ? null : activeTenantId,
        name: name.trim(),
        description: description.trim() || undefined,
        scriptType,
        scriptContent,
      }),
    onSuccess: () => {
      setName("");
      setDescription("");
      setScriptType("powershell");
      setScriptContent("");
      setGlobal(false);
      setFileError(null);
      setUploadOpen(false);
      invalidate();
    },
  });

  const remove = useMutation<unknown, Error, string>({
    mutationFn: (id) =>
      api.del(`/api/script-catalog/${id}?tenantId=${encodeURIComponent(activeTenantId ?? "")}`),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(err.message),
  });

  const archive = useMutation<unknown, Error, { id: string; archived: boolean }>({
    mutationFn: ({ id, archived }) =>
      api.patch(`/api/script-catalog/${id}`, { tenantId: activeTenantId, archived }),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(err.message),
  });

  const bulkArchive = useMutation<unknown, Error, { ids: string[]; archived: boolean }>({
    mutationFn: ({ ids, archived }) =>
      api.post("/api/script-catalog/bulk-archive", { tenantId: activeTenantId, ids, archived }),
    onSuccess: () => {
      setActionError(null);
      setSelected(new Set());
      invalidate();
    },
    onError: (err) => setActionError(err.message),
  });

  const bulkDelete = useMutation<unknown, Error, string[]>({
    mutationFn: (ids) =>
      api.post("/api/script-catalog/bulk-delete", { tenantId: activeTenantId, ids }),
    onSuccess: () => {
      setActionError(null);
      setSelected(new Set());
      invalidate();
    },
    onError: (err) => setActionError(err.message),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scripts;
    return scripts.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q) ||
        s.createdBy.toLowerCase().includes(q) ||
        SCRIPT_TYPE_LABELS[s.scriptType].toLowerCase().includes(q),
    );
  }, [scripts, search]);

  const sorted = useMemo(() => {
    const rows = [...filtered];
    rows.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av !== bv) {
        const cmp = typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      }
      return a.name.localeCompare(b.name);
    });
    return rows;
  }, [filtered, sortKey, sortDir]);

  // Selection is scoped to ids that still exist so a completed mutation, tenant
  // switch, or the archived toggle can't leave phantom rows "selected".
  useEffect(() => {
    const ids = new Set(scripts.map((s) => s.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [scripts]);

  const selectedScripts = useMemo(
    () => scripts.filter((s) => selected.has(s.id)),
    [scripts, selected],
  );
  const allSelectedArchived =
    selectedScripts.length > 0 && selectedScripts.every((s) => !!s.archivedAt);
  const allVisibleSelected = sorted.length > 0 && sorted.every((s) => selected.has(s.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of sorted) {
        if (allVisibleSelected) next.delete(s.id);
        else next.add(s.id);
      }
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function onSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset immediately so re-picking the same file fires change again.
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setFileError(`${file.name} is larger than 1 MB — paste the script instead.`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setFileError(`Could not read ${file.name}.`);
    reader.onload = () => {
      setFileError(null);
      setScriptContent(String(reader.result ?? ""));
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const inferred = EXT_TO_SCRIPT_TYPE[ext];
      if (inferred) setScriptType(inferred);
      // Only prefill the name when the engineer hasn't typed one.
      setName((prev) => prev || file.name.replace(/\.[^.]+$/, ""));
    };
    reader.readAsText(file);
  }

  function download(entry: ScriptCatalogEntry) {
    downloadText(
      `${slugify(entry.name)}.${scriptTypeExt(entry.scriptType)}`,
      entry.scriptContent,
      "text/plain;charset=utf-8",
    );
  }

  // Metadata only — the per-row Download covers script bodies, and multi-line
  // script content in a CSV cell makes the file unreadable in Excel. Cells go
  // through csvRow/csvCell, which neutralise Excel formula injection: script
  // names are engineer-supplied and can start with "=".
  function exportCsv() {
    const rows = selected.size > 0 ? sorted.filter((s) => selected.has(s.id)) : sorted;
    const csv =
      csvRow(["name", "description", "type", "scope", "uploaded_by", "uploaded_at", "archived"]) +
      rows
        .map((s) =>
          csvRow([
            s.name,
            s.description ?? "",
            SCRIPT_TYPE_LABELS[s.scriptType],
            s.tenantId ? "This tenant" : "Global",
            s.createdBy,
            s.createdAt,
            s.archivedAt ? "yes" : "no",
          ]),
        )
        .join("");
    downloadText("script-catalog.csv", csv, "text/csv;charset=utf-8");
  }

  const busy =
    remove.isPending || archive.isPending || bulkArchive.isPending || bulkDelete.isPending;
  const canSubmit = !!name.trim() && !!scriptContent.trim() && !upload.isPending && canWrite;
  const activePlaceholder =
    SCRIPT_TYPES.find((t) => t.value === scriptType)?.placeholder ?? "";

  function confirmDelete() {
    if (!pendingDelete) return;
    const ids = pendingDelete.map((s) => s.id);
    if (ids.length === 1) remove.mutate(ids[0]!);
    else bulkDelete.mutate(ids);
    setPendingDelete(null);
  }

  return (
    <div>
      <PageHeader
        title="Script Catalog"
        subtitle="Engineer-uploaded scripts for manual and Intune remediation. Dispatch only runs through the Intune (Platform/Remediation Script) Method — PowerShell only, preview quality, always reports not performed today."
      />

      {isAllTenants ? (
        <Placeholder note="Select a tenant to view its script catalog." />
      ) : (
        <div>
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, description, type, engineer…"
                className="w-72 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
              />
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                  className="rounded border-slate-300"
                />
                Show archived
              </label>
              <button
                type="button"
                onClick={exportCsv}
                disabled={sorted.length === 0}
                className="ml-auto rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
              >
                {selected.size > 0 ? `Export selected (${selected.size})` : "Export CSV"}
              </button>
              {/* Upload is occasional, browsing is constant — so the form is a
                  panel rather than a permanent column, leaving the table the
                  full width its seven columns need. */}
              <button
                type="button"
                onClick={() => setUploadOpen((o) => !o)}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700"
              >
                {uploadOpen ? "Close upload" : "Upload a script"}
              </button>
            </div>

            {selected.size > 0 && (
              <div className="mb-3 flex items-center gap-3 rounded-md border border-slate-300 bg-slate-50 px-4 py-2 text-sm">
                <span className="font-medium text-slate-700">
                  {selected.size} script{selected.size === 1 ? "" : "s"} selected
                </span>
                <button
                  type="button"
                  onClick={() =>
                    bulkArchive.mutate({ ids: [...selected], archived: !allSelectedArchived })
                  }
                  disabled={busy || !canWrite}
                  className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                >
                  {allSelectedArchived ? "Restore selected" : "Archive selected"}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingDelete(selectedScripts)}
                  disabled={busy || !canWrite}
                  className="rounded-md border border-rose-300 px-3 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                >
                  Delete selected
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="text-xs font-medium text-slate-500 hover:text-slate-700"
                >
                  Clear selection
                </button>
              </div>
            )}

            {actionError && (
              <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
                {actionError}
              </div>
            )}

            {uploadOpen && (
              <Card className="mb-4">
                <div className="mb-3 text-sm font-medium text-slate-700">Upload a script</div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600">Name</label>
                      <input
                        className={INPUT_CLASS}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g. Remove legacy Java runtime"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600">
                        Description
                      </label>
                      <input
                        className={INPUT_CLASS}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Optional"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600">
                        Script type
                      </label>
                      <select
                        className={INPUT_CLASS}
                        value={scriptType}
                        onChange={(e) => setScriptType(e.target.value as ScriptType)}
                      >
                        {SCRIPT_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                      {scriptType !== "powershell" && (
                        <div className="mt-1 text-[11px] text-amber-600">
                          Catalog-only — Intune remediation scripts must be PowerShell, so this
                          can't be dispatched from Run Now.
                        </div>
                      )}
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={global}
                        onChange={(e) => setGlobal(e.target.checked)}
                      />
                      Available to all tenants
                    </label>
                  </div>

                  <div className="flex flex-col">
                    <div className="mb-1 flex items-center justify-between">
                      <label className="block text-xs font-medium text-slate-600">
                        Script content
                      </label>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-xs font-medium text-indigo-600 hover:underline"
                      >
                        Upload from file
                      </button>
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".ps1,.psm1,.cmd,.bat,.sh,.txt"
                      onChange={onPickFile}
                      className="hidden"
                    />
                    <textarea
                      className={`${INPUT_CLASS} h-40 font-mono text-xs`}
                      value={scriptContent}
                      onChange={(e) => setScriptContent(e.target.value)}
                      placeholder={activePlaceholder}
                    />
                    {fileError && <div className="mt-1 text-xs text-rose-600">{fileError}</div>}
                    <button
                      onClick={() => upload.mutate()}
                      disabled={!canSubmit}
                      className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
                    >
                      {upload.isPending ? "Uploading…" : "Upload script"}
                    </button>
                    {tenantReadOnly && (
                      <div className="mt-2 text-xs text-slate-500">
                        This tenant is read-only — enable write actions in Settings → Tenants to
                        upload.
                      </div>
                    )}
                    {!canWriteRole && (
                      <div className="mt-2 text-xs text-amber-600">
                        Your role doesn't include catalog write access.
                      </div>
                    )}
                    {upload.isError && (
                      <div className="mt-2 text-xs text-rose-600">{upload.error.message}</div>
                    )}
                  </div>
                </div>
              </Card>
            )}

            <Card className="p-0">
              <div className="border-b border-slate-200 px-4 py-3 text-sm font-medium text-slate-700">
                Uploaded scripts
                {search.trim() && !isLoading && (
                  <span className="ml-2 text-xs font-normal text-slate-400">
                    {filtered.length} of {scripts.length} match
                  </span>
                )}
              </div>
              {isLoading ? (
                <div className="py-6 text-center text-sm text-slate-400">Loading…</div>
              ) : scripts.length === 0 ? (
                <div className="py-6 text-center text-sm text-slate-400">
                  No scripts uploaded yet.
                </div>
              ) : sorted.length === 0 ? (
                <div className="py-6 text-center text-sm text-slate-400">
                  No scripts match "{search.trim()}".
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-2.5 font-medium">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleSelectAll}
                          className="rounded border-slate-300"
                          aria-label="Select all scripts"
                        />
                      </th>
                      <SortableTh
                        label="Name"
                        sortKey="name"
                        activeKey={sortKey}
                        dir={sortDir}
                        onSort={onSort}
                      />
                      <SortableTh
                        label="Type"
                        sortKey="type"
                        activeKey={sortKey}
                        dir={sortDir}
                        onSort={onSort}
                      />
                      <SortableTh
                        label="Scope"
                        sortKey="scope"
                        activeKey={sortKey}
                        dir={sortDir}
                        onSort={onSort}
                      />
                      <SortableTh
                        label="Uploaded by"
                        sortKey="createdBy"
                        activeKey={sortKey}
                        dir={sortDir}
                        onSort={onSort}
                      />
                      <SortableTh
                        label="Uploaded"
                        sortKey="createdAt"
                        activeKey={sortKey}
                        dir={sortDir}
                        onSort={onSort}
                      />
                      <th className="px-4 py-2.5 text-right font-medium uppercase tracking-wide">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((entry) => {
                      const isOpen = expanded === entry.id;
                      const isArchived = !!entry.archivedAt;
                      return (
                        <Fragment key={entry.id}>
                          <tr
                            className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 ${isArchived ? "opacity-60" : ""}`}
                          >
                            <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={selected.has(entry.id)}
                                onChange={() => toggleSelect(entry.id)}
                                className="rounded border-slate-300"
                                aria-label={`Select ${entry.name}`}
                              />
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-slate-800">{entry.name}</span>
                                {isArchived && (
                                  <span className="rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
                                    Archived
                                  </span>
                                )}
                              </div>
                              {entry.description && (
                                <div className="mt-0.5 text-xs text-slate-500">
                                  {entry.description}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <TypeBadge type={entry.scriptType} />
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              {entry.tenantId ? "This tenant" : "Global"}
                            </td>
                            <td className="px-4 py-3 text-slate-600">{entry.createdBy}</td>
                            <td className="px-4 py-3 text-slate-600">
                              {formatDate(entry.createdAt)}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex justify-end gap-3 whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => setExpanded(isOpen ? null : entry.id)}
                                  className="text-xs font-medium text-indigo-600 hover:underline"
                                >
                                  {isOpen ? "Hide" : "View"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => download(entry)}
                                  className="text-xs font-medium text-slate-600 hover:underline"
                                >
                                  Download
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    archive.mutate({ id: entry.id, archived: !isArchived })
                                  }
                                  disabled={busy || !canWrite}
                                  className="text-xs font-medium text-slate-600 hover:underline disabled:opacity-50"
                                >
                                  {isArchived ? "Restore" : "Archive"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setPendingDelete([entry])}
                                  disabled={busy || !canWrite}
                                  className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-50"
                                >
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="border-b border-slate-100 last:border-0">
                              <td colSpan={7} className="px-4 pb-3">
                                <pre className="max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
                                  {entry.scriptContent}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* In-app confirm, not window.confirm — see the rationale in settings/Tenants.tsx. */}
      {pendingDelete && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setPendingDelete(null)}
            aria-hidden
          />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-slate-900">
              {pendingDelete.length === 1
                ? `Delete "${pendingDelete[0]!.name}"?`
                : `Delete ${pendingDelete.length} scripts?`}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              This permanently removes the script content. Archive instead if you only want it out
              of the way. The change is audited.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rose-500"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
