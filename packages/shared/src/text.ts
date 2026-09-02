/**
 * Makes arbitrary device-side text safe to store in a Postgres `text` column.
 *
 * Postgres rejects NUL (U+0000) in text values outright — `invalid byte sequence
 * for encoding "UTF8": 0x00` (SQLSTATE 22021) — and it is the ONLY codepoint it
 * refuses this way. Defender Live Response returns script output verbatim from
 * the device, and a PowerShell/winget process writing UTF-16LE to stdout arrives
 * as ASCII text with a NUL after every character. Writing that straight to the
 * `jobs.output` column threw mid-remediation, which aborted the worker's
 * terminal-status write and left the job row stuck at "running" forever with a
 * transcript that stopped at the last line that happened to write cleanly.
 *
 * Dropping the NULs both fixes the write and incidentally repairs that mangling:
 * "P\0u\0T\0T\0Y\0" reads back as "PuTTY".
 *
 * Lone surrogates are also replaced — they survive in a JS string but throw when
 * encoded to UTF-8 on the way to the driver.
 */

/** U+0000. Built via fromCharCode so no invisible control byte sits in this source. */
const NUL = String.fromCharCode(0);

/** U+FFFD REPLACEMENT CHARACTER. */
const REPLACEMENT = "�";

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizeDbText(text: string): string {
  return text.split(NUL).join("").replace(LONE_SURROGATE, REPLACEMENT);
}

/**
 * `sanitizeDbText` plus a length ceiling, for columns fed by untrusted device
 * output. A runaway script (winget progress spinners, a stack trace loop) can
 * otherwise push megabytes into a single job row.
 */
export function sanitizeDbTextBounded(text: string, maxChars = 200_000): string {
  const clean = sanitizeDbText(text);
  if (clean.length <= maxChars) return clean;
  const dropped = clean.length - maxChars;
  return `${clean.slice(0, maxChars)}\n…[truncated ${dropped} more characters]`;
}

/**
 * Escapes text for interpolation into an HTML document.
 *
 * Same reasoning as `csvCell`'s formula guard in audit.ts: hostnames, software
 * titles and publisher names arrive from Microsoft Graph, i.e. from whatever a
 * customer happened to install, and are not content we authored. React escapes
 * these for us everywhere in `apps/web`; the report renderer in `apps/worker`
 * builds HTML with template literals and has no such backstop, so every
 * interpolation there goes through this.
 *
 * Covers `&<>"'` — enough for both element content and quoted attribute values,
 * which is the only way this template interpolates. `null`/`undefined` render
 * as an empty string so a missing field can't print "undefined" in a document
 * that goes to a customer.
 */
export function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
