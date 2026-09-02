import { describe, expect, it } from "vitest";
import {
  formatOs,
  isOsFinding,
  latestClientBuild,
  windowsLineForBuild,
  resolveTargetBuild,
  isClientWindows,
  isDeviceBehindFeatureUpdate,
} from "./os.js";

describe("formatOs", () => {
  it("names current Windows 11 client builds with edition + feature update", () => {
    expect(
      formatOs({ operatingSystem: "Windows", osVersion: "10.0.26200.1234", skuFamily: "Enterprise" }),
    ).toBe("Windows 11 Enterprise 25H2");
    expect(
      formatOs({ operatingSystem: "Windows", osVersion: "10.0.26100", skuFamily: "Professional" }),
    ).toBe("Windows 11 Pro 24H2");
    expect(
      formatOs({ operatingSystem: "Windows", osVersion: "10.0.22631", skuFamily: "Pro" }),
    ).toBe("Windows 11 Pro 23H2");
  });

  it("names Windows 10 client builds (below the Win11 threshold)", () => {
    expect(
      formatOs({ operatingSystem: "Windows", osVersion: "10.0.19045", skuFamily: "Professional" }),
    ).toBe("Windows 10 Pro 22H2");
    expect(
      formatOs({ operatingSystem: "Windows", osVersion: "10.0.19044", skuFamily: "Enterprise" }),
    ).toBe("Windows 10 Enterprise 21H2");
  });

  it("names Windows Server by release year, appending the feature-update build", () => {
    // 20348 has no client-release label, so no build suffix is shown.
    expect(formatOs({ operatingSystem: "Windows Server", osVersion: "10.0.20348" })).toBe(
      "Windows Server 2022",
    );
    expect(
      formatOs({ operatingSystem: "Windows Server", osVersion: "10.0.14393", skuFamily: "ServerStandard" }),
    ).toBe("Windows Server 2016 (Build 1607)");
    expect(formatOs({ operatingSystem: "Windows Server", osVersion: "10.0.26100" })).toBe(
      "Windows Server 2025 (Build 24H2)",
    );
  });

  it("detects Server from Defender osPlatform when Intune reports a bare 'Windows'", () => {
    // The real-world bug: Intune's operatingSystem is "Windows" (not "Windows
    // Server") for servers, so without osPlatform a 2019 box read as "Windows 10
    // 1809". Defender's osPlatform is the authoritative server signal.
    expect(
      formatOs({
        operatingSystem: "Windows",
        osVersion: "10.0.17763",
        osPlatform: "WindowsServer2019",
      }),
    ).toBe("Windows Server 2019 (Build 1809)");
  });

  it("prefers Server naming even though build 26100 collides with Win11 24H2", () => {
    expect(formatOs({ operatingSystem: "Windows Server", osVersion: "10.0.26100" })).toBe(
      "Windows Server 2025 (Build 24H2)",
    );
    expect(formatOs({ operatingSystem: "Windows", osVersion: "10.0.26100", skuFamily: "Pro" })).toBe(
      "Windows 11 Pro 24H2",
    );
  });

  it("omits the edition when skuFamily is missing or unrecognised", () => {
    expect(formatOs({ operatingSystem: "Windows", osVersion: "10.0.26100" })).toBe(
      "Windows 11 24H2",
    );
    expect(
      formatOs({ operatingSystem: "Windows", osVersion: "10.0.26100", skuFamily: "Mystery" }),
    ).toBe("Windows 11 24H2");
  });

  it("still names the Windows line when the build is unrecognised", () => {
    // Line is known from the build threshold; feature update is dropped rather
    // than guessed, so we get "Windows 11" with no trailing feature label.
    expect(formatOs({ operatingSystem: "Windows", osVersion: "10.0.99999" })).toBe("Windows 11");
  });

  it("falls back to the plain join for non-Windows operating systems", () => {
    expect(formatOs({ operatingSystem: "macOS", osVersion: "14.5" })).toBe("macOS 14.5");
    expect(formatOs({ operatingSystem: "iOS", osVersion: "17.5.1" })).toBe("iOS 17.5.1");
  });

  it("never returns empty for sparse input", () => {
    expect(formatOs({})).toBe("Unknown");
    expect(formatOs({ operatingSystem: "Windows" })).toBe("Windows");
  });
});

