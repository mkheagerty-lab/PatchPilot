/**
 * Friendly operating-system naming.
 *
 * Microsoft hands us machine-readable OS facts — Intune `operatingSystem`
 * ("Windows") + `osVersion` ("10.0.26100.1234") + `skuFamily` ("Enterprise") —
 * which render as the unhelpful "Windows 10.0.26100". MSP engineers think in
 * marketing names ("Windows 11 Pro 24H2", "Windows Server 2022"), so this maps
 * the build number to its feature-update / release name and folds in the edition.
 *
 * Pure and side-effect free so it can be unit-tested against captured device
 * payloads and reused by both the live sync and (if needed) the web layer.
 */

export interface OsInput {
  /** Intune `operatingSystem`, e.g. "Windows", "iOS", "macOS". */
  operatingSystem?: string | null;
  /** Intune `osVersion`, e.g. "10.0.26100" or "10.0.26100.1234". */
  osVersion?: string | null;
  /** Intune `skuFamily`/`skuNumber`-derived edition, e.g. "Enterprise", "Pro". */
  skuFamily?: string | null;
  /**
   * Defender machine `osPlatform`, e.g. "Windows11", "WindowsServer2019". The
   * authoritative server-vs-client signal: Intune reports `operatingSystem` as a
   * bare "Windows" for servers, so without this a Server box misclassifies as a
   * Windows 10/11 client. Absent for Intune-only (Defender-uncovered) devices.
   */
  osPlatform?: string | null;
}

/**
 * Windows 10/11 client builds → feature-update label. Client builds < 22000 are
 * Windows 10; ≥ 22000 are Windows 11. A handful of builds collide with Server
 * (e.g. 26100 = Win 11 24H2 *and* Server 2025), so server detection always wins
 * first via the OS string before this table is consulted.
 */
export const CLIENT_BUILDS: Record<number, string> = {
  // Windows 10
  10240: "1507",
  10586: "1511",
  14393: "1607",
  15063: "1703",
  16299: "1709",
  17134: "1803",
  17763: "1809",
  18362: "1903",
  18363: "1909",
  19041: "2004",
  19042: "20H2",
  19043: "21H1",
  19044: "21H2",
  19045: "22H2",
  // Windows 11
  22000: "21H2",
  22621: "22H2",
  22631: "23H2",
  26100: "24H2",
  26200: "25H2",
};

/** Windows Server builds → release year/name. */
const SERVER_BUILDS: Record<number, string> = {
  14393: "2016",
  17763: "2019",
  20348: "2022",
  25398: "23H2",
  26100: "2025",
};

/** The first build number that marks Windows 11 rather than Windows 10. */
const WINDOWS_11_MIN_BUILD = 22000;

/**
 * Normalises an Intune `skuFamily` to a short edition label, or null when it's
 * absent/unrecognised (in which case we simply omit the edition). Server SKUs
 * are dropped because the "Windows Server <year>" name already conveys the line.
 */
function normalizeEdition(skuFamily?: string | null): string | null {
  const sku = skuFamily?.trim().toLowerCase();
  if (!sku) return null;
  if (sku.includes("server")) return null;
  if (sku.includes("enterprise")) return "Enterprise";
  if (sku.includes("education")) return "Education";
  if (sku.includes("professional") || sku.includes("pro")) return "Pro";
  if (sku.includes("home") || sku.includes("core")) return "Home";
  return null;
}

/** Pulls the build number (third dotted component) out of an osVersion string. */
export function parseBuild(osVersion?: string | null): number | null {
  if (!osVersion) return null;
  const parts = osVersion.split(".");
  const build = Number(parts[2]);
  return Number.isFinite(build) && build > 0 ? build : null;
}

/** Best-effort fallback: the raw join we used before, never empty. */
function rawFallback(input: OsInput): string {
  const joined = [input.operatingSystem, input.osVersion]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join(" ")
    .trim();
  return joined || "Unknown";
}

/**
 * Turns raw OS facts into a human-friendly "Windows 11 Pro 24H2" /
 * "Windows Server 2022" string. Non-Windows or unrecognised inputs fall back to
 * the plain "<operatingSystem> <osVersion>" join so we never show worse than the
 * raw data.
 */
export function formatOs(input: OsInput): string {
  const osName = input.operatingSystem?.trim() ?? "";
  const platform = input.osPlatform?.trim() ?? "";
  // Treat as Windows when either Intune's operatingSystem or Defender's
  // osPlatform says so — Defender covers the case where Intune is absent.
  if (!/windows/i.test(osName) && !/windows/i.test(platform)) {
    // macOS / iOS / Android / Linux: the marketing version already lives in
    // osVersion, so the plain join reads fine ("macOS 14.5", "iOS 17.5").
    return rawFallback(input);
  }

  const build = parseBuild(input.osVersion);
  // Server detection: Intune labels servers a bare "Windows", so the reliable
  // signal is Defender's osPlatform ("WindowsServer2019") or the server SKU.
  const isServer =
    /server/i.test(osName) ||
    /server/i.test(platform) ||
    /server/i.test(input.skuFamily ?? "");

  if (isServer) {
    const release = build != null ? SERVER_BUILDS[build] : undefined;
    if (!release) return rawFallback(input);
    // Append the feature-update label the engineer recognises (Defender/Intune
    // both report e.g. 17763) — "Windows Server 2019 (Build 1809)". Omitted when
    // the build has no client-release label (e.g. 20348 → "Windows Server 2022").
    const serverFeature = build != null ? CLIENT_BUILDS[build] : undefined;
    return serverFeature
      ? `Windows Server ${release} (Build ${serverFeature})`
      : `Windows Server ${release}`;
  }

  if (build == null) return rawFallback(input);

  const line = build >= WINDOWS_11_MIN_BUILD ? "Windows 11" : "Windows 10";
  const edition = normalizeEdition(input.skuFamily);
  const feature = CLIENT_BUILDS[build];

  return [line, edition, feature].filter(Boolean).join(" ");
}

