/**
 * Alternate package sources for app findings winget doesn't drive.
 *
 * Coverage classifies every app finding as `covered` (a winget package matched)
 * or `not-supported` (an app, but no winget package). "Not supported" is a
 * dead-end only if winget is the only repo we know about. This module adds a
 * second tier of honest, real-world repos — Chocolatey and the Microsoft Store —
 * so a not-supported app can still be remediated through the same channels.
 *
 * Honest-preview parity: each source models a real delivery path and surfaces
 * the real package id / call it would make, but execution is simulated in this
 * build (`availability: "preview"`). The mappings are a small *curated* set —
 * hand-verified ids for a handful of apps — rather than a live repo index, which
 * is what production would resolve. Keep this list small and trustworthy.
 *
 * Pure and deterministic so it can be unit-tested and shared by API + web.
 */
import { z } from "zod";
import { normalizeTitle } from "./winget.js";

/** The alternate repos PatchPilot can resolve a not-supported app to. */
export const PackageSource = z.enum(["chocolatey", "microsoft-store"]);
export type PackageSource = z.infer<typeof PackageSource>;

export interface SourceSpec {
  source: PackageSource;
  label: string;
  /** How the package is delivered when this source runs. */
  delivery: string;
  /**
   * Honest-preview flag: these sources are modeled end-to-end but not yet wired
   * to a live repo, so the UI must never imply a production guarantee.
   */
  availability: "preview";
  /** One-line note shown in the UI to set expectations honestly. */
  note: string;
}

export const SOURCE_SPECS: Record<PackageSource, SourceSpec> = {
  chocolatey: {
    source: "chocolatey",
    label: "Chocolatey",
    delivery: "choco upgrade, run as SYSTEM via the chosen channel",
    // `availability` here still reads "preview" (SourceSpec's type only has that
    // one value — see sources.test.ts) but that no longer means "always
    // simulated": Live Response actually bootstraps choco.exe and runs the
    // upgrade on the device today. The remaining preview-ness is per-channel
    // (win32-app/Intune-remediation), same as it already is for winget — see
    // CHANNEL_SPECS[channel].availability, which the UI/preflight check instead.
    availability: "preview",
    note: "Community repo package, delivered through the chosen channel. Real execution via Defender Live Response; still simulated on the other channels (same as winget).",
  },
  "microsoft-store": {
    source: "microsoft-store",
    label: "Microsoft Store",
    delivery: "winget install --source msstore (Store-published app)",
    availability: "preview",
    note: "Store-published app — deployed via the Microsoft Store source. Preview in this build.",
  },
};

/** A not-supported app's resolution in an alternate repo. */
export interface AltSource {
  source: PackageSource;
  /** The source-native package id — a Chocolatey id or a Store product id. */
  packageId: string;
  /** Display name of the package in that repo. */
  name: string;
}

/**
 * Curated demo mappings: a few apps winget doesn't drive, each mapped to a real,
 * plausible package id in an alternate repo. Keyed by `normalizeTitle(software)`
 * so a Defender software title resolves regardless of version/arch noise.
 *
 * These are intentionally small and hand-verified. Production would resolve them
 * from the live Chocolatey / Store indexes; here they are fixtures so the demo
 * shows real ids without reaching the network.
 */
const CURATED: { titles: string[]; sources: AltSource[] }[] = [
  {
    titles: ["Greenshot"],
    sources: [{ source: "chocolatey", packageId: "greenshot", name: "Greenshot" }],
  },
  {
    titles: ["WhatsApp", "WhatsApp Desktop"],
    sources: [
      { source: "microsoft-store", packageId: "9NKSQGP7F2NH", name: "WhatsApp" },
    ],
  },
];

/** normalizeTitle(software) -> the alternate sources we can drive it through. */
export const ALT_SOURCE_MAP: ReadonlyMap<string, readonly AltSource[]> = new Map(
  CURATED.flatMap((e) =>
    e.titles.map((t) => [normalizeTitle(t), e.sources] as const),
  ),
);

/** Curated alternate sources for a software title, or `[]` if none are known. */
export function altSourcesFor(
  software: string | null | undefined,
): readonly AltSource[] {
  if (!software) return [];
  return ALT_SOURCE_MAP.get(normalizeTitle(software)) ?? [];
}

/** Resolve a specific source's package id for a software title, if curated. */
export function altSourceFor(
  software: string | null | undefined,
  source: PackageSource,
): AltSource | null {
  return altSourcesFor(software).find((a) => a.source === source) ?? null;
}
