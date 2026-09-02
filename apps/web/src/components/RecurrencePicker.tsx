const WEEKDAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

export type RecurrenceFrequency = "daily" | "weekly" | "monthly";

export interface Recurrence {
  freq: RecurrenceFrequency;
  /** HH:MM, 24h. */
  time: string;
  /** Weekly only — 0 (Sun) through 6 (Sat). At least one required. */
  daysOfWeek: number[];
  /** Monthly only — 1 through 28 (kept sub-29 so every month has the day). */
  dayOfMonth: number;
}

export function defaultRecurrence(): Recurrence {
  return { freq: "daily", time: "02:00", daysOfWeek: [new Date().getDay()], dayOfMonth: 1 };
}

/** Builds a standard 5-field cron expression from a recurrence — the shape `schedules.cron` stores. */
export function toCron(r: Recurrence): string {
  const [hh, mm] = r.time.split(":").map(Number);
  const h = Number.isFinite(hh) ? hh : 0;
  const m = Number.isFinite(mm) ? mm : 0;
  switch (r.freq) {
    case "daily":
      return `${m} ${h} * * *`;
    case "weekly": {
      const days = r.daysOfWeek.length > 0 ? [...r.daysOfWeek].sort().join(",") : "*";
      return `${m} ${h} * * ${days}`;
    }
    case "monthly":
      return `${m} ${h} ${r.dayOfMonth} * *`;
  }
}

/** Human-readable summary of a recurrence, shown next to the generated cron for a sanity check. */
export function describeRecurrence(r: Recurrence): string {
  switch (r.freq) {
    case "daily":
      return `Every day at ${r.time}`;
    case "weekly": {
      if (r.daysOfWeek.length === 0) return `Weekly at ${r.time} (pick at least one day)`;
      const names = [...r.daysOfWeek]
        .sort()
        .map((d) => WEEKDAYS.find((w) => w.value === d)?.label)
        .join(", ");
      return `Every ${names} at ${r.time}`;
    }
    case "monthly":
      return `Monthly on day ${r.dayOfMonth} at ${r.time}`;
  }
}

/**
 * Human-readable summary of a stored cron string, for display in the
 * Schedules table. Only recognizes the three shapes `toCron()` emits
 * (daily / weekly-by-day-of-week / monthly-by-day-of-month, minute+hour
 * fixed, month always `*`); anything else — steps, ranges, a restricted
 * month, or both day-of-month and day-of-week constrained — falls back to
 * the raw cron string rather than risk describing it wrong.
 */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = parts;

  const m = Number(minute);
  const h = Number(hour);
  if (!Number.isInteger(m) || !Number.isInteger(h) || m < 0 || m > 59 || h < 0 || h > 23) {
    return cron;
  }
  if (month !== "*") return cron;

  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

  if (dom === "*" && dow === "*") {
    return `Every day at ${time}`;
  }

  if (dom === "*" && dow !== "*") {
    const days = dow.split(",").map(Number);
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return cron;
    const names = [...new Set(days)]
      .sort((a, b) => a - b)
      .map((d) => WEEKDAYS.find((w) => w.value === d)?.label)
      .join(", ");
    return `Every ${names} at ${time}`;
  }

  if (dow === "*" && dom !== "*") {
    const day = Number(dom);
    if (!Number.isInteger(day) || day < 1 || day > 31) return cron;
    return `Monthly on day ${day} at ${time}`;
  }

  return cron;
}

/**
 * Inverse of `toCron` — recovers a `Recurrence` from a stored cron string so an
 * existing schedule can be re-opened in the picker instead of a raw cron field.
 * Only recognizes the same three shapes `toCron()` emits (mirrors
 * `describeCron`'s parsing); anything else (steps, ranges, a restricted month,
 * or both day-of-month and day-of-week constrained) returns null, since there's
 * no `Recurrence` that round-trips it — callers should fall back to
 * `defaultRecurrence()` and let the engineer redefine it.
 */
export function cronToRecurrence(cron: string): Recurrence | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = parts;

  const m = Number(minute);
  const h = Number(hour);
  if (!Number.isInteger(m) || !Number.isInteger(h) || m < 0 || m > 59 || h < 0 || h > 23) {
    return null;
  }
  if (month !== "*") return null;

  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

  if (dom === "*" && dow === "*") {
    return { freq: "daily", time, daysOfWeek: [new Date().getDay()], dayOfMonth: 1 };
  }

  if (dom === "*" && dow !== "*") {
    const days = dow.split(",").map(Number);
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return null;
    return { freq: "weekly", time, daysOfWeek: [...new Set(days)].sort(), dayOfMonth: 1 };
  }

  if (dow === "*" && dom !== "*") {
    const day = Number(dom);
    if (!Number.isInteger(day) || day < 1 || day > 31) return null;
    return { freq: "monthly", time, daysOfWeek: [new Date().getDay()], dayOfMonth: day };
  }

  return null;
}

const FREQ_OPTIONS: { id: RecurrenceFrequency; label: string }[] = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
];

/**
 * Recurrence builder — Daily / Weekly / Monthly + time — for creating a
 * recurring `schedules` row inline. Emits a `Recurrence`; convert with
 * `toCron()` when posting to `/api/schedules`.
 */
export function RecurrencePicker({
  value,
  onChange,
}: {
  value: Recurrence;
  onChange: (r: Recurrence) => void;
}) {
  function toggleDay(day: number) {
    const has = value.daysOfWeek.includes(day);
    onChange({
      ...value,
      daysOfWeek: has
        ? value.daysOfWeek.filter((d) => d !== day)
        : [...value.daysOfWeek, day],
    });
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {FREQ_OPTIONS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => onChange({ ...value, freq: f.id })}
            className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
              value.freq === f.id
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {value.freq === "weekly" && (
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAYS.map((w) => {
            const active = value.daysOfWeek.includes(w.value);
            return (
              <button
                key={w.value}
                type="button"
                onClick={() => toggleDay(w.value)}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  active
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {w.label}
              </button>
            );
          })}
        </div>
      )}

      {value.freq === "monthly" && (
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-600">Day of month</label>
          <select
            value={value.dayOfMonth}
            onChange={(e) => onChange({ ...value, dayOfMonth: Number(e.target.value) })}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-800 focus:border-slate-500 focus:outline-none"
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex items-center gap-2">
        <label className="text-xs font-medium text-slate-600">Time</label>
        <input
          type="time"
          value={value.time}
          onChange={(e) => onChange({ ...value, time: e.target.value })}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-800 focus:border-slate-500 focus:outline-none"
        />
      </div>

      <p className="text-[11px] leading-tight text-slate-500">
        {describeRecurrence(value)} · <code className="font-mono">{toCron(value)}</code>
      </p>
    </div>
  );
}
