/**
 * Maps MDVM software titles to Winget package ids.
 *
 * Defender reports a free-text software title (e.g. "Mozilla Firefox (x64 en-US)
 * 126.0") that has to be resolved to a stable Winget package id ("Mozilla.Firefox")
 * before PatchPilot can generate an upgrade. This module is pure and deterministic
 * so it is fully unit-testable and runs identically in demo and production.
 */

/** A catalog entry — mirrors the `winget_catalog` table / demo fixtures. */
export interface WingetCatalogEntry {
  packageId: string;
  name: string;
  publisher: string;
  latestVersion?: string | null;
  /** The canonical MDVM software title this package maps to, if known. */
  softwareTitle?: string | null;
}

export interface WingetMatch {
  packageId: string;
  name: string;
  /** 0..1 — 1 is an exact normalized-title match (or a manual override). */
  confidence: number;
  /** How the match was made, for surfacing in the UI / audit. */
  method: "manual" | "exact" | "contains" | "token-overlap";
}

/**
 * An engineer-authored pin from a software title to a winget package, overriding
 * the fuzzy matcher. Mirrors the `winget_catalog_override` table. Callers resolve
 * scope (tenant-specific beats global) before passing these to `matchWinget` —
 * earlier entries win, so order tenant-scoped overrides ahead of global ones.
 */
export interface WingetOverride {
  softwareTitle: string;
  packageId: string;
}

/** Architecture / locale / packaging noise to drop from a software title. */
const NOISE_TOKENS = new Set([
  "x64",
  "x86",
  "x32",
  "arm64",
  "amd64",
  "bit",
  "32bit",
  "64bit",
  "win32",
  "win64",
  "version",
  "edition",
  "setup",
  "installer",
  "msi",
  "enus",
  "release",
]);

/**
 * Reduces a software title to a comparable token signature: lowercase, no
 * parenthetical/bracketed segments, no version numbers, no architecture/locale
 * noise, punctuation collapsed to spaces.
 *
 * Uses Unicode letter/number classes (`\p{L}`/`\p{N}`) rather than `[a-z0-9]`
 * when stripping punctuation — an ASCII-only class would delete every
 * character of a non-Latin title (CJK, Cyrillic, etc.) outright, collapsing
 * e.g. "B站录播姬" down to the single leftover letter "b". That degenerate
 * one-character signature then spuriously substring-matches almost any other
 * title (anything containing the letter "b"), causing unrelated software to
 * be misidentified via `matchWinget`'s "contains" rule.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // (x64 en-US)
    .replace(/\[[^\]]*\]/g, " ") // [bundle]
    // version numbers: 126.0, v1_2_3, v8.6.2 — must be v-prefixed or carry a
    // separator so a digit that's part of a name (e.g. "7-Zip") is preserved.
    .replace(/\b(?:v\d+(?:[._]\d+)*|\d+(?:[._]\d+)+)\b/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ") // punctuation -> space (Unicode-aware)
    .split(/\s+/)
    .filter((tok) => tok && !NOISE_TOKENS.has(tok))
    .join(" ")
    .trim();
}

/**
 * Best-effort friendly display title for a raw Defender product name.
 *
 * Defender reports machine-readable product names ("visual_studio_code",
 * "firefox") that read poorly in a UI. When a finding resolves to a winget
 * package we prefer the curated catalog `name`; this is the fallback for
 * everything else — it un-snakes and title-cases the raw token so the
 * Vulnerabilities table shows "Visual Studio Code" rather than
 * "visual_studio_code". Purely cosmetic and deterministic; hyphens (e.g.
 * "7-zip") and existing capitalisation are preserved.
 */
export function prettifySoftwareTitle(raw: string): string {
  const cleaned = raw.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return raw;
  return cleaned
    .split(" ")
    .map((word) =>
      word.length <= 1
        ? word.toUpperCase()
        : word[0]!.toUpperCase() + word.slice(1),
    )
    .join(" ");
}

/**
 * Capitalises the first *alphabetic* character of a token, preserving any leading
 * punctuation and the rest of the token's existing casing. Unlike a naive
 * `word[0].toUpperCase()`, this turns ".net" into ".Net" (not ".net") and leaves
 * pure digit/punctuation tokens ("11", "2019") untouched.
 */
