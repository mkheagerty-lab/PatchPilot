#!/usr/bin/env node
// Bumps PatchPilot's version ahead of cutting a release tag (see
// .github/workflows/release.yml, which asserts the pushed tag matches
// whatever this script last wrote to the root package.json).
//
// Usage: node scripts/bump-version.mjs 0.2.0
// (or: pnpm version:bump 0.2.0)
//
// Regex-replaces the `"version"` line rather than JSON.parse/stringify, so a
// bump doesn't reformat the rest of each package.json in the diff.
//
// Prefer `pnpm release 0.2.0` (scripts/release.mjs) for cutting an actual
// release — it chains this bump with the changelog cut, commit, tag, and
// push. This script (and its exports below) stay usable standalone for a
// bare version bump, and release.mjs imports `bumpVersions`/`compareVersions`
// from here rather than duplicating them.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Every package.json whose version tracks the product release — packages/*
// stay internal/unversioned (never published, never referenced by tag).
export const VERSIONED_PACKAGES = ["package.json", "apps/api/package.json", "apps/worker/package.json", "apps/web/package.json"];

/**
 * Duplicated from `compareWingetVersions` in packages/shared/src/winget.ts
 * (same segment-by-segment comparator) rather than imported: this script
 * runs as plain `node`, with no TS loader available at the repo root, so it
 * can't import a workspace package's `.ts` source directly. Keep this in
 * sync if that comparator's behavior ever changes.
 */
export function compareVersions(a, b) {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? "0";
    const sb = pb[i] ?? "0";
    const aNum = /^\d+$/.test(sa);
    const bNum = /^\d+$/.test(sb);
    if (aNum && bNum) {
      const na = Number.parseInt(sa, 10);
      const nb = Number.parseInt(sb, 10);
      if (na !== nb) return na - nb;
    } else {
      const c = sa.localeCompare(sb);
      if (c !== 0) return c;
    }
  }
  return 0;
}

export function readVersion(root, relPath) {
  const text = readFileSync(path.join(root, relPath), "utf8");
  const match = text.match(/"version":\s*"([^"]+)"/);
  if (!match) throw new Error(`${relPath}: no "version" field found`);
  return match[1];
}

function writeVersion(root, relPath, newVersion) {
  const abs = path.join(root, relPath);
  const text = readFileSync(abs, "utf8");
  const next = text.replace(/"version":\s*"[^"]+"/, `"version": "${newVersion}"`);
  writeFileSync(abs, next);
}

/**
 * Bumps every entry in VERSIONED_PACKAGES to `newVersion`, validating it's
 * greater than the root package.json's current version first. Returns
 * `{ currentVersion, changes: [{ path, from, to }] }`. Throws (doesn't
 * process.exit) on validation failure, so callers like release.mjs can
 * decide how to report it.
 */
export function bumpVersions(root, newVersion) {
  if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    throw new Error(`"${newVersion}" doesn't look like a plain X.Y.Z version.`);
  }
  const currentVersion = readVersion(root, "package.json");
  if (compareVersions(newVersion, currentVersion) <= 0) {
    throw new Error(`"${newVersion}" must be greater than the current version "${currentVersion}".`);
  }
  const changes = VERSIONED_PACKAGES.map((relPath) => {
    writeVersion(root, relPath, newVersion);
    return { path: relPath, from: currentVersion, to: newVersion };
  });
  return { currentVersion, changes };
}

// Only run the CLI body when this file is executed directly (`node
// bump-version.mjs ...`), not when imported by release.mjs.
if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "")) {
  const newVersion = process.argv[2];
  if (!newVersion) {
    console.error("usage: bump-version.mjs <new-version>  (e.g. 0.2.0)");
    process.exit(1);
  }

  let result;
  try {
    result = bumpVersions(ROOT, newVersion);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  for (const { path: relPath, from, to } of result.changes) {
    console.log(`  ${relPath}: ${from} -> ${to}`);
  }

  console.log(`\nDone. Next steps:`);
  console.log(`  1. Move CHANGELOG.md's "## Unreleased" entries into a new "## [${newVersion}] - ${new Date().toISOString().slice(0, 10)}" section.`);
  console.log(`  2. Commit, then: git tag v${newVersion} && git push origin v${newVersion}`);
  console.log(`     (pushing the tag triggers .github/workflows/release.yml)`);
  console.log(`\n(Or skip all of the above next time: pnpm release ${newVersion} does this whole flow in one step.)`);
}
