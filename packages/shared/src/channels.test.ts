import { describe, expect, it } from "vitest";
import { CHANNEL_SPECS, selectableChannels } from "./channels.js";

describe("winget-app channel", () => {
  it("is registered in CHANNEL_SPECS with the expected shape", () => {
    const spec = CHANNEL_SPECS["winget-app"];
    expect(spec).toBeDefined();
    expect(spec.label).toBe("Microsoft Store app (new)");
    expect(spec.host).toBe("graph");
    expect(spec.requiredLicenses).toContain("intune");
    expect(spec.supports).toEqual({ app: true, os: false });
  });

  it(
    "is excluded from selectableChannels() — Fix All has no per-CVE Store-package " +
      "match table to dispatch against, so this channel is Run Now only",
    () => {
      expect(selectableChannels("app")).not.toContain("winget-app");
      expect(selectableChannels("os")).not.toContain("winget-app");
    },
  );
});

describe("expedited-feature-update channel", () => {
  it("is registered in CHANNEL_SPECS with the expected shape", () => {
    const spec = CHANNEL_SPECS["expedited-feature-update"];
    expect(spec).toBeDefined();
    expect(spec.label).toBe("Expedited Feature Update");
    expect(spec.host).toBe("graph");
    expect(spec.requiredLicenses).toContain("intune");
    expect(spec.supports).toEqual({ app: false, os: true });
  });

  it(
    "is excluded from selectableChannels() — a feature-update version has no per-CVE " +
      "concept to key off, so this channel is Run Now only via its own Devices-page action",
    () => {
      expect(selectableChannels("app")).not.toContain("expedited-feature-update");
      expect(selectableChannels("os")).not.toContain("expedited-feature-update");
    },
  );
});
