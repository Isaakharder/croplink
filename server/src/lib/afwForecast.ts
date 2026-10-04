// Grower-entered AFW forecasts — pure (no I/O).
//
// Projection priority for a target packing week T (experimental models only;
// the legacy projection keeps its own harvest_afw_by_week series):
//   1. manual forecast entered for T itself            → 'manual-exact'
//   2. most recent manual forecast for a week before T → 'manual-carried'
//   3. latest SETTLED GrowLink AFW (week <= as-of)     → 'growlink-settled'
//   4. the existing fallback (latest GrowLink AFW, else
//      CropLink's harvest_afw_by_week)                  → its own source
//
// No look-ahead, in two senses:
//   - week: T only ever uses manual values for weeks <= T;
//   - time: a forecast only sees manual entries made by its knowledge time
//     (issue time for live forecasts, the as-of cutoff for hindcasts), and
//     GrowLink values only as they were — unchanged and settled — at the cutoff.
import { isoWeekIndex, isoWeekOfDate, isValidIsoWeek, weeksInIsoYear, fromIsoWeekIndex } from './isoWeek';
import { isSettled } from './harvestForecast';
import { harvestWindowFraction } from './cropWindow';

export const AFW_FORECAST_MIN_G = 20;
export const AFW_FORECAST_MAX_G = 1000;
/** Values outside this band are accepted but flagged for a second look. */
export const AFW_FORECAST_TYPICAL_G: [number, number] = [60, 450];
/** A GrowLink week is settled once unchanged this long (and 10 days past week end). */
export const SETTLE_QUIET_DAYS = 3;
/** Editor window when the variety has no pull-out date. */
export const NO_PULL_OUT_WEEKS = 12;
export const MAX_CHANGES_PER_SAVE = 120;

export interface ManualAfwEntry {
  id: number;
  varietyId: string;
  year: number;
  week: number;
  action: 'set' | 'clear';
  grams: number | null;
  enteredAt: string;
}

export interface ManualAfwValue { index: number; grams: number; entryId: number; enteredAt: string }

/** Current manual forecast per week index, using only entries made by `knownBy`. Cleared weeks are absent. */
export function effectiveManualAfw(entries: ManualAfwEntry[], knownBy: Date): Map<number, ManualAfwValue> {
  const latest = new Map<number, ManualAfwEntry>();
  for (const e of entries) {
    if (Date.parse(e.enteredAt) > knownBy.getTime()) continue;
    const i = isoWeekIndex(e.year, e.week);
    const prev = latest.get(i);
    if (!prev || Date.parse(e.enteredAt) > Date.parse(prev.enteredAt) || (e.enteredAt === prev.enteredAt && e.id > prev.id)) latest.set(i, e);
  }
  const out = new Map<number, ManualAfwValue>();
  for (const [i, e] of latest) if (e.action === 'set' && e.grams != null && e.grams > 0) out.set(i, { index: i, grams: Number(e.grams), entryId: e.id, enteredAt: e.enteredAt });
  return out;
}

export interface GrowlinkAfwPoint { index: number; grams: number; knownAt: string; settled: boolean | null }

/** Latest GrowLink AFW for a week <= asOf that was already settled — and unchanged since — at `at`. */
export function latestSettledGrowlinkAfw(points: GrowlinkAfwPoint[], asOfIndex: number, at: Date): GrowlinkAfwPoint | null {
  let best: GrowlinkAfwPoint | null = null;
  for (const p of points) {
    if (p.index > asOfIndex || p.settled !== true || !(p.grams > 0)) continue;
    const known = Date.parse(p.knownAt);
    if (known > at.getTime()) continue; // changed after the cutoff: the value then is unknown
    if (!isSettled(p.index, at) || known + SETTLE_QUIET_DAYS * 86_400_000 > at.getTime()) continue;
    if (!best || p.index > best.index) best = p;
  }
  return best;
}

export type TargetAfwSource = 'manual-exact' | 'manual-carried' | 'growlink-settled' | 'growlink-v2' | 'croplink-manual';

export interface TargetAfw {
  grams: number;
  source: TargetAfwSource;
  /** Week index the value belongs to (the manual week, or the GrowLink/CropLink measurement week). */
  fromIndex: number;
  entryId: number | null;
}

export function resolveTargetAfw(
  targetIndex: number,
  manual: Map<number, ManualAfwValue>,
  settled: GrowlinkAfwPoint | null,
  fallback: { index: number; grams: number; source: 'growlink-v2' | 'croplink-manual' } | null,
): TargetAfw | null {
  const exact = manual.get(targetIndex);
  if (exact) return { grams: exact.grams, source: 'manual-exact', fromIndex: exact.index, entryId: exact.entryId };
  let carried: ManualAfwValue | null = null;
  for (const v of manual.values()) if (v.index < targetIndex && (!carried || v.index > carried.index)) carried = v;
  if (carried) return { grams: carried.grams, source: 'manual-carried', fromIndex: carried.index, entryId: carried.entryId };
  if (settled) return { grams: settled.grams, source: 'growlink-settled', fromIndex: settled.index, entryId: null };
  if (fallback && fallback.grams > 0) return { grams: fallback.grams, source: fallback.source, fromIndex: fallback.index, entryId: null };
  return null;
}

