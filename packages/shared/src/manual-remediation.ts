import { z } from "zod";

interface ManualRemediationFamily {
  id: string;
  pattern: RegExp;
  reason: string;
}

/**
 * Some vulnerable software has no safe automated Run Now path. Each family
 * here is always routed to manual remediation instead of being offered as a
 * one-click fix, regardless of channel or package mapping — see the
 * per-family `reason` for why.
 */
const MANUAL_REMEDIATION_FAMILIES: ManualRemediationFamily[] = [
  {
    id: "openssl",
    pattern: /\bopenssl\b/i,
    reason:
      "OpenSSL is typically statically linked into other applications, so there is no standalone package to silently upgrade.",
  },
  {
    id: "mysql",
    pattern: /\bmysql\b/i,
    reason:
      "MySQL's upgrade path requires interactive service/data reconfiguration that a silent winget/choco install would risk corrupting.",
  },
  {
    id: "log4j",
    pattern: /\blog4j\b/i,
    reason:
      "Log4j ships bundled inside other applications' JAR files rather than as an installable package — fixing it requires the vendor to rebuild and redeploy the host application, not a silent installer swap.",
  },
];

export function requiresManualRemediation(software: string | null | undefined): boolean {
  return manualRemediationReason(software) !== null;
}

/** The reason a software family is blocked from automated Run Now, or null if it isn't. */
export function manualRemediationReason(software: string | null | undefined): string | null {
  const s = (software ?? "").trim();
  if (!s) return null;
  return MANUAL_REMEDIATION_FAMILIES.find((f) => f.pattern.test(s))?.reason ?? null;
}

/**
 * A tracked "marked as manually remediated" record — the Remediation
 * Options Manual → record sub-flow. Unrelated to the hard-blocked families
 * above: this is an engineer's free-text note that a finding was fixed by
 * hand, kept "waiting on Defender" until the next sync stops reporting the
 * CVE on that device. Shared between API and web so both sides agree on
 * the shape (see `manual_remediations` table, packages/db/src/schema.ts).
 */
export const ManualRemediation = z.object({
  id: z.string(),
  tenantId: z.string(),
  deviceId: z.string(),
  cveId: z.string().nullable(),
  software: z.string(),
  notes: z.string(),
  engineer: z.string(),
  markedAt: z.string(),
  confirmedAt: z.string().nullable(),
});
export type ManualRemediation = z.infer<typeof ManualRemediation>;
