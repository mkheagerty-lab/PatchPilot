import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  USER_STATUS_LABELS,
  PERMISSION_AREAS,
  AREA_ACCESS_LABELS,
  accessFor,
  type Role,
  type UserStatus,
  type AreaAccess,
} from "@patchpilot/shared";
import { api, ApiError, type User } from "../../lib/api";
import { useEngineer } from "../../lib/auth";
import { Card, PageHeader } from "../../components/ui";
import { SortIcon, type SortDir } from "../../components/cve";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-slate-400 focus:outline-none";

// Least-privilege default for the add form — an admin grant should always be
// a deliberate role change afterwards, never the form's resting state.
const DEFAULT_NEW_ROLE: Role = "reader";

type SortKey = "name" | "upn" | "role" | "status" | "lastLogin" | "invitedBy" | "added";

const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  upn: "asc",
  role: "asc",
  status: "asc",
  lastLogin: "desc",
  invitedBy: "asc",
  added: "desc",
};

function sortValue(u: User, key: SortKey): string | number {
  switch (key) {
    case "name":
      return u.displayName.toLowerCase();
    case "upn":
      return u.upn.toLowerCase();
    case "role":
      // Most- to least-privileged, matching ROLES' own order.
      return ROLES.indexOf(u.role);
    case "status":
      return u.status;
    case "lastLogin":
      return u.lastLoginAt ?? "";
    case "invitedBy":
      return (u.invitedBy ?? "").toLowerCase();
    case "added":
      return new Date(u.createdAt).getTime();
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
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

function SortableTh({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sortKey === activeKey;
  return (
    <th className={`px-4 py-2.5 font-medium ${align === "right" ? "text-right" : ""}`}>
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

const STATUS_STYLE: Record<UserStatus, string> = {
  active: "bg-emerald-100 text-emerald-700",
  disabled: "bg-slate-200 text-slate-600",
};

const ACCESS_STYLE: Record<AreaAccess, string> = {
  readwrite: "bg-emerald-100 text-emerald-700",
  readonly: "bg-sky-100 text-sky-700",
  none: "bg-slate-100 text-slate-500",
};

/** The specific 409 codes the server invariants (§3.7 of the plan) return,
 *  turned into the sentence an operator actually needs to read. */
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const code = (err.data as { error?: string } | undefined)?.error;
    if (code === "last_admin") {
      return "That would leave PatchPilot with no active admin — add or promote another admin first.";
    }
    if (code === "self_modification") {
      return "You can't change your own role or disable/remove your own account.";
    }
    return err.message || fallback;
  }
  return fallback;
}

/**
 * Settings > Users — the provisioned PatchPilot user list and their global
 * role. Modeled on Tenants.tsx (sortable/searchable table, chip actions,
 * hand-rolled confirm modal) with ScriptCatalog.tsx's inline collapsible
 * "Add" panel instead of a modal, since adding a user is occasional and
 * browsing the list is constant.
 *
 * Every write here is mirrored server-side by the real invariants — the last
 * active admin can't be demoted/disabled/deleted, and nobody can modify their
 * own row (see apps/api/src/routes/users.ts). This page disables the
 * corresponding controls proactively, but a 409 from the server is always
 * the real answer, not just this page's guess.
 */
export function Users() {
  const engineer = useEngineer();
  const qc = useQueryClient();
  const selfUpn = engineer.upn.toLowerCase();

  const [tab, setTab] = useState<"people" | "roles">("people");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("added");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [addOpen, setAddOpen] = useState(false);
  const [upn, setUpn] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [newRole, setNewRole] = useState<Role>(DEFAULT_NEW_ROLE);
  // Follows the role's own default (admin -> on) until the operator overrides
  // it by hand, matching the server's own "admin unless explicitly set"
  // default in apps/api/src/routes/users.ts.
  const [alertsTouched, setAlertsTouched] = useState(false);
  const [receiveJobAlerts, setReceiveJobAlerts] = useState(DEFAULT_NEW_ROLE === "admin");
  const [actionError, setActionError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<User | null>(null);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<User[]>("/api/users"),
  });

  function invalidate() {
    void qc.invalidateQueries({ queryKey: ["users"] });
  }

  const activeAdminCount = useMemo(
    () => users.filter((u) => u.role === "admin" && u.status === "active").length,
    [users],
  );

  const create = useMutation<User, Error>({
    mutationFn: () =>
      api.post<User>("/api/users", {
        upn: upn.trim(),
        displayName: displayName.trim(),
        role: newRole,
        receiveJobAlerts,
      }),
    onSuccess: () => {
      setUpn("");
      setDisplayName("");
      setNewRole(DEFAULT_NEW_ROLE);
      setAlertsTouched(false);
      setReceiveJobAlerts(DEFAULT_NEW_ROLE === "admin");
      setAddOpen(false);
      invalidate();
    },
  });

  const patch = useMutation<
    User,
    Error,
    { id: string; body: { role?: Role; status?: UserStatus; receiveJobAlerts?: boolean } }
  >({
    mutationFn: ({ id, body }) => api.patch<User>(`/api/users/${id}`, body),
    onMutate: ({ id }) => {
      setActionError(null);
      setSavingId(id);
    },
    onSuccess: () => invalidate(),
    onError: (err) => setActionError(errorMessage(err, "Could not update that user.")),
    onSettled: () => setSavingId(null),
  });

  const del = useMutation<unknown, Error, string>({
    mutationFn: (id) => api.del(`/api/users/${id}`),
    onMutate: (id) => {
      setActionError(null);
      setSavingId(id);
    },
    onSuccess: () => {
      setPendingDelete(null);
      invalidate();
    },
    onError: (err) => setActionError(errorMessage(err, "Could not remove that user.")),
    onSettled: () => setSavingId(null),
  });

  const revoke = useMutation<{ revoked: boolean }, Error, string>({
    mutationFn: (id) => api.post<{ revoked: boolean }>(`/api/users/${id}/revoke-background-access`, {}),
    onMutate: (id) => {
      setActionError(null);
      setSavingId(id);
    },
    onSuccess: () => invalidate(),
    onError: (err) => setActionError(errorMessage(err, "Could not revoke background access.")),
    onSettled: () => setSavingId(null),
  });

  function onSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? users.filter(
          (u) => u.displayName.toLowerCase().includes(q) || u.upn.toLowerCase().includes(q),
        )
      : users;
    const sorted = [...filtered].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [users, search, sortKey, sortDir]);

  const canSubmit = !!upn.trim() && !!displayName.trim() && !create.isPending;

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Who can sign in to PatchPilot, and what their role lets them do here."
        actions={
          tab === "people" ? (
            <button
              type="button"
              onClick={() => setAddOpen((o) => !o)}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700"
            >
              {addOpen ? "Close" : "Add a user"}
            </button>
          ) : undefined
        }
      />

      <Card className="mb-5 border-dashed">
        <p className="text-sm text-slate-500">
          A PatchPilot role controls what a person can{" "}
          <span className="font-medium text-slate-600">do inside PatchPilot</span> — dispatch
          remediations, manage catalogs, change settings. Their GDAP roles in Entra separately
          control{" "}
          <span className="font-medium text-slate-600">which customer tenants</span> they can
          reach at all. Both apply to every action.
        </p>
        <p className="mt-2 text-sm text-slate-500">
          Signing out no longer revokes a person's background-access session — it's designed to
          keep hourly auto-sync and their schedules running even while they're signed out. Use{" "}
          <span className="font-medium text-slate-600">Revoke access</span> below (or disable/
          remove the account) to actually cut that off.
        </p>
      </Card>

      <div className="mb-5 flex gap-1 border-b border-slate-200">
        {(
          [
            { key: "people", label: "People" },
            { key: "roles", label: "Roles" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "roles" ? (
        <>
          <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-3">
            {ROLES.map((r) => (
              <Card key={r}>
                <div className="mb-1 text-sm font-semibold text-slate-800">{ROLE_LABELS[r]}</div>
                <p className="text-sm text-slate-500">{ROLE_DESCRIPTIONS[r]}</p>
              </Card>
            ))}
          </div>

          <Card className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2.5 font-medium">Area</th>
                  {ROLES.map((r) => (
                    <th key={r} className="px-4 py-2.5 text-center font-medium">
                      {ROLE_LABELS[r]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERMISSION_AREAS.map((area) => (
                  <tr key={area.key} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">{area.label}</div>
                      <div className="mt-0.5 text-xs text-slate-500">{area.description}</div>
                    </td>
                    {ROLES.map((r) => {
                      const access = accessFor(r, area);
                      return (
                        <td key={r} className="px-4 py-3 text-center">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${ACCESS_STYLE[access]}`}
                          >
                            {AREA_ACCESS_LABELS[access]}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      ) : (
        <>
      {actionError && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {actionError}
        </div>
      )}

      {addOpen && (
        <Card className="mb-4">
          <div className="mb-3 text-sm font-medium text-slate-700">Add a user</div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                User principal name
              </label>
              <input
                className={INPUT_CLASS}
                value={upn}
                onChange={(e) => setUpn(e.target.value)}
                placeholder="name@tenant.com"
              />
              <p className="mt-1 text-[11px] text-slate-400">
                Must match their Entra sign-in UPN exactly.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Display name</label>
              <input
                className={INPUT_CLASS}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Priya Patel"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Role</label>
              <select
                className={INPUT_CLASS}
                value={newRole}
                onChange={(e) => {
                  const r = e.target.value as Role;
                  setNewRole(r);
                  if (!alertsTouched) setReceiveJobAlerts(r === "admin");
                }}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-400">{ROLE_DESCRIPTIONS[newRole]}</p>
            </div>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={receiveJobAlerts}
              onChange={(e) => {
                setAlertsTouched(true);
                setReceiveJobAlerts(e.target.checked);
              }}
              className="rounded border-slate-300"
            />
            Send this person job/sync failure alert emails (requires SMTP relay configured under{" "}
            <span className="font-medium text-slate-700">Settings &gt; Notifications</span>)
          </label>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => create.mutate()}
              disabled={!canSubmit}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
            >
              {create.isPending ? "Adding…" : "Add user"}
            </button>
            {create.isError && (
              <span className="text-xs text-rose-600">
                {errorMessage(create.error, "Could not add that user.")}
              </span>
            )}
          </div>
        </Card>
      )}

      <Card className="p-0">
        {isLoading ? (
          <div className="p-5 text-sm text-slate-500">Loading…</div>
        ) : users.length === 0 ? (
          <div className="p-5 text-sm text-slate-500">
            No users yet. Add yourself and your team above.
          </div>
        ) : (
          <>
            <div className="border-b border-slate-100 p-3">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or UPN…"
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 sm:w-80"
              />
            </div>
            {visible.length === 0 ? (
              <div className="p-5 text-sm text-slate-500">No users match "{search}".</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                    <SortableTh label="UPN" sortKey="upn" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                    <SortableTh label="Role" sortKey="role" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                    <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                    <SortableTh label="Last sign-in" sortKey="lastLogin" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                    <SortableTh label="Added by" sortKey="invitedBy" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                    <SortableTh label="Added" sortKey="added" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                    <th className="px-4 py-2.5 font-medium">Alerts</th>
                    <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((u) => {
                    const isSelf = u.upn.toLowerCase() === selfUpn;
                    const isLastActiveAdmin =
                      u.role === "admin" && u.status === "active" && activeAdminCount <= 1;
                    // Own row and the last standing admin both stay locked — the
                    // server enforces this either way, but a control that's
                    // disabled up front reads better than one that 409s on click.
                    const locked = isSelf || isLastActiveAdmin;
                    const lockedTitle = isSelf
                      ? "You can't change your own role or status."
                      : isLastActiveAdmin
                        ? "This is the last active admin — promote another admin first."
                        : undefined;
                    const busy = savingId === u.id;
                    return (
                      <tr key={u.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                        <td className="px-4 py-2.5 font-medium text-slate-800">
                          {u.displayName}
                          {isSelf && (
                            <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-indigo-700">
                              You
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{u.upn}</td>
                        <td className="px-4 py-2.5">
                          <select
                            value={u.role}
                            disabled={locked || busy}
                            title={lockedTitle}
                            onChange={(e) =>
                              patch.mutate({ id: u.id, body: { role: e.target.value as Role } })
                            }
                            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-4 py-2.5">
                          <button
                            type="button"
                            disabled={locked || busy}
                            title={
                              lockedTitle ??
                              (u.status === "active"
                                ? "Disable this account — blocks sign-in immediately."
                                : "Re-enable this account.")
                            }
                            onClick={() =>
                              patch.mutate({
                                id: u.id,
                                body: { status: u.status === "active" ? "disabled" : "active" },
                              })
                            }
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${STATUS_STYLE[u.status]}`}
                          >
                            {busy ? "Saving…" : USER_STATUS_LABELS[u.status]}
                          </button>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-slate-500">
                          {formatDate(u.lastLoginAt)}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-slate-500">{u.invitedBy ?? "—"}</td>
                        <td className="px-4 py-2.5 text-xs text-slate-500">{formatDate(u.createdAt)}</td>
                        <td className="px-4 py-2.5">
                          <button
                            type="button"
                            disabled={busy}
                            title={
                              u.receiveJobAlerts
                                ? "Receiving job/sync failure alert emails. Click to opt out."
                                : "Not receiving alert emails. Click to opt in."
                            }
                            onClick={() =>
                              patch.mutate({ id: u.id, body: { receiveJobAlerts: !u.receiveJobAlerts } })
                            }
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                              u.receiveJobAlerts
                                ? "bg-emerald-100 text-emerald-700"
                                : "bg-slate-100 text-slate-500"
                            }`}
                          >
                            {busy ? "Saving…" : u.receiveJobAlerts ? "On" : "Off"}
                          </button>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              disabled={isSelf || busy}
                              title={
                                isSelf
                                  ? "You can't revoke your own background access."
                                  : "Revoke this person's cached background-access session — used by hourly auto-sync and their schedules. Does not disable their account."
                              }
                              onClick={() => revoke.mutate(u.id)}
                              className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Revoke access
                            </button>
                            <button
                              type="button"
                              disabled={locked || busy}
                              title={lockedTitle}
                              onClick={() => setPendingDelete(u)}
                              className="rounded-md border border-rose-200 px-2.5 py-1 text-xs font-medium text-rose-600 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Remove
                            </button>
                          </div>
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

      {pendingDelete && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setPendingDelete(null)}
            aria-hidden
          />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-slate-900">
              Remove {pendingDelete.displayName}?
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              They will no longer be able to sign in to PatchPilot. Their past attribution (jobs,
              audit entries) is unaffected — this only removes the account.
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
                onClick={() => del.mutate(pendingDelete.id)}
                disabled={del.isPending}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-50"
              >
                {del.isPending ? "Removing…" : "Remove user"}
              </button>
            </div>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}
