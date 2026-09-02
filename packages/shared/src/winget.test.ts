import { describe, expect, it } from "vitest";
import {
  normalizeTitle,
  matchWinget,
  prettifySoftwareTitle,
  friendlyProductName,
  hasNonLatinScript,
  annotateForeignName,
  compareWingetVersions,
  wingetVersionGate,
  alignVersionDisplay,
  resolveDisplaySoftwareName,
  detectMicrosoftStoreInstall,
  type WingetCatalogEntry,
} from "./winget.js";

const catalog: WingetCatalogEntry[] = [
  { packageId: "Mozilla.Firefox", name: "Mozilla Firefox", publisher: "Mozilla", softwareTitle: "Mozilla Firefox" },
  { packageId: "7zip.7zip", name: "7-Zip", publisher: "Igor Pavlov", softwareTitle: "7-Zip" },
  { packageId: "Google.Chrome", name: "Google Chrome", publisher: "Google", softwareTitle: "Google Chrome" },
  { packageId: "Notepad++.Notepad++", name: "Notepad++", publisher: "Notepad++ Team", softwareTitle: "Notepad++" },
];

describe("detectMicrosoftStoreInstall", () => {
  it("detects a WindowsApps disk path", () => {
    expect(
      detectMicrosoftStoreInstall(
        ["C:\\Program Files\\WindowsApps\\Mozilla.Firefox_130.0.0.0_x64__n80bbvh6b1yt2\\firefox.exe"],
        [],
      ),
    ).toBe(true);
  });
  it("detects an AppModel registry path", () => {
    expect(
      detectMicrosoftStoreInstall(
        [],
        ["HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages\\Mozilla.Firefox"],
      ),
    ).toBe(true);
  });
  it("matches case-insensitively", () => {
    expect(detectMicrosoftStoreInstall(["c:\\program files\\WINDOWSAPPS\\foo"], [])).toBe(true);
  });
  it("detects a Defender 'Microsoft Store: Get-AppxPackage ...' descriptor in place of a real path", () => {
    expect(
      detectMicrosoftStoreInstall(
        [
          'Microsoft Store: Get-AppxPackage -AllUsers | Where-Object { $_.PackageFullName -eq "Mozilla.Firefox_153.0.4.0_x64__n80bbvh6b1yt2" }',
        ],
        [],
      ),
    ).toBe(true);
  });
  it("does not match a plain Program Files path", () => {
    expect(
      detectMicrosoftStoreInstall(["C:\\Program Files\\Mozilla Firefox\\firefox.exe"], []),
    ).toBe(false);
  });
  it("does not match a plain HKLM Uninstall registry path", () => {
    expect(
      detectMicrosoftStoreInstall(
        [],
        ["HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mozilla Firefox"],
      ),
    ).toBe(false);
  });
  it("returns false for no evidence at all", () => {
    expect(detectMicrosoftStoreInstall(null, null)).toBe(false);
    expect(detectMicrosoftStoreInstall(undefined, undefined)).toBe(false);
    expect(detectMicrosoftStoreInstall([], [])).toBe(false);
  });
});

describe("normalizeTitle", () => {
  it("strips version, architecture and locale noise", () => {
    expect(normalizeTitle("Mozilla Firefox (x64 en-US) 126.0")).toBe("mozilla firefox");
  });
  it("normalizes punctuation-heavy titles", () => {
    expect(normalizeTitle("7-Zip 24.08 (x64)")).toBe("7 zip");
  });
  it("drops bracketed segments and v-prefixed versions", () => {
    expect(normalizeTitle("Notepad++ [bundle] v8.6.2")).toBe("notepad");
  });
  it("preserves non-Latin scripts instead of collapsing them to a stray Latin letter", () => {
    // Regression: an ASCII-only punctuation strip reduced "B站录播姬" to just
    // "b", which then spuriously substring-matched unrelated titles like
    // "Microsoft Edge Chromium-based" (via the letter "b" in "based").
    expect(normalizeTitle("B站录播姬")).toBe("b站录播姬");
  });
});

describe("matchWinget non-Latin false-positive regression", () => {
  it("does not match an unrelated Latin title against a CJK catalog entry", () => {
    const bililiveCatalog: WingetCatalogEntry[] = [
      { packageId: "Bililive.BililiveRecorder", name: "B站录播姬", publisher: "Bililive", softwareTitle: null },
    ];
    expect(matchWinget("Microsoft Edge Chromium-based", bililiveCatalog)).toBeNull();
  });
});

