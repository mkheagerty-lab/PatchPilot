import { createDecipheriv } from "node:crypto";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { getWin32ScriptWrapperPackage, getWin32WrapperPackage } from "./win32-app.js";

describe("getWin32WrapperPackage", () => {
  it("returns the same cached object on repeated calls for a family", () => {
    const a = getWin32WrapperPackage("winget");
    const b = getWin32WrapperPackage("winget");
    expect(a).toBe(b);
  });

  it("builds distinct content per family", () => {
    const winget = getWin32WrapperPackage("winget");
    const chocolatey = getWin32WrapperPackage("chocolatey");
    expect(winget.encryptionInfo.fileDigest).not.toBe(chocolatey.encryptionInfo.fileDigest);
  });

  it("always uses install.ps1 as the setup file name", () => {
    expect(getWin32WrapperPackage("winget").setupFileName).toBe("install.ps1");
    expect(getWin32WrapperPackage("chocolatey").setupFileName).toBe("install.ps1");
  });

  it("packages both install.ps1 and uninstall.ps1 in the same content, since installCommandLine/uninstallCommandLine both reference files within one uploaded content version", () => {
    const pkg = getWin32WrapperPackage("winget");
    // Decrypt the same way the Intune service (the real consumer of this
    // format) would, to prove the zip actually contains both entry points.
    const iv = pkg.package.subarray(32, 48);
    const ciphertext = pkg.package.subarray(48);

    const encryptionKey = Buffer.from(pkg.encryptionInfo.encryptionKey, "base64");
    const decipher = createDecipheriv("aes-256-cbc", encryptionKey, iv);
    const contentZip = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const files = unzipSync(new Uint8Array(contentZip));

    expect(Object.keys(files).sort()).toEqual(["install.ps1", "uninstall.ps1"]);
  });

  it("produces a usable package with non-zero content size", () => {
    const pkg = getWin32WrapperPackage("chocolatey");
    expect(pkg.package.length).toBeGreaterThan(0);
    expect(pkg.unencryptedContentSize).toBeGreaterThan(0);
    expect(pkg.encryptionInfo.profileIdentifier).toBe("ProfileVersion1");
  });
});

/**
 * Unlike getWin32WrapperPackage's family-keyed cache (byte-identical content
 * across every package in a family), this one is keyed on
 * `scriptCatalogEntryId:contentHash` because a script-sourced wrapper embeds
 * one specific catalog entry's own content — no two entries, and no two
 * edits of the same entry, may share a cached package.
 */
describe("getWin32ScriptWrapperPackage", () => {
  const baseInput = {
    scriptCatalogEntryId: "script-abc",
    scriptContent: "Write-Output 'hello'",
    contentHash: "hash-1",
  };

  it("returns the same cached object on repeated calls with the same entry id + content hash", () => {
    const a = getWin32ScriptWrapperPackage(baseInput);
    const b = getWin32ScriptWrapperPackage({ ...baseInput });
    expect(a).toBe(b);
  });

  it("builds distinct content for a different content hash on the same entry (edited script)", () => {
    const original = getWin32ScriptWrapperPackage(baseInput);
    const edited = getWin32ScriptWrapperPackage({ ...baseInput, contentHash: "hash-2" });
    expect(original).not.toBe(edited);
    expect(original.encryptionInfo.fileDigest).not.toBe(edited.encryptionInfo.fileDigest);
  });

  it("builds distinct content for a different entry id, even with identical script content", () => {
    const a = getWin32ScriptWrapperPackage(baseInput);
    const b = getWin32ScriptWrapperPackage({ ...baseInput, scriptCatalogEntryId: "script-xyz" });
    expect(a).not.toBe(b);
  });

  it("re-hits the same cache entry when an edit is reverted back to a prior hash", () => {
    const first = getWin32ScriptWrapperPackage(baseInput);
    getWin32ScriptWrapperPackage({ ...baseInput, contentHash: "hash-2" });
    const revertedBack = getWin32ScriptWrapperPackage({ ...baseInput });
    expect(revertedBack).toBe(first);
  });

  it("always uses install.ps1 as the setup file name", () => {
    expect(getWin32ScriptWrapperPackage(baseInput).setupFileName).toBe("install.ps1");
  });

  it("packages both install.ps1 and uninstall.ps1, with the script content embedded in install.ps1", () => {
    const pkg = getWin32ScriptWrapperPackage(baseInput);
    const iv = pkg.package.subarray(32, 48);
    const ciphertext = pkg.package.subarray(48);
    const encryptionKey = Buffer.from(pkg.encryptionInfo.encryptionKey, "base64");
    const decipher = createDecipheriv("aes-256-cbc", encryptionKey, iv);
    const contentZip = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const files = unzipSync(new Uint8Array(contentZip));

    expect(Object.keys(files).sort()).toEqual(["install.ps1", "uninstall.ps1"]);
    const installText = Buffer.from(files["install.ps1"]!).toString("utf-8");
    expect(installText).toContain(baseInput.scriptContent);
    expect(installText).toContain(baseInput.scriptCatalogEntryId);
  });
});
