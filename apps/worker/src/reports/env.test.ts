import { describe, expect, it } from "vitest";
import { parseReportEnv } from "./env.js";

describe("parseReportEnv", () => {
  it("renders a full set of defaults from an empty environment", () => {
    const env = parseReportEnv({});
    // Rendering is on by default; narration is not. That asymmetry is the
    // whole point of the split gate — a deployment with AI switched off still
    // produces reports.
    expect(env.REPORT_PDF_ENABLED).toBe(true);
    expect(env.AI_FEATURES_ENABLED).toBe(false);
    expect(env.REPORT_CONCURRENCY).toBe(1);
    expect(env.REPORT_BROWSER_CHANNEL).toBeUndefined();
    expect(env.REPORT_BROWSER_EXECUTABLE_PATH).toBeUndefined();
  });

  it("treats an empty string as absent, not as a browser channel named ''", () => {
    // A container image or a .env carrying a bare `REPORT_BROWSER_CHANNEL=`
    // line. Passing "" through makes Playwright throw at launch, on the first
    // report anyone generates — long after this value was set.
    const env = parseReportEnv({ REPORT_BROWSER_CHANNEL: "", REPORT_BROWSER_EXECUTABLE_PATH: "" });
    expect(env.REPORT_BROWSER_CHANNEL).toBeUndefined();
    expect(env.REPORT_BROWSER_EXECUTABLE_PATH).toBeUndefined();
  });

  it("keeps a real channel and a real path", () => {
    const env = parseReportEnv({
      REPORT_BROWSER_CHANNEL: "msedge",
      REPORT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium-browser",
    });
    expect(env.REPORT_BROWSER_CHANNEL).toBe("msedge");
    expect(env.REPORT_BROWSER_EXECUTABLE_PATH).toBe("/usr/bin/chromium-browser");
  });

  it("coerces numeric strings, because env values are always strings", () => {
    const env = parseReportEnv({
      REPORT_PDF_TIMEOUT_MS: "90000",
      REPORT_MAX_BYTES: "1048576",
      REPORT_RETENTION_DAYS: "30",
    });
    expect(env.REPORT_PDF_TIMEOUT_MS).toBe(90_000);
    expect(env.REPORT_MAX_BYTES).toBe(1_048_576);
    expect(env.REPORT_RETENTION_DAYS).toBe(30);
  });

  it("rejects a nonsensical value loudly at boot rather than at render time", () => {
    expect(() => parseReportEnv({ REPORT_PDF_TIMEOUT_MS: "10" })).toThrow();
    expect(() => parseReportEnv({ REPORT_RETENTION_DAYS: "0" })).toThrow();
    expect(() => parseReportEnv({ REPORT_PDF_ENABLED: "yes" })).toThrow();
  });

  it("defaults the two api-shared values to the same numbers apps/api/src/config.ts uses", () => {
    // These are hand-synced across two apps: the api stamps reports.expires_at
    // from REPORT_RETENTION_DAYS at INSERT and the worker sweeps against it, so
    // a drift here means reports are stamped on one retention and deleted on
    // another. Asserted so the drift fails a test rather than a customer.
    const env = parseReportEnv({});
    expect(env.REPORT_RETENTION_DAYS).toBe(90);
    expect(env.REPORT_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});