function capitalizeToken(word: string): string {
  if (!word) return word;
  const idx = word.search(/[a-z]/i);
  if (idx === -1) return word; // pure digits / punctuation
  return word.slice(0, idx) + word[idx]!.toUpperCase() + word.slice(idx + 1);
}

/** Un-snakes ("windows_11" -> "windows 11") and title-cases each token. */
function titleCaseTokens(raw: string): string {
  const cleaned = raw.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.split(" ").map(capitalizeToken).join(" ");
}

/**
 * True when a string contains characters from a script an English-reading MSP
 * engineer can't sound out — CJK ideographs, kana, Hangul, Cyrillic, Arabic,
 * Hebrew, Thai, and CJK full-width forms. Defender reports software/CVE product
 * names verbatim from its catalog, so a vendor that registered a product under
 * (say) a Chinese name shows that name regardless of the device's OS locale.
 * We use this only to decide whether a name needs an English anchor alongside
 * it — we never rewrite or drop the source name.
 */
export function hasNonLatinScript(str: string): boolean {
  return /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯Ѐ-ӿ؀-ۿ֐-׿฀-๿]/.test(
    str,
  );
}

/**
 * Curated English hints for non-Latin product names Defender reports verbatim.
 * Keyed by the distinctive foreign substring (matched anywhere in the name so it
 * survives any vendor-prefixing in {@link friendlyProductName}). This is a
 * hand-maintained allow-list — there is no translation engine — so add rows as
 * unfamiliar names surface in the field. The hint annotates, never replaces: the
 * authoritative Defender/NVD name is always kept so it stays cross-referenceable.
 */
const FOREIGN_NAME_HINTS = new Map<string, string>([
  ["B站录播姬", "Bilibili Live Recorder"],
  ["乐启office工具箱", "LeQi Office Toolbox"],
]);

/**
 * Appends a parenthetical English hint to a non-Latin product name when we have
 * a curated one — e.g. "B站录播姬" -> "B站录播姬 (Bilibili Live Recorder)". The
 * source name is preserved verbatim; this is purely an added anchor. Idempotent
 * (won't double-append) and a no-op for Latin names or names we have no hint for.
 */
export function annotateForeignName(name: string): string {
  const raw = (name ?? "").trim();
  if (!raw || !hasNonLatinScript(raw)) return name;
  for (const [foreign, hint] of FOREIGN_NAME_HINTS) {
    if (raw.includes(foreign) && !raw.includes(hint)) return `${name} (${hint})`;
  }
  return name;
}

/**
 * Vendor-prefixed friendly display name for a Defender recommendation's product.
 *
 * Defender's `/recommendations` feed reports machine-readable product slugs
 * ("chrome", "windows_11", ".net_core") alongside a separate vendor token
 * ("google", "microsoft"). MSP engineers want the marketing name — "Google
 * Chrome", "Microsoft Windows 11", "Microsoft .Net Core" — so a bare slug is
 * un-snaked, title-cased, and prefixed with the (title-cased) vendor unless the
 * product already leads with it.
 *
 * Names that already look human ("Mozilla Firefox", "7-Zip" — they contain a
 * space or an uppercase letter) are passed through untouched so this stays
 * idempotent over curated data. Non-Latin names get a curated English hint
 * appended (see {@link annotateForeignName}). Purely cosmetic and deterministic.
 */
export function friendlyProductName(productName: string, vendor?: string | null): string {
  return annotateForeignName(baseFriendlyProductName(productName, vendor));
}

function baseFriendlyProductName(productName: string, vendor?: string | null): string {
  const raw = (productName ?? "").trim();
  if (!raw) return vendor?.trim() ? titleCaseTokens(vendor) : raw;

  // Only normalise bare machine-readable slugs; leave already-friendly names be.
  const isSlug = !/[A-Z]/.test(raw) && !/\s/.test(raw);
  if (!isSlug) return raw;

  const product = titleCaseTokens(raw);
  const vendorName = vendor?.trim() ? titleCaseTokens(vendor) : "";
  if (!vendorName) return product;

  // Avoid "Google Google Chrome" when the slug already begins with the vendor.
  const firstProductTok = product.split(" ")[0]?.toLowerCase() ?? "";
  const firstVendorTok = vendorName.split(" ")[0]?.toLowerCase() ?? "";
  if (firstProductTok === firstVendorTok) return product;

  return `${vendorName} ${product}`;
}

