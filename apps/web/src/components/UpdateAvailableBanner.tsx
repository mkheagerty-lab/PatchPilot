import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type UpdatesSettingsView } from "../lib/api";

const DISMISS_KEY = "pp:update-dismissed";

/**
 * Global "a new PatchPilot version is available" banner (Settings > Updates).
 * Mounted once in App.tsx's Layout(), not page-scoped like
 * pages/dashboard/ExclusionNoticeBanners.tsx (whose amber styling this
 * reuses for visual consistency).
 *
 * Dismissal is keyed by version, not a boolean: dismissing v0.2.0 hides the
 * banner only until something newer than v0.2.0 is available, so it neither
 * nags forever nor goes silent forever across future releases.
 */
export function UpdateAvailableBanner() {
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });

  const { data } = useQuery({
    queryKey: ["settings", "updates"],
    queryFn: () => api.get<UpdatesSettingsView>("/api/settings/updates"),
    refetchInterval: 15 * 60_000,
    // A missing permission (settings:read) or a transient network error
    // shouldn't spam retries for a banner nobody's actively watching.
    retry: false,
  });

  if (!data?.updateAvailable || !data.latestVersion) return null;
  if (dismissedVersion === data.latestVersion) return null;

  function dismiss() {
    const version = data!.latestVersion!;
    try {
      localStorage.setItem(DISMISS_KEY, version);
    } catch {
      // Best-effort — worst case the banner reappears next load.
    }
    setDismissedVersion(version);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 print:hidden">
      <p>
        PatchPilot v{data.latestVersion} is available (you're on v{data.currentVersion}).
      </p>
      <div className="flex shrink-0 items-center gap-3">
        <Link
          to="/settings/updates"
          className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
        >
          View details
        </Link>
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="text-amber-500 hover:text-amber-700"
        >
          ×
        </button>
      </div>
    </div>
  );
}
