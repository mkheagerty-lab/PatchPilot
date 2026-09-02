import { describe, expect, it } from "vitest";
import {
  SOURCE_SPECS,
  altSourcesFor,
  altSourceFor,
  PackageSource,
} from "./sources.js";

describe("alternate package sources", () => {
  it("every source spec is preview-availability and self-consistent", () => {
    for (const [key, spec] of Object.entries(SOURCE_SPECS)) {
      expect(spec.source).toBe(key);
      expect(spec.availability).toBe("preview");
      expect(PackageSource.safeParse(spec.source).success).toBe(true);
      expect(spec.label.length).toBeGreaterThan(0);
    }
  });

  it("resolves a curated Chocolatey app regardless of version/arch noise", () => {
    const sources = altSourcesFor("Greenshot (x64) 1.2.10");
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      source: "chocolatey",
      packageId: "greenshot",
    });
  });

  it("resolves a curated Microsoft Store app", () => {
    const hit = altSourceFor("WhatsApp", "microsoft-store");
    expect(hit?.packageId).toBe("9NKSQGP7F2NH");
  });

  it("returns no sources for an unmapped or empty title", () => {
    expect(altSourcesFor("Some Internal LOB App")).toEqual([]);
    expect(altSourcesFor("")).toEqual([]);
    expect(altSourcesFor(null)).toEqual([]);
  });

  it("does not resolve a source the app is not mapped to", () => {
    expect(altSourceFor("Greenshot", "microsoft-store")).toBeNull();
  });
});