export const AFW_SOURCE_LABELS: Record<TargetAfwSource, string> = {
  'manual-exact': 'Manual forecast (this week)',
  'manual-carried': 'Manual forecast (carried forward)',
  'growlink-settled': 'GrowLink settled actual',
  'growlink-v2': 'GrowLink actual (not settled)',
  'croplink-manual': 'CropLink AFW (existing fallback)',
};

// ── Editor window and validation ───────────────────────────────────────────

export function pullOutIndex(pullOutDate: string | null | undefined): number | null {
  if (!pullOutDate) return null;
  const w = isoWeekOfDate(new Date(`${pullOutDate}T12:00:00Z`));
  return isoWeekIndex(w.year, w.week);
}

/** Editable weeks: the current ISO week through the pull-out week (inclusive; W53 and year rollover exact). */
export function editableWeeks(now: Date, pullOutDate: string | null | undefined): { from: number; to: number; pullOutKnown: boolean } {
  const n = isoWeekOfDate(now);
  const from = isoWeekIndex(n.year, n.week);
  const pull = pullOutIndex(pullOutDate);
  if (pull == null) return { from, to: from + NO_PULL_OUT_WEEKS - 1, pullOutKnown: false };
  // A pull-out on Monday of a week leaves 1/7 of it; on/after pull-out nothing is harvested.
  let to = pull;
  while (to >= from && harvestWindowFraction(to, pullOutDate) <= 0) to--;
  return { from, to, pullOutKnown: true };
}

export interface AfwChange { year: number; week: number; grams: number | null }
export interface AfwChangeError { year: unknown; week: unknown; reason: string }

/**
 * Validates one Save. Accepted rows are normalised (grams rounded to 0.1 g).
 * Weeks before the current ISO week are rejected (history is not rewritten),
 * as are weeks after pull-out, duplicates, and clears of weeks with no value.
 */
export function validateAfwChanges(
  changes: unknown,
  ctx: { now: Date; pullOutDate: string | null | undefined; current: Map<number, ManualAfwValue> },
): { accepted: AfwChange[]; errors: AfwChangeError[]; notices: string[] } {
  const errors: AfwChangeError[] = [];
  const accepted: AfwChange[] = [];
  const notices: string[] = [];
  if (!Array.isArray(changes) || changes.length === 0) return { accepted, errors: [{ year: null, week: null, reason: 'No changes to save' }], notices };
  if (changes.length > MAX_CHANGES_PER_SAVE) return { accepted, errors: [{ year: null, week: null, reason: `At most ${MAX_CHANGES_PER_SAVE} weeks per save` }], notices };
  const win = editableWeeks(ctx.now, ctx.pullOutDate);
  const seen = new Set<number>();
  for (const raw of changes as Record<string, unknown>[]) {
    const year = Number(raw?.year);
    const week = Number(raw?.week);
    const fail = (reason: string) => errors.push({ year: raw?.year, week: raw?.week, reason });
    if (!isValidIsoWeek(year, week)) { fail(`W${raw?.week} does not exist in ${raw?.year}${Number.isInteger(year) ? ` (valid: 1–${weeksInIsoYear(year)})` : ''}`); continue; }
    const i = isoWeekIndex(year, week);
    const label = `${year}-W${String(week).padStart(2, '0')}`;
    if (seen.has(i)) { fail(`${label} appears twice`); continue; }
    seen.add(i);
    if (i < win.from) { fail(`${label} is in the past — AFW forecasts start at the current week (W${fromIsoWeekIndex(win.from).week})`); continue; }
    if (i > win.to) { fail(win.pullOutKnown ? `${label} is after the pull-out date` : `${label} is beyond the ${NO_PULL_OUT_WEEKS}-week window (no pull-out date set)`); continue; }
    if (raw?.grams === null || raw?.grams === undefined || raw?.grams === '') {
      if (!ctx.current.has(i)) { fail(`${label} has no forecast to clear`); continue; }
      accepted.push({ year, week, grams: null });
      continue;
    }
    const g = Number(raw.grams);
    if (!Number.isFinite(g)) { fail(`${label}: AFW must be a number`); continue; }
    if (g < AFW_FORECAST_MIN_G || g > AFW_FORECAST_MAX_G) { fail(`${label}: AFW must be between ${AFW_FORECAST_MIN_G} and ${AFW_FORECAST_MAX_G} g`); continue; }
    const grams = Math.round(g * 10) / 10;
    if (ctx.current.get(i)?.grams === grams) continue; // unchanged — nothing to record
    if (grams < AFW_FORECAST_TYPICAL_G[0] || grams > AFW_FORECAST_TYPICAL_G[1]) notices.push(`${label}: ${grams} g is outside the usual ${AFW_FORECAST_TYPICAL_G[0]}–${AFW_FORECAST_TYPICAL_G[1]} g range`);
    accepted.push({ year, week, grams });
  }
  return { accepted, errors, notices };
}
