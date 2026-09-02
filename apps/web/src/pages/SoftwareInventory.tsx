import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { csvRow, detectMicrosoftStoreInstall } from "@patchpilot/shared";
import {
  api,
  type AltSource,
  type Device,
  type SoftwareInventoryDevice,
  type SoftwareInventoryDevicesResult,
  type SoftwareInventoryRow,
} from "../lib/api";
import { useTenant } from "../lib/tenant";
import {
  Card,
  DetailRow,
  MsStoreChip,
  PageHeader,
  Placeholder,
  ScopeChip,
  SlideOver,
} from "../components/ui";
import { RunNowModal } from "../components/RunNowModal";
import { DetectionEvidence, SortIcon, type SortDir } from "../components/cve";
import { downloadCsv } from "../lib/csv";

// Sortable inventory-table column keys + direction.
type SortKey =
  | "name"
  | "vendor"
  | "context"
  | "installed"
  | "exposed"
  | "weaknesses"
  | "version";

// Names/vendor/context/version read best A→Z; the count columns read best
// highest-first — mirrors the Vulnerabilities table's per-column defaults.
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  vendor: "asc",
  context: "asc",
  installed: "desc",
  exposed: "desc",
  weaknesses: "desc",
  version: "asc",
};

function sortValue(row: SoftwareInventoryRow, key: SortKey): string | number {
  switch (key) {
    case "name":
      return row.name.toLowerCase();
    case "vendor":
      return (row.vendor ?? "").toLowerCase();
    case "context":
      return row.context ?? "";
    case "installed":
      return row.installedMachinesCount;
    case "exposed":
      return row.exposedMachinesCount;
    case "weaknesses":
      return row.weaknessCount;
    case "version":
      return (row.matchedLatestVersion ?? "").toLowerCase();
  }
}

/** A clickable inventory-table column header that sorts by `sortKey`. */
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

/**
 * Defender's full per-tenant software inventory (Phase 5, Ask 3) — every
 * installed title Defender reports, not just software with an open CVE
 * finding. Unlike Devices/Vulnerabilities, /api/software-inventory has no
 * "all tenants" aggregate, so this page requires a specific tenant.
 */

const CONTEXT_LABELS: Record<string, string> = {
  machine: "SYSTEM",
  user: "User",
  mixed: "Mixed",
  unknown: "Unknown scope",
};

function ContextTag({ context }: { context: string | null }) {
  const label = context ? (CONTEXT_LABELS[context] ?? context) : "Unknown scope";
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
      {label}
    </span>
  );
}

