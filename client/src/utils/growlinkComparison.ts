// Deterministic "Projected vs GrowLink Actual" comparison — reporting only.
//
// This module NEVER writes anywhere. It only reads already-computed
// projectedKg figures (from GET /harvest-projections, itself driven by
// harvest_timing_profiles + fruit_weight_by_week — see the trace in the
// commit that added this file) and already-synced GrowLink actuals (from
// growlink_harvest_actuals), and joins them client-side for display. It
// must never be imported by anything that generates or stores a forecast —
// if you're tempted to import this from a projection/forecast code path,
// that's the wrong direction; this consumes forecasts, it doesn't feed them.
import type { GrowlinkHarvestActual } from '../types';

export interface WeeklyComparisonRow {
  week: number;
  projectedKg: number;
  /** null means no matched GrowLink record exists for this week — distinct from a real 0 kg actual. */
  actualKg: number | null;
  /**
   * null whenever actualKg is null, OR projectedKg is not greater than 0.
   * A difference against zero/unavailable projected kg isn't a meaningful
   * comparison — it would just restate the actual as if it were "all
   * variance," which misrepresents "no projection exists" as "the forecast
   * was off by 100%." Only computed when there's an actual projection to
   * compare against.
   */
  differenceKg: number | null;
  /** Same null conditions as differenceKg, plus never computed when projectedKg is 0 (would be a division by zero — never silently coerced to 0/Infinity). */
  differencePct: number | null;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export interface DifferenceLabel {
  /** Plain-language, no arrow embedded: "12.4% over" / "8.7% under" / "On target" / "—". */
  text: string;
  /** '' when there's nothing to compare or the % is undefined (projected kg is 0) — never shown as an arrow in that case. */
  arrow: '▲' | '▼' | '';
}

/**
 * Neutral-styling plain-language label for a comparison row's difference —
 * no green/red here deliberately: this app has no pre-existing convention
 * for which direction of "actual vs. projected" is good or bad, so this
 * uses direction-neutral arrows instead of asserting one.
 */
export function formatDifferenceLabel(row: Pick<WeeklyComparisonRow, 'differenceKg' | 'differencePct'>): DifferenceLabel {
  if (row.differenceKg == null) return { text: '—', arrow: '' }; // no matched GrowLink actual for this week
  if (row.differencePct == null) return { text: '—', arrow: '' }; // projected kg was 0 — percentage is undefined, not 0/Infinity
  if (row.differencePct === 0) return { text: 'On target', arrow: '' };
  const abs = Math.abs(row.differencePct);
  return row.differencePct > 0
    ? { text: `${abs.toFixed(1)}% over`, arrow: '▲' }
    : { text: `${abs.toFixed(1)}% under`, arrow: '▼' };
}

/**
 * Joins a variety's (or a multi-variety total's) projected-kg-by-week series
 * against matched GrowLink harvest actuals for the same weeks.
 *
 * `matchedActuals` is filtered to `variety_id != null` again here even
 * though callers are expected to already request matched-only records —
 * this is the hard invariant the reporting requirement calls for, not just
 * a convention the caller has to remember to uphold.
 */
export function buildWeeklyComparison(
  projectedByWeek: { week: number; projectedKg: number }[],
  matchedActuals: GrowlinkHarvestActual[]
): WeeklyComparisonRow[] {
  const matched = matchedActuals.filter((a) => a.variety_id != null);

  const actualByWeek = new Map<number, number>();
  for (const a of matched) {
    if (a.kg == null) continue;
    actualByWeek.set(a.week_number, (actualByWeek.get(a.week_number) ?? 0) + Number(a.kg));
  }

  const projectedByWeekNum = new Map(projectedByWeek.map((w) => [w.week, w.projectedKg]));
  const weeks = Array.from(new Set([...projectedByWeekNum.keys(), ...actualByWeek.keys()])).sort((a, b) => a - b);

  const rows: WeeklyComparisonRow[] = [];
  for (const week of weeks) {
    const projectedKg = projectedByWeekNum.get(week) ?? 0;
    const hasActual = actualByWeek.has(week);
    const actualKg = hasActual ? (actualByWeek.get(week) as number) : null;

    // Nothing projected and nothing actual for this week — skip it, same as
    // the existing Projected-vs-Actual card's week filter.
    if (projectedKg === 0 && !hasActual) continue;

    let differenceKg: number | null = null;
    let differencePct: number | null = null;
    // Only calculate a difference when there's an actual AND a real (> 0)
    // projection to measure it against — a week with an actual but no
    // projection has nothing to compare, not "100% variance."
    if (actualKg != null && projectedKg > 0) {
      differenceKg = round2(actualKg - projectedKg);
      differencePct = round2(((actualKg - projectedKg) / projectedKg) * 100);
    }

    rows.push({
      week,
      projectedKg: round2(projectedKg),
      actualKg: actualKg != null ? round2(actualKg) : null,
      differenceKg,
      differencePct,
    });
  }

  return rows;
}
