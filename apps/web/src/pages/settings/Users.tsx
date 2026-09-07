import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  USER_STATUS_LABELS,
  PERMISSION_AREAS,
  AREA_ACCESS_LABELS,
  accessFor,
  READONLY_GROUP_NAME,
  WRITE_GROUP_NAME,
  WRITE_GROUP_ROLES,
  type Role,
  type UserStatus,
  type AreaAccess,
} from "@patchpilot/shared";
import { api, ApiError, type User, type OnboardingReport } from "../../lib/api";
import { useEngineer } from "../../lib/auth";
import { Card, PageHeader, ResponsiveTable, type ResponsiveTableColumn } from "../../components/ui";
import { SortIcon, type SortDir } from "../../components/cve";

/**
 * Runs a home-tenant access-group step-up silently: loads
 * /api/users/access-group/start?...&silent=1 in a hidden iframe (prompt=none)
 * instead of a top-level redirect. Mirrors AppRegistration.tsx's
 * runSilentTestConnection exactly — see apps/api/src/auth/routes.ts's
 * SILENT_ACCESS_GROUP_STATE_PREFIX branch for what runs on the other end.
 * Used only for the automatic add-to-read-only-group call right after a new
 * user is created; never for the write-access toggle, which is always a
 * full, visible, interactive redirect (see runWriteAccessToggle below).
 */
function runSilentAddReadonly(targetUserId: string, onSettled: (ok: boolean) => void): void {
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.setAttribute("aria-hidden", "true");

  let settled = false;
  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    window.removeEventListener("message", onMessage);
    iframe.remove();
    onSettled(ok);
  };

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as { source?: string; ok?: boolean } | null;
    if (!data || data.source !== "patchpilot-access-group") return;
    finish(data.ok === true);
  };

  // Same generous-but-bounded timeout as Test Connection's silent path — a
  // real prompt=none round trip is normally under a second.
  const timer = window.setTimeout(() => finish(false), 8000);

  window.addEventListener("message", onMessage);
  iframe.src = `/api/users/access-group/start?action=add-readonly&targetUserId=${encodeURIComponent(targetUserId)}&silent=1`;
  document.body.appendChild(iframe);
}

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

