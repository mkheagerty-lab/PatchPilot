import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";

const { tableRows, insertedRows, updatedRows, auditSafeMock, configOverride } = vi.hoisted(() => ({
  tableRows: new Map<unknown, unknown[]>(),
  insertedRows: new Map<unknown, unknown[]>(),
  updatedRows: new Map<unknown, unknown[]>(),
  auditSafeMock: vi.fn(),
  configOverride: { DEMO_MODE: false, BOOTSTRAP_ADMIN_UPN: undefined as string | undefined },
}));

interface Chain extends PromiseLike<unknown[]> {
  where: () => Chain;
  limit: (n: number) => Chain;
}

function chain(rows: unknown[]): Chain {
  return {
    where: () => chain(rows),
    limit: (n: number) => chain(rows.slice(0, n)),
    then: (onFulfilled, onRejected) => Promise.resolve(rows).then(onFulfilled, onRejected),
  };
}

vi.mock("@patchpilot/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@patchpilot/db")>();
  return {
    ...actual,
    db: {
      select: () => ({ from: (table: unknown) => chain(tableRows.get(table) ?? []) }),
      insert: (table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          const list = insertedRows.get(table) ?? [];
          list.push(vals);
          insertedRows.set(table, list);
          return Promise.resolve();
        },
      }),
      update: (table: unknown) => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => {
            const list = updatedRows.get(table) ?? [];
            list.push(vals);
            updatedRows.set(table, list);
            return Promise.resolve();
          },
        }),
      }),
    },
  };
});

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    get config() {
      return { ...actual.config, ...configOverride };
    },
  };
});

vi.mock("@patchpilot/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@patchpilot/graph")>();
  return { ...actual, auditSafe: auditSafeMock };
});

const { bootstrapAdmin } = await import("./bootstrap.js");
const { tables } = await import("@patchpilot/db");

function fakeLog() {
  return { warn: vi.fn() } as unknown as FastifyBaseLogger & { warn: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  tableRows.clear();
  insertedRows.clear();
  updatedRows.clear();
  auditSafeMock.mockReset().mockResolvedValue(undefined);
  configOverride.DEMO_MODE = false;
  configOverride.BOOTSTRAP_ADMIN_UPN = undefined;
});

describe("bootstrapAdmin", () => {
  it("returns immediately in DEMO_MODE, no db calls", async () => {
    configOverride.DEMO_MODE = true;
    configOverride.BOOTSTRAP_ADMIN_UPN = "admin@example.com";
    const log = fakeLog();
    await bootstrapAdmin(log);
    expect(insertedRows.size).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("inserts a new active admin row when BOOTSTRAP_ADMIN_UPN has no existing row", async () => {
    configOverride.BOOTSTRAP_ADMIN_UPN = "admin@example.com";
    const log = fakeLog();
    await bootstrapAdmin(log);
    const [inserted] = insertedRows.get(tables.engineers) ?? [];
    expect(inserted).toMatchObject({ upn: "admin@example.com", role: "admin", status: "active" });
    expect(log.warn).toHaveBeenCalled();
    expect(auditSafeMock).toHaveBeenCalledWith(expect.objectContaining({ action: "user:create" }));
  });

  it("is idempotent when the existing row is already admin/active", async () => {
    configOverride.BOOTSTRAP_ADMIN_UPN = "admin@example.com";
    tableRows.set(tables.engineers, [{ id: "eng-1", upn: "admin@example.com", role: "admin", status: "active" }]);
    const log = fakeLog();
    await bootstrapAdmin(log);
    expect(updatedRows.size).toBe(0);
    expect(auditSafeMock).not.toHaveBeenCalled();
  });

  it("promotes an existing row with the wrong role/status to active admin", async () => {
    configOverride.BOOTSTRAP_ADMIN_UPN = "admin@example.com";
    tableRows.set(tables.engineers, [{ id: "eng-1", upn: "admin@example.com", role: "reader", status: "disabled" }]);
    const log = fakeLog();
    await bootstrapAdmin(log);
    const [updated] = updatedRows.get(tables.engineers) ?? [];
    expect(updated).toMatchObject({ role: "admin", status: "active" });
    expect(auditSafeMock).toHaveBeenCalledWith(expect.objectContaining({ action: "user:update-role" }));
  });

  it("does not warn when BOOTSTRAP_ADMIN_UPN is unset and an active admin exists", async () => {
    tableRows.set(tables.engineers, [{ id: "eng-1", role: "admin", status: "active" }]);
    const log = fakeLog();
    await bootstrapAdmin(log);
    expect(log.warn).not.toHaveBeenCalled();
    expect(insertedRows.size).toBe(0);
  });

  it("warns when BOOTSTRAP_ADMIN_UPN is unset and no active admin exists", async () => {
    tableRows.set(tables.engineers, []);
    const log = fakeLog();
    await bootstrapAdmin(log);
    expect(log.warn).toHaveBeenCalled();
    expect(insertedRows.size).toBe(0);
  });
});
