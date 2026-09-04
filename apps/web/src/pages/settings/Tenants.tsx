import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildConsentUrl } from "@patchpilot/shared";
import {
  api,
  ApiError,
  type Tenant,
  type OnboardingReport,
  type SyncTenantsResult,
  type SyncDataResult,
  type EntitlementView,
} from "../../lib/api";
import { useCan } from "../../lib/auth";
import { Card, PageHeader, CopyButton } from "../../components/ui";

// GDAP relationship lifecycle (NOT the same as admin consent). Customer values
// are relabeled to read as a relationship state; the MSP's own tenant is handled
// separately as the home tenant.
const GDAP_META: Record<string, { label: string; style: string }> = {
  consented: { label: "Active", style: "bg-emerald-100 text-emerald-700" },
  pending: { label: "Pending", style: "bg-amber-100 text-amber-700" },
  expired: { label: "Expired", style: "bg-rose-100 text-rose-700" },
};

function gdapMeta(status: string): { label: string; style: string } {
  return GDAP_META[status] ?? { label: status, style: "bg-slate-100 text-slate-600" };
}

// Reachability is the honest "can we actually call Graph" signal, distinct from
// the GDAP relationship status. label + style per value.
const REACH_META: Record<string, { label: string; style: string }> = {
  reachable: { label: "Reachable", style: "bg-emerald-100 text-emerald-700" },
  "consent-needed": { label: "Needs consent", style: "bg-amber-100 text-amber-700" },
  throttled: { label: "Throttled", style: "bg-sky-100 text-sky-700" },
  unreachable: { label: "Unreachable", style: "bg-rose-100 text-rose-700" },
  unknown: { label: "Not probed", style: "bg-slate-100 text-slate-500" },
};

// Resolve to a guaranteed-defined meta — the object-literal fallback keeps this
// total even under noUncheckedIndexedAccess (a bare REACH_META.unknown is `| undefined`).
function reachMeta(reachability: string): { label: string; style: string } {
  return REACH_META[reachability] ?? { label: "Not probed", style: "bg-slate-100 text-slate-500" };
}

// Standard "external link" glyph for the per-row consent action.
function ExternalLinkIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

type SortKey = "name" | "gdap" | "reachability" | "mode" | "licenses" | "lastSynced";
type SortDir = "asc" | "desc";

type ConsentSortKey = "name" | "reachability" | "consent";

// Pre-fills a mailto: draft with the tenant's consent URL — the plain-text
// fallback for MSPs who'd rather forward the link than click "Open" and hand
// off to a customer's Global Administrator directly.
function consentMailto(tenantName: string, consentUrl: string): string {
  const subject = encodeURIComponent(`Action needed: approve PatchPilot access for ${tenantName}`);
  const body = encodeURIComponent(
    `Hi,\n\nPatchPilot needs a Global Administrator to approve read-only access for ${tenantName}. Please open the link below while signed in as a Global Admin and approve the consent prompt:\n\n${consentUrl}\n\nThanks!`,
  );
  return `mailto:?subject=${subject}&body=${body}`;
}

// Per-key comparators. The MSP home tenant has no GDAP relationship, so it sorts
// to the end of the GDAP column ("zzz") rather than masquerading as a value.
function sortValue(t: Tenant, key: SortKey): string {
  switch (key) {
    case "name":
      return t.displayName.toLowerCase();
    case "gdap":
      return t.isMspTenant ? "zzz-home" : gdapMeta(t.consentStatus).label.toLowerCase();
    case "reachability":
      return reachMeta(t.reachability).label.toLowerCase();
    case "mode":
      return t.readOnly ? "read-only" : "write enabled";
    case "licenses":
      return t.licenses.join(", ").toLowerCase();
    case "lastSynced":
      // ISO timestamps sort lexically; never-synced ("") sorts first ascending.
      return t.lastSyncedAt ?? "";
  }
}

