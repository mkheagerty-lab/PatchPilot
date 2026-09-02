import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchStoreApps } from "./store-apps.js";

/**
 * searchStoreApps proxies a raw fetch() to Microsoft's manifestSearch
 * endpoint (not Graph/Defender — see the module doc comment) and layers a
 * short-TTL in-memory cache keyed by normalized query string on top. These
 * tests mock global fetch entirely and use fake timers to exercise the TTL
 * boundary without a real 10-minute wait.
 *
 * The cache is module-level (not reset between tests), so every test uses
 * its own distinct query string to avoid cross-test cache hits.
 */

function manifestSearchResponse(
  entries: Array<{ id: string; name: string; publisher: string; version?: string }>,
) {
  return {
    Data: entries.map((e) => ({
      PackageIdentifier: e.id,
      PackageName: e.name,
      Publisher: e.publisher,
      Versions: e.version ? [{ PackageVersion: e.version }] : [],
    })),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () =>
        manifestSearchResponse([
          { id: "9NZVDKPMR9RD", name: "Mozilla Firefox", publisher: "Mozilla", version: "130.0" },
        ]),
    })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("searchStoreApps", () => {
  it("normalizes the query (trim + lowercase) into the manifestSearch request body", async () => {
    await searchStoreApps("  Firefox  ", 20);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.Query.KeyWord).toBe("firefox");
  });

  it("maps the raw manifestSearch shape to the normalized StoreAppResult shape", async () => {
    const results = await searchStoreApps("firefox-map-test", 20);
    expect(results).toEqual([
      { packageIdentifier: "9NZVDKPMR9RD", name: "Mozilla Firefox", publisher: "Mozilla", version: "130.0" },
    ]);
  });

  it("returns [] for an empty/whitespace-only query without calling fetch at all", async () => {
    const results = await searchStoreApps("   ", 20);
    expect(results).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clamps results to the requested limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () =>
          manifestSearchResponse([
            { id: "A", name: "A", publisher: "P" },
            { id: "B", name: "B", publisher: "P" },
            { id: "C", name: "C", publisher: "P" },
          ]),
      })),
    );
    const results = await searchStoreApps("limit-test", 2);
    expect(results).toHaveLength(2);
  });

  it("serves a repeat query from cache within the TTL window without calling fetch again", async () => {
    await searchStoreApps("cache-hit-test", 20);
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000); // well inside the 10-minute TTL
    const results = await searchStoreApps("cache-hit-test", 20);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { packageIdentifier: "9NZVDKPMR9RD", name: "Mozilla Firefox", publisher: "Mozilla", version: "130.0" },
    ]);
  });

  it("re-fetches once the TTL has expired", async () => {
    await searchStoreApps("cache-expiry-test", 20);
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(11 * 60 * 1000); // past the 10-minute TTL
    await searchStoreApps("cache-expiry-test", 20);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("treats differently-cased/whitespaced queries as the same cache key", async () => {
    await searchStoreApps("MixedCase-Test", 20);
    expect(fetch).toHaveBeenCalledTimes(1);

    await searchStoreApps("  mixedcase-test  ", 20);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("propagates a non-ok upstream response as a thrown error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    await expect(searchStoreApps("error-test", 20)).rejects.toThrow("manifestSearch HTTP 500");
  });
});