/**
 * Unambiguous raw Defender `software` titles mapped straight to their
 * vendor-prefixed marketing name — each is a hand-confirmed 1:1 alias, not a
 * heuristic, so no evidence check is needed (contrast with "Chromium" below).
 * Add rows here as unfamiliar Defender titles surface in the field, citing the
 * CVE that prompted the addition so the mapping stays auditable:
 *  - "pje-office" -> "Microsoft Office" (CVE-2026-55120)
 *  - "MiTeam Meetings" -> "Zoom Meetings" (CVE-2025-49457)
 *  - "Meetings" -> "Zoom Meetings" (engineer-confirmed field alias, 2026-07)
 *  - "Computing Improvement Program" -> "Intel Computing Improvement Program"
 *    (vendor-prefixed passthrough, not a rename — this is a distinct Intel
 *    telemetry product, not an alias for Intel Driver & Support Assistant,
 *    which the map previously and incorrectly pointed to. Confirmed against
 *    the Defender portal directly: CVE-2025-24299 and its siblings list
 *    "Intel Computing Improvement Program" as both Related component and
 *    Affected software, never IDSA (engineer-corrected 2026-08, after the
 *    2026-07 alias was found to conflate the two products))
 *  - "Chrome" -> "Google Chrome" (Defender's own inventory title for the
 *    browser is the bare "Chrome"; unlike "Chromium" this is never used for
 *    Edge or any other Chromium-embedding app, so it's safe to alias
 *    outright rather than routing through the disk-path heuristic below)
 *  - "Agilebits 1Password" -> "1Password" (Defender reports Microsoft
 *    Store/AppX-installed 1Password with the publisher folded into the
 *    title; normalised that's the 2-token "agilebits 1password" against the
 *    catalog's single distinctive token "1password", which never clears
 *    {@link isCredibleOverlap}'s both-sides-2-tokens guard — the same guard
 *    that correctly rejects "meetings" above. Result: `matchWinget` silently
 *    returned null and the device's Inventories tab showed no available
 *    update at all for an install that was two major versions behind
 *    (engineer-confirmed field alias, 2026-08))
 *  - "Windows 11 Fixer" -> "Windows 11" (CVE-2026-62727; same OS-misattribution
 *    pattern as "asix windows 11..." below — zero disk/registry evidence
 *    across every affected device, confirming it's the OS CVE filed under a
 *    stray publisher-supplied component title, not a real third-party app
 *    despite the "99natmar99" publisher on the raw Defender row)
 */
const UNAMBIGUOUS_DISPLAY_NAMES = new Map<string, string>([
  ["chrome", "Google Chrome"],
  ["chromedriver", "Google Chrome"],
  ["pje-office", "Microsoft Office"],
  ["miteam meetings", "Zoom Meetings"],
  ["meetings", "Zoom Meetings"],
  ["computing improvement program", "Intel Computing Improvement Program"],
  ["asix windows 11 64-bit hlk/whck drivers setup program", "Windows 11"],
  ["agilebits 1password", "1Password"],
  ["windows 11 fixer", "Windows 11"],
]);

/**
 * Raw Defender `software` titles that are genuinely the OS itself, filed
 * under a driver/component name in the raw `SoftwareVulnerabilitiesByMachine`
 * feed instead of "Microsoft Windows 11" (confirmed against Defender's own
 * Software inventory page for the same device, which lists it as "Windows 11" —
 * CVE-2026-45602). Renamed via {@link UNAMBIGUOUS_DISPLAY_NAMES} above; also
 * drives {@link isOsMisattributedSoftware} so per-device UI can show a
 * dedicated "OS" scope instead of a meaningless per-user/machine-wide
 * install-scope guess for these rows.
 */
const OS_MISATTRIBUTED_SOFTWARE = new Set<string>([
  "asix windows 11 64-bit hlk/whck drivers setup program",
]);

export function isOsMisattributedSoftware(software: string): boolean {
  return OS_MISATTRIBUTED_SOFTWARE.has(software.trim().toLowerCase());
}

/**
 * Applies the {@link UNAMBIGUOUS_DISPLAY_NAMES} aliases to a raw title before
 * it's used as a matcher target, so a raw Defender title like "Chrome" is
 * matched against the catalog as "Google Chrome" instead of falling through
 * to "not supported" on the single-generic-token guards in
 * {@link isCredibleContainment}/{@link isCredibleOverlap}. Deliberately
 * narrower than {@link resolveDisplaySoftwareName} — it never touches that
 * function's ambiguous Chromium/disk-path branch, so unlike that function
 * it's safe to feed straight into matching (winget and Chocolatey both call
 * this on their match target and on override titles, so a stored override
 * compares equal regardless of whether it was saved under the raw or the
 * aliased title).
 */
