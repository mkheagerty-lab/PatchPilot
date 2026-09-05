#!/usr/bin/env node
// Cuts a PatchPilot release end to end: bump versions, cut the changelog,
// commit, tag, and push — the tag push is what triggers
// .github/workflows/release.yml (lint/typecheck/test/build, a tag-matches-
// package.json guard, then publishing the GitHub Release).
//
// Usage:
//   pnpm release 0.2.0                    cut the release for real
//   pnpm release 0.2.0 --dry-run          preview every change, touch nothing
//   pnpm release 0.2.0 --skip-dev-refresh cut the release, skip the local dev-API restart
//
// This wraps scripts/bump-version.mjs (imported, not shelled out to) plus a
// CHANGELOG.md "## Unreleased" -> "## [X.Y.Z] - <date>" cut. Both remain
// individually usable — `pnpm version:bump` for a bare version bump, editing
// CHANGELOG.md by hand for a bare changelog edit — this script is just the
// documented happy path chained into one command.
//
// After the tag is pushed, best-effort restarts a locally running dev API
// (see refreshLocalDevApi below) so `apps/api`'s in-memory CURRENT_VERSION —
// read once at boot from package.json — reflects the just-cut version without
// needing infra/updater (that sidecar only exists in the production compose
// stack; a host-run dev instance has nothing else polling for updates).

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import http from "node:http";
import os from "node:os";
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
  return {
    version: positional[0],
    dryRun: flags.has("--dry-run"),
    skipDevRefresh: flags.has("--skip-dev-refresh"),
  };
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

/** Reads apps/api's dev listen port the same way it does at boot: an
 * `API_PORT` line in the repo-root `.env`, falling back to config.ts's
 * default. Good enough for local convenience — no need to pull in zod/dotenv
 * just for this. */
function readApiPort() {
  try {
    const env = readFileSync(path.join(ROOT, ".env"), "utf8");
    const match = env.match(/^API_PORT=(\d+)\s*$/m);
    if (match) return Number(match[1]);
  } catch {
    // no root .env — fall through to the default
  }
  return 4000;
}

/** Finds the PID currently LISTENING on `port` via `netstat -ano` — more
 * reliable in practice on this project's dev machine than
 * `Get-NetTCPConnection`/`Get-CimInstance`, which have both silently missed
 * real processes during manual debugging this same port. Returns null if
 * nothing is listening (or the process can't be run at all). */
function findListenerPid(port) {
  let out;
  try {
    out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
  } catch {
    return null;
  }
  const match = out.match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`));
  return match ? Number(match[1]) : null;
}

/** Best-effort: PIDs of any other process belonging to this exact dev
 * supervisor chain (scripts/run-resilient.mjs wrapping `tsx ... index.ts` for
 * apps/api) — not just whichever one currently holds the port — so a stale
 * supervisor doesn't sit there re-fighting for the port after the fresh one
 * comes up. Matched on a command-line substring specific enough that it can't
 * plausibly hit an unrelated process. Silently returns [] if the query fails
 * or nothing matches (this is a cleanup nicety, not load-bearing — the actual
 * port-holder is killed separately, by exact PID, in refreshLocalDevApi). */
function findDevApiSupervisorPids() {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | " +
          "Where-Object { $_.CommandLine -like '*run-resilient.mjs*' -and $_.CommandLine -like '*index.ts*' } | " +
          "Select-Object -ExpandProperty ProcessId",
      ],
      { encoding: "utf8" },
    );
    return out
      .split(/\r?\n/)
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function killPid(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // already gone, or couldn't be killed — either way, keep going
  }
}

/** Resolves once an HTTP request to `http://127.0.0.1:port/` gets *any*
 * response (even a 404) — that's enough to prove Fastify itself is up,
 * without needing an authenticated session to check a real route. */
function pingApi(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort: if a dev `apps/api` is already running on this machine (host
 * `pnpm dev`/`dev:resilient`, not infra/docker-compose's containers), restart
 * it so its in-memory CURRENT_VERSION picks up the version just bumped —
 * apps/api doesn't hot-reload a root package.json change (tsx watch only
 * watches its own src/ tree), and there's no `updater` sidecar outside the
 * production compose stack to do this for you.
 *
 * Windows-only (this project's local dev workflow always runs on Windows);
 * skipped elsewhere. Never fails the release itself — any problem here is
 * caught and reported as a warning, since the tag is already pushed by the
 * time this runs.
 */
async function refreshLocalDevApi(version) {
  if (process.platform !== "win32") {
    console.log(`\nSkipping local dev-API refresh (not Windows).`);
    return;
  }

  const port = readApiPort();
  const existingPid = findListenerPid(port);
  if (!existingPid) {
    console.log(`\nNo local dev API detected on :${port} — skipping dev refresh.`);
    return;
  }

  console.log(`\nRestarting local dev API (:${port}, was pid ${existingPid}) to pick up v${version}...`);
  killPid(existingPid);
  for (const pid of findDevApiSupervisorPids()) {
    if (pid !== existingPid) killPid(pid);
  }

  // Give Windows a beat to actually release the socket before rebinding.
  await sleep(1000);

  const logPath = path.join(os.tmpdir(), `patchpilot-dev-api-${port}.log`);
  const out = openSync(logPath, "a");
  const err = openSync(logPath, "a");
  const child = spawn("pnpm", ["--filter", "@patchpilot/api", "dev:resilient"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, err],
    shell: true,
    windowsHide: true,
  });
  child.unref();

  const ATTEMPTS = 30;
  for (let i = 0; i < ATTEMPTS; i++) {
    await sleep(1000);
    if (await pingApi(port)) {
      console.log(`Dev API back up on :${port} — now running v${version}.`);
      return;
    }
  }
  console.warn(
    `WARNING: dev API didn't come back up on :${port} within ${ATTEMPTS}s. ` +
      `Check ${logPath}, or start it manually: pnpm --filter @patchpilot/api dev:resilient`,
  );
}

async function main() {
  const { version, dryRun, skipDevRefresh } = parseArgs(process.argv.slice(2));
  if (!version) {
    console.error("usage: release.mjs <new-version> [--dry-run] [--skip-dev-refresh]  (e.g. 0.2.0)");
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
    if (skipDevRefresh) {
      console.log(`\n(--skip-dev-refresh passed: would not touch any locally running dev API.)`);
    } else {
      console.log(
        `\nWould then also check for a locally running dev API (port from .env's API_PORT, ` +
          `default 4000) and restart it in place, if one is running, so it reflects v${version}.`,
      );
    }
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

  if (!skipDevRefresh) {
    try {
      await refreshLocalDevApi(version);
    } catch (err) {
      console.warn(`WARNING: local dev-API refresh failed (release itself is unaffected): ${err.message}`);
    }
  }
}

main();