describe("friendlyProductName", () => {
  it("vendor-prefixes a bare product slug", () => {
    expect(friendlyProductName("chrome", "google")).toBe("Google Chrome");
    expect(friendlyProductName("office", "microsoft")).toBe("Microsoft Office");
  });
  it("un-snakes multi-token slugs", () => {
    expect(friendlyProductName("windows_11", "microsoft")).toBe("Microsoft Windows 11");
    expect(friendlyProductName("windows_server_2019", "microsoft")).toBe(
      "Microsoft Windows Server 2019",
    );
  });
  it("keeps leading punctuation while capitalising the first letter", () => {
    expect(friendlyProductName(".net", "microsoft")).toBe("Microsoft .Net");
    expect(friendlyProductName(".net_core", "microsoft")).toBe("Microsoft .Net Core");
  });
  it("does not double up when the slug already leads with the vendor", () => {
    expect(friendlyProductName("google_chrome", "google")).toBe("Google Chrome");
  });
  it("passes already-friendly names through untouched", () => {
    expect(friendlyProductName("Mozilla Firefox", "Mozilla")).toBe("Mozilla Firefox");
    expect(friendlyProductName("7-Zip", "Igor Pavlov")).toBe("7-Zip");
    expect(friendlyProductName("Microsoft Windows 11", "Microsoft")).toBe("Microsoft Windows 11");
  });
  it("falls back to the prettified product when no vendor is given", () => {
    expect(friendlyProductName("openssl", null)).toBe("Openssl");
  });
  it("appends a curated English hint to a non-Latin name", () => {
    expect(friendlyProductName("B站录播姬", null)).toBe(
      "B站录播姬 (Bilibili Live Recorder)",
    );
  });
});

describe("hasNonLatinScript", () => {
  it("detects CJK / non-Latin scripts", () => {
    expect(hasNonLatinScript("B站录播姬")).toBe(true);
    expect(hasNonLatinScript("乐启office工具箱")).toBe(true);
  });
  it("is false for plain Latin names", () => {
    expect(hasNonLatinScript("Google Chrome")).toBe(false);
    expect(hasNonLatinScript("7-Zip")).toBe(false);
    expect(hasNonLatinScript("OpenSSL")).toBe(false);
  });
});

describe("annotateForeignName", () => {
  it("appends a curated English hint, preserving the source name", () => {
    expect(annotateForeignName("乐启office工具箱")).toBe(
      "乐启office工具箱 (LeQi Office Toolbox)",
    );
  });
  it("finds the hint even when the name is vendor-prefixed", () => {
    expect(annotateForeignName("Bilibili B站录播姬")).toBe(
      "Bilibili B站录播姬 (Bilibili Live Recorder)",
    );
  });
  it("is idempotent and a no-op for Latin or un-hinted names", () => {
    expect(annotateForeignName("Google Chrome")).toBe("Google Chrome");
    expect(annotateForeignName("B站录播姬 (Bilibili Live Recorder)")).toBe(
      "B站录播姬 (Bilibili Live Recorder)",
    );
    // Non-Latin but no curated hint — left untouched.
    expect(annotateForeignName("日本語アプリ")).toBe("日本語アプリ");
  });
});

describe("prettifySoftwareTitle", () => {
  it("un-snakes and title-cases a machine-readable product name", () => {
    expect(prettifySoftwareTitle("visual_studio_code")).toBe("Visual Studio Code");
  });
  it("capitalizes a single bare token", () => {
    expect(prettifySoftwareTitle("firefox")).toBe("Firefox");
  });
  it("preserves hyphens and existing capitalisation", () => {
    expect(prettifySoftwareTitle("7-zip")).toBe("7-zip");
    expect(prettifySoftwareTitle("iTunes")).toBe("ITunes");
  });
  it("collapses repeated separators and whitespace", () => {
    expect(prettifySoftwareTitle("microsoft__edge  ")).toBe("Microsoft Edge");
  });
});