export function resolveMatchingTitle(title: string): string {
  const alias = UNAMBIGUOUS_DISPLAY_NAMES.get(title.trim().toLowerCase());
  return alias ?? title;
}

/**
 * Curated, evidence-aware display name for a Defender-reported vulnerability's
 * `software` field, for CVE-drill-down UI only — never for matching, storage,
 * or the `(tenantId, defenderMachineId, cveId, software)` grain, which must
 * stay keyed on the raw Defender value so distinct-but-related products
 * (Edge/Chrome/a CEF-embedding app) don't collapse into one row.
 *
 * - {@link UNAMBIGUOUS_DISPLAY_NAMES} entries are unambiguous: each Defender
 *   title only ever refers to one real product, so they're swapped outright.
 * - "Chromium" is genuinely ambiguous — both Microsoft Edge and Google Chrome
 *   are Chromium-based and can share CVEs. We use `device_vulnerabilities`
 *   disk-path evidence to disambiguate when we have it (an msedge.exe or
 *   chrome.exe path on disk); with no path evidence (e.g. reported as an
 *   OS/registry component) we default to Microsoft Edge, since it ships as
 *   part of Windows and is by far the more common source of a path-less
 *   Chromium finding.
 */
export function resolveDisplaySoftwareName(
  software: string,
  diskPaths?: readonly string[] | null,
): string {
  const norm = software.trim().toLowerCase();
  const unambiguous = UNAMBIGUOUS_DISPLAY_NAMES.get(norm);
  if (unambiguous) return unambiguous;
  if (norm === "chromium") {
    const paths = (diskPaths ?? []).join(" ").toLowerCase();
    if (paths.includes("chrome.exe") || paths.includes("google\\chrome") || paths.includes("google/chrome")) {
      return "Google Chrome";
    }
    return "Microsoft Edge (Chromium-based)";
  }
  return software;
}

/** Per-user install evidence: `HKEY_USERS\...`, `HKEY_CURRENT_USER\...`, or a path under `C:\Users\<user>\...`. */
function isPerUserEvidence(path: string): boolean {
  const p = path.toLowerCase();
  return p.includes("hkey_users") || p.includes("hkey_current_user") || /(^|[\\/])users[\\/]/.test(p);
}

/** Machine-wide install evidence: `HKEY_LOCAL_MACHINE\...`, `Program Files`, or `ProgramData`. */
function isMachineWideEvidence(path: string): boolean {
  const p = path.toLowerCase();
  return p.includes("hkey_local_machine") || p.includes("program files") || p.includes("programdata");
}

/**
 * Whether Defender's Software Evidence for a finding points to a per-user
 * install (registered under the interactively logged-on user's profile/hive,
 * invisible to a SYSTEM-context winget) or a machine-wide one.
 *
 * Live Response has no user-context execution mode at all — scripts only ever
 * run as SYSTEM — and SYSTEM-context winget enforces machine scope, so it
 * cannot correlate against packages that only registered under
 * `HKCU\...\Uninstall` or a per-user `C:\Users\<user>\...` install path.
 * Defender's `diskPaths`/`registryPaths` evidence usually makes the install
 * type unambiguous: `C:\Users\...` / `HKEY_USERS\...` means per-user,
 * `C:\Program Files...` / `HKEY_LOCAL_MACHINE\...` means machine-wide.
 *
 * `"machine"` wins over `"user"` when evidence for both is present — that
 * means at least one machine-wide registration exists for winget to find,
 * even if a per-user copy also lingers. Only when *every* path is per-user
 * evidence (and none is machine-wide) do we call it `"user"`. No evidence at
 * all is `"unknown"`.
 *
 * This is diagnostic and routing signal ONLY — server-side callers use it to
 * write a clearer failure message and to decide whether to route to a
 * curated alt source. It must never become a pre-flight/runtime gate inside
 * the winget script itself: an earlier version of
 * {@link wingetLiveResponseLibraryScript} gated on "winget list can't see the
 * app" as a per-user proxy and that fired a false positive on Remote Desktop
 * Manager, a machine-wide install winget simply hadn't indexed yet.
 */
