import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  cronToRecurrence,
  defaultRecurrence,
  describeCron,
  describeRecurrence,
  RecurrencePicker,
  toCron,
  type Recurrence,
} from "./RecurrencePicker";

/** A full Recurrence with a fixed timezone, so `toCron`/`describe*` inputs stay terse. */
function rec(over: Partial<Recurrence> = {}): Recurrence {
  return {
    freq: "daily",
    time: "02:00",
    daysOfWeek: [],
    dayOfMonth: 1,
    timezone: "UTC",
    ...over,
  };
}

describe("toCron", () => {
  it("builds a daily cron from the time alone", () => {
    expect(toCron(rec({ freq: "daily", time: "02:30" }))).toBe("30 2 * * *");
  });

  it("sorts and joins weekly days", () => {
    expect(toCron(rec({ freq: "weekly", time: "09:00", daysOfWeek: [5, 1, 3] }))).toBe(
      "0 9 * * 1,3,5",
    );
  });

  it("falls back to * when no weekly day is selected", () => {
    expect(toCron(rec({ freq: "weekly", time: "09:00", daysOfWeek: [] }))).toBe("0 9 * * *");
  });

  it("builds a monthly cron from the day of month", () => {
    expect(toCron(rec({ freq: "monthly", time: "23:59", dayOfMonth: 15 }))).toBe("59 23 15 * *");
  });

  it("ignores the timezone — the cron string carries no zone", () => {
    expect(toCron(rec({ timezone: "Australia/Sydney" }))).toBe(toCron(rec({ timezone: "UTC" })));
  });
});

describe("describeRecurrence", () => {
  it("describes daily", () => {
    expect(describeRecurrence(rec({ freq: "daily", time: "02:00" }))).toBe("Every day at 02:00");
  });

  it("describes weekly with named, sorted days", () => {
    expect(describeRecurrence(rec({ freq: "weekly", time: "09:00", daysOfWeek: [5, 1] }))).toBe(
      "Every Mon, Fri at 09:00",
    );
  });

  it("flags an empty weekly day selection", () => {
    expect(describeRecurrence(rec({ freq: "weekly", time: "09:00", daysOfWeek: [] }))).toBe(
      "Weekly at 09:00 (pick at least one day)",
    );
  });

  it("describes monthly", () => {
    expect(describeRecurrence(rec({ freq: "monthly", time: "02:00", dayOfMonth: 15 }))).toBe(
      "Monthly on day 15 at 02:00",
    );
  });
});

describe("describeCron", () => {
  it("describes a daily cron", () => {
    expect(describeCron("30 2 * * *")).toBe("Every day at 02:30");
  });

  it("describes a weekly cron", () => {
    expect(describeCron("0 9 * * 1,3,5")).toBe("Every Mon, Wed, Fri at 09:00");
  });

  it("describes a monthly cron", () => {
    expect(describeCron("0 0 15 * *")).toBe("Monthly on day 15 at 00:00");
  });

  it("falls back to the raw string for a shape it doesn't recognize", () => {
    expect(describeCron("*/5 * * * *")).toBe("*/5 * * * *");
    expect(describeCron("0 9 15 * 1")).toBe("0 9 15 * 1");
    expect(describeCron("not a cron")).toBe("not a cron");
  });
});

describe("cronToRecurrence", () => {
  it("round-trips a daily cron", () => {
    const r = cronToRecurrence("30 2 * * *");
    expect(r?.freq).toBe("daily");
    expect(r?.time).toBe("02:30");
  });

  it("round-trips a weekly cron, deduping and sorting days", () => {
    const r = cronToRecurrence("0 9 * * 3,1,1", "Australia/Sydney");
    expect(r).toEqual({
      freq: "weekly",
      time: "09:00",
      daysOfWeek: [1, 3],
      dayOfMonth: 1,
      timezone: "Australia/Sydney",
    });
  });

  it("defaults the timezone to UTC when none is passed", () => {
    expect(cronToRecurrence("0 9 * * 1")?.timezone).toBe("UTC");
  });

  it("round-trips a monthly cron", () => {
    const r = cronToRecurrence("0 0 15 * *");
    expect(r?.freq).toBe("monthly");
    expect(r?.dayOfMonth).toBe(15);
  });

  it("returns null for a shape it can't express", () => {
    expect(cronToRecurrence("*/5 * * * *")).toBeNull();
    expect(cronToRecurrence("0 9 15 * 1")).toBeNull();
    expect(cronToRecurrence("garbage")).toBeNull();
  });
});

describe("defaultRecurrence", () => {
  it("defaults to daily at 02:00 with today's weekday preselected", () => {
    const r = defaultRecurrence();
    expect(r.freq).toBe("daily");
    expect(r.time).toBe("02:00");
    expect(r.daysOfWeek).toEqual([new Date().getDay()]);
    expect(r.dayOfMonth).toBe(1);
    expect(typeof r.timezone).toBe("string");
    expect(r.timezone.length).toBeGreaterThan(0);
  });
});

describe("RecurrencePicker component", () => {
  it("switches frequency and reveals the weekly day picker", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <RecurrencePicker value={defaultRecurrence()} onChange={onChange} />,
    );

    await user.click(screen.getByRole("button", { name: "Weekly" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ freq: "weekly" }));

    const next = onChange.mock.calls[0]![0] as Recurrence;
    rerender(<RecurrencePicker value={next} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Mon" })).toBeInTheDocument();
  });

  it("toggles a weekday on and off", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value = rec({ freq: "weekly", time: "09:00", daysOfWeek: [1] });
    render(<RecurrencePicker value={value} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Fri" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...value, daysOfWeek: [1, 5] });

    await user.click(screen.getByRole("button", { name: "Mon" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...value, daysOfWeek: [] });
  });

  it("shows the day-of-month select only in monthly mode", () => {
    const onChange = vi.fn();
    render(<RecurrencePicker value={rec({ freq: "monthly", dayOfMonth: 15 })} onChange={onChange} />);
    expect(screen.getByText("Day of month")).toBeInTheDocument();
  });

  it("emits a timezone change from the timezone select", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value = rec({ timezone: "UTC" });
    render(<RecurrencePicker value={value} onChange={onChange} />);

    await user.selectOptions(screen.getByRole("combobox"), "America/New_York");
    expect(onChange).toHaveBeenLastCalledWith({ ...value, timezone: "America/New_York" });
  });

  it("renders the live cron + description preview", () => {
    const onChange = vi.fn();
    render(<RecurrencePicker value={rec({ freq: "daily", time: "02:00" })} onChange={onChange} />);
    expect(screen.getByText(/Every day at 02:00/)).toBeInTheDocument();
    expect(screen.getByText("0 2 * * *")).toBeInTheDocument();
  });
});
