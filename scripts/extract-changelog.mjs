#!/usr/bin/env node
// Pulls one version's section out of CHANGELOG.md for use as a GitHub Release
// body (see .github/workflows/release.yml).
//
// Usage: node scripts/extract-changelog.mjs 0.2.0 out.md
//
// Writes the section between a "## [0.2.0]" (with or without a trailing
// " - date") heading and the next "## " heading to `out.md`. If no matching
// section exists, writes an empty file and exits 0 — the workflow treats an
// empty file as "fall back to GitHub's auto-generated release notes" rather
// than failing the release.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const [version, outFile] = process.argv.slice(2);
if (!version || !outFile) {
  console.error("usage: extract-changelog.mjs <version> <out-file>");
  process.exit(1);
}

const changelog = readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headingRe = new RegExp(`^## \\[${escaped}\\].*$`, "m");

const startMatch = headingRe.exec(changelog);
if (!startMatch) {
  console.error(`No "## [${version}]" section found in CHANGELOG.md — writing an empty file.`);
  writeFileSync(outFile, "");
  process.exit(0);
}

const bodyStart = startMatch.index + startMatch[0].length;
const rest = changelog.slice(bodyStart);
const nextHeading = rest.search(/^## /m);
const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();

writeFileSync(outFile, body + "\n");
console.error(`Extracted "## [${version}]" section (${body.length} chars) to ${outFile}.`);