export type InstallScope = "machine" | "user" | "unknown" | "os";

export function detectInstallScope(
  diskPaths?: readonly string[] | null,
  registryPaths?: readonly string[] | null,
): InstallScope {
  const evidence = [...(diskPaths ?? []), ...(registryPaths ?? [])];
  let sawUser = false;
  let sawMachine = false;
  for (const path of evidence) {
    if (isMachineWideEvidence(path)) sawMachine = true;
    else if (isPerUserEvidence(path)) sawUser = true;
  }
  if (sawMachine) return "machine";
  if (sawUser) return "user";
  return "unknown";
}

/**
 * Whether Defender's Software Evidence for a finding shows a Microsoft Store
 * (UWP/MSIX) install rather than a traditional Win32 one: a disk path under
 * `...\WindowsApps\...`, a registry path under the AppModel per-user
 * package registration hive (`...\Microsoft\Windows\CurrentVersion\
 * AppModel\...`), or (live-verified against BLACK IRON — Defender doesn't
 * always report a real file path for MSIX packages) a "Microsoft Store:
 * Get-AppxPackage ..." descriptor string standing in for one.
 *
 * Deliberately independent of {@link detectInstallScope}'s machine/user
 * precedence chain rather than folded into it: a Store install's disk path
 * (`C:\Program Files\WindowsApps\...`) contains "program files" and would
 * false-positive-match {@link isMachineWideEvidence} if this check reused
 * that same evidence walk instead of its own dedicated one.
 */
export function detectMicrosoftStoreInstall(
  diskPaths?: readonly string[] | null,
  registryPaths?: readonly string[] | null,
): boolean {
  const evidence = [...(diskPaths ?? []), ...(registryPaths ?? [])];
  return evidence.some((path) => {
    const p = path.toLowerCase();
    return (
      p.includes("windowsapps") ||
      p.includes("currentversion\\appmodel") ||
      p.includes("microsoft store:") ||
      p.includes("get-appxpackage")
    );
  });
}

/**
 * Compares two winget version strings, returning <0, 0, or >0 like a sort
 * comparator. winget versions are free-form strings (not guaranteed semver), so
 * we split on the usual separators and compare segment-by-segment: numerically
 * where both segments parse as integers, lexically otherwise. Missing trailing
 * segments count as "0" so "1.2" < "1.2.1".
 *
 * Lives in shared (not the API's mirror module) because both the catalog
 * ingestion — picking the highest version per package — and remediation gating —
 * deciding whether the catalog can reach a required version — need it, and it is
 * pure and deterministic so it is fully unit-testable.
 */
export function compareWingetVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? "0";
    const sb = pb[i] ?? "0";
    const aNum = /^\d+$/.test(sa);
    const bNum = /^\d+$/.test(sb);
    if (aNum && bNum) {
      const na = Number.parseInt(sa, 10);
      const nb = Number.parseInt(sb, 10);
      if (na !== nb) return na - nb;
    } else {
      const c = sa.localeCompare(sb);
      if (c !== 0) return c;
    }
  }
  return 0;
}

/**
 * Aligns two version strings for side-by-side display when they're the same
 * version but with a different number of trailing-zero segments — e.g. a
 * device-reported "7.1.43453.0" vs. a catalog's "7.1.43453". Without this
 * they read as mismatched to an engineer even though `compareWingetVersions`
 * already treats them as equal (missing trailing segments count as "0").
 * Pads whichever string has fewer dot-separated segments with trailing ".0"s
 * to match the other's length, preserving the longer string's precision
 * rather than truncating a real reported digit. Versions that aren't
 * actually equal (per `compareWingetVersions`) are returned unchanged.
 */
export function alignVersionDisplay(
  detected: string | null | undefined,
  latest: string | null | undefined,
): { detected: string | null | undefined; latest: string | null | undefined } {
  if (!detected || !latest) return { detected, latest };
  if (compareWingetVersions(detected, latest) !== 0) return { detected, latest };
  const dLen = detected.split(/[.\-+]/).length;
  const lLen = latest.split(/[.\-+]/).length;
  if (dLen === lLen) return { detected, latest };
  if (dLen > lLen) return { detected, latest: latest + ".0".repeat(dLen - lLen) };
  return { detected: detected + ".0".repeat(lLen - dLen), latest };
}

