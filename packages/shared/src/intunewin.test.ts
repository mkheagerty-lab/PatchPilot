import { createDecipheriv, createHmac } from "node:crypto";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildIntuneWinPackage, type BuildIntuneWinPackageResult } from "./intunewin.js";

/** Mirrors what a real Intune content-upload caller does after fetching `fileEncryptionInfo`
 *  back off the app — this repo has no such caller yet, so the round-trip lives only here. */
function decryptIntuneWinPackage(result: BuildIntuneWinPackageResult): Record<string, Uint8Array> {
  const { package: pkg, encryptionInfo } = result;
  const mac = pkg.subarray(0, 32);
  const iv = pkg.subarray(32, 48);
  const ciphertext = pkg.subarray(48);

  const macKey = Buffer.from(encryptionInfo.macKey, "base64");
  const expectedMac = createHmac("sha256", macKey).update(Buffer.concat([iv, ciphertext])).digest();
  expect(mac.equals(expectedMac)).toBe(true);

  const encryptionKey = Buffer.from(encryptionInfo.encryptionKey, "base64");
  const decipher = createDecipheriv("aes-256-cbc", encryptionKey, iv);
  const contentZip = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  expect(contentZip.length).toBe(result.unencryptedContentSize);

  return unzipSync(new Uint8Array(contentZip));
}

describe("buildIntuneWinPackage", () => {
  it("round-trips file content through encrypt -> decrypt byte-identical", () => {
    const installScript = Buffer.from("Write-Host 'installing'\nexit 0\n", "utf-8");
    const detectScript = Buffer.from("Write-Host 'detecting'\n", "utf-8");

    const result = buildIntuneWinPackage({
      files: [
        { name: "install.ps1", content: installScript },
        { name: "detect.ps1", content: detectScript },
      ],
      setupFileName: "install.ps1",
    });

    const decrypted = decryptIntuneWinPackage(result);

    expect(Buffer.from(decrypted["install.ps1"]!).equals(installScript)).toBe(true);
    expect(Buffer.from(decrypted["detect.ps1"]!).equals(detectScript)).toBe(true);
  });

  it("round-trips larger binary-ish content", () => {
    const bytes = Buffer.alloc(50_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

    const result = buildIntuneWinPackage({
      files: [{ name: "payload.bin", content: bytes }],
      setupFileName: "payload.bin",
    });

    const decrypted = decryptIntuneWinPackage(result);
    expect(Buffer.from(decrypted["payload.bin"]!).equals(bytes)).toBe(true);
  });

  it("produces independent random keys/IVs across builds of identical content", () => {
    const files = [{ name: "a.ps1", content: Buffer.from("same content") }];
    const a = buildIntuneWinPackage({ files, setupFileName: "a.ps1" });
    const b = buildIntuneWinPackage({ files, setupFileName: "a.ps1" });

    expect(a.encryptionInfo.encryptionKey).not.toBe(b.encryptionInfo.encryptionKey);
    expect(a.encryptionInfo.initializationVector).not.toBe(b.encryptionInfo.initializationVector);
    expect(a.encryptionInfo.mac).not.toBe(b.encryptionInfo.mac);
    // Same plaintext content zip -> same digest, even though the encrypted bytes differ.
    expect(a.encryptionInfo.fileDigest).toBe(b.encryptionInfo.fileDigest);
  });

  it("throws when setupFileName is not among the packaged files", () => {
    expect(() =>
      buildIntuneWinPackage({
        files: [{ name: "install.ps1", content: Buffer.from("x") }],
        setupFileName: "missing.ps1",
      }),
    ).toThrow(/setupFileName/);
  });

  it("throws when files is empty", () => {
    expect(() => buildIntuneWinPackage({ files: [], setupFileName: "install.ps1" })).toThrow(
      /at least one file/,
    );
  });
});
