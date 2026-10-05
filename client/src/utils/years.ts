import { Season } from '../types';

export function getIsoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/**
 * The greenhouse's current ISO year and week. The greenhouse runs on Toronto
 * time, whatever the device's time zone: at 8–11:59 PM on a Sunday in
 * Toronto it is already Monday in UTC, but the greenhouse is still in the
 * previous ISO week. Matches the server's greenhouseIsoWeek().
 */
export const GREENHOUSE_TZ = 'America/Toronto';
export function greenhouseIsoWeek(now: Date = new Date()): { year: number; week: number } {
  const p: Record<string, number> = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: GREENHOUSE_TZ, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now)) {
    if (x.type !== 'literal') p[x.type] = Number(x.value);
  }
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const year = date.getUTCFullYear();
  return { year, week: Math.ceil((((date.getTime() - Date.UTC(year, 0, 1)) / 86400000) + 1) / 7) };
}

export function isoWeeksInYear(year: number): number {
  // A year has 53 ISO weeks if Jan 1 or Dec 31 is a Thursday
  const jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  const dec31 = new Date(Date.UTC(year, 11, 31)).getUTCDay();
  return jan1 === 4 || dec31 === 4 ? 53 : 52;
}

export function uniqueYears(seasons: Season[]): Season[] {
  const byYear = new Map<number, Season>();
  for (const season of seasons) {
    if (!byYear.has(season.year)) {
      byYear.set(season.year, season);
    }
  }

  return Array.from(byYear.values()).sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year;
    return b.created_at.localeCompare(a.created_at);
  });
}

export function yearNumbers(seasons: Season[], fallbackYear = new Date().getFullYear()): number[] {
  return Array.from(new Set([...seasons.map(season => season.year), fallbackYear])).sort((a, b) => b - a);
}

export function defaultYear(seasons: Season[], fallbackYear = new Date().getFullYear()): number {
  return seasons.find(season => season.is_active)?.year ?? seasons[0]?.year ?? fallbackYear;
}