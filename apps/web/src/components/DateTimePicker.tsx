import { useState } from "react";

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTH_FORMAT = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function toTimeInputValue(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Cell grid for a given month, padded with leading/trailing days from the neighboring months. */
function monthCells(viewMonth: Date): Date[] {
  const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const start = new Date(first);
  start.setDate(start.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

/**
 * Hand-rolled month-grid calendar + time field, combined into a single
 * `Date`. No date-picker dependency. Past dates/times are disabled — this
 * feeds a one-time future dispatch (`scheduleAt`), which the API itself also
 * rejects if it isn't in the future.
 */
export function DateTimePicker({
  value,
  onChange,
  maxDate,
}: {
  value: Date | null;
  onChange: (date: Date | null) => void;
  /** Optional upper bound (inclusive, by day) — dates past it are disabled. */
  maxDate?: Date;
}) {
  const now = new Date();
  const today = startOfDay(now);
  const max = maxDate ? startOfDay(maxDate) : null;
  const [viewMonth, setViewMonth] = useState(() => startOfDay(value ?? now));

  const selectedDay = value ? startOfDay(value) : null;
  const timeValue = value ? toTimeInputValue(value) : "09:00";

  function selectDay(day: Date) {
    if (day < today || (max && day > max)) return;
    const [h, m] = timeValue.split(":").map(Number);
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
    onChange(next);
  }

  function selectTime(next: string) {
    const [h, m] = next.split(":").map(Number);
    const base = selectedDay ?? today;
    onChange(new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m));
  }

  const cells = monthCells(viewMonth);
  const minTime = selectedDay && sameDay(selectedDay, today) ? toTimeInputValue(now) : undefined;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() =>
            setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))
          }
          aria-label="Previous month"
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path
              fillRule="evenodd"
              d="M12.79 5.23a.75.75 0 0 1 0 1.06L9.06 10l3.73 3.71a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <div className="text-xs font-medium text-slate-700">
          {MONTH_FORMAT.format(viewMonth)}
        </div>
        <button
          type="button"
          onClick={() =>
            setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))
          }
          aria-label="Next month"
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path
              fillRule="evenodd"
              d="M7.21 14.77a.75.75 0 0 1 0-1.06L10.94 10 7.21 6.29a.75.75 0 1 1 1.06-1.06l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0Z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      <div className="mt-2 grid grid-cols-7 gap-1 text-center text-[10px] font-medium text-slate-400">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((day) => {
          const inMonth = day.getMonth() === viewMonth.getMonth();
          const disabled = day < today || (max !== null && day > max);
          const selected = selectedDay && sameDay(day, selectedDay);
          const isToday = sameDay(day, today);
          return (
            <button
              key={day.toISOString()}
              type="button"
              disabled={disabled}
              onClick={() => selectDay(day)}
              className={`rounded-md py-1 text-xs transition-colors ${
                selected
                  ? "bg-slate-900 font-semibold text-white"
                  : disabled
                    ? "cursor-not-allowed text-slate-300"
                    : !inMonth
                      ? "text-slate-300 hover:bg-slate-50"
                      : isToday
                        ? "font-semibold text-slate-900 hover:bg-slate-100"
                        : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
        <label className="text-xs font-medium text-slate-600">Time</label>
        <input
          type="time"
          value={timeValue}
          min={minTime}
          onChange={(e) => selectTime(e.target.value)}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-800 focus:border-slate-500 focus:outline-none"
        />
        {selectedDay && (
          <span className="ml-auto text-[11px] text-slate-500">
            {selectedDay.toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
            })}{" "}
            at {timeValue}
          </span>
        )}
      </div>
    </div>
  );
}
