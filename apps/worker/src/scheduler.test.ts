import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression cover for the reconcile loop that mirrors DB schedules into BullMQ
 * cron job-schedulers.
 *
 * The bug this guards against: `reconcileSchedules` used to call
 * `Queue.upsertJobScheduler` for every enabled schedule on every 30s pass.
 * That upsert runs with `override: true`, which deletes the pending next-fire
 * delayed job and recomputes it from now(). On a worker restart while a weekly
 * fire was overdue-but-not-yet-run, the startup reconcile therefore deleted the
 * overdue fire and re-armed for the following week — so the schedule missed
 * essentially every week, since the worker restarts more than weekly. The fix:
 * only upsert a scheduler that is missing, whose cron/timezone changed, or whose
 * pending fire was lost out-of-band (the heal path).
 */

const HOUR = 3_600_000;

const queue = vi.hoisted(() => ({
  getJobSchedulers:
    vi.fn<() => Promise<Array<{ key: string; pattern?: string; tz?: string; next?: number }>>>(),
  upsertJobScheduler: vi.fn(async () => {}),
  removeJobScheduler: vi.fn(async () => {}),
  on: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn(() => queue),
  Worker: vi.fn(() => ({ on: vi.fn(), close: vi.fn(async () => {}) })),
}));

vi.mock("./queue.js", () => ({
  connection: {},
  remediationQueue: { add: vi.fn() },
}));

vi.mock("./logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }) },
}));

vi.mock("@patchpilot/shared/alerting", () => ({ sendAlertEmail: vi.fn(async () => {}) }));

// scheduler.ts pulls these from @patchpilot/graph at module load; none are used
// by reconcileSchedules itself. Mocked so the real module (and its DB-touching
// audit layer) never loads under this suite.
vi.mock("@patchpilot/graph", () => ({
  assertWritesAllowed: vi.fn(),
  auditSafe: vi.fn(async () => {}),
  env: { DEMO_MODE: false },
  hasCachedSession: vi.fn(async () => true),
}));

const schedulesState = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("@patchpilot/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@patchpilot/db")>();
  return {
    ...actual,
    db: {
      select: () => ({ from: () => ({ where: async () => schedulesState.rows }) }),
    },
  };
});

const { reconcileSchedules } = await import("./scheduler.js");

function schedule(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "sched-1",
    name: "Weekly Chrome",
    cron: "0 2 * * 1",
    timezone: "Australia/Sydney",
    engineer: "eng@contoso.com",
    tenantId: "tenant-1",
    enabled: true,
    ...over,
  };
}

/** An existing scheduler whose next fire is comfortably in the future. */
function existing(over: { key?: string; pattern?: string; tz?: string; next?: number } = {}) {
  return {
    key: "sched-1",
    pattern: "0 2 * * 1",
    tz: "Australia/Sydney",
    next: Date.now() + 24 * HOUR,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  schedulesState.rows = [];
  queue.getJobSchedulers.mockResolvedValue([]);
});

describe("reconcileSchedules", () => {
  it("registers a scheduler for an eligible schedule that has none", async () => {
    schedulesState.rows = [schedule()];
    queue.getJobSchedulers.mockResolvedValue([]);

    await reconcileSchedules();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "sched-1",
      { pattern: "0 2 * * 1", tz: "Australia/Sydney" },
      { name: "fire", data: { scheduleId: "sched-1" } },
    );
  });

  it("leaves an already-correct scheduler untouched (does not re-upsert)", async () => {
    schedulesState.rows = [schedule()];
    queue.getJobSchedulers.mockResolvedValue([existing()]);

    await reconcileSchedules();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it("re-registers a scheduler whose cron changed", async () => {
    schedulesState.rows = [schedule({ cron: "30 3 * * 5" })];
    queue.getJobSchedulers.mockResolvedValue([existing({ pattern: "0 2 * * 1" })]);

    await reconcileSchedules();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "sched-1",
      { pattern: "30 3 * * 5", tz: "Australia/Sydney" },
      { name: "fire", data: { scheduleId: "sched-1" } },
    );
  });

  it("re-registers a scheduler whose timezone changed", async () => {
    schedulesState.rows = [schedule({ timezone: "America/New_York" })];
    queue.getJobSchedulers.mockResolvedValue([existing({ tz: "Australia/Sydney" })]);

    await reconcileSchedules();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "sched-1",
      { pattern: "0 2 * * 1", tz: "America/New_York" },
      { name: "fire", data: { scheduleId: "sched-1" } },
    );
  });

  it("defaults a schedule with no timezone to UTC", async () => {
    schedulesState.rows = [schedule({ timezone: null })];
    queue.getJobSchedulers.mockResolvedValue([]);

    await reconcileSchedules();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "sched-1",
      { pattern: "0 2 * * 1", tz: "UTC" },
      { name: "fire", data: { scheduleId: "sched-1" } },
    );
  });

  it("treats a scheduler with a UTC tz and a UTC schedule as unchanged", async () => {
    schedulesState.rows = [schedule({ timezone: "UTC" })];
    // BullMQ omits `tz` entirely for a UTC scheduler.
    queue.getJobSchedulers.mockResolvedValue([existing({ tz: undefined })]);

    await reconcileSchedules();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("re-arms a scheduler whose pending fire is missing (heal path)", async () => {
    schedulesState.rows = [schedule()];
    queue.getJobSchedulers.mockResolvedValue([existing({ next: undefined })]);

    await reconcileSchedules();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "sched-1",
      { pattern: "0 2 * * 1", tz: "Australia/Sydney" },
      { name: "fire", data: { scheduleId: "sched-1" } },
    );
  });

  it("re-arms a scheduler whose next fire is long past (heal path)", async () => {
    schedulesState.rows = [schedule()];
    queue.getJobSchedulers.mockResolvedValue([existing({ next: Date.now() - HOUR })]);

    await reconcileSchedules();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
  });

  it("does not re-arm a scheduler whose fire is only seconds overdue (mid-promotion)", async () => {
    schedulesState.rows = [schedule()];
    queue.getJobSchedulers.mockResolvedValue([existing({ next: Date.now() - 5_000 })]);

    await reconcileSchedules();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("removes a scheduler whose schedule is gone or no longer eligible", async () => {
    schedulesState.rows = [schedule({ id: "sched-keep" })];
    queue.getJobSchedulers.mockResolvedValue([
      existing({ key: "sched-keep" }),
      existing({ key: "sched-deleted" }),
    ]);

    await reconcileSchedules();

    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith("sched-deleted");
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("skips a schedule with no owning engineer and removes its stale scheduler", async () => {
    schedulesState.rows = [schedule({ engineer: null })];
    queue.getJobSchedulers.mockResolvedValue([existing()]);

    await reconcileSchedules();

    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith("sched-1");
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("a bad cron on one schedule does not stop the others from reconciling", async () => {
    schedulesState.rows = [schedule({ id: "bad" }), schedule({ id: "good" })];
    queue.getJobSchedulers.mockResolvedValue([]);
    queue.upsertJobScheduler.mockRejectedValueOnce(new Error("invalid cron"));

    await expect(reconcileSchedules()).resolves.toBeUndefined();
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
  });
});