describe("isOsFinding", () => {
  it("classifies Windows OS titles as OS findings", () => {
    expect(isOsFinding("Microsoft Windows")).toBe(true);
    expect(isOsFinding("Windows 10")).toBe(true);
    expect(isOsFinding("Windows 11")).toBe(true);
    expect(isOsFinding("Windows Server 2019")).toBe(true);
  });

  it("excludes Windows-branded applications that patch independently of the OS", () => {
    expect(isOsFinding("Windows Terminal")).toBe(false);
    expect(isOsFinding("Windows Subsystem for Linux")).toBe(false);
    expect(isOsFinding("Windows Defender")).toBe(false);
  });

  it("classifies Microsoft Defender / security-platform components as OS findings", () => {
    // These are serviced via the Defender platform updater / Windows Update, not
    // independently winget/Chocolatey-installable — fuzzy-matching them against an
    // unrelated catalog package (e.g. a third-party "disable Defender" utility) is
    // worse than no match at all.
    expect(isOsFinding("Microsoft Windows Defender")).toBe(true);
    expect(isOsFinding("Microsoft Defender For Endpoint")).toBe(true);
    expect(isOsFinding("Microsoft Defender Antimalware Platform")).toBe(true);
    expect(isOsFinding("Microsoft Defender Security Intelligence Updates")).toBe(true);
  });

  it("treats unrelated application titles as non-OS findings", () => {
    expect(isOsFinding("Google Chrome")).toBe(false);
    expect(isOsFinding("Zoom Meetings")).toBe(false);
  });

  it("handles empty/missing input", () => {
    expect(isOsFinding(null)).toBe(false);
    expect(isOsFinding(undefined)).toBe(false);
    expect(isOsFinding("")).toBe(false);
    expect(isOsFinding("   ")).toBe(false);
  });
});

describe("latestClientBuild / windowsLineForBuild", () => {
  it("returns the highest known client build", () => {
    expect(latestClientBuild()).toBe(26200);
  });

  it("names the Windows line either side of the 11 threshold", () => {
    expect(windowsLineForBuild(19045)).toBe("Windows 10");
    expect(windowsLineForBuild(22000)).toBe("Windows 11");
    expect(windowsLineForBuild(26100)).toBe("Windows 11");
  });
});

describe("resolveTargetBuild", () => {
  it("resolves a known label to its build number", () => {
    expect(resolveTargetBuild("24H2")).toBe(26100);
    expect(resolveTargetBuild("22H2")).toBe(19045);
  });

  it("falls back to the latest build for null, unset, or unrecognised labels", () => {
    expect(resolveTargetBuild(null)).toBe(latestClientBuild());
    expect(resolveTargetBuild(undefined)).toBe(latestClientBuild());
    expect(resolveTargetBuild("not-a-real-label")).toBe(latestClientBuild());
  });
});

describe("isClientWindows", () => {
  it("accepts Windows 10/11 client display strings", () => {
    expect(isClientWindows("Windows 11 Pro 24H2")).toBe(true);
    expect(isClientWindows("Windows 10 Enterprise 22H2")).toBe(true);
    expect(isClientWindows("Windows 11")).toBe(true);
  });

  it("rejects Windows Server", () => {
    expect(isClientWindows("Windows Server 2022")).toBe(false);
    expect(isClientWindows("Windows Server 2019 (Build 1809)")).toBe(false);
  });

  it("rejects non-Windows and empty input", () => {
    expect(isClientWindows("macOS 14.5")).toBe(false);
    expect(isClientWindows(null)).toBe(false);
    expect(isClientWindows(undefined)).toBe(false);
    expect(isClientWindows("")).toBe(false);
  });
});

describe("isDeviceBehindFeatureUpdate", () => {
  it("flags a client device whose build is below the target", () => {
    expect(isDeviceBehindFeatureUpdate(22631, "Windows 11 Pro 23H2", 26100)).toBe(true);
  });

  it("does not flag a device already at or ahead of the target", () => {
    expect(isDeviceBehindFeatureUpdate(26100, "Windows 11 Pro 24H2", 26100)).toBe(false);
    expect(isDeviceBehindFeatureUpdate(26200, "Windows 11 Pro 25H2", 26100)).toBe(false);
  });

  it("never flags Server or non-Windows devices regardless of build", () => {
    expect(isDeviceBehindFeatureUpdate(20348, "Windows Server 2022", 26100)).toBe(false);
    expect(isDeviceBehindFeatureUpdate(23, "macOS 14.5", 26100)).toBe(false);
  });

  it("never flags a device with no osBuild yet (unsynced or non-Windows)", () => {
    expect(isDeviceBehindFeatureUpdate(null, "Windows 11 Pro 23H2", 26100)).toBe(false);
    expect(isDeviceBehindFeatureUpdate(undefined, "Windows 11 Pro 23H2", 26100)).toBe(false);
  });
});
