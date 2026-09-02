import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { zipSync } from "fflate";

/**
 * Builds the encrypted content blob a `win32LobApp`'s content-upload pipeline
 * sends to Azure Blob Storage, in the wire format Intune expects.
 *
 * This is deliberately NOT a reimplementation of Microsoft's
 * `IntuneWinAppUtil.exe` output — that tool produces an outer `.intunewin`
 * ZIP containing `IntuneWinPackage/Metadata/Detection.xml` alongside the
 * encrypted payload, because its Detection.xml is read by the Intune admin
 * center's own browser-based upload flow (drag-and-drop a `.intunewin` file
 * in the portal) to recover the encryption params client-side. The Graph API
 * upload path this module feeds does not go through that flow: the encryption
 * params are submitted directly as JSON (`fileEncryptionInfo`) in the commit
 * call, and only the raw encrypted bytes below are ever chunked and PUT to
 * the blob SAS URI. So there is no outer ZIP, no Detection.xml, and no
 * `setupFileName`-shaped file layout requirement beyond "the file exists in
 * the content ZIP" — building the full IntuneWinAppUtil container format
 * would be extra work this upload path never reads.
 *
 * Wire format (reverse-engineered from IntuneWinAppUtil's own encryption
 * routine and confirmed against several independent third-party
 * reimplementations that upload via Graph the same way this does):
 *
 *   HMAC-SHA256(macKey, IV || ciphertext)  — 32 bytes, written FIRST
 *   IV                                     — 16 bytes
 *   AES-256-CBC(encryptionKey, IV) of the content ZIP, PKCS7-padded
 *
 * `encryptionKey`/`macKey`/`initializationVector` are independent random
 * values per build — reusing a key across packages would let anyone who
 * captured one encrypted blob decrypt any other sharing that key, which
 * defeats the point of Intune requiring per-content encryption at all.
 */

export interface IntuneWinFile {
  /** Path inside the content ZIP, e.g. "install.ps1" — flat is fine, wrapper scripts need no subfolders. */
  name: string;
  content: Buffer;
}

export interface BuildIntuneWinPackageInput {
  files: IntuneWinFile[];
  /** Must match one entry in `files` by name — the win32LobApp's installCommandLine invokes this file. */
  setupFileName: string;
}

export interface IntuneWinEncryptionInfo {
  encryptionKey: string;
  macKey: string;
  initializationVector: string;
  mac: string;
  /** Fixed per Intune's own encryption scheme — there has only ever been this one profile. */
  profileIdentifier: "ProfileVersion1";
  /** SHA-256 of the UNENCRYPTED content ZIP, base64 — lets the service verify decryption round-tripped correctly. */
  fileDigest: string;
  fileDigestAlgorithm: "SHA256";
}

export interface BuildIntuneWinPackageResult {
  /** mac(32) || iv(16) || ciphertext — upload this, unmodified, as the blob content. */
  package: Buffer;
  encryptionInfo: IntuneWinEncryptionInfo;
  /** The content ZIP's size before encryption — Intune's file-placeholder `size` field. */
  unencryptedContentSize: number;
}

export function buildIntuneWinPackage(input: BuildIntuneWinPackageInput): BuildIntuneWinPackageResult {
  const { files, setupFileName } = input;
  if (files.length === 0) {
    throw new Error("buildIntuneWinPackage: at least one file is required");
  }
  if (!files.some((f) => f.name === setupFileName)) {
    throw new Error(`buildIntuneWinPackage: setupFileName "${setupFileName}" is not among the packaged files`);
  }

  const zipInput: Record<string, Uint8Array> = {};
  for (const file of files) {
    zipInput[file.name] = new Uint8Array(file.content.buffer, file.content.byteOffset, file.content.byteLength);
  }
  const contentZip = Buffer.from(zipSync(zipInput, { level: 6 }));

  const encryptionKey = randomBytes(32);
  const macKey = randomBytes(32);
  const iv = randomBytes(16);

  const cipher = createCipheriv("aes-256-cbc", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(contentZip), cipher.final()]);

  const mac = createHmac("sha256", macKey).update(Buffer.concat([iv, ciphertext])).digest();
  const fileDigest = createHash("sha256").update(contentZip).digest();

  return {
    package: Buffer.concat([mac, iv, ciphertext]),
    encryptionInfo: {
      encryptionKey: encryptionKey.toString("base64"),
      macKey: macKey.toString("base64"),
      initializationVector: iv.toString("base64"),
      mac: mac.toString("base64"),
      profileIdentifier: "ProfileVersion1",
      fileDigest: fileDigest.toString("base64"),
      fileDigestAlgorithm: "SHA256",
    },
    unencryptedContentSize: contentZip.length,
  };
}
