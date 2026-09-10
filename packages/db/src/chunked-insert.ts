/**
 * PostgreSQL caps a single query at 65535 bind parameters; postgres.js (this
 * project's driver) rejects at 65534 with
 * `MAX_PARAMETERS_EXCEEDED: Max number of parameters (65534) exceeded`.
 *
 * A multi-row `INSERT ... VALUES (…),(…),…` binds `rows × columns-per-row`
 * parameters, so a bulk insert of a long-enough (or wide-enough) row set blows
 * the limit and the whole statement fails. This splits `rows` into fixed-size
 * batches and runs the insert once per batch, in order.
 *
 * Pass a closure that builds the actual drizzle insert for one batch — plain or
 * `.onConflictDoUpdate(...)`, on `db` or on a transaction handle — so all the
 * table typing stays at the call site. When the surrounding `delete` + re-insert
 * has to stay atomic, call this inside a `db.transaction(...)` and hand the
 * closure the transaction handle: every batch then commits or rolls back
 * together.
 *
 * `CHUNK_SIZE` (1000) keeps the parameter count well under the cap for any table
 * up to ~65 columns, matching the `UPSERT_CHUNK` the winget/Chocolatey catalog
 * mirrors already use for the same reason.
 */
export const CHUNK_SIZE = 1000;

export async function insertInChunks<Row>(
  rows: readonly Row[],
  insertChunk: (chunk: Row[]) => Promise<unknown>,
  chunkSize: number = CHUNK_SIZE,
): Promise<void> {
  if (chunkSize < 1) {
    throw new Error(`insertInChunks: chunkSize must be >= 1, got ${chunkSize}`);
  }
  for (let i = 0; i < rows.length; i += chunkSize) {
    await insertChunk(rows.slice(i, i + chunkSize));
  }
}
