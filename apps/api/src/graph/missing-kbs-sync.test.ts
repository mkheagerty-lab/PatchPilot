import { describe, expect, it } from "vitest";
import { normalizeCveAddressed } from "./sync.js";

describe("normalizeCveAddressed", () => {
  it("passes through a real CVE-id array", () => {
    expect(normalizeCveAddressed(["CVE-2026-1111", "CVE-2026-2222"])).toEqual({
      cveIds: ["CVE-2026-1111", "CVE-2026-2222"],
      cveCount: 2,
    });
  });

  it("treats an empty array as zero CVEs", () => {
    expect(normalizeCveAddressed([])).toEqual({ cveIds: [], cveCount: 0 });
  });

  it("falls back to a count when Defender returns a bare number instead of an array", () => {
    // Live-verified against BLACK IRON: getmissingkbs returned cveAddressed: 1
    // for a real KB, which crashed `new Set(row.cveIds)` before this guard.
    expect(normalizeCveAddressed(1)).toEqual({ cveIds: [], cveCount: 1 });
  });

  it("defaults to zero when cveAddressed is missing", () => {
    expect(normalizeCveAddressed(undefined)).toEqual({ cveIds: [], cveCount: 0 });
  });
});
