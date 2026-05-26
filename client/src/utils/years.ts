import { Season } from '../types';

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