function SortableLabel({
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
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className="group inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-slate-700 dark:hover:text-slate-300"
    >
      {label}
      <SortIcon active={active} dir={dir} />
    </button>
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
 *  turned into the sentence an operator actually needs to read. Returns a
 *  ReactNode rather than a plain string so the access-group case can link
 *  straight to the App Registration page instead of just naming a script. */
function errorMessage(err: unknown, fallback: string): ReactNode {
  if (err instanceof ApiError) {
    const data = err.data as { error?: string; groupName?: string } | undefined;
    const code = data?.error;
    if (code === "last_admin") {
      return "That would leave PatchPilot with no active admin — add or promote another admin first.";
    }
    if (code === "self_modification") {
      return "You can't change your own role or disable/remove your own account.";
    }
    if (code === "access_group_not_provisioned") {
      return (
        <>
          <strong>{data?.groupName ?? "That access group"}</strong> hasn't been provisioned in the
          home tenant yet.{" "}
          <Link to="/setup/app-registration" className="font-medium underline hover:no-underline">
            See App Registration
          </Link>{" "}
          for the setup steps and script to run — if it warns about a missing Entra ID P1/P2
          license, that's expected on a tenant without one; a Global Administrator can still
          manage the home tenant directly without this group.
        </>
      );
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
  const [actionError, setActionError] = useState<ReactNode>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<User | null>(null);
  // Write-access toggle confirm dialog — set for either direction (grant or
  // revoke; see the plan's "turning it off confirms and revokes the same
  // way"). The dialog reads the target's *current* writeAccessEnabled to
  // decide which way it's confirming.
  const [pendingWriteAccess, setPendingWriteAccess] = useState<User | null>(null);
  const [writeTogglePending, setWriteTogglePending] = useState(false);
  // Set right after POST /api/users while the silent add-to-read-only-group
  // iframe is in flight, purely so the row can show "Syncing…" instead of
  // "Not yet synced" for that ~1s window instead of flashing a false negative.
  const [syncingReadonlyId, setSyncingReadonlyId] = useState<string | null>(null);
  const [retryingReadonlyId, setRetryingReadonlyId] = useState<string | null>(null);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<User[]>("/api/users"),
  });

  // Home-tenant access groups (badge/toggle below) are hard-disabled in
  // DEMO_MODE server-side (see routes/access-groups.ts) — read the same
  // report AppRegistration.tsx and License.tsx already use rather than
  // re-deriving it, and hide the UI entirely instead of showing controls that
  // 400 on every click.
  const { data: onboardingReport } = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.get<OnboardingReport>("/api/onboarding"),
  });
  const demoMode = onboardingReport?.demoMode ?? false;

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
    onSuccess: (created) => {
      setUpn("");
      setDisplayName("");
      setNewRole(DEFAULT_NEW_ROLE);
      setAlertsTouched(false);
      setReceiveJobAlerts(DEFAULT_NEW_ROLE === "admin");
      setAddOpen(false);
      invalidate();

      // Best-effort, never blocks the user-creation flow above: a failure
      // here just leaves readOnlyGroupSyncedAt null and the row shows a
      // retry action (see the sync-status column below). Skipped entirely in
      // DEMO_MODE, where the start route would just 400.
      if (!demoMode) {
        setSyncingReadonlyId(created.id);
        runSilentAddReadonly(created.id, () => {
          setSyncingReadonlyId(null);
          invalidate();
        });
      }
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

  /**
   * Preflights the write-access toggle, then does a real top-level navigation
   * to the redirect URL it gets back — the interactive Microsoft consent
   * screen (see apps/api/src/routes/access-groups.ts's start route and the
   * ACCESS_GROUP_STATE_PREFIX callback branch). Navigating away means this
   * component unmounts before the result is known; the callback lands back
   * on this same page via landingPage()'s "Return to PatchPilot" link, and
   * the users list simply reflects whatever actually happened in Entra.
   */
  const writeAccessToggle = useMutation<
    { redirectUrl: string },
    Error,
    { id: string; enabled: boolean }
  >({
    mutationFn: ({ id, enabled }) =>
      api.post<{ redirectUrl: string }>(`/api/users/${id}/write-access`, { enabled }),
    onMutate: ({ id }) => {
      setActionError(null);
      setSavingId(id);
      setWriteTogglePending(true);
    },
    onSuccess: (res) => {
      window.location.href = res.redirectUrl;
    },
    onError: (err) => {
      setActionError(
        errorMessage(err, "Could not start the write-access request."),
      );
      setWriteTogglePending(false);
      setSavingId(null);
    },
  });

  /** Same preflight-then-navigate shape as writeAccessToggle, for the
   *  read-only group's "retry" action. Always interactive (never silent) —
   *  see /api/users/:id/sync-readonly-group's own doc comment. */
  const retryReadonlySync = useMutation<{ redirectUrl: string }, Error, string>({
    mutationFn: (id) => api.post<{ redirectUrl: string }>(`/api/users/${id}/sync-readonly-group`, {}),
    onMutate: (id) => {
      setActionError(null);
      setRetryingReadonlyId(id);
    },
    onSuccess: (res) => {
      window.location.href = res.redirectUrl;
    },
    onError: (err) => {
      setActionError(errorMessage(err, "Could not retry the read-only group sync."));
      setRetryingReadonlyId(null);
    },
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

  const userColumns: ResponsiveTableColumn<User>[] = [
    {
      key: "name",
      primary: true,
      header: (
        <SortableLabel label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onSort} />
      ),
      cell: (u) => (
        <>
          {u.displayName}
          {u.upn.toLowerCase() === selfUpn && (
            <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
              You
            </span>
          )}
        </>
      ),
    },
    {
      key: "upn",
      header: <SortableLabel label="UPN" sortKey="upn" activeKey={sortKey} dir={sortDir} onSort={onSort} />,
      mobileLabel: "UPN",
      cell: (u) => <span className="font-mono text-xs">{u.upn}</span>,
    },
    {
      key: "role",
      header: <SortableLabel label="Role" sortKey="role" activeKey={sortKey} dir={sortDir} onSort={onSort} />,
      mobileLabel: "Role",
      cell: (u) => {
        const isSelf = u.upn.toLowerCase() === selfUpn;
        const isLastActiveAdmin = u.role === "admin" && u.status === "active" && activeAdminCount <= 1;
        const locked = isSelf || isLastActiveAdmin;
        const lockedTitle = isSelf
          ? "You can't change your own role or status."
          : isLastActiveAdmin
            ? "This is the last active admin — promote another admin first."
            : undefined;
        const busy = savingId === u.id;
        return (
          <select
            value={u.role}
            disabled={locked || busy}
            title={lockedTitle}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => patch.mutate({ id: u.id, body: { role: e.target.value as Role } })}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        );
      },
    },
    {
      key: "status",
      header: (
        <SortableLabel label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onSort} />
      ),
      mobileLabel: "Status",
      cell: (u) => {
        const isSelf = u.upn.toLowerCase() === selfUpn;
        const isLastActiveAdmin = u.role === "admin" && u.status === "active" && activeAdminCount <= 1;
        const locked = isSelf || isLastActiveAdmin;
        const lockedTitle = isSelf
          ? "You can't change your own role or status."
          : isLastActiveAdmin
            ? "This is the last active admin — promote another admin first."
            : undefined;
        const busy = savingId === u.id;
        return (
          <button
            type="button"
            disabled={locked || busy}
            title={
              lockedTitle ??
              (u.status === "active"
                ? "Disable this account — blocks sign-in immediately."
                : "Re-enable this account.")
            }
            onClick={(e) => {
              e.stopPropagation();
              patch.mutate({ id: u.id, body: { status: u.status === "active" ? "disabled" : "active" } });
            }}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${STATUS_STYLE[u.status]}`}
          >
            {busy ? "Saving…" : USER_STATUS_LABELS[u.status]}
          </button>
        );
      },
    },
    {
      key: "lastLogin",
      header: (
        <SortableLabel
          label="Last sign-in"
          sortKey="lastLogin"
          activeKey={sortKey}
          dir={sortDir}
          onSort={onSort}
        />
      ),
      mobileLabel: "Last sign-in",
      cell: (u) => <span className="text-xs">{formatDate(u.lastLoginAt)}</span>,
    },
    {
      key: "invitedBy",
      header: (
        <SortableLabel
          label="Added by"
          sortKey="invitedBy"
          activeKey={sortKey}
          dir={sortDir}
          onSort={onSort}
        />
      ),
      cell: (u) => <span className="text-xs">{u.invitedBy ?? "—"}</span>,
      hideOnMobile: true,
    },
    {
      key: "added",
      header: <SortableLabel label="Added" sortKey="added" activeKey={sortKey} dir={sortDir} onSort={onSort} />,
      mobileLabel: "Added",
      cell: (u) => <span className="text-xs">{formatDate(u.createdAt)}</span>,
    },
    {
      key: "alerts",
      header: "Alerts",
      cell: (u) => {
        const busy = savingId === u.id;
        return (
          <button
            type="button"
            disabled={busy}
            title={
              u.receiveJobAlerts
                ? "Receiving job/sync failure alert emails. Click to opt out."
                : "Not receiving alert emails. Click to opt in."
            }
            onClick={(e) => {
              e.stopPropagation();
              patch.mutate({ id: u.id, body: { receiveJobAlerts: !u.receiveJobAlerts } });
            }}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              u.receiveJobAlerts
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            }`}
          >
            {busy ? "Saving…" : u.receiveJobAlerts ? "On" : "Off"}
          </button>
        );
      },
    },
    ...(demoMode
      ? []
      : [
          {
            key: "readonlyGroup",
            header: "Read-only group (home tenant)",
            cell: (u: User) => {
              const syncing = syncingReadonlyId === u.id;
              const retrying = retryingReadonlyId === u.id;
              if (syncing) {
                return (
                  <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">
                    Syncing…
                  </span>
                );
              }
              if (u.readOnlyGroupSyncedAt) {
                return (
                  <span
                    title={`Confirmed member of ${READONLY_GROUP_NAME} as of ${formatDate(u.readOnlyGroupSyncedAt)}.`}
                    className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                  >
                    Synced
                  </span>
                );
              }
              return (
                <button
                  type="button"
                  disabled={retrying}
                  title={`Not yet confirmed a member of ${READONLY_GROUP_NAME} — click to retry.`}
                  onClick={(e) => {
                    e.stopPropagation();
                    retryReadonlySync.mutate(u.id);
                  }}
                  className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-500/20 dark:text-amber-300"
                >
                  {retrying ? "Retrying…" : "Not synced — retry"}
                </button>
              );
            },
            hideOnMobile: true,
          },
          {
            key: "writeAccess",
            header: "Write access (home tenant)",
            cell: (u: User) => {
              const busy = savingId === u.id && writeTogglePending;
              return (
                <button
                  type="button"
                  disabled={busy}
                  title={
                    u.writeAccessEnabled
                      ? `Member of ${WRITE_GROUP_NAME} in the home tenant. Click to revoke.`
                      : `Not a member of ${WRITE_GROUP_NAME}. Click to grant.`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingWriteAccess(u);
                  }}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    u.writeAccessEnabled
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                      : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                  }`}
                >
                  {busy ? "Working…" : u.writeAccessEnabled ? "On" : "Off"}
                </button>
              );
            },
            hideOnMobile: true,
          },
        ]),
    {
      key: "actions",
      header: "Actions",
      align: "right",
      fullWidthOnMobile: true,
      cell: (u) => {
        const isSelf = u.upn.toLowerCase() === selfUpn;
        const isLastActiveAdmin = u.role === "admin" && u.status === "active" && activeAdminCount <= 1;
        const locked = isSelf || isLastActiveAdmin;
        const lockedTitle = isSelf
          ? "You can't change your own role or status."
          : isLastActiveAdmin
            ? "This is the last active admin — promote another admin first."
            : undefined;
        const busy = savingId === u.id;
        return (
          <div className="inline-flex items-center gap-2">
            <button
              type="button"
              disabled={isSelf || busy}
              title={
                isSelf
                  ? "You can't revoke your own background access."
                  : "Revoke this person's cached background-access session — used by hourly auto-sync and their schedules. Does not disable their account."
              }
              onClick={(e) => {
                e.stopPropagation();
                revoke.mutate(u.id);
              }}
              className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Revoke access
            </button>
            <button
              type="button"
              disabled={locked || busy}
              title={lockedTitle}
              onClick={(e) => {
                e.stopPropagation();
                setPendingDelete(u);
              }}
              className="rounded-md border border-rose-200 px-2.5 py-1 text-xs font-medium text-rose-600 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-500/30 dark:text-rose-400 dark:hover:bg-rose-500/10"
            >
              Remove
            </button>
          </div>
        );
      },
    },
  ];

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
        <p className="text-sm text-slate-500">Three things decide what a person can do:</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-slate-500">
          <li>
            <span className="font-medium text-slate-600">Role</span> — what they can do inside
            PatchPilot itself: dispatch remediations, manage catalogs, change settings. Their
            GDAP roles in Entra separately control which customer tenants they can reach at all.
          </li>
          <li>
            <span className="font-medium text-slate-600">Read-only group (home tenant)</span> —
            every new user is added automatically. It gives PatchPilot's background sync and
            read-only pages something to run as in your own tenant.
          </li>
          <li>
            <span className="font-medium text-slate-600">Write access (home tenant)</span> — an
            explicit toggle below. It grants a person real Microsoft write privilege in the home
            tenant itself; granting or revoking it always needs confirmation from a Global
            Administrator or Privileged Role Administrator.
          </li>
        </ul>
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
            <div className="p-3">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or UPN…"
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 sm:w-80 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500"
              />
            </div>
            {visible.length === 0 ? (
              <div className="p-5 text-sm text-slate-500">No users match "{search}".</div>
            ) : null}
          </>
        )}
      </Card>

      {!isLoading && users.length > 0 && visible.length > 0 && (
        <div className="mt-3">
          <ResponsiveTable columns={userColumns} rows={visible} rowKey={(u) => u.id} />
        </div>
      )}

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

      {pendingWriteAccess && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setPendingWriteAccess(null)}
            aria-hidden
          />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            {pendingWriteAccess.writeAccessEnabled ? (
              <>
                <h2 className="text-base font-semibold text-slate-900">
                  Revoke write access for {pendingWriteAccess.displayName}?
                </h2>
                <p className="mt-2 text-sm text-slate-600">
                  This removes <span className="font-medium text-slate-700">{pendingWriteAccess.upn}</span>{" "}
                  from <strong>{WRITE_GROUP_NAME}</strong> in the home tenant, revoking:
                </p>
                <ul className="mt-2 list-inside list-disc text-sm text-slate-600">
                  {WRITE_GROUP_ROLES.map((role) => (
                    <li key={role}>
                      <strong>{role}</strong>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <h2 className="text-base font-semibold text-slate-900">
                  Grant write access to {pendingWriteAccess.displayName}?
                </h2>
                <p className="mt-2 text-sm text-slate-600">
                  This adds <span className="font-medium text-slate-700">{pendingWriteAccess.upn}</span> to{" "}
                  <strong>{WRITE_GROUP_NAME}</strong> in the home tenant, granting:
                </p>
                <ul className="mt-2 list-inside list-disc text-sm text-slate-600">
                  {WRITE_GROUP_ROLES.map((role) => (
                    <li key={role}>
                      <strong>{role}</strong>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-slate-500">
                  You'll be taken to Microsoft to confirm — this requires your account to be a
                  Global Administrator or Privileged Role Administrator in the home tenant.
                </p>
              </>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingWriteAccess(null)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = pendingWriteAccess;
                  setPendingWriteAccess(null);
                  writeAccessToggle.mutate({ id: target.id, enabled: !target.writeAccessEnabled });
                }}
                className={`rounded-md px-3 py-1.5 text-sm font-medium text-white transition-colors ${
                  pendingWriteAccess.writeAccessEnabled
                    ? "bg-rose-600 hover:bg-rose-500"
                    : "bg-slate-900 hover:bg-slate-700"
                }`}
              >
                {pendingWriteAccess.writeAccessEnabled ? "Revoke write access" : "Continue to Microsoft"}
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
