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

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Every package.json whose version tracks the product release — packages/*
// stay internal/unversioned (never published, never referenced by tag).
const VERSIONED_PACKAGES = ["package.json", "apps/api/package.json", "apps/worker/package.json", "apps/web/package.json"];

/**
 * Duplicated from `compareWingetVersions` in packages/shared/src/winget.ts
 * (same segment-by-segment comparator) rather than imported: this script
 * runs as plain `node`, with no TS loader available at the repo root, so it
 * can't import a workspace package's `.ts` source directly. Keep this in
 * sync if that comparator's behavior ever changes.
 */
function compareVersions(a, b) {
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

function readVersion(relPath) {
  const text = readFileSync(path.join(ROOT, relPath), "utf8");
  const match = text.match(/"version":\s*"([^"]+)"/);
  if (!match) throw new Error(`${relPath}: no "version" field found`);
  return match[1];
}

function writeVersion(relPath, newVersion) {
  const abs = path.join(ROOT, relPath);
  const text = readFileSync(abs, "utf8");
  const next = text.replace(/"version":\s*"[^"]+"/, `"version": "${newVersion}"`);
  writeFileSync(abs, next);
}

const newVersion = process.argv[2];
if (!newVersion) {
  console.error("usage: bump-version.mjs <new-version>  (e.g. 0.2.0)");
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error(`"${newVersion}" doesn't look like a plain X.Y.Z version.`);
  process.exit(1);
}

const currentVersion = readVersion("package.json");
if (compareVersions(newVersion, currentVersion) <= 0) {
  console.error(`"${newVersion}" must be greater than the current version "${currentVersion}".`);
  process.exit(1);
}

for (const relPath of VERSIONED_PACKAGES) {
  writeVersion(relPath, newVersion);
  console.log(`  ${relPath}: ${currentVersion} -> ${newVersion}`);
}

console.log(`\nDone. Next steps:`);
console.log(`  1. Move CHANGELOG.md's "## Unreleased" entries into a new "## [${newVersion}] - ${new Date().toISOString().slice(0, 10)}" section.`);
console.log(`  2. Commit, then: git tag v${newVersion} && git push origin v${newVersion}`);
console.log(`     (pushing the tag triggers .github/workflows/release.yml)`);