describe("compareWingetVersions", () => {
  it("orders numeric segments numerically, not lexically", () => {
    // lexical compare would put "9" after "10"; numeric must not.
    expect(compareWingetVersions("10.0", "9.0")).toBeGreaterThan(0);
    expect(compareWingetVersions("2.10", "2.9")).toBeGreaterThan(0);
    expect(compareWingetVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("treats missing trailing segments as zero", () => {
    expect(compareWingetVersions("1.2", "1.2.1")).toBeLessThan(0);
    expect(compareWingetVersions("1.2.0", "1.2")).toBe(0);
  });

  it("splits on '.', '-' and '+' separators alike", () => {
    expect(compareWingetVersions("1.2-3", "1.2.3")).toBe(0);
    expect(compareWingetVersions("1.2+4", "1.2.3")).toBeGreaterThan(0);
  });

  it("falls back to lexical compare for non-numeric segments", () => {
    expect(compareWingetVersions("1.2.beta", "1.2.alpha")).toBeGreaterThan(0);
    expect(compareWingetVersions("1.2.0", "1.2.beta")).toBeLessThan(0);
  });
});

describe("wingetVersionGate", () => {
  it("is 'ready' when the catalog's latest reaches or exceeds the target", () => {
    expect(wingetVersionGate("126.0", "126.0")).toBe("ready");
    expect(wingetVersionGate("127.0", "126.0")).toBe("ready");
  });

  it("is 'behind' when the catalog hasn't published the fixed version yet", () => {
    expect(wingetVersionGate("125.0", "126.0")).toBe("behind");
    expect(wingetVersionGate("1.2", "1.2.1")).toBe("behind");
  });

  it("is 'unknown' when either side is missing or blank", () => {
    expect(wingetVersionGate(null, "126.0")).toBe("unknown");
    expect(wingetVersionGate("126.0", null)).toBe("unknown");
    expect(wingetVersionGate("126.0", undefined)).toBe("unknown");
    expect(wingetVersionGate("  ", "126.0")).toBe("unknown");
    expect(wingetVersionGate("126.0", "")).toBe("unknown");
  });
});

describe("alignVersionDisplay", () => {
  it("pads the shorter equal version with trailing .0s to match the longer", () => {
    // The Zoom Meetings case: device reports "7.1.43453.0", catalog reports
    // "7.1.43453" — same version, different segment counts.
    expect(alignVersionDisplay("7.1.43453.0", "7.1.43453")).toEqual({
      detected: "7.1.43453.0",
      latest: "7.1.43453.0",
    });
    expect(alignVersionDisplay("7.1.43453", "7.1.43453.0")).toEqual({
      detected: "7.1.43453.0",
      latest: "7.1.43453.0",
    });
  });

  it("leaves versions unchanged when they're already the same length", () => {
    expect(alignVersionDisplay("1.2.3", "1.2.3")).toEqual({ detected: "1.2.3", latest: "1.2.3" });
  });

  it("leaves genuinely different versions unchanged", () => {
    expect(alignVersionDisplay("1.2.3", "1.2.4")).toEqual({ detected: "1.2.3", latest: "1.2.4" });
    expect(alignVersionDisplay("7.1.43453.1", "7.1.43453")).toEqual({
      detected: "7.1.43453.1",
      latest: "7.1.43453",
    });
  });

  it("passes through when either side is missing", () => {
    expect(alignVersionDisplay(null, "1.2.3")).toEqual({ detected: null, latest: "1.2.3" });
    expect(alignVersionDisplay("1.2.3", undefined)).toEqual({ detected: "1.2.3", latest: undefined });
    expect(alignVersionDisplay(null, null)).toEqual({ detected: null, latest: null });
  });
});

describe("matchWinget", () => {
  it("matches an exact title with full confidence", () => {
    const m = matchWinget("Google Chrome", catalog);
    expect(m?.packageId).toBe("Google.Chrome");
    expect(m?.confidence).toBe(1);
    expect(m?.method).toBe("exact");
  });

  it("matches a noisy MDVM title to the right package", () => {
    const m = matchWinget("Mozilla Firefox (x64 en-US) 126.0", catalog);
    expect(m?.packageId).toBe("Mozilla.Firefox");
    expect(m?.confidence).toBe(1);
  });

  it("matches via substring containment", () => {
    const m = matchWinget("Google Chrome for Business", catalog);
    expect(m?.packageId).toBe("Google.Chrome");
    expect(m?.method).toBe("contains");
  });

  it("returns null when nothing clears the threshold", () => {
    expect(matchWinget("Microsoft Windows", catalog)).toBeNull();
    expect(matchWinget("", catalog)).toBeNull();
  });

  it("does not let a single generic-word catalog entry contain-match an unrelated longer title", () => {
    // Regression: a catalog entry that normalizes to the bare word "office"
    // used to substring-match "Ability Office 8 Professional" (a SoftMaker
    // product, unrelated to Microsoft Office) via the "contains" rule.
    const officeCatalog: WingetCatalogEntry[] = [
      { packageId: "Microsoft.Office", name: "Office", publisher: "Microsoft", softwareTitle: "Office" },
    ];
    expect(matchWinget("Ability Office 8 Professional", officeCatalog)).toBeNull();
  });

  it("does not let a bare single-token title token-overlap-match an unrelated two-word product", () => {
    // Regression: Defender's reported title for a Zoom finding normalised to
    // the single token "meetings", which reached exactly the 0.5 Jaccard
    // threshold against "Dialpad Meetings" (2 tokens, 1 shared) even though
    // none of the real Zoom catalog entries share any token with it — so
    // Dialpad won by being the only candidate to clear the threshold at all,
    // not by any real similarity to Zoom.
    const meetingsCatalog: WingetCatalogEntry[] = [
      { packageId: "Dialpad.DialpadMeetings", name: "Dialpad Meetings", publisher: "Dialpad", softwareTitle: null },
      { packageId: "Zoom.Zoom", name: "Zoom Workplace", publisher: "Zoom", softwareTitle: null },
    ];
    expect(matchWinget("meetings", meetingsCatalog)).toBeNull();
  });

  it("matches a Store-reported vendor-prefixed title against a single-token catalog name", () => {
    // Regression: Defender reports Microsoft Store-installed 1Password as
    // "Agilebits 1Password" (publisher folded into the title). Normalised
    // that's 2 tokens against the catalog's single distinctive token
    // "1password", which the single-generic-token guards used to reject
    // outright (same guard that correctly blocks "meetings" above) — so the
    // device showed no available update at all.
    const onePasswordCatalog: WingetCatalogEntry[] = [
      { packageId: "AgileBits.1Password", name: "1Password", publisher: "AgileBits", softwareTitle: null },
      { packageId: "AgileBits.1Password.Beta", name: "1Password Beta", publisher: "AgileBits", softwareTitle: null },
      { packageId: "AgileBits.1Password.CLI", name: "1Password CLI", publisher: "AgileBits", softwareTitle: null },
    ];
    const m = matchWinget("Agilebits 1Password", onePasswordCatalog);
    expect(m?.packageId).toBe("AgileBits.1Password");
  });

  it("resolves a title nothing else covers via a manual override", () => {
    const overrides = [{ softwareTitle: "Globex VPN Client", packageId: "Globex.VPN" }];
    const cat = [
      ...catalog,
      { packageId: "Globex.VPN", name: "Globex VPN", publisher: "Globex", softwareTitle: null },
    ];
    const m = matchWinget("Globex VPN Client 4.2 (x64)", cat, overrides);
    expect(m?.packageId).toBe("Globex.VPN");
    expect(m?.name).toBe("Globex VPN");
    expect(m?.confidence).toBe(1);
    expect(m?.method).toBe("manual");
  });

  it("lets a manual override beat an otherwise-confident fuzzy match", () => {
    const overrides = [{ softwareTitle: "Google Chrome", packageId: "Google.ChromeBeta" }];
    const cat = [
      ...catalog,
      { packageId: "Google.ChromeBeta", name: "Google Chrome Beta", publisher: "Google", softwareTitle: null },
    ];
    const m = matchWinget("Google Chrome", cat, overrides);
    expect(m?.packageId).toBe("Google.ChromeBeta");
    expect(m?.method).toBe("manual");
  });

  it("honours override precedence order (tenant-scoped passed first wins)", () => {
    const overrides = [
      { softwareTitle: "7-Zip", packageId: "Custom.SevenZip" }, // tenant-scoped, first
      { softwareTitle: "7-Zip", packageId: "7zip.7zip" }, // global, second
    ];
    const cat = [
      ...catalog,
      { packageId: "Custom.SevenZip", name: "Custom 7-Zip", publisher: "ACME", softwareTitle: null },
    ];
    const m = matchWinget("7-Zip 24.08 (x64)", cat, overrides);
    expect(m?.packageId).toBe("Custom.SevenZip");
  });

  it("ignores an override whose package is absent from the catalog, using the id as name", () => {
    const overrides = [{ softwareTitle: "Mystery App", packageId: "Unknown.Pkg" }];
    const m = matchWinget("Mystery App", catalog, overrides);
    expect(m?.packageId).toBe("Unknown.Pkg");
    expect(m?.name).toBe("Unknown.Pkg");
    expect(m?.method).toBe("manual");
  });
});

/**
 * The winget repo publishes packaging, channel and locale variants of the same
 * product whose display names differ from the base only by a parenthetical — or
 * not at all. `normalizeTitle` strips parentheticals, so they all reduce to the
 * same signature and every one of them is an `exact` match at confidence 1.0.
 * The rows below are copied from the live catalog; `softwareTitle` is null there,
 * so matching runs off `name` alone, as it does in production.
 *
 * This mattered in the field: a Live Response job was handed `Google.Chrome.EXE`
 * for a device carrying Chrome as `Google.Chrome`, so `winget list --id
 * Google.Chrome.EXE --exact` found nothing and the upgrade failed with
 * 0x8A150014 (NO_APPLICATIONS_FOUND). The tie previously went to whichever row
 * the catalog iterated first, which is not a decision at all.
 */
describe("matchWinget variant tie-breaks", () => {
  const chrome: WingetCatalogEntry[] = [
    { packageId: "Google.Chrome.EXE", name: "Google Chrome (EXE)", publisher: "Google" },
    { packageId: "Google.Chrome", name: "Google Chrome", publisher: "Google" },
    { packageId: "Google.Chrome.Beta", name: "Google Chrome Beta", publisher: "Google" },
    { packageId: "Google.Chrome.Beta.EXE", name: "Google Chrome Beta (EXE)", publisher: "Google" },
    { packageId: "Google.Chrome.Dev", name: "Google Chrome Dev", publisher: "Google" },
  ];

  it("prefers the base package over a packaging variant that normalises identically", () => {
    expect(matchWinget("Google Chrome", chrome)?.packageId).toBe("Google.Chrome");
  });

  it("resolves the same way whatever order the catalog rows arrive in", () => {
    // The defect was invisible in any single ordering — it *was* the ordering.
    for (const order of [chrome, [...chrome].reverse(), [...chrome].slice(2).concat(chrome.slice(0, 2))]) {
      expect(matchWinget("Google Chrome 150.0.7871.184", order)?.packageId).toBe("Google.Chrome");
    }
  });

  it("prefers the base package over locale variants, of which there are ~100 per product", () => {
    const firefox: WingetCatalogEntry[] = [
      { packageId: "Mozilla.Firefox.de", name: "Mozilla Firefox", publisher: "Mozilla" },
      { packageId: "Mozilla.Firefox.MSIX", name: "Mozilla Firefox", publisher: "Mozilla" },
      { packageId: "Mozilla.Firefox.ca-valencia", name: "Mozilla Firefox", publisher: "Mozilla" },
      { packageId: "Mozilla.Firefox", name: "Mozilla Firefox", publisher: "Mozilla" },
    ];
    expect(matchWinget("Mozilla Firefox (x64 en-US) 126.0", firefox)?.packageId).toBe("Mozilla.Firefox");
  });

  it("treats a longer base id as the base when its own variants sit below it", () => {
    // "Mozilla Firefox ESR" is a distinct signature from "Mozilla Firefox", so the
    // three-segment id is the base here — depth is judged against its rivals, not
    // against an absolute segment count.
    const esr: WingetCatalogEntry[] = [
      { packageId: "Mozilla.Firefox.ESR.MSIX", name: "Mozilla Firefox ESR", publisher: "Mozilla" },
      { packageId: "Mozilla.Firefox.ESR.de", name: "Mozilla Firefox ESR", publisher: "Mozilla" },
      { packageId: "Mozilla.Firefox.ESR", name: "Mozilla Firefox ESR", publisher: "Mozilla" },
    ];
    expect(matchWinget("Mozilla Firefox ESR", esr)?.packageId).toBe("Mozilla.Firefox.ESR");
  });

  it("never lets the tie-break override a genuinely better match", () => {
    // Confidence still decides first: Google.Chrome.Beta matches this title exactly,
    // while the shorter Google.Chrome only contains it (0.8). Preferring plain ids
    // must not mean answering a request for the Beta channel with the stable one.
    const m = matchWinget("Google Chrome Beta", chrome);
    expect(m?.packageId).toBe("Google.Chrome.Beta");
    expect(m?.method).toBe("exact");
  });

  it("still lets a manual override pin a variant", () => {
    const overrides = [{ softwareTitle: "Google Chrome", packageId: "Google.Chrome.EXE" }];
    const m = matchWinget("Google Chrome", chrome, overrides);
    expect(m?.packageId).toBe("Google.Chrome.EXE");
    expect(m?.method).toBe("manual");
  });

  /**
   * The three cases below are the ones an earlier draft of the tie-break got
   * wrong. Replaying every stored mapping against the live 14,014-row catalog
   * showed it displacing these, and each would have sent a device the wrong
   * package. They are not variants of one another — they only *look* alike once
   * `normalizeTitle` has stripped punctuation and version numbers — so the
   * tie-break must leave them alone.
   *
   * Each fixture is written incumbent-first, because that is precisely the claim:
   * a correct match already in hand must not be displaced. Ties between genuinely
   * unrelated ids stay order-dependent, which is the pre-existing behaviour and a
   * separate gap; nothing here pretends to settle them.
   */
  it("does not displace Notepad++ with Notepad--, a different product entirely", () => {
    // normalizeTitle drops all non-alphanumerics, so both names reduce to "notepad"
    // and both match at 1.0. Different publishers, different software.
    const notepad: WingetCatalogEntry[] = [
      { packageId: "Notepad++.Notepad++", name: "Notepad++", publisher: "Notepad++ Team" },
      { packageId: "ndd.Notepad--", name: "Notepad--", publisher: "ndd" },
    ];
    expect(matchWinget("Notepad++", notepad)?.packageId).toBe("Notepad++.Notepad++");
  });

  it("does not displace a runtime major with a different one", () => {
    // Version numbers are stripped too, so all seven ASP.NET Core majors share the
    // signature "microsoft asp net core runtime". Remediating a 10.0 finding with
    // the 5.0 package would install the wrong — and long unsupported — runtime.
    const aspnet: WingetCatalogEntry[] = [
      {
        packageId: "Microsoft.DotNet.AspNetCore.10",
        name: "Microsoft ASP.NET Core Runtime 10.0",
        publisher: "Microsoft",
      },
      {
        packageId: "Microsoft.DotNet.AspNetCore.5",
        name: "Microsoft ASP.NET Core Runtime 5.0",
        publisher: "Microsoft",
      },
      {
        packageId: "Microsoft.DotNet.AspNetCore.8",
        name: "Microsoft ASP.NET Core Runtime 8.0",
        publisher: "Microsoft",
      },
    ];
    expect(matchWinget("Microsoft ASP.NET Core Runtime 10.0", aspnet)?.packageId).toBe(
      "Microsoft.DotNet.AspNetCore.10",
    );
  });

  it("does not treat a shallower id as the base when the segments disagree", () => {
    // `DeveloperPack_4` is not `DeveloperPack`, so this is not a base/variant pair
    // however few segments the other id carries. Segment count alone would have
    // ranked it first and answered a 4.5 finding with the wrong pack.
    const packs: WingetCatalogEntry[] = [
      {
        packageId: "Microsoft.DotNet.Framework.DeveloperPack.4.5",
        name: "Microsoft .NET Framework 4.5.1 Developer Pack (KB2861696)",
        publisher: "Microsoft",
      },
      {
        packageId: "Microsoft.DotNet.Framework.DeveloperPack_4",
        name: "Microsoft .NET Framework Developer Pack",
        publisher: "Microsoft",
      },
    ];
    expect(
      matchWinget("Microsoft .NET Framework 4.5.1 Developer Pack (KB2861696)", packs)?.packageId,
    ).toBe("Microsoft.DotNet.Framework.DeveloperPack.4.5");
  });
});

/**
 * Ties between *unrelated* ids (no `isVariantOf` relationship either way) —
 * unlike the variant ties above, these are settled by which candidate's
 * token set overlaps more with the target's, not by id shape. Reproduces two
 * live-tenant mismatches: a generic, short catalog entry ("Remote Desktop",
 * 2 tokens) contain-matches inside several unrelated, longer titles at the
 * same 0.8 confidence as each title's own, more specific package.
 */
describe("matchWinget specificity tie-breaks", () => {
  const remoteDesktop: WingetCatalogEntry[] = [
    { packageId: "Microsoft.RemoteDesktopClient", name: "Remote Desktop", publisher: "Microsoft" },
    { packageId: "Google.ChromeRemoteDesktopHost", name: "Chrome Remote Desktop Host", publisher: "Google" },
    { packageId: "Devolutions.RemoteDesktopManager", name: "Remote Desktop Manager", publisher: "Devolutions" },
  ];

  it("prefers Chrome Remote Desktop Host over the generic Remote Desktop client", () => {
    expect(matchWinget("Google Chrome Remote Desktop Host", remoteDesktop)?.packageId).toBe(
      "Google.ChromeRemoteDesktopHost",
    );
  });

  it("prefers Devolutions Remote Desktop Manager over the generic Remote Desktop client", () => {
    expect(matchWinget("Devolutions Remote Desktop Manager", remoteDesktop)?.packageId).toBe(
      "Devolutions.RemoteDesktopManager",
    );
  });

  it("resolves the same way whatever order the catalog rows arrive in", () => {
    for (const order of [remoteDesktop, [...remoteDesktop].reverse(), [
      remoteDesktop[1]!,
      remoteDesktop[2]!,
      remoteDesktop[0]!,
    ]]) {
      expect(matchWinget("Google Chrome Remote Desktop Host", order)?.packageId).toBe(
        "Google.ChromeRemoteDesktopHost",
      );
      expect(matchWinget("Devolutions Remote Desktop Manager", order)?.packageId).toBe(
        "Devolutions.RemoteDesktopManager",
      );
    }
  });
});

describe("resolveDisplaySoftwareName", () => {
  it("maps ChromeDriver to Google Chrome unconditionally", () => {
    expect(resolveDisplaySoftwareName("ChromeDriver")).toBe("Google Chrome");
    expect(resolveDisplaySoftwareName("chromedriver")).toBe("Google Chrome");
  });

  it("maps Chromium to Google Chrome when disk paths show a Chrome install", () => {
    expect(
      resolveDisplaySoftwareName("Chromium", ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]),
    ).toBe("Google Chrome");
  });

  it("defaults Chromium to Microsoft Edge when there is no Chrome disk-path evidence", () => {
    expect(resolveDisplaySoftwareName("Chromium")).toBe("Microsoft Edge (Chromium-based)");
    expect(
      resolveDisplaySoftwareName("Chromium", ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]),
    ).toBe("Microsoft Edge (Chromium-based)");
  });

  it("maps pje-office to Microsoft Office unconditionally (CVE-2026-55120)", () => {
    expect(resolveDisplaySoftwareName("pje-office")).toBe("Microsoft Office");
    expect(resolveDisplaySoftwareName("PJE-Office")).toBe("Microsoft Office");
  });

  it("maps MiTeam Meetings to Zoom Meetings unconditionally (CVE-2025-49457)", () => {
    expect(resolveDisplaySoftwareName("MiTeam Meetings")).toBe("Zoom Meetings");
    expect(resolveDisplaySoftwareName("miteam meetings")).toBe("Zoom Meetings");
  });

  it("maps Windows 11 Fixer to Windows 11 unconditionally (CVE-2026-62727)", () => {
    expect(resolveDisplaySoftwareName("Windows 11 Fixer")).toBe("Windows 11");
    expect(resolveDisplaySoftwareName("windows 11 fixer")).toBe("Windows 11");
  });

  it("passes through unrelated software unchanged", () => {
    expect(resolveDisplaySoftwareName("Mozilla Firefox")).toBe("Mozilla Firefox");
    expect(resolveDisplaySoftwareName("Ability Office 8 Professional")).toBe(
      "Ability Office 8 Professional",
    );
  });
});
