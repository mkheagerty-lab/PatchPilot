import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    config: { ...actual.config, PUBLIC_URL: "https://app.example.com" },
    webOrigins: ["https://app.example.com", "https://proxy.example.com", "http://app.example.com"],
  };
});

const { resolveWebOrigin } = await import("./origin.js");

function fakeRequest(headers: Record<string, string | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe("resolveWebOrigin", () => {
  it("returns PUBLIC_URL when there is no host header at all", () => {
    expect(resolveWebOrigin(fakeRequest({}))).toBe("https://app.example.com");
  });

  it("uses x-forwarded-host when present and allow-listed", () => {
    const req = fakeRequest({ "x-forwarded-host": "proxy.example.com", "x-forwarded-proto": "https" });
    expect(resolveWebOrigin(req)).toBe("https://proxy.example.com");
  });

  it("falls back to the host header when there is no forwarded-host", () => {
    const req = fakeRequest({ host: "app.example.com", "x-forwarded-proto": "https" });
    expect(resolveWebOrigin(req)).toBe("https://app.example.com");
  });

  it("falls back to PUBLIC_URL when the candidate origin is not allow-listed", () => {
    const req = fakeRequest({ host: "evil.example.com", "x-forwarded-proto": "https" });
    expect(resolveWebOrigin(req)).toBe("https://app.example.com");
  });

  it("uses only the first value of a comma-separated x-forwarded-host/proto", () => {
    const req = fakeRequest({
      "x-forwarded-host": "proxy.example.com, evil.example.com",
      "x-forwarded-proto": "https, http",
    });
    expect(resolveWebOrigin(req)).toBe("https://proxy.example.com");
  });

  it("defaults to http when x-forwarded-proto is absent", () => {
    const req = fakeRequest({ host: "app.example.com" });
    expect(resolveWebOrigin(req)).toBe("http://app.example.com");
  });
});
