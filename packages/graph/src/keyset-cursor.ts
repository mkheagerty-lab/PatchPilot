/**
 * Generic keyset (seek) pagination cursor over a `(sortValue, id)` tuple.
 *
 * The `id` tiebreak is mandatory wherever the sort column can repeat — audit
 * rows and remediation events both routinely share a timestamp (several
 * writes land within the same millisecond), and a bare `sortValue < $cursor`
 * would silently drop every tied row at a page boundary. OFFSET is the wrong
 * tool wherever new rows are continuously inserted at the head, since every
 * page would shift under the reader.
 *
 * Extracted out of audit.ts's own (at, id) cursor so Remediation History's
 * (remediatedAt, id) cursor reuses the same encode/decode instead of copying
 * it — see remediatedAt's own precision(3) comment in schema.ts for why the
 * value must be an ISO string carrying exactly the precision Postgres stores.
 */
export interface KeysetCursor {
  /** ISO-8601 string of the sort column's value. */
  sortValue: string;
  id: string;
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(`${cursor.sortValue}|${cursor.id}`, "utf8").toString("base64url");
}

export function decodeKeysetCursor(raw: string): KeysetCursor | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf("|");
    if (sep <= 0) return null;
    const sortValue = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!id || Number.isNaN(Date.parse(sortValue))) return null;
    return { sortValue, id };
  } catch {
    return null;
  }
}