export function SoftwareInventory() {
  const { activeTenantId, activeTenant, isAllTenants } = useTenant();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<SoftwareInventoryRow | null>(null);
  const [fixTarget, setFixTarget] = useState<SoftwareInventoryDevice | null>(null);
  const [fixAllOpen, setFixAllOpen] = useState(false);
  // "Fix all" launched directly from a table row, independent of the
  // drill-down SlideOver's own Fix All button.
  const [rowFixAllTarget, setRowFixAllTarget] = useState<SoftwareInventoryRow | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // Which device row (by defenderMachineId) has its "how it was detected"
  // evidence expanded in the device drill-down SlideOver below.
  const [expandedDevice, setExpandedDevice] = useState<string | null>(null);
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  };

  const { data: inventory = [], isLoading } = useQuery({
    queryKey: ["software-inventory", activeTenantId],
    queryFn: () =>
      api
        .get<{ softwareInventory: SoftwareInventoryRow[] }>(
          `/api/software-inventory?tenantId=${activeTenantId}`,
        )
        .then((r) => r.softwareInventory),
    enabled: !!activeTenantId && !isAllTenants,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return inventory;
    return inventory.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.vendor ?? "").toLowerCase().includes(q),
    );
  }, [inventory, search]);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      let cmp: number;
      if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      if (cmp === 0) cmp = a.name.localeCompare(b.name);
      return cmp * dir;
    });
  }, [filtered, sortKey, sortDir]);

  const { data: devicesResult, isLoading: devicesLoading } = useQuery({
    queryKey: ["software-inventory-devices", activeTenantId, selected?.softwareId],
    queryFn: () =>
      api.get<SoftwareInventoryDevicesResult>(
        `/api/software-inventory/${selected!.softwareId}/devices?tenantId=${activeTenantId}`,
      ),
    enabled: !!activeTenantId && !!selected,
  });

  // RunNowModal's `lockedDevice` needs a full Device row (managedDeviceId,
  // os, etc.) — SoftwareInventoryDevice only carries the subset the drill-down
  // table needs, so resolve the rest from the tenant's device list once Fix
  // Now is actually opened.
  const { data: tenantDevices = [] } = useQuery<Device[]>({
    queryKey: ["devices", activeTenantId],
    queryFn: () => api.get<Device[]>(`/api/devices?tenantId=${activeTenantId}`),
    enabled: !!activeTenantId && !!fixTarget,
  });
  const lockedDevice = fixTarget
    ? (tenantDevices.find((d) => d.id === fixTarget.deviceId) ?? null)
    : null;
  // Winget couldn't match this device's install — surface the live-resolved
  // Chocolatey match (if any) as the pre-filled alternate source, same as the
  // Vulnerabilities page does for a not-supported app.
  const fixAltSources: AltSource[] =
    fixTarget && !fixTarget.wingetPackageId && fixTarget.chocolateyPackageId
      ? [{ source: "chocolatey", packageId: fixTarget.chocolateyPackageId, name: selected?.name ?? "" }]
      : [];

  function exportCsv() {
    const csv =
      csvRow([
        "software",
        "vendor",
        "context",
        "installed_on",
        "exposed",
        "weaknesses",
        "latest_version",
        "public_exploit",
      ]) +
      sorted
        .map((s) =>
          csvRow([
            s.name,
            s.vendor ?? "",
            s.context ?? "",
            s.installedMachinesCount,
            s.exposedMachinesCount,
            s.weaknessCount,
            s.matchedLatestVersion ?? "",
            s.publicExploit,
          ]),
        )
        .join("");
    downloadCsv("software-inventory.csv", csv);
  }

  return (
    <div>
      <PageHeader
        title="Inventories"
        subtitle="Every title Defender reports installed across this tenant's devices"
        actions={
          !isAllTenants && (
            <button
              type="button"
              onClick={exportCsv}
              disabled={sorted.length === 0}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              Export CSV
            </button>
          )
        }
      />

      {isAllTenants ? (
        <Placeholder note="Select a tenant to view its software inventory." />
      ) : (
        <>
          <Card className="mb-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-[220px] flex-1">
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                >
                  <path
                    fillRule="evenodd"
                    d="M9 3.5a5.5 5.5 0 1 0 3.39 9.83l3.14 3.14a.75.75 0 1 0 1.06-1.06l-3.14-3.14A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"
                    clipRule="evenodd"
                  />
                </svg>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search software, vendor…"
                  className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
                />
              </div>
              <span className="text-xs text-slate-500">
                {filtered.length} {filtered.length === 1 ? "title" : "titles"}
                {filtered.length !== inventory.length && ` of ${inventory.length}`}
              </span>
            </div>
          </Card>

          <Card className="p-0">
            {isLoading ? (
              <div className="p-5 text-sm text-slate-500">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="p-5 text-sm text-slate-500">
                {inventory.length === 0
                  ? "No software inventory reported for this tenant yet."
                  : "No software matches your search."}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <SortableTh label="Software" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                    <SortableTh label="Vendor" sortKey="vendor" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                    <SortableTh label="Context" sortKey="context" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                    <SortableTh label="Installed on" sortKey="installed" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                    <SortableTh label="Exposed" sortKey="exposed" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                    <SortableTh label="Weaknesses" sortKey="weaknesses" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                    <SortableTh label="Latest version" sortKey="version" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
                    <th className="px-4 py-2.5 font-medium uppercase tracking-wide">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((s) => {
                    return (
                      <tr
                        key={s.id}
                        onClick={() => setSelected(s)}
                        className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                      >
                        <td className="px-4 py-2.5 font-medium text-slate-800">
                          {s.name}
                          {s.publicExploit && (
                            <span className="ml-2 inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-700">
                              Public exploit
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-slate-500">{s.vendor ?? "—"}</td>
                        <td className="px-4 py-2.5">
                          <ContextTag context={s.context} />
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{s.installedMachinesCount}</td>
                        <td className="px-4 py-2.5 text-slate-600">{s.exposedMachinesCount}</td>
                        <td className="px-4 py-2.5 text-slate-600">{s.weaknessCount}</td>
                        <td className="px-4 py-2.5 text-slate-600">{s.matchedLatestVersion ?? "—"}</td>
                        <td className="px-4 py-2.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRowFixAllTarget(s);
                            }}
                            className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                          >
                            Fix Now
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      <SlideOver
        open={!!selected}
        onClose={() => {
          setSelected(null);
          setExpandedDevice(null);
        }}
        title={selected?.name ?? ""}
        subtitle={selected?.vendor ?? undefined}
      >
        {devicesLoading ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : !devicesResult || devicesResult.devices.length === 0 ? (
          <div className="text-sm text-slate-500">No devices reported for this software.</div>
        ) : (
          <>
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={() => setFixAllOpen(true)}
                disabled={!devicesResult.devices.some((d) => d.deviceId && !d.upToDate)}
                title={
                  devicesResult.devices.some((d) => d.deviceId && !d.upToDate)
                    ? undefined
                    : devicesResult.devices.some((d) => d.deviceId)
                      ? "All devices are already up to date."
                      : "No devices are enrolled for remediation."
                }
                className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
              >
                Fix all
              </button>
            </div>
            <ul>
              {devicesResult.devices.map((d) => {
                // Not gated on d.fixable: RunNowModal always has a path (Manual,
                // or a live Microsoft Store search) even with no pre-matched
                // winget/chocolatey entry. Still requires an Intune-enrolled
                // device to dispatch against.
                const hasDevice = !!d.deviceId;
                const canFix = hasDevice && !d.upToDate;
                const hasEvidence = d.diskPaths.length > 0 || d.registryPaths.length > 0;
                const expanded = expandedDevice === d.defenderMachineId;
                return (
                  <li
                    key={d.defenderMachineId}
                    className="border-b border-slate-100 py-3 last:border-0"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-slate-800">{d.hostname}</div>
                        <div className="mt-1 space-y-1">
                          <DetailRow label="Detected version">{d.detectedVersion ?? "—"}</DetailRow>
                          <DetailRow label="Context">
                            <div className="flex items-center gap-1">
                              <ScopeChip scope={d.installScope} />
                              <MsStoreChip
                                isStoreInstall={detectMicrosoftStoreInstall(
                                  d.diskPaths,
                                  d.registryPaths,
                                )}
                              />
                            </div>
                          </DetailRow>
                          <DetailRow label="Latest version">{d.latestVersion ?? "—"}</DetailRow>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setFixTarget(d)}
                        disabled={!canFix}
                        title={
                          !hasDevice
                            ? "Device not enrolled for remediation."
                            : d.upToDate
                              ? "Already up to date."
                              : undefined
                        }
                        className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                      >
                        Fix now
                      </button>
                    </div>
                    {hasEvidence && (
                      <>
                        <button
                          type="button"
                          onClick={() => setExpandedDevice(expanded ? null : d.defenderMachineId)}
                          className="mt-2 text-xs font-medium text-indigo-600 hover:text-indigo-800"
                        >
                          {expanded ? "Hide how it was detected" : "How it was detected"}
                        </button>
                        {expanded && (
                          <div className="mt-2">
                            <DetectionEvidence
                              installedVersions={[]}
                              diskPaths={d.diskPaths}
                              registryPaths={d.registryPaths}
                              showVersion={false}
                            />
                          </div>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </SlideOver>

      {selected && fixTarget && activeTenantId && lockedDevice && (
        <RunNowModal
          open={!!fixTarget}
          onClose={() => setFixTarget(null)}
          vulnId=""
          softwareId={selected.softwareId}
          software={selected.name}
          patchType="app"
          tenantId={activeTenantId}
          tenantReadOnly={activeTenant?.readOnly ?? false}
          altSources={fixAltSources}
          lockedDevice={lockedDevice}
        />
      )}

      {selected && fixAllOpen && activeTenantId && (
        <RunNowModal
          open={fixAllOpen}
          onClose={() => setFixAllOpen(false)}
          vulnId=""
          softwareId={selected.softwareId}
          software={selected.name}
          patchType="app"
          tenantId={activeTenantId}
          tenantReadOnly={activeTenant?.readOnly ?? false}
          altSources={
            selected.matchedPackageSource === "chocolatey" && selected.matchedPackageId
              ? [{ source: "chocolatey", packageId: selected.matchedPackageId, name: selected.name }]
              : []
          }
        />
      )}

      {rowFixAllTarget && activeTenantId && (
        <RunNowModal
          open={!!rowFixAllTarget}
          onClose={() => setRowFixAllTarget(null)}
          vulnId=""
          softwareId={rowFixAllTarget.softwareId}
          software={rowFixAllTarget.name}
          patchType="app"
          tenantId={activeTenantId}
          tenantReadOnly={activeTenant?.readOnly ?? false}
          altSources={
            rowFixAllTarget.matchedPackageSource === "chocolatey" && rowFixAllTarget.matchedPackageId
              ? [
                  {
                    source: "chocolatey",
                    packageId: rowFixAllTarget.matchedPackageId,
                    name: rowFixAllTarget.name,
                  },
                ]
              : []
          }
        />
      )}
    </div>
  );
}
