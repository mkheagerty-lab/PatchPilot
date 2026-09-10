import { describe, expect, it, vi } from "vitest";
import { insertInChunks, CHUNK_SIZE } from "@patchpilot/db";

// Unit coverage for the shared batched-insert helper (packages/db). It lives in
// the graph/ suite because sync.ts is its reason for existing: several
// per-tenant join-table writes there build one multi-row INSERT whose bind
// parameter count (rows x columns) blows Postgres' 65534 cap on a large tenant.

describe("insertInChunks", () => {
  it("splits rows into CHUNK_SIZE batches, in order, with a smaller final batch", async () => {
    const rows = Array.from({ length: CHUNK_SIZE * 2 + 7 }, (_, i) => i);
    const batches: number[][] = [];

    await insertInChunks(rows, async (chunk) => {
      batches.push(chunk);
    });

    expect(batches.map((b) => b.length)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 7]);
    expect(batches.flat()).toEqual(rows);
  });

  it("awaits each batch before starting the next", async () => {
    const rows = Array.from({ length: CHUNK_SIZE + 1 }, (_, i) => i);
    const events: string[] = [];

    await insertInChunks(rows, async (chunk) => {
      events.push(`start:${chunk.length}`);
      await new Promise((r) => setTimeout(r, 0));
      events.push(`end:${chunk.length}`);
    });

    expect(events).toEqual([`start:${CHUNK_SIZE}`, `end:${CHUNK_SIZE}`, "start:1", "end:1"]);
  });

  it("does nothing for an empty row set", async () => {
    const insertChunk = vi.fn();
    await insertInChunks([], insertChunk);
    expect(insertChunk).not.toHaveBeenCalled();
  });

  it("runs a single batch when rows fit within one chunk", async () => {
    const insertChunk = vi.fn(async () => {});
    await insertInChunks([1, 2, 3], insertChunk);
    expect(insertChunk).toHaveBeenCalledTimes(1);
    expect(insertChunk).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("honours an explicit chunkSize", async () => {
    const batches: number[][] = [];
    await insertInChunks([1, 2, 3, 4, 5], async (chunk) => void batches.push(chunk), 2);
    expect(batches).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("rejects a non-positive chunkSize rather than looping forever", async () => {
    await expect(insertInChunks([1], async () => {}, 0)).rejects.toThrow(/chunkSize must be >= 1/);
  });

  it("propagates a batch failure and stops (the caller's transaction rolls back)", async () => {
    const rows = Array.from({ length: CHUNK_SIZE * 3 }, (_, i) => i);
    let calls = 0;

    await expect(
      insertInChunks(rows, async () => {
        calls += 1;
        if (calls === 2) throw new Error("insert failed");
      }),
    ).rejects.toThrow("insert failed");

    expect(calls).toBe(2);
  });
});