// Human-readable "last synced" cell. Null means the tenant's data has never been
// pulled in (the freshness stamp is only written by a successful data sync).
function formatSynced(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  active: boolean;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  return (
    <th className={`px-5 py-3 font-medium ${align === "right" ? "text-right" : ""}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-slate-700 ${
          active ? "text-slate-700" : ""
        }`}
      >
        {label}
        <span className="text-[9px] leading-none text-slate-400">
          {active ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

export function Tenants() {
  const qc = useQueryClient();
  const canWrite = useCan("settings:write");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  // Independent search/sort for the "Per-tenant admin consent" section below —
  // deliberately separate from the main table's `search`/`sort` above so
  // filtering one doesn't affect the other.
  const [consentSearch, setConsentSearch] = useState("");
  const [consentSortKey, setConsentSortKey] = useState<ConsentSortKey>("name");
  // Set when the engineer opens an admin-consent tab; the next window focus
  // auto-re-probes so the row reflects the freshly granted access.
  const pendingRecheck = useRef(false);

  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<{ ok: boolean; demoMode: boolean }>("/api/health"),
  });
  const demoMode = health?.demoMode ?? false;

  const { data: tenants = [], isLoading, isFetching } = useQuery({
    queryKey: ["tenants"],
    queryFn: () => api.get<Tenant[]>("/api/tenants"),
  });

  // Re-query the tenant list (and the data surfaces) WITHOUT re-running Graph
  // discovery. Useful after a sync, when devices/CVEs land a few seconds behind
  // the "Synced" confirmation — a refresh pulls the freshly-stamped rows in.
  function refresh() {
    setMessage(null);
    void qc.invalidateQueries({ queryKey: ["tenants"] });
    void qc.invalidateQueries({ queryKey: ["devices"] });
    void qc.invalidateQueries({ queryKey: ["vulnerabilities"] });
  }

  // App identity for building per-tenant admin-consent URLs client-side (same
  // helper the API/installer use — carries only the public client id).
  const { data: onboarding } = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.get<OnboardingReport>("/api/onboarding"),
  });

  // PatchPilot's Live Response device pool — read here (settings:read, same
  // as Settings > License) purely to show each row's allocation against the
  // pool total; editing an allocation goes through PATCH /api/tenants/:id
  // below, not this page's own settings:write mutation.
  const { data: entitlement } = useQuery({
    queryKey: ["settings", "entitlement"],
    queryFn: () => api.get<EntitlementView>("/api/settings/entitlement"),
    enabled: !demoMode,
  });

  function consentUrlFor(tenantId: string): string | null {
    if (!onboarding) return null;
    return buildConsentUrl(tenantId, onboarding.clientId, onboarding.redirectUri);
  }

  const discover = useMutation({
    mutationFn: () => api.post<SyncTenantsResult>("/api/sync/tenants", {}),
    onSuccess: (res) => {
      const { reachable, consentNeeded, throttled, unreachable, licensingUnavailable } =
        res.summary;
      const parts = [`${reachable} reachable`];
      if (consentNeeded) parts.push(`${consentNeeded} need consent`);
      if (throttled) parts.push(`${throttled} throttled`);
      if (unreachable) parts.push(`${unreachable} unreachable`);
      // Reachability and licensing are separate signals: a tenant can be fully
      // reachable yet have its SKU read blocked (needs Organization.Read.All).
      // Call that out as a footnote so it never reads as "no access".
      const note = licensingUnavailable
        ? ` Licensing unread for ${licensingUnavailable} reachable tenant(s) — access is fine; SKU detail needs Organization.Read.All.`
        : "";
      setMessage({
        tone: "ok",
        text: `Discovered ${res.tenants} tenant(s); probed ${res.probed} (${parts.join(", ")}).${note}`,
      });
      void qc.invalidateQueries({ queryKey: ["tenants"] });
    },
    onError: (err) =>
      setMessage({
        tone: "error",
        text: err instanceof ApiError ? err.message : "Tenant discovery failed.",
      }),
  });

  // Re-probe access/licensing when the engineer returns from an admin-consent tab.
  useEffect(() => {
    function onFocus() {
      if (!pendingRecheck.current) return;
      pendingRecheck.current = false;
      if (demoMode || discover.isPending) return;
      setMessage({ tone: "ok", text: "Re-checking tenant access after consent…" });
      discover.mutate();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [demoMode, discover]);

  // Per-tenant in-flight set so several syncs can run concurrently, each row
  // tracking its own progress. A single React Query mutation observer only keeps
  // the *latest* call's state, so starting a second sync made the first row
  // revert from "Syncing…" and clobbered its result message — making it look as
  // if the first never finished. Server-side the syncs are fully independent
  // (separate requests, per-tenant Redis token keys), so tracking in-flight ids
  // ourselves is all that's needed.
  const [syncing, setSyncing] = useState<ReadonlySet<string>>(() => new Set());

  async function syncTenantData(tenantId: string) {
    if (syncing.has(tenantId)) return;
    setSyncing((s) => new Set(s).add(tenantId));
    setMessage(null);
    try {
      const res = await api.post<SyncDataResult>(`/api/sync/${tenantId}/data`, {});
      setMessage({
        tone: "ok",
        text: `Synced tenant ${res.tenantId}: ${res.devices} device(s), ${res.vulnerabilities} CVE(s).`,
      });
      void qc.invalidateQueries({ queryKey: ["devices"] });
      void qc.invalidateQueries({ queryKey: ["vulnerabilities"] });
      void qc.invalidateQueries({ queryKey: ["tenants"] });
    } catch (err) {
      setMessage({
        tone: "error",
        text: err instanceof ApiError ? err.message : "Tenant data sync failed.",
      });
    } finally {
      setSyncing((s) => {
        const next = new Set(s);
        next.delete(tenantId);
        return next;
      });
    }
  }

  // Deliberate write-actions opt-in. Flipping this is the ONLY thing that lets a
  // tenant's remediations dispatch (sync never touches read-only posture), so it's
  // an explicit, audited engineer action rather than a silent side effect. Enabling
  // write is gated behind an in-app confirm modal (not window.confirm — that's a
  // native dialog that silently no-ops with zero feedback in plenty of ordinary
  // situations: Chrome's own "prevent this page from creating additional dialogs"
  // toggle, an iframe without modal permission, browser automation, etc. This bit
  // us in practice — the button looked completely dead). Re-freezing to read-only
  // stays one click. Tracked per-tenant so several rows can flip independently
  // without clobbering each other.
  const [flipping, setFlipping] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingWrite, setPendingWrite] = useState<Tenant | null>(null);

  async function setWritePosture(t: Tenant, readOnly: boolean) {
    if (flipping.has(t.tenantId)) return;
    setFlipping((s) => new Set(s).add(t.tenantId));
    setMessage(null);
    try {
      await api.patch<Tenant>(`/api/tenants/${t.tenantId}`, { readOnly });
      setMessage({
        tone: "ok",
        text: readOnly
          ? `${t.displayName} is read-only again — remediations are frozen.`
          : `${t.displayName} is now write-enabled — remediations can dispatch.`,
      });
      void qc.invalidateQueries({ queryKey: ["tenants"] });
    } catch (err) {
      setMessage({
        tone: "error",
        text: err instanceof ApiError ? err.message : "Could not change write posture.",
      });
    } finally {
      setFlipping((s) => {
        const next = new Set(s);
        next.delete(t.tenantId);
        return next;
      });
    }
  }

  // Per-tenant Live Response device allocation — this MSP's own split of
  // the instance-wide pool (entitlement.deviceLicensePool). Draft
  // values are tracked locally so an in-progress edit in one row survives a
  // background refetch of the tenant list, matching the readOnly/flipping
  // pattern above (own in-flight set, not a single shared mutation state).
  const [deviceLimitDrafts, setDeviceLimitDrafts] = useState<Record<string, string>>({});
  const [savingDeviceLimit, setSavingDeviceLimit] = useState<ReadonlySet<string>>(() => new Set());

  async function saveDeviceLimit(t: Tenant) {
    const draft = deviceLimitDrafts[t.tenantId];
    if (draft === undefined) return;
    const parsed = Number(draft);
    if (!Number.isInteger(parsed) || parsed < 0) {
      setMessage({ tone: "error", text: "Device allocation must be a non-negative whole number." });
      return;
    }
    if (parsed === t.liveResponseDeviceLimit) {
      setDeviceLimitDrafts((d) => {
        const next = { ...d };
        delete next[t.tenantId];
        return next;
      });
      return;
    }
    setSavingDeviceLimit((s) => new Set(s).add(t.tenantId));
    setMessage(null);
    try {
      await api.patch<Tenant>(`/api/tenants/${t.tenantId}`, { liveResponseDeviceLimit: parsed });
      setMessage({
        tone: "ok",
        text: `${t.displayName}'s Live Response device allocation is now ${parsed}.`,
      });
      setDeviceLimitDrafts((d) => {
        const next = { ...d };
        delete next[t.tenantId];
        return next;
      });
      void qc.invalidateQueries({ queryKey: ["tenants"] });
      void qc.invalidateQueries({ queryKey: ["settings", "entitlement"] });
    } catch (err) {
      setMessage({
        tone: "error",
        text: err instanceof ApiError ? err.message : "Could not change the device allocation.",
      });
    } finally {
      setSavingDeviceLimit((s) => {
        const next = new Set(s);
        next.delete(t.tenantId);
        return next;
      });
    }
  }

  function toggleSort(key: SortKey) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? tenants.filter(
          (t) =>
            t.displayName.toLowerCase().includes(q) ||
            t.tenantId.toLowerCase().includes(q),
        )
      : tenants;
    const sorted = [...filtered].sort((a, b) => {
      const cmp = sortValue(a, sort.key).localeCompare(sortValue(b, sort.key));
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [tenants, search, sort]);

  // Same admin-consent targets the onboarding report already computes
  // (routes/onboarding.ts) — every customer tenant (the MSP's own home
  // tenant consents during deployment, not via a per-customer URL).
  const consentTargets = onboarding?.consentTargets ?? [];

  const visibleConsentTargets = useMemo(() => {
    const q = consentSearch.trim().toLowerCase();
    const filtered = q
      ? consentTargets.filter(
          (t) =>
            t.displayName.toLowerCase().includes(q) ||
            t.tenantId.toLowerCase().includes(q),
        )
      : consentTargets;
    const keyOf = (t: (typeof consentTargets)[number]) =>
      consentSortKey === "reachability"
        ? reachMeta(t.reachability).label.toLowerCase()
        : consentSortKey === "consent"
          ? gdapMeta(t.consentStatus).label.toLowerCase()
          : t.displayName.toLowerCase();
    return [...filtered].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  }, [consentTargets, consentSearch, consentSortKey]);

  return (
    <div>
      <PageHeader
        title="Tenants"
        subtitle="GDAP-linked customer tenants. Every tenant starts read-only until write actions are opted in."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isFetching}
              onClick={refresh}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="Re-query the tenant list and data (no Graph re-discovery)"
            >
              {isFetching ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              disabled={demoMode || !canWrite || discover.isPending}
              onClick={() => {
                setMessage(null);
                discover.mutate();
              }}
              className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              title={
                demoMode
                  ? "Live sync is disabled in DEMO_MODE."
                  : !canWrite
                    ? "Your role doesn't include settings write access."
                    : undefined
              }
            >
              {discover.isPending ? "Discovering…" : "Discover tenants"}
            </button>
          </div>
        }
      />

      {message && (
        <Card
          className={`mb-5 ${
            message.tone === "ok" ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"
          }`}
        >
          <p
            className={`text-sm ${
              message.tone === "ok" ? "text-emerald-700" : "text-rose-700"
            }`}
          >
            {message.text}
          </p>
        </Card>
      )}

      <Card className="mb-5 border-dashed">
        <p className="text-sm text-slate-500">
          {demoMode
            ? "Live sync is disabled in DEMO_MODE — data is served from in-memory fixtures."
            : "Discover tenants reads your home tenant and GDAP customer relationships from Graph, then probes access and licensing. Sync data pulls each tenant's Intune devices and Defender CVE exposure into PatchPilot. "}
          {!demoMode && (
            <>
              The <span className="font-medium text-slate-600">Licenses</span> column and{" "}
              <span className="font-medium text-slate-600">Reachability</span> refresh on Discover
              (not Sync data). Per-tenant admin-consent links are below.
            </>
          )}
        </p>
      </Card>

      {!demoMode && entitlement && (
        <Card className="mb-5 border-dashed">
          <p className="text-sm text-slate-500">
            {entitlement.deviceLicensePool !== null ? (
              <>
                <span className="font-medium text-slate-700">Live Response device pool:</span>{" "}
                {entitlement.deviceLicenseAllocated} / {entitlement.deviceLicensePool} allocated across
                tenants below.{" "}
                {entitlement.deviceLicenseAllocated >= entitlement.deviceLicensePool &&
                  "The pool is fully allocated — raise a tenant's share by lowering another's, or contact PatchPilot Support to expand the pool."}
              </>
            ) : (
              "No license key has been uploaded — the Live Response device pool is 0 until one is (see Settings → License)."
            )}
          </p>
        </Card>
      )}

      <Card className="p-0">
        {isLoading ? (
          <div className="p-5 text-sm text-slate-500">Loading…</div>
        ) : tenants.length === 0 ? (
          <div className="p-5 text-sm text-slate-500">
            No tenants yet.{" "}
            {!demoMode && "Click “Discover tenants” to pull them from Graph."}
          </div>
        ) : (
          <>
            <div className="border-b border-slate-100 p-3">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or tenant ID…"
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 sm:w-80"
              />
            </div>
            {visible.length === 0 ? (
              <div className="p-5 text-sm text-slate-500">No tenants match “{search}”.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <SortHeader label="Tenant" sortKey="name" active={sort.key === "name"} dir={sort.dir} onSort={toggleSort} />
                    <th className="px-5 py-3 font-medium">Entra tenant ID</th>
                    <SortHeader label="GDAP status" sortKey="gdap" active={sort.key === "gdap"} dir={sort.dir} onSort={toggleSort} />
                    <SortHeader label="Reachability" sortKey="reachability" active={sort.key === "reachability"} dir={sort.dir} onSort={toggleSort} />
                    <SortHeader label="Mode" sortKey="mode" active={sort.key === "mode"} dir={sort.dir} onSort={toggleSort} />
                    <th className="px-5 py-3 font-medium" title="This tenant's share of the Live Response device pool.">
                      LR devices
                    </th>
                    <SortHeader label="Licenses" sortKey="licenses" active={sort.key === "licenses"} dir={sort.dir} onSort={toggleSort} />
                    <SortHeader label="Last synced" sortKey="lastSynced" active={sort.key === "lastSynced"} dir={sort.dir} onSort={toggleSort} />
                    <th className="px-5 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((t) => {
                    const consentUrl = consentUrlFor(t.tenantId);
                    return (
                      <tr
                        key={t.id}
                        className="border-b border-slate-100 last:border-0 hover:bg-slate-50"
                      >
                        <td className="px-5 py-3 font-medium text-slate-800">
                          {t.displayName}
                          {t.isMspTenant && (
                            <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-indigo-700">
                              MSP
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3 font-mono text-xs text-slate-500">
                          {t.tenantId}
                        </td>
                        <td className="px-5 py-3">
                          {t.isMspTenant ? (
                            <span
                              className="inline-flex items-center rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700"
                              title="Your own MSP tenant — installed directly, no GDAP relationship applies."
                            >
                              Home tenant
                            </span>
                          ) : (
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                gdapMeta(t.consentStatus).style
                              }`}
                              title="The GDAP delegated-admin relationship between your MSP and this customer (Active / Pending / Expired)."
                            >
                              {gdapMeta(t.consentStatus).label}
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                reachMeta(t.reachability).style
                              }`}
                              title={
                                t.reachability === "unknown"
                                  ? "Run Discover to probe whether PatchPilot can reach this tenant's Graph."
                                  : "Whether PatchPilot can actually call Graph for this tenant (probed via Discover)."
                              }
                            >
                              {reachMeta(t.reachability).label}
                            </span>
                            {!demoMode && consentUrl && (
                              <a
                                href={consentUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={() => {
                                  pendingRecheck.current = true;
                                }}
                                title={
                                  t.isMspTenant
                                    ? "Open admin consent for your home tenant"
                                    : "Open admin consent for this tenant"
                                }
                                aria-label="Open admin consent in a new tab"
                                className="inline-flex items-center rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                              >
                                <ExternalLinkIcon />
                              </a>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          {(() => {
                            const busy = flipping.has(t.tenantId);
                            return (
                              <button
                                type="button"
                                disabled={demoMode || !canWrite || busy}
                                onClick={() =>
                                  t.readOnly ? setPendingWrite(t) : void setWritePosture(t, true)
                                }
                                title={
                                  demoMode
                                    ? "Write posture is fixed to read-only in DEMO_MODE."
                                    : !canWrite
                                      ? "Your role doesn't include settings write access."
                                      : t.readOnly
                                        ? "Opt this tenant into write actions so remediations can dispatch."
                                        : "Disable this tenant back to read-only (blocks all remediations)."
                                }
                                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                                  t.readOnly
                                    ? "bg-slate-100 text-slate-600 hover:bg-slate-200"
                                    : "bg-blue-100 text-blue-700 hover:bg-blue-200"
                                }`}
                              >
                                {busy
                                  ? "Saving…"
                                  : t.readOnly
                                    ? "Read-only"
                                    : "Write enabled"}
                                {!demoMode && !busy && (
                                  <span className="text-[9px] leading-none opacity-60">
                                    {t.readOnly ? "→ enable" : "→ disable"}
                                  </span>
                                )}
                              </button>
                            );
                          })()}
                        </td>
                        <td className="px-5 py-3">
                          {(() => {
                            const draft = deviceLimitDrafts[t.tenantId];
                            const value = draft ?? String(t.liveResponseDeviceLimit);
                            const dirty = draft !== undefined && draft !== String(t.liveResponseDeviceLimit);
                            const saving = savingDeviceLimit.has(t.tenantId);
                            const used = entitlement?.perTenantDeviceUsage.find(
                              (u) => u.tenantId === t.tenantId,
                            )?.used;
                            return (
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  disabled={demoMode || !canWrite || saving}
                                  value={value}
                                  onChange={(e) =>
                                    setDeviceLimitDrafts((d) => ({ ...d, [t.tenantId]: e.target.value }))
                                  }
                                  className="w-14 rounded-md border border-slate-200 px-1.5 py-1 text-xs text-slate-700 focus:border-indigo-400 focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-50"
                                  title={
                                    !canWrite
                                      ? "Your role doesn't include settings write access."
                                      : "Devices allocated to this tenant from the Live Response pool."
                                  }
                                />
                                {used !== undefined && (
                                  <span className="text-[10px] text-slate-400">used {used}</span>
                                )}
                                {dirty && (
                                  <button
                                    type="button"
                                    onClick={() => void saveDeviceLimit(t)}
                                    disabled={saving}
                                    className="rounded-md bg-indigo-600 px-1.5 py-1 text-[10px] font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                                  >
                                    {saving ? "…" : "Save"}
                                  </button>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-5 py-3 text-xs text-slate-500">
                          {t.licenses.length > 0 ? t.licenses.join(", ") : "—"}
                        </td>
                        <td
                          className={`px-5 py-3 text-xs ${
                            t.lastSyncedAt ? "text-slate-500" : "text-slate-400"
                          }`}
                          title={
                            t.lastSyncedAt
                              ? "When this tenant's devices + CVEs were last pulled in."
                              : "This tenant has not been synced yet — click “Sync data”."
                          }
                        >
                          {formatSynced(t.lastSyncedAt)}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <button
                            type="button"
                            disabled={
                              demoMode ||
                              !canWrite ||
                              t.consentStatus !== "consented" ||
                              syncing.has(t.tenantId)
                            }
                            onClick={() => void syncTenantData(t.tenantId)}
                            className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            title={
                              !canWrite
                                ? "Your role doesn't include settings write access."
                                : t.consentStatus !== "consented"
                                  ? "Tenant must be consented before syncing."
                                  : undefined
                            }
                          >
                            {syncing.has(t.tenantId) ? "Syncing…" : "Sync data"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </Card>

      {!demoMode && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-700">
              Per-tenant admin consent
            </h2>
            {consentTargets.length > 0 && (
              <button
                type="button"
                disabled={!canWrite || discover.isPending}
                onClick={() => {
                  setMessage(null);
                  discover.mutate();
                }}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                title="Re-probe every tenant's access and consent status."
              >
                {discover.isPending ? "Re-checking…" : "Re-check access"}
              </button>
            )}
          </div>

          <Card className="p-0">
            {consentTargets.length === 0 ? (
              <div className="p-5 text-sm text-slate-500">
                No customer tenants to consent yet.
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:items-center">
                  <input
                    type="search"
                    value={consentSearch}
                    onChange={(e) => setConsentSearch(e.target.value)}
                    placeholder="Search by name or tenant ID…"
                    className="flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                  />
                  <label className="flex items-center gap-2 text-xs text-slate-500">
                    Sort
                    <select
                      value={consentSortKey}
                      onChange={(e) => setConsentSortKey(e.target.value as ConsentSortKey)}
                      className="rounded-md border border-slate-200 px-2 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    >
                      <option value="name">Name</option>
                      <option value="reachability">Reachability</option>
                      <option value="consent">Consent status</option>
                    </select>
                  </label>
                </div>
                {visibleConsentTargets.length === 0 ? (
                  <div className="p-5 text-sm text-slate-500">
                    No tenants match “{consentSearch}”.
                  </div>
                ) : (
                  <ul>
                    {visibleConsentTargets.map((t) => (
                      <li
                        key={t.tenantId}
                        className="border-b border-slate-100 px-5 py-4 last:border-0"
                      >
                        <div className="flex items-center justify-between gap-4">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-slate-800">
                              {t.displayName}
                            </div>
                            <div className="font-mono text-xs text-slate-400">
                              {t.tenantId}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                reachMeta(t.reachability).style
                              }`}
                              title="Whether PatchPilot can actually call Graph for this tenant (probed via Discover)."
                            >
                              {reachMeta(t.reachability).label}
                            </span>
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                gdapMeta(t.consentStatus).style
                              }`}
                            >
                              {gdapMeta(t.consentStatus).label}
                            </span>
                          </div>
                        </div>

                        {t.reachability === "consent-needed" && (
                          <p className="mt-2 text-xs text-amber-700">
                            App-only tokens mint but Graph returns 403. Re-run{" "}
                            <code className="font-mono">Deploy-PatchPilot.ps1</code>{" "}
                            to grant customer access (adds the SP to the GDAP
                            group), then Discover to re-probe.
                          </p>
                        )}
                        {t.reachability === "reachable" && t.licenses.length === 0 && (
                          <p className="mt-2 text-xs text-slate-400">
                            Reachable, but no managed licenses detected
                            (reseller-only or unlicensed) — informational only,
                            no action needed.
                          </p>
                        )}
                        <div className="mt-2 flex items-center gap-2">
                          <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600">
                            {t.consentUrl}
                          </code>
                          <CopyButton value={t.consentUrl} />
                          <a
                            href={consentMailto(t.displayName, t.consentUrl)}
                            className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
                          >
                            Email
                          </a>
                          <a
                            href={t.consentUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={() => {
                              pendingRecheck.current = true;
                            }}
                            className="shrink-0 rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-slate-700"
                          >
                            Open
                          </a>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Card>
        </div>
      )}

      {pendingWrite && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setPendingWrite(null)}
            aria-hidden
          />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-slate-900">
              Opt {pendingWrite.displayName} into write actions?
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              This lets PatchPilot dispatch real remediations (Live Response scripts, Intune
              actions) to this tenant's devices. The change is audited. You can switch back to
              read-only at any time.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingWrite(null)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void setWritePosture(pendingWrite, false);
                  setPendingWrite(null);
                }}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
              >
                Enable write actions
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
