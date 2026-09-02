import { describe, expect, it } from "vitest";
import {
  isBundledLibrary,
  resolveAltSource,
  resolveAltSources,
  type ChocolateyMatcher,
} from "./matching.js";

/**
 * resolveAltSources/resolveAltSources are the one place that decides which
 * alternate-repo suggestion an engineer sees for a winget "not-supported" app:
 * a live hit against the real mirrored Chocolatey catalog (buildChocolateyMatcher)
 * must win over the small hand-curated fixture in sources.ts (Greenshot/WhatsApp),
 * and the curated fixture must still be the fallback when the live matcher has
 * nothing. Both functions are pure — they take an already-built matcher callback
 * rather than touching the database themselves — so this covers the resolution
 * order without needing a real Postgres connection.
 */
describe("resolveAltSources", () => {
  it("prefers a live Chocolatey match over the curated fixture", () => {
    // Greenshot is in the curated CURATED list in sources.ts (packageId "greenshot"),
    // but the live mirror should win when it has an answer of its own.
    const liveMatcher: ChocolateyMatcher = () => ({
      packageId: "greenshot.portable",
      name: "Greenshot (Portable)",
      confidence: 1,
      method: "exact",
    });
    const result = resolveAltSources(liveMatcher, "tenant-1", "Greenshot");
    expect(result).toEqual([
      { source: "chocolatey", packageId: "greenshot.portable", name: "Greenshot (Portable)" },
    ]);
  });

  it("falls back to the curated fixture when the live matcher finds nothing", () => {
    const noMatch: ChocolateyMatcher = () => null;
    const result = resolveAltSources(noMatch, "tenant-1", "Greenshot");
    expect(result).toEqual([{ source: "chocolatey", packageId: "greenshot", name: "Greenshot" }]);
  });

  it("live-matches software the curated fixture has never heard of, e.g. FileZilla", () => {
    // FileZilla isn't in sources.ts's curated list at all — this is the scenario
    // the whole Chocolatey plan exists to fix: a live catalog hit must still
    // surface a suggestion even though no one hand-curated this title.
    const liveMatcher: ChocolateyMatcher = (_tenantId, software) =>
      software === "FileZilla Client"
        ? { packageId: "filezilla", name: "FileZilla", confidence: 1, method: "exact" }
        : null;
    const result = resolveAltSources(liveMatcher, "tenant-1", "FileZilla Client");
    expect(result).toEqual([{ source: "chocolatey", packageId: "filezilla", name: "FileZilla" }]);
  });

  it("returns nothing for software with no live match and no curated entry", () => {
    const noMatch: ChocolateyMatcher = () => null;
    expect(resolveAltSources(noMatch, "tenant-1", "Totally Unknown App")).toEqual([]);
  });

  it("keeps curated Microsoft Store suggestions alongside a live Chocolatey hit", () => {
    // The live matcher only ever resolves Chocolatey (no live Store index exists),
    // so a curated non-Chocolatey source for the same title must survive untouched.
    const liveMatcher: ChocolateyMatcher = () => ({
      packageId: "whatsapp-live",
      name: "WhatsApp (live)",
      confidence: 0.9,
      method: "token-overlap",
    });
    const result = resolveAltSources(liveMatcher, "tenant-1", "WhatsApp");
    expect(result).toEqual([
      { source: "chocolatey", packageId: "whatsapp-live", name: "WhatsApp (live)" },
      { source: "microsoft-store", packageId: "9NKSQGP7F2NH", name: "WhatsApp" },
    ]);
  });

  it("passes a null matcher through as 'no live catalog available', not a crash", () => {
    // Callers that couldn't build a matcher (e.g. DEMO_MODE, or a load failure)
    // pass null rather than a no-op function — this must behave like a live miss.
    const result = resolveAltSources(null, "tenant-1", "Greenshot");
    expect(result).toEqual([{ source: "chocolatey", packageId: "greenshot", name: "Greenshot" }]);
  });

  it("treats missing software as no suggestions, without calling the matcher", () => {
    let called = false;
    const matcher: ChocolateyMatcher = () => {
      called = true;
      return null;
    };
    expect(resolveAltSources(matcher, "tenant-1", null)).toEqual([]);
    expect(called).toBe(false);
  });
});

/**
 * isBundledLibrary gates buildWingetMatcher/buildChocolateyMatcher against
 * titles that winget/Chocolatey both happen to carry a real standalone
 * package for, but which only ever show up on this tenant's devices as a
 * vendored DLL embedded inside unrelated apps (OneDrive, Wireshark, Power BI,
 * …) — never as an independent install. "Fixing" one of those would upgrade
 * a package nothing actually installed, so the matcher must refuse to
 * resolve it at all rather than confidently pick the wrong target.
 */
describe("isBundledLibrary", () => {
  it("excludes Tukaani Xz Utils, the vendor-prefixed display name built from device_software.name", () => {
    expect(isBundledLibrary("Tukaani Xz Utils")).toBe(true);
  });

  it("excludes xz_utils, the raw un-prefixed DeviceTvmSoftwareInventory slug syncSoftwareInventory matches against directly", () => {
    // Regression: syncSoftwareInventory's agg.rawName is this raw slug, not
    // the friendly display name — the frozen software_inventory row for XZ
    // Utils kept a live matchedPackageId (TukaaniProject.XZUtils) after a
    // real resync until this form was added, even though the live
    // buildWingetMatcher-backed drilldown was already correctly excluded.
    expect(isBundledLibrary("xz_utils")).toBe(true);
    expect(isBundledLibrary("XZ_Utils")).toBe(true);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(isBundledLibrary("  TUKAANI XZ UTILS  ")).toBe(true);
  });

  it("does not exclude unrelated software", () => {
    expect(isBundledLibrary("7-Zip")).toBe(false);
  });

  it("treats missing software as not excluded", () => {
    expect(isBundledLibrary(null)).toBe(false);
    expect(isBundledLibrary(undefined)).toBe(false);
  });
});

describe("resolveAltSource", () => {
  it("filters resolveAltSources down to the requested source", () => {
    const liveMatcher: ChocolateyMatcher = () => ({
      packageId: "filezilla",
      name: "FileZilla",
      confidence: 1,
      method: "exact",
    });
    expect(resolveAltSource(liveMatcher, "tenant-1", "FileZilla Client", "chocolatey")).toEqual({
      source: "chocolatey",
      packageId: "filezilla",
      name: "FileZilla",
    });
    expect(resolveAltSource(liveMatcher, "tenant-1", "FileZilla Client", "microsoft-store")).toBeNull();
  });
});
