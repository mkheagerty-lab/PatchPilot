#!/usr/bin/env node
// Cuts a PatchPilot release end to end: bump versions, cut the changelog,
// commit, tag, and push — the tag push is what triggers
// .github/workflows/release.yml (lint/typecheck/test/build, a tag-matches-
// package.json guard, then publishing the GitHub Release).
//
// Usage:
//   pnpm release 0.2.0             cut the release for real
//   pnpm release 0.2.0 --dry-run   preview every change, touch nothing
//
// This wraps scripts/bump-version.mjs (imported, not shelled out to) plus a
// CHANGELOG.md "## Unreleased" -> "## [X.Y.Z] - <date>" cut. Both remain
// individually usable — `pnpm version:bump` for a bare version bump, editing
// CHANGELOG.md by hand for a bare changelog edit — this script is just the
// documented happy path chained into one command.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { bumpVersions, compareVersions, readVersion } from "./bump-version.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHANGELOG_PATH = path.join(ROOT, "CHANGELOG.md");

function git(args, { capture = false } = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function gitCapture(args) {
  return git(args, { capture: true }).trim();
}

/**
 * Finds CHANGELOG.md's "## Unreleased" section. Returns null if the heading
 * doesn't exist at all (unusual — the file should always have one going
 * forward). Otherwise returns the heading's start offset, the offset where
 * the next "## " heading (or EOF) begins, and the raw body text between them.
 */
function findUnreleasedSection(changelog) {
  const headingRe = /^## Unreleased\s*$/m;
  const headingMatch = headingRe.exec(changelog);
  if (!headingMatch) return null;
  const headingEnd = headingMatch.index + headingMatch[0].length;
  const rest = changelog.slice(headingEnd);
  const nextHeadingMatch = rest.match(/^## /m);
  const bodyEnd = nextHeadingMatch ? headingEnd + nextHeadingMatch.index : changelog.length;
  return {
    headingStart: headingMatch.index,
    bodyEnd,
    body: changelog.slice(headingEnd, bodyEnd),
  };
}

/**
 * Replaces the "## Unreleased" section's content with a fresh empty
 * Unreleased section followed by a new dated "## [version]" section holding
 * what used to be under Unreleased. Returns the new file text, or null if
 * there was nothing under Unreleased to cut (heading missing, or empty).
 */
function cutChangelog(changelog, version, date) {
  const section = findUnreleasedSection(changelog);
  if (!section) return null;
  const body = section.body.trim();
  if (!body) return null;
  const replacement = `## Unreleased\n\n## [${version}] - ${date}\n\n${body}\n\n`;
  return changelog.slice(0, section.headingStart) + replacement + changelog.slice(section.bodyEnd);
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  return { version: positional[0], dryRun: flags.has("--dry-run") };
}

function repoSlugFromRemote() {
  try {
    const url = gitCapture(["remote", "get-url", "origin"]);
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function main() {
  const { version, dryRun } = parseArgs(process.argv.slice(2));
  if (!version) {
    console.error("usage: release.mjs <new-version> [--dry-run]  (e.g. 0.2.0)");
    process.exit(1);
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`"${version}" doesn't look like a plain X.Y.Z version.`);
    process.exit(1);
  }

  const tag = `v${version}`;
  const date = new Date().toISOString().slice(0, 10);

  // --- Preflight ---------------------------------------------------------
  const branch = gitCapture(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") {
    const msg = `On branch "${branch}", not "main". A release should be cut from main.`;
    if (dryRun) {
      console.warn(`[dry-run] WARNING: ${msg}`);
    } else {
      console.error(msg);
      console.error(`Switch to main (merge/pull first) and re-run.`);
      process.exit(1);
    }
  }

  const dirty = gitCapture(["status", "--porcelain"]);
  if (dirty) {
    const msg = "Working tree is not clean:";
    if (dryRun) {
      console.warn(`[dry-run] WARNING: ${msg}\n${dirty}`);
    } else {
      console.error(msg);
      console.error(dirty);
      console.error(`Commit, stash, or discard these changes and re-run.`);
      process.exit(1);
    }
  }

  if (branch === "main") {
    try {
      git(["fetch", "origin", "main", "--quiet"], { capture: true });
      const localHead = gitCapture(["rev-parse", "HEAD"]);
      const remoteHead = gitCapture(["rev-parse", "origin/main"]);
      if (localHead !== remoteHead) {
        const [behind, ahead] = gitCapture(["rev-list", "--left-right", "--count", "origin/main...HEAD"]).split(/\s+/);
        if (Number(behind) > 0) {
          const msg = `Local main is ${behind} commit(s) behind origin/main.`;
          if (dryRun) {
            console.warn(`[dry-run] WARNING: ${msg}`);
          } else {
            console.error(msg);
            console.error(`Run "git pull --ff-only" and re-run.`);
            process.exit(1);
          }
        }
        if (Number(ahead) > 0) {
          console.warn(`Note: local main is ${ahead} commit(s) ahead of origin/main (will be pushed with the release commit).`);
        }
      }
    } catch (err) {
      const msg = `Couldn't fetch origin/main to verify local main is up to date (${err.message.trim().split("\n")[0]}).`;
      if (dryRun) {
        console.warn(`[dry-run] WARNING: ${msg}`);
      } else {
        console.error(msg);
        console.error(`Fix connectivity/auth and re-run, or verify manually and re-run with confidence.`);
        process.exit(1);
      }
    }
  }

  let tagExistsLocally = false;
  try {
    gitCapture(["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
    tagExistsLocally = true;
  } catch {
    // doesn't exist locally — expected
  }
  let tagExistsRemotely = false;
  try {
    tagExistsRemotely = gitCapture(["ls-remote", "--tags", "origin", tag]).length > 0;
  } catch {
    // ls-remote failure here isn't fatal — the later push will surface any real problem
  }
  if (tagExistsLocally || tagExistsRemotely) {
    const where = [tagExistsLocally && "locally", tagExistsRemotely && "on origin"].filter(Boolean).join(" and ");
    const msg = `Tag ${tag} already exists ${where}.`;
    if (dryRun) {
      console.warn(`[dry-run] WARNING: ${msg}`);
    } else {
      console.error(msg);
      console.error(`Pick a different version, or delete the existing tag first if this was a mistake.`);
      process.exit(1);
    }
  }

  // --- Compute what would change ------------------------------------------
  const currentVersion = readVersion(ROOT, "package.json");
  if (compareVersions(version, currentVersion) <= 0) {
    console.error(`"${version}" must be greater than the current version "${currentVersion}".`);
    process.exit(1);
  }

  const changelog = readFileSync(CHANGELOG_PATH, "utf8");
  const newChangelog = cutChangelog(changelog, version, date);
  const section = findUnreleasedSection(changelog);
  const unreleasedBody = section ? section.body.trim() : "";

  // --- Dry run: report and stop --------------------------------------------
  if (dryRun) {
    console.log(`\nDry run for ${tag} (branch: ${branch}, current version: ${currentVersion}):\n`);
    console.log(`Would bump:`);
    for (const relPath of ["package.json", "apps/api/package.json", "apps/worker/package.json", "apps/web/package.json"]) {
      console.log(`  ${relPath}: ${currentVersion} -> ${version}`);
    }
    console.log(`\nChangelog:`);
    if (!section) {
      console.log(`  No "## Unreleased" heading found — CHANGELOG.md would be left untouched.`);
      console.log(`  The GitHub Release would fall back to auto-generated notes.`);
    } else if (!unreleasedBody) {
      console.log(`  "## Unreleased" section is empty — CHANGELOG.md would be left untouched.`);
      console.log(`  The GitHub Release would fall back to auto-generated notes.`);
    } else {
      console.log(`  Would cut the current "## Unreleased" entries into "## [${version}] - ${date}":`);
      for (const line of unreleasedBody.split("\n")) console.log(`    ${line}`);
    }
    console.log(`\nWould then run:`);
    console.log(`  git add ${["package.json", "apps/api/package.json", "apps/worker/package.json", "apps/web/package.json", newChangelog ? "CHANGELOG.md" : null].filter(Boolean).join(" ")}`);
    console.log(`  git commit -m "Release ${tag}"`);
    console.log(`  git tag -a ${tag} -m "${tag}"`);
    console.log(`  git push origin ${branch}`);
    console.log(`  git push origin ${tag}`);
    console.log(`\nNo files were changed. Re-run without --dry-run to actually cut the release.`);
    return;
  }

  // --- Do it ---------------------------------------------------------------
  console.log(`Bumping version ${currentVersion} -> ${version}...`);
  const { changes } = bumpVersions(ROOT, version);
  for (const { path: relPath, from, to } of changes) console.log(`  ${relPath}: ${from} -> ${to}`);

  const addPaths = changes.map((c) => c.path);
  if (newChangelog) {
    writeFileSync(CHANGELOG_PATH, newChangelog);
    addPaths.push("CHANGELOG.md");
    console.log(`Cut "## Unreleased" into "## [${version}] - ${date}" in CHANGELOG.md.`);
  } else if (!section) {
    console.warn(`WARNING: no "## Unreleased" heading found in CHANGELOG.md — leaving it untouched. This release's GitHub Release will fall back to auto-generated notes.`);
  } else {
    console.warn(`WARNING: "## Unreleased" section is empty — leaving CHANGELOG.md untouched. This release's GitHub Release will fall back to auto-generated notes.`);
  }

  console.log(`\nCommitting...`);
  git(["add", ...addPaths]);
  git(["commit", "-m", `Release ${tag}`]);

  console.log(`Tagging ${tag}...`);
  git(["tag", "-a", tag, "-m", tag]);

  console.log(`Pushing ${branch}...`);
  git(["push", "origin", branch]);

  console.log(`Pushing ${tag} (this triggers .github/workflows/release.yml)...`);
  git(["push", "origin", tag]);

  const slug = repoSlugFromRemote();
  console.log(`\nDone. ${tag} pushed.`);
  if (slug) {
    console.log(`Watch the release workflow: https://github.com/${slug}/actions/workflows/release.yml`);
    console.log(`Once it finishes:            https://github.com/${slug}/releases/tag/${tag}`);
    console.log(`Or from the CLI:              gh run list --workflow=release.yml -L 1`);
  }
}

main();