/** The highest build in CLIENT_BUILDS — the default feature-update target when a tenant hasn't set one. */
export function latestClientBuild(): number {
  return Math.max(...Object.keys(CLIENT_BUILDS).map(Number));
}

/** "Windows 10" or "Windows 11" for a client build number, reusing formatOs's own line boundary. */
export function windowsLineForBuild(build: number): string {
  return build >= WINDOWS_11_MIN_BUILD ? "Windows 11" : "Windows 10";
}

/**
 * Resolves a tenant's friendly feature-update target label (e.g. "24H2", as
 * stored in tenants.featureUpdateTargetVersion) to the build number it names.
 * Null/unrecognised labels fall back to latestClientBuild() — a stored label
 * that no longer maps to a CLIENT_BUILDS entry (e.g. a stale value predating a
 * table change) should never silently pin devices to a build 0.
 */
export function resolveTargetBuild(targetVersionLabel?: string | null): number {
  if (!targetVersionLabel) return latestClientBuild();
  const match = Object.entries(CLIENT_BUILDS).find(([, label]) => label === targetVersionLabel);
  return match ? Number(match[0]) : latestClientBuild();
}

/**
 * Whether a device's formatted `os` string (devices.os, e.g. "Windows 11 Pro
 * 24H2") is a Windows 10/11 client — true for a workstation, false for Server
 * or non-Windows. Feature-update campaigns are client-only: Server has
 * different upgrade mechanics and is out of scope.
 */
export function isClientWindows(os?: string | null): boolean {
  const s = (os ?? "").trim();
  if (!/^windows\b/i.test(s)) return false;
  return !/^windows server\b/i.test(s);
}

/**
 * The one predicate the Devices badge, the Dashboard tile, and the
 * /api/feature-updates/fix guard all call: is this device both eligible
 * (client Windows) and strictly behind the resolved target build? A device
 * with no osBuild yet (never synced, or non-Windows) is never "behind" —
 * there's nothing to compare.
 */
export function isDeviceBehindFeatureUpdate(
  osBuild: number | null | undefined,
  os: string | null | undefined,
  targetBuild: number,
): boolean {
  if (!isClientWindows(os)) return false;
  if (osBuild == null) return false;
  return osBuild < targetBuild;
}

/**
 * Windows-branded products that ship and patch independently of the OS, so a
 * finding against them is an *application* finding (winget-remediable), not an
 * OS finding — despite the title starting with "Windows".
 */
const WINDOWS_APP_EXCEPTIONS =
  /^windows (terminal|app sdk|subsystem|admin center|package manager|installer|defender)\b/i;

/**
 * Whether a vulnerability finding or inventory title targets the Windows OS
 * itself, or a Microsoft security-platform component serviced the same way —
 * patched via Windows Update / the Defender platform updater — rather than an
 * installed application patched via winget/Chocolatey (or another app
 * channel).
 *
 * This is the live app-vs-OS classifier the coverage + remediation +
 * inventory-matching paths use to separate "package-manager-applicable"
 * findings from ones that are out of scope by nature regardless of catalog
 * contents. We must derive this live rather than trust the stored
 * `wingetRemediable` flag, which is frozen at sync time and conflates "is an
 * app" with "has a catalog match".
 *
 * Defender TVM reports OS findings under software titles like "Microsoft
 * Windows", "Windows 10/11", or "Windows Server 2019"; device software
 * inventory reports Defender's own components under titles like "Microsoft
 * Windows Defender" or "Microsoft Defender for Endpoint" — none of these are
 * independently winget/Chocolatey-installable, and fuzzy-matching them against
 * an unrelated catalog package (e.g. a third-party "disable Defender" utility,
 * or a Defender diagnostic tool) produces a confidently wrong match rather
 * than the correct "no package source" result. We match those shapes while
 * excluding Windows-branded applications (Terminal, App SDK, Subsystem for
 * Linux, …) that are updated independently of the OS.
 */
export function isOsFinding(software: string | null | undefined): boolean {
  const s = (software ?? "").trim().toLowerCase();
  if (!s) return false;
  if (WINDOWS_APP_EXCEPTIONS.test(s)) return false;
  return (
    /^microsoft windows\b/.test(s) ||
    /^windows (10|11|7|8|8\.1|server|vista|xp)\b/.test(s) ||
    /^windows server\b/.test(s) ||
    /^microsoft defender\b/.test(s)
  );
}
