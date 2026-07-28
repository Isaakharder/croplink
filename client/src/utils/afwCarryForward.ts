export type AfwSource = 'actual' | 'override';

export interface AfwRow {
  week_number: number;
  weight_grams: number;
  source: AfwSource;
}

export interface ResolvedAfw {
  weightGrams: number;
  asOfWeek: number;
  source: AfwSource;
}

// Mirrors server/src/lib/afwCarryForward.ts — resolves, for every harvest
// week 1..52, the latest known AFW as of that week (same-year only, carried
// forward from the most recent earlier week that has its own row). Used by
// the Calculator to show "Using latest actual: 220 g from W31" without an
// extra round trip.
export function resolveAfwCarryForward(rows: AfwRow[]): Map<number, ResolvedAfw | null> {
  const byWeek = new Map<number, AfwRow>();
  for (const row of rows) byWeek.set(row.week_number, row);

  const result = new Map<number, ResolvedAfw | null>();
  let lastKnown: ResolvedAfw | null = null;
  for (let w = 1; w <= 52; w++) {
    const row = byWeek.get(w);
    if (row) lastKnown = { weightGrams: row.weight_grams, asOfWeek: w, source: row.source };
    result.set(w, lastKnown);
  }
  return result;
}
