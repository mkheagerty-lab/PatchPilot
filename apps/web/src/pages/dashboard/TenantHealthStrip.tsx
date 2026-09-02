import { Link } from "react-router-dom";
import type { DashboardScope, Tenant } from "../../lib/api";

const STALE_HOURS = 24;
const MS_PER_HOUR = 3_600_000;

/** "4h ago" / "3d ago" — coarse enough for a one-line strip, exported for
 * ActivityFeedCard's row timestamps too. */
export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TenantHealthStrip({
  scope,
  isAllTenants,
  activeTenant,
}: {
  scope: DashboardScope;
  isAllTenants: boolean;
  activeTenant: Tenant | null;
}) {
  let label: string;
  let stale: boolean;

  if (isAllTenants) {
    label = `${scope.reachable} reachable · ${scope.stale} stale · ${scope.neverSynced} never synced`;
    stale = scope.stale > 0 || scope.neverSynced > 0;
  } else if (activeTenant) {
    const synced = activeTenant.lastSyncedAt;
    stale = !synced || Date.now() - new Date(synced).getTime() > STALE_HOURS * MS_PER_HOUR;
    label = `${activeTenant.displayName} · synced ${synced ? relativeTime(synced) : "never"}${
      activeTenant.readOnly ? " · read-only" : ""
    }`;
  } else {
    label = "Select a tenant to view posture";
    stale = false;
  }

  return (
    <Link
      to="/settings/tenants"
      className={`mb-4 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
        stale
          ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      }`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stale ? "bg-rose-500" : "bg-emerald-500"}`} />
      {label}
    </Link>
  );
}
