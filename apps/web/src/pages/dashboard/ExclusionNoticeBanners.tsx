import { Link } from "react-router-dom";
import type { DashboardTiles } from "../../lib/api";
import { toExcludedDevices, toExceptions } from "./links";

const bannerClass =
  "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800";
const linkClass =
  "shrink-0 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100";

/**
 * Surfaces device exclusions and recommendation exceptions at the top of the
 * Dashboard. Both tiles (`excludedDevices`, `activeExceptions`) already existed
 * in the summary payload but were never rendered anywhere — an engineer
 * comparing PatchPilot's counts to the Defender portal had no way to see that
 * the gap was explained by a local exclusion/exception rather than a sync bug.
 *
 * The OpenSSL callout is split out from the general banner because it's
 * expected on nearly every tenant: OpenSSL library findings can't be
 * auto-remediated (the fix ships inside the owning app), so engineers
 * routinely except the whole recommendation, and it's the single most common
 * cause of this kind of confusion.
 */
export function ExclusionNoticeBanners({
  tiles,
  opensslExceptionTenantIds,
  isAllTenants,
  tenantCount,
}: {
  tiles: DashboardTiles;
  opensslExceptionTenantIds: string[];
  isAllTenants: boolean;
  tenantCount: number;
}) {
  const hasExclusions = tiles.excludedDevices > 0;
  const hasExceptions = tiles.activeExceptions > 0;
  const hasOpenssl = opensslExceptionTenantIds.length > 0;

  if (!hasExclusions && !hasExceptions && !hasOpenssl) return null;

  return (
    <div className="mb-4 space-y-2 print:hidden">
      {(hasExclusions || hasExceptions) && (
        <div className={bannerClass}>
          <p>
            {hasExclusions && (
              <>
                <strong>{tiles.excludedDevices}</strong> device{tiles.excludedDevices === 1 ? "" : "s"} excluded
              </>
            )}
            {hasExclusions && hasExceptions && " and "}
            {hasExceptions && (
              <>
                <strong>{tiles.activeExceptions}</strong> recommendation exception
                {tiles.activeExceptions === 1 ? "" : "s"} active
              </>
            )}{" "}
            — hidden from PatchPilot's default counts, which can make them run lower than
            Defender's.
          </p>
          <div className="flex shrink-0 gap-2">
            {hasExclusions && (
              <Link to={toExcludedDevices()} className={linkClass}>
                View excluded devices
              </Link>
            )}
            {hasExceptions && (
              <Link to={toExceptions()} className={linkClass}>
                View exceptions
              </Link>
            )}
          </div>
        </div>
      )}

      {hasOpenssl && (
        <div className={bannerClass}>
          <p>
            An exception is active for the <strong>OpenSSL</strong> security recommendation
            {isAllTenants ? ` on ${opensslExceptionTenantIds.length} of ${tenantCount} tenants` : ""}.
            OpenSSL library findings usually can't be auto-remediated, so this is commonly
            excepted tenant-wide — expect it to explain part of any gap between PatchPilot's and
            Defender's recommendation counts.
          </p>
          <Link to={toExceptions()} className={linkClass}>
            View exception
          </Link>
        </div>
      )}
    </div>
  );
}
