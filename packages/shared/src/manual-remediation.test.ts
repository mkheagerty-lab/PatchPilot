import { describe, expect, it } from "vitest";
import { manualRemediationReason, requiresManualRemediation } from "./manual-remediation.js";

describe("requiresManualRemediation", () => {
  it("flags OpenSSL", () => {
    expect(requiresManualRemediation("OpenSSL")).toBe(true);
    expect(requiresManualRemediation("OpenSSL 3.0.x")).toBe(true);
  });

  it("flags MySQL", () => {
    expect(requiresManualRemediation("MySQL")).toBe(true);
    expect(requiresManualRemediation("MySQL Server 8.0")).toBe(true);
    expect(requiresManualRemediation("Oracle MySQL Community Edition")).toBe(true);
  });

  it("flags Log4j", () => {
    expect(requiresManualRemediation("Log4j")).toBe(true);
    expect(requiresManualRemediation("Apache Log4j")).toBe(true);
    expect(requiresManualRemediation("Apache Log4j 2.17.1")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(requiresManualRemediation("mysql server")).toBe(true);
    expect(requiresManualRemediation("openssl")).toBe(true);
    expect(requiresManualRemediation("log4j")).toBe(true);
  });

  it("does not flag unrelated software", () => {
    expect(requiresManualRemediation("7-Zip")).toBe(false);
    expect(requiresManualRemediation("Google Chrome")).toBe(false);
    expect(requiresManualRemediation("Mozilla Firefox")).toBe(false);
  });

  it("does not false-positive on substrings", () => {
    expect(requiresManualRemediation("MySQLWorkbenchViewer")).toBe(false);
    expect(requiresManualRemediation("NotLog4jRelated")).toBe(false);
  });

  it("handles null/undefined/empty", () => {
    expect(requiresManualRemediation(null)).toBe(false);
    expect(requiresManualRemediation(undefined)).toBe(false);
    expect(requiresManualRemediation("")).toBe(false);
    expect(requiresManualRemediation("   ")).toBe(false);
  });
});

describe("manualRemediationReason", () => {
  it("returns the family-specific reason", () => {
    expect(manualRemediationReason("OpenSSL")).toMatch(/statically linked/);
    expect(manualRemediationReason("MySQL Server 8.0")).toMatch(/service\/data reconfiguration/);
    expect(manualRemediationReason("Apache Log4j 2.17.1")).toMatch(/JAR files/);
  });

  it("returns null when no family matches", () => {
    expect(manualRemediationReason("7-Zip")).toBeNull();
    expect(manualRemediationReason(null)).toBeNull();
    expect(manualRemediationReason(undefined)).toBeNull();
    expect(manualRemediationReason("")).toBeNull();
  });
});
