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
  /**
   * IANA timezone the `time` above is read in — the cron has no zone of its own,
   * so this is what the worker hands BullMQ. Defaults to the creator's browser
   * zone; stored on the schedule row.
   */
  timezone: string;
}

/** The creating engineer's own timezone, falling back to UTC if the browser won't say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Every IANA zone the browser knows, for the picker's dropdown. Falls back to a
 * short common-zone list on the handful of engines without `supportedValuesOf`.
 */
export function timeZoneOptions(): string[] {
  try {
    const all = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.("timeZone");
    if (all && all.length > 0) return all;
  } catch {
    /* fall through to the short list */
  }
  return [
    "UTC",
    "America/Los_Angeles",
    "America/Denver",
    "America/Chicago",
    "America/New_York",
    "Europe/London",
    "Europe/Berlin",
    "Asia/Kolkata",
    "Asia/Singapore",
    "Australia/Perth",
    "Australia/Sydney",
    "Pacific/Auckland",
  ];
}

/**
 * Current UTC offset of an IANA zone, in minutes (east of UTC positive). Derived
 * by formatting one instant in that zone and diffing it against the same instant
 * in UTC, so it needs no `timeZoneName: "shortOffset"` support and reflects DST
 * as it stands right now. Returns 0 for an unknown zone rather than throwing.
 */
function tzOffsetMinutes(tz: string, at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
    const p: Record<string, string> = {};
    for (const part of parts) p[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

/**
 * IANA zone plus its current GMT offset for the picker's option labels and the
 * schedule table, e.g. `Australia/Brisbane (GMT+10)` or `Asia/Kolkata (GMT+5:30)`.
 * The stored value is still the bare IANA name — this is display only.
 */
export function describeTimeZone(tz: string): string {
  const mins = tzOffsetMinutes(tz);
  if (mins === 0) return `${tz} (GMT)`;
  const sign = mins > 0 ? "+" : "-";
  const abs = Math.abs(mins);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const offset = m === 0 ? `${h}` : `${h}:${String(m).padStart(2, "0")}`;
  return `${tz} (GMT${sign}${offset})`;
}

export function defaultRecurrence(): Recurrence {
  return {
    freq: "daily",
    time: "02:00",
    daysOfWeek: [new Date().getDay()],
    dayOfMonth: 1,
    timezone: browserTimeZone(),
  };
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
 *
 * `timezone` is carried alongside the cron on the schedule row, not encoded in
 * it, so the caller passes the stored value in (defaulting to "UTC" for rows
 * that predate the column).
 */
export function cronToRecurrence(cron: string, timezone = "UTC"): Recurrence | null {
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
  const tz = timezone || "UTC";

  if (dom === "*" && dow === "*") {
    return { freq: "daily", time, daysOfWeek: [new Date().getDay()], dayOfMonth: 1, timezone: tz };
  }

  if (dom === "*" && dow !== "*") {
    const days = dow.split(",").map(Number);
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return null;
    return { freq: "weekly", time, daysOfWeek: [...new Set(days)].sort(), dayOfMonth: 1, timezone: tz };
  }

  if (dow === "*" && dom !== "*") {
    const day = Number(dom);
    if (!Number.isInteger(day) || day < 1 || day > 31) return null;
    return { freq: "monthly", time, daysOfWeek: [new Date().getDay()], dayOfMonth: day, timezone: tz };
  }

  return null;
}

const FREQ_OPTIONS: { id: RecurrenceFrequency; label: string }[] = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
];

/** IANA zone list for the picker — resolved once, it doesn't change mid-session. */
const TZ_OPTIONS = timeZoneOptions();

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
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {FREQ_OPTIONS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => onChange({ ...value, freq: f.id })}
            className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
              value.freq === f.id
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
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
                    : "border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
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
          <label className="text-xs font-medium text-slate-600 dark:text-slate-300">Day of month</label>
          <select
            value={value.dayOfMonth}
            onChange={(e) => onChange({ ...value, dayOfMonth: Number(e.target.value) })}
            className="rounded-md border border-slate-300 dark:border-slate-700 px-2 py-1 text-xs text-slate-800 dark:text-slate-100 focus:border-slate-500 focus:outline-none"
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-600 dark:text-slate-300">Time</label>
          <input
            type="time"
            value={value.time}
            onChange={(e) => onChange({ ...value, time: e.target.value })}
            className="rounded-md border border-slate-300 dark:border-slate-700 px-2 py-1 text-xs text-slate-800 dark:text-slate-100 focus:border-slate-500 focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-600 dark:text-slate-300">Timezone</label>
          <select
            value={value.timezone}
            onChange={(e) => onChange({ ...value, timezone: e.target.value })}
            className="rounded-md border border-slate-300 dark:border-slate-700 px-2 py-1 text-xs text-slate-800 dark:text-slate-100 focus:border-slate-500 focus:outline-none"
          >
            {(TZ_OPTIONS.includes(value.timezone)
              ? TZ_OPTIONS
              : [value.timezone, ...TZ_OPTIONS]
            ).map((tz) => (
              <option key={tz} value={tz}>
                {describeTimeZone(tz)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="text-[11px] leading-tight text-slate-500 dark:text-slate-400">
        {describeRecurrence(value)} · <code className="font-mono">{toCron(value)}</code> ·{" "}
        {describeTimeZone(value.timezone)}
      </p>
    </div>
  );
}