/**
 * Whether the winget catalog's `latest` version can satisfy a `target` version
 * a finding needs to be remediated (Defender's recommendedVersion):
 *  - "ready"   — latest >= target: a winget upgrade reaches (or exceeds) the fix.
 *  - "behind"  — latest <  target: the catalog hasn't published the fixed version
 *                yet, so a winget upgrade would NOT close the finding.
 *  - "unknown" — either side is missing/blank, so we can't make the call.
 *
 * Used to gate remediation so PatchPilot never offers a winget upgrade that
 * silently leaves the vulnerability open.
 */
export type WingetVersionGate = "ready" | "behind" | "unknown";

export function wingetVersionGate(
  latest: string | null | undefined,
  target: string | null | undefined,
): WingetVersionGate {
  const l = latest?.trim();
  const t = target?.trim();
  if (!l || !t) return "unknown";
  return compareWingetVersions(l, t) >= 0 ? "ready" : "behind";
}

function tokens(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

interface IndexedCandidate {
  normalized: string;
  tokenSet: Set<string>;
}

interface IndexedCatalogEntry {
  entry: WingetCatalogEntry;
  candidates: IndexedCandidate[];
}

/**
 * Per-entry normalization (regex-heavy {@link normalizeTitle}, twice per entry)
 * is the expensive part of {@link matchWinget}. Callers that resolve many titles
 * against the same catalog in one request — `/api/vulnerabilities` calls
 * `matchWinget` once per vulnerability row, all against the same catalog array —
 * were redoing that normalization from scratch on every single call, turning an
 * O(catalog) cost into O(rows * catalog) and blocking the event loop for minutes
 * on a full-size mirror (~14k packages) against a few thousand rows.
 *
 * Cached by catalog array identity so it's computed once per distinct catalog
 * (e.g. once per `buildWingetMatcher()` call, reused across every row it
 * resolves) and freed automatically once that array is no longer referenced.
 */
const catalogIndexCache = new WeakMap<readonly WingetCatalogEntry[], IndexedCatalogEntry[]>();

function getIndexedCatalog(catalog: readonly WingetCatalogEntry[]): IndexedCatalogEntry[] {
  const cached = catalogIndexCache.get(catalog);
  if (cached) return cached;

  const indexed = catalog.map((entry) => ({
    entry,
    candidates: [entry.softwareTitle, entry.name]
      .filter((c): c is string => Boolean(c))
      .map(normalizeTitle)
      .filter(Boolean)
      .map((normalized) => ({ normalized, tokenSet: tokens(normalized) })),
  }));
  catalogIndexCache.set(catalog, indexed);
  return indexed;
}

/** Jaccard overlap of two token sets (0..1). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** The minimum token-overlap score to consider a fuzzy match credible. */
export const MATCH_THRESHOLD = 0.5;

/**
 * Whether a substring-containment match between two normalized titles is
 * trustworthy enough for the "contains" rule (confidence 0.8).
 *
 * A raw `includes()` check alone lets a short, generic normalized string
 * (e.g. a catalog entry that normalizes to the bare word "office") falsely
 * "contain-match" any unrelated longer title that happens to include that
 * word (e.g. "Ability Office 8 Professional", a SoftMaker product with no
 * relation to Microsoft Office). Guard: whichever side is the *contained*
 * one (the substring, not the container) must carry at least two tokens —
 * a single generic word is never enough on its own. Multi-word substrings
 * ("google chrome" inside "google chrome for business") still pass.
 */
function isCredibleContainment(cand: string, target: string): boolean {
  if (cand.includes(target)) return tokens(target).size >= 2;
  if (target.includes(cand)) return tokens(cand).size >= 2;
  return false;
}

/**
 * Whether a token-overlap ("Jaccard") score is credible enough for the
 * "token-overlap" rule, given the token sets it was computed from.
 *
 * The same single-generic-word problem that {@link isCredibleContainment}
 * guards against on the substring path reappears here, and it is the *only*
 * way a single-token side can ever clear {@link MATCH_THRESHOLD} at all: for
 * `jaccard = intersection / union` to reach 0.5 with a 1-token side, the
 * other side must be exactly 2 tokens (intersection <= 1, so
 * `union = a + b - intersection <= 2*intersection` forces `a + b <= 3`).
 * Any 1-token side paired with a 3+ token side always scores below 0.5 on its
 * own, so this guard only ever removes that exact boundary case — a bare word
 * like "meetings" landing on a two-word catalog entry like "Dialpad Meetings"
 * for a Zoom finding whose Defender-reported title normalises to one token —
 * and never narrows a genuine multi-token overlap.
 */
function isCredibleOverlap(targetTokens: ReadonlySet<string>, candTokens: ReadonlySet<string>): boolean {
  return targetTokens.size >= 2 && candTokens.size >= 2;
}

/**
 * Whether `base` is the package that `variant` is a variant *of* — i.e. their
 * ids agree segment for segment and `variant` merely carries more segments.
 * `Google.Chrome` is the base of `Google.Chrome.EXE`; `Mozilla.Firefox.ESR` is
 * the base of `Mozilla.Firefox.ESR.ne-NP`.
 *
 * Deliberately narrow. It is tempting to rank tied ids by segment count or
 * length outright, but measured against the live catalog that misfires on ids
 * which merely *look* alike after normalisation:
 *
 *   - `Notepad++.Notepad++` vs `ndd.Notepad--` — punctuation is stripped, so both
 *     normalise to "notepad". Two unrelated products; "shortest id wins" would
 *     answer a Notepad++ finding with Notepad--.
 *   - `Microsoft.DotNet.AspNetCore.10` vs `.5` — version numbers are stripped, so
 *     all seven runtime majors collide. Same segment count, and the shorter id is
 *     the *older* runtime.
 *   - `Microsoft.DotNet.Framework.DeveloperPack.4.5` vs `..._4` — likewise.
 *
 * Segment-prefix leaves all three alone: none of those pairs is a prefix of the
 * other, so the incumbent stands and the matcher behaves exactly as it did.
 */
function isVariantOf(variant: string, base: string): boolean {
  const v = variant.split(".");
  const b = base.split(".");
  if (b.length >= v.length) return false;
  return b.every((seg, i) => seg === v[i]);
}

/**
 * Whether `next` should displace the incumbent `best`.
 *
 * Confidence first, as before. What's new is everything after it: the old test
 * was a bare `match.confidence > best.confidence`, so a tie kept whichever entry
 * the catalog happened to iterate first — and ties are the *normal* case here,
 * not an edge case. `normalizeTitle` strips parentheticals, so the winget repo's
 * packaging and channel variants ("Google Chrome (EXE)", "Mozilla Firefox" for
 * `Mozilla.Firefox.de`) reduce to exactly the same signature as the base package
 * and all match at confidence 1.0. Measured against the live catalog, 102 entries
 * normalise to "mozilla firefox", 103 to "mozilla firefox esr", 39 to "ffmpeg".
 *
 * That is how a real Live Response job came to target `Google.Chrome.EXE` on a
 * device carrying Chrome under `Google.Chrome`: `winget list --id
 * Google.Chrome.EXE --exact` found nothing, and the upgrade failed with
 * 0x8A150014 (NO_APPLICATIONS_FOUND). The remediation script was correct
 * throughout — it was handed the wrong package id.
 *
 * So a tie falls to the base package when one candidate is demonstrably a
 * variant of the other, because that is the id a device actually registers
 * unless it deliberately installed the variant.
 *
 * Ties between *unrelated* ids fall to whichever candidate's token set
 * overlaps more with the target's — a specificity score, not an identity
 * relationship, so it's safe where {@link isVariantOf}'s id-shape heuristics
 * are not. This is what catches "Google Chrome Remote Desktop Host" landing
 * on `Microsoft.RemoteDesktopClient` ("Remote Desktop", a 2-token containment
 * match at the same 0.8 confidence as the correct, more specific
 * `Google.ChromeRemoteDesktopHost`, "Chrome Remote Desktop Host", 4 tokens) —
 * the two ids share no dotted-segment prefix, so `isVariantOf` never applies
 * and the old code fell back to arbitrary catalog row order. Ties where both
 * sides normalise identically to the target (the Notepad++/Notepad-- case
 * `isVariantOf`'s JSDoc describes) score equal specificity too, so those stay
 * order-dependent exactly as before — this only resolves cases where the
 * candidates are genuinely distinguishable on overlap.
 */
function isBetterMatch(
  next: WingetMatch,
  best: WingetMatch | null,
  nextSpecificity: number,
  bestSpecificity: number,
): boolean {
  if (!best) return true;
  if (next.confidence !== best.confidence) return next.confidence > best.confidence;
  if (isVariantOf(best.packageId, next.packageId)) return true;
  if (isVariantOf(next.packageId, best.packageId)) return false;
  return nextSpecificity > bestSpecificity;
}

/**
 * `matchWinget` results, cached by catalog array identity then by a
 * `(title, overrides)` key. Real callers resolve a handful of distinct
 * software titles across thousands of rows — 3994 vulnerability rows on a
 * live tenant carried only 38 distinct titles — so most calls within one
 * `buildWingetMatcher()`-scoped request are exact repeats of an earlier call
 * against the same catalog. `overrides` is rebuilt fresh per call (it's
 * `[...tenantOverrides, ...globalOverrides]` spread inline in
 * `buildWingetMatcher`), so it can't be cached by identity like the catalog
 * — it's folded into the key by content instead.
 */
const matchResultCache = new WeakMap<readonly WingetCatalogEntry[], Map<string, WingetMatch | null>>();

function matchCacheKey(title: string, overrides: readonly WingetOverride[]): string {
  let key = title;
  for (const o of overrides) key += `\u0000${o.softwareTitle}\u0000${o.packageId}`;
  return key;
}

/**
 * Resolves a software title to the best Winget package in the catalog, or null
 * if nothing clears `MATCH_THRESHOLD`. Each entry is compared on both its
 * declared `softwareTitle` and its display `name`; ties go to {@link isBetterMatch}.
 *
 * Note what that does *not* promise. It settles a tie between a package and its
 * own variants, which is the common case and the one that was misfiring. A tie
 * between ids with no such relationship — `Notepad++.Notepad++` and
 * `ndd.Notepad--`, two unrelated products that normalise alike — still keeps
 * whichever entry the catalog iterated first, so it can resolve differently
 * across syncs. Deciding those needs evidence this function is not given
 * (publisher, install path); ranking them on the shape of the id alone is what
 * produced the wrong answers recorded in {@link isVariantOf}.
 *
 * `overrides` (engineer-authored pins) are consulted FIRST: the first override
 * whose title normalises to the same signature as `title` wins outright as a
 * `manual` match at confidence 1.0, so a human decision always beats heuristics.
 * Callers pass overrides already ordered by precedence (tenant-scoped first).
 */
export function matchWinget(
  title: string,
  catalog: readonly WingetCatalogEntry[],
  overrides: readonly WingetOverride[] = [],
): WingetMatch | null {
  let cache = matchResultCache.get(catalog);
  if (!cache) {
    cache = new Map();
    matchResultCache.set(catalog, cache);
  }
  const cacheKey = matchCacheKey(title, overrides);
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = computeWingetMatch(title, catalog, overrides);
  cache.set(cacheKey, result);
  return result;
}

function computeWingetMatch(
  title: string,
  catalog: readonly WingetCatalogEntry[],
  overrides: readonly WingetOverride[],
): WingetMatch | null {
  const target = normalizeTitle(resolveMatchingTitle(title));
  if (!target) return null;
  const targetTokens = tokens(target);

  // Manual overrides win outright, in caller-supplied precedence order.
  for (const o of overrides) {
    if (normalizeTitle(resolveMatchingTitle(o.softwareTitle)) === target) {
      const entry = catalog.find((c) => c.packageId === o.packageId);
      return {
        packageId: o.packageId,
        name: entry?.name ?? o.packageId,
        confidence: 1,
        method: "manual",
      };
    }
  }

  let best: WingetMatch | null = null;
  let bestSpecificity = 0;

  for (const { entry, candidates } of getIndexedCatalog(catalog)) {
    for (const { normalized: cand, tokenSet: candTokens } of candidates) {
      const specificity = jaccard(targetTokens, candTokens);
      let match: WingetMatch | null = null;

      if (cand === target) {
        match = { packageId: entry.packageId, name: entry.name, confidence: 1, method: "exact" };
      } else if (isCredibleContainment(cand, target)) {
        match = { packageId: entry.packageId, name: entry.name, confidence: 0.8, method: "contains" };
      } else if (specificity >= MATCH_THRESHOLD && isCredibleOverlap(targetTokens, candTokens)) {
        match = {
          packageId: entry.packageId,
          name: entry.name,
          confidence: Number(specificity.toFixed(2)),
          method: "token-overlap",
        };
      }

      if (match && isBetterMatch(match, best, specificity, bestSpecificity)) {
        best = match;
        bestSpecificity = specificity;
      }
    }
  }

  return best;
}
