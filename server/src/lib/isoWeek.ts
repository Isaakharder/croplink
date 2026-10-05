// ISO 8601 week arithmetic that does NOT assume 52 weeks per year.
//
// An ISO year has 53 weeks when Dec 28 falls in week 53 (e.g. 2020, 2026,
// 2032); otherwise 52. Anything that stores (year, week_number) pairs must
// validate against the specific year, and anything that adds weeks must roll
// into the next ISO year rather than capping at 52 or dropping the week.

export interface IsoWeek {
  year: number;
  week: number;
}

const MS_PER_DAY = 86_400_000;

/** Monday (UTC midnight) of ISO week `week` of ISO year `year`. Jan 4 is always in week 1. */
export function isoWeekMonday(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // Mon=1..Sun=7
  const week1Monday = Date.UTC(year, 0, 4) - (jan4Day - 1) * MS_PER_DAY;
  return new Date(week1Monday + (week - 1) * 7 * MS_PER_DAY);
}

/** ISO year + week containing the given date (evaluated in UTC). Note the ISO year can differ from the calendar year near Jan 1. */
export function isoWeekOfDate(d: Date): IsoWeek {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day); // Thursday of this week decides the ISO year
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / MS_PER_DAY + 1) / 7);
  return { year, week };
}

/** 52 or 53. */
export function weeksInIsoYear(year: number): number {
  return isoWeekOfDate(new Date(Date.UTC(year, 11, 28))).week;
}

export function isValidIsoWeek(year: unknown, week: unknown): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(week) &&
    (week as number) >= 1 &&
    (week as number) <= weeksInIsoYear(year as number)
  );
}

/**
 * Monotonic week index (weeks since the ISO week containing 1970-01-01),
 * so differences between (year, week) pairs are exact across year
 * boundaries — replaces the `year * 52 + week` idiom, which is off by one
 * for every 53-week year crossed.
 */
export function isoWeekIndex(year: number, week: number): number {
  return Math.round((isoWeekMonday(year, week).getTime() - isoWeekMonday(1970, 1).getTime()) / (7 * MS_PER_DAY));
}

export function fromIsoWeekIndex(index: number): IsoWeek {
  const monday = new Date(isoWeekMonday(1970, 1).getTime() + index * 7 * MS_PER_DAY);
  return isoWeekOfDate(monday);
}

export function addIsoWeeks(year: number, week: number, n: number): IsoWeek {
  return fromIsoWeekIndex(isoWeekIndex(year, week) + n);
}

// ── Greenhouse local time ───────────────────────────────────────────────────
// "Now" in CropLink means the greenhouse's wall clock, not UTC: at 8–11:59 PM
// on a Sunday in Toronto it is already Monday in UTC, but the greenhouse is
// still in the previous ISO week. Every "current week" and every week-based
// cutoff instant goes through these helpers. DST is handled by Intl.

export const GREENHOUSE_TZ = 'America/Toronto';

const partsFormatter = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = partsFormatter.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    partsFormatter.set(tz, f);
  }
  return f;
}

/** Wall-clock date/time parts of an instant in `tz`. */
export function zonedParts(d: Date, tz = GREENHOUSE_TZ): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const p: Record<string, number> = {};
  for (const x of formatterFor(tz).formatToParts(d)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour === 24 ? 0 : p.hour, minute: p.minute, second: p.second };
}

/** Offset of `tz` from UTC at instant `d`, in ms (Toronto: −4 h in EDT, −5 h in EST). */
export function zoneOffsetMs(d: Date, tz = GREENHOUSE_TZ): number {
  const p = zonedParts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (Math.floor(d.getTime() / 1000) * 1000);
}

/** The instant of local midnight (00:00) on calendar date year-month-day in `tz`. */
export function zonedMidnight(year: number, month: number, day: number, tz = GREENHOUSE_TZ): Date {
  const guess = Date.UTC(year, month - 1, day);
  let t = guess - zoneOffsetMs(new Date(guess), tz);
  t = guess - zoneOffsetMs(new Date(t), tz); // second pass lands on the right side of a DST change
  return new Date(t);
}

/** ISO week the greenhouse is in at instant `d` (local calendar date in `tz`). */
export function greenhouseIsoWeek(d: Date, tz = GREENHOUSE_TZ): IsoWeek {
  const p = zonedParts(d, tz);
  return isoWeekOfDate(new Date(Date.UTC(p.year, p.month - 1, p.day)));
}

export function greenhouseIsoWeekIndex(d: Date, tz = GREENHOUSE_TZ): number {
  const w = greenhouseIsoWeek(d, tz);
  return isoWeekIndex(w.year, w.week);
}

/** Instant the ISO week starts in the greenhouse: Monday 00:00 local time. `dayOffset` moves by local calendar days (e.g. 8 = the following Tuesday 00:00). */
export function greenhouseWeekStart(year: number, week: number, dayOffset = 0, tz = GREENHOUSE_TZ): Date {
  const monday = isoWeekMonday(year, week); // UTC midnight of the Monday's calendar date
  const date = new Date(monday.getTime() + dayOffset * MS_PER_DAY);
  return zonedMidnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), tz);
}
