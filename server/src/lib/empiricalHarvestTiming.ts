import { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './paginatedFetch';

// Same offset window ripeningActuals.ts already uses for its +4..+10 grid —
// kept as a local constant rather than importing from that route module, so
// this stays a plain library file with no route-layer dependency.
export const OFFSETS = [4, 5, 6, 7, 8, 9, 10] as const;

// Same threshold ripeningActuals.ts already uses (MIN_SAMPLE_SIZE_FOR_LEARNED_PROFILE)
// before trusting a learned distribution over a fallback — reused here for both
// the per-set-week resolution rate (Step 1) and the per-set-week timing shape
// (Step 2), so a thin set-week falls back the same way a thin breaker sample does.
export const MIN_RESOLVED_SAMPLE_SIZE = 5;

// How many weeks after its set-week a set-week's OWN resolution rate can be
// trusted at all, regardless of sample size. Derived from OFFSETS (not a
// second independent magic number) so it can never drift out of sync with
// the window this module actually models: OFFSETS tops out at +10, one week
// past the empirically observed max — confirmed directly against
// fruit_instances (all varieties, all years, every harvested row with a
// known offset) at the time this gate was added: offsets +3..+9 only, zero
// at +10, out of 263 harvested instances. A set-week younger than this has
// simply not had time for its harvest tail to show up yet — its "resolved"
// pool skews toward abort/prune, which resolve fast, while harvest takes
// 5-9 weeks. That's a maturity problem, not a sample-size problem, so the
// existing MIN_RESOLVED_SAMPLE_SIZE gate above can't catch it (see
// SetWk30 in the 2026-08-28 backtest: 89 resolved instances, 0 harvested —
// a large sample that is still completely immature).
export const MATURITY_WINDOW_WEEKS = Math.max(...OFFSETS);

// Floor for the POOL itself (distinct from MIN_RESOLVED_SAMPLE_SIZE, which
// gates a single set-week). Reuses the same value deliberately — it's
// already the established "trust this only past n=5" threshold elsewhere
// in the codebase (ripeningActuals.ts's breaker profile), so this isn't a
// new number to justify on its own. What differs is what happens BELOW the
// floor: see the comment on PooledFallback.isThin.
export const MIN_POOL_SAMPLE_SIZE = MIN_RESOLVED_SAMPLE_SIZE;

// Same ISO-week calculation ripeningActuals.ts, breakerLearning.ts, and
// harvestAfwByWeek.ts each already carry their own copy of — kept local
// here too rather than centralized, matching that existing per-file
// convention.
function getIsoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

interface FruitInstanceRow {
  set_year: number;
  set_week_number: number;
  status: string;
  harvested_year: number | null;
  harvested_week_number: number | null;
}

export interface SetWeekTiming {
  setWeekNumber: number;
  /** harvested + aborted + pruned for this set-week, this year only. */
  resolvedCount: number;
  harvestedCount: number;
  /** harvested / resolved — the fraction of set fruit that actually becomes a harvest, of any timing. */
  resolutionRate: number;
  resolutionRateIsFallback: boolean;
  /** True when the fallback specifically fired because this set-week hasn't reached MATURITY_WINDOW_WEEKS yet — distinct from firing on sample size, since the sample can be large and still immature (see SetWk30, 2026-08-28 backtest). */
  resolutionRateFallbackReason: 'sample-too-small' | 'not-yet-matured' | 'sample-too-small-and-not-matured' | null;
  /** % of in-window harvested fruit landing at each offset (4..10) — sums to ~100 across the window. */
  offsetPercents: Record<number, number>;
  offsetPercentsIsFallback: boolean;
}

export interface PooledFallback {
  resolutionRate: number | null;
  resolutionRateSampleSize: number;
  offsetPercents: Record<number, number> | null;
  offsetPercentsSampleSize: number;
  /** Distinct (set_year, set_week_number) pairs feeding this pool — not just an instance count, since a pool built from one giant set-week is a different (weaker) kind of evidence than the same instance count spread across several. */
  sampleSetWeeks: number;
  /**
   * True when resolutionRateSampleSize < MIN_POOL_SAMPLE_SIZE — the pool
   * itself doesn't have enough matured, resolved evidence yet. This is
   * expected and unavoidable early in a variety's first season (nothing
   * has had time to mature). No auto-widening is implemented for this
   * case: reaching into a PRIOR season for the "same" variety was
   * considered, but the schema has no stable cross-season variety
   * identity — `varieties.id` is 1:1 with `season_id`, so a variety
   * grown again next year gets a brand-new row with no link back to this
   * one, and matching on `name` alone would be a heuristic (a renamed or
   * coincidentally-same-named variety would silently pool the wrong
   * data). No prior season exists for any variety today either, so this
   * would be unexercised, unverifiable code if written now. Left as an
   * explicit decision for sign-off rather than guessed at — see the
   * 2026-08-28 projection audit thread. Until then, a thin/empty pool
   * still resolves safely: resolutionRate falls through to the set-week's
   * OWN rate, and only to the fixed default of 1 (no loss) if that is
   * also unavailable — never NaN, never a silent revert to the
   * unfiltered (maturity-contaminated) pool this fix exists to avoid.
   */
  isThin: boolean;
}

export interface EmpiricalHarvestTimingResult {
  bySetWeek: Map<number, SetWeekTiming>;
  /** Variety-wide (all years, all set-weeks) pooled fallback — same "pool everything else" pattern the breaker-timing profile in ripeningActuals.ts already uses. */
  pooled: PooledFallback;
}

function computeOffsetPercents(harvestedInWindow: { offset: number }[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const o of OFFSETS) counts[o] = 0;
  for (const h of harvestedInWindow) counts[h.offset] = (counts[h.offset] ?? 0) + 1;
  const total = harvestedInWindow.length;
  const percents: Record<number, number> = {};
  for (const o of OFFSETS) {
    percents[o] = total > 0 ? (counts[o] / total) * 100 : 0;
  }
  return percents;
}

/**
 * Empirical replacement for the static harvest_timing_profiles week4_percent..
 * week10_percent columns. Computed live from fruit_instances so it reflects
 * this variety's actual set→harvest behavior instead of a value hand-entered
 * once and never revisited (see the 2026-08-28 projection audit).
 *
 * Two things are computed per set-week, each with its own fallback when the
 * set-week doesn't have enough resolved fruit yet:
 *  - resolutionRate (Step 1): what fraction of set fruit is EVER harvested,
 *    vs. aborted/pruned. Replaces the old implicit "100% of set fruit is
 *    eventually harvested" assumption.
 *  - offsetPercents (Step 2): GIVEN a fruit is harvested, which week (offset
 *    from its set week) it lands in. Replaces the fixed 20/40/40 curve.
 *
 * The fallback for both is the variety-wide pool (all years, all set-weeks)
 * — the same "pool everything else" shape ripeningActuals.ts already uses
 * for its breaker-to-harvest profile — never the old fixed curve.
 */
export async function computeEmpiricalHarvestTiming(
  supabase: SupabaseClient,
  varietyId: string,
  year: number
): Promise<EmpiricalHarvestTimingResult> {
  // Paginated — confirmed live that a plain, unpaginated select() here
  // silently truncates to Supabase's default 1,000-row cap (Mathieu alone
  // has 1,307 fruit_instances rows; a variety further into its season would
  // only get worse). This was a real, load-bearing bug: it silently fed
  // survival rate and timing shape from an incomplete, non-random slice
  // (whatever order Postgres happens to return without an ORDER BY) of the
  // true population. See the 2026-08-28 Round 7 investigation.
  const all = await fetchAllRows<FruitInstanceRow>(() =>
    supabase
      .from('fruit_instances')
      .select('set_year, set_week_number, status, harvested_year, harvested_week_number')
      .eq('variety_id', varietyId)
  );

  const today = new Date();
  const todayAbsWeek = today.getFullYear() * 52 + getIsoWeek(today);

  const isResolved = (r: FruitInstanceRow) => r.status === 'harvested' || r.status === 'aborted' || r.status === 'pruned';

  function harvestedOffset(r: FruitInstanceRow): number | null {
    if (r.status !== 'harvested' || r.harvested_year == null || r.harvested_week_number == null) return null;
    return (r.harvested_year - r.set_year) * 52 + r.harvested_week_number - r.set_week_number;
  }

  // ── Variety-wide pool — the fallback source ──────────────────────────────
  // Maturity-filtered: a set-week that isn't old enough to trust for its OWN
  // rate (see the per-set-week gate below) must not be included in the pool
  // either, or the pool just launders the same still-resolving, abort-biased
  // data back in one level up. Confirmed this was happening before this
  // filter existed: the unfiltered pool sat at 41.9% vs. 65-93% for the
  // set-weeks that were actually matured (2026-08-28 backtest).
  function isMatured(r: FruitInstanceRow): boolean {
    return r.set_year * 52 + r.set_week_number + MATURITY_WINDOW_WEEKS <= todayAbsWeek;
  }

  const maturedAll = all.filter(isMatured);
  const pooledResolved = maturedAll.filter(isResolved);
  const pooledHarvested = pooledResolved.filter((r) => r.status === 'harvested');
  const pooledHarvestedInWindow = pooledHarvested
    .map((r) => ({ offset: harvestedOffset(r) }))
    .filter((h): h is { offset: number } => h.offset != null && (OFFSETS as readonly number[]).includes(h.offset));
  const pooledSetWeeks = new Set(pooledResolved.map((r) => `${r.set_year}-${r.set_week_number}`));

  const pooled: PooledFallback = {
    resolutionRate: pooledResolved.length > 0 ? pooledHarvested.length / pooledResolved.length : null,
    resolutionRateSampleSize: pooledResolved.length,
    offsetPercents: pooledHarvestedInWindow.length > 0 ? computeOffsetPercents(pooledHarvestedInWindow) : null,
    offsetPercentsSampleSize: pooledHarvestedInWindow.length,
    sampleSetWeeks: pooledSetWeeks.size,
    isThin: pooledResolved.length < MIN_POOL_SAMPLE_SIZE,
  };

  // ── Per-set-week, this year only ─────────────────────────────────────────
  const thisYear = all.filter((r) => r.set_year === year);
  const bySetWeekRaw = new Map<number, FruitInstanceRow[]>();
  for (const r of thisYear) {
    const sw = r.set_week_number;
    if (!bySetWeekRaw.has(sw)) bySetWeekRaw.set(sw, []);
    bySetWeekRaw.get(sw)!.push(r);
  }

  const bySetWeek = new Map<number, SetWeekTiming>();
  for (const [setWeekNumber, group] of bySetWeekRaw) {
    const resolved = group.filter(isResolved);
    const harvested = resolved.filter((r) => r.status === 'harvested');
    const harvestedInWindow = harvested
      .map((r) => ({ offset: harvestedOffset(r) }))
      .filter((h): h is { offset: number } => h.offset != null && (OFFSETS as readonly number[]).includes(h.offset));

    // Both conditions must pass before a set-week's own resolution rate is
    // trusted over the pool: enough samples (MIN_RESOLVED_SAMPLE_SIZE) AND
    // enough calendar time for the harvest tail to have had a chance to show
    // up (MATURITY_WINDOW_WEEKS). A set-week can fail on sample size alone,
    // maturity alone, or both — surfaced separately so it's inspectable
    // rather than collapsed into one opaque boolean.
    const sampleTooSmall = resolved.length < MIN_RESOLVED_SAMPLE_SIZE;
    const notYetMatured = year * 52 + setWeekNumber + MATURITY_WINDOW_WEEKS > todayAbsWeek;
    const resolutionRateIsFallback = sampleTooSmall || notYetMatured;
    const resolutionRateFallbackReason: SetWeekTiming['resolutionRateFallbackReason'] =
      sampleTooSmall && notYetMatured ? 'sample-too-small-and-not-matured'
      : sampleTooSmall ? 'sample-too-small'
      : notYetMatured ? 'not-yet-matured'
      : null;
    const ownResolutionRate = resolved.length > 0 ? harvested.length / resolved.length : null;
    // Never fall back to "assume no loss" (rate 1) unless there is truly
    // nowhere else to look — the pool itself is empty too.
    const resolutionRate = !resolutionRateIsFallback
      ? (ownResolutionRate as number)
      : pooled.resolutionRate ?? ownResolutionRate ?? 1;

    const offsetPercentsIsFallback = harvestedInWindow.length < MIN_RESOLVED_SAMPLE_SIZE;
    const ownOffsetPercents = harvestedInWindow.length > 0 ? computeOffsetPercents(harvestedInWindow) : null;
    const offsetPercents = !offsetPercentsIsFallback
      ? (ownOffsetPercents as Record<number, number>)
      : pooled.offsetPercents ?? ownOffsetPercents ?? Object.fromEntries(OFFSETS.map((o) => [o, 0]));

    bySetWeek.set(setWeekNumber, {
      setWeekNumber,
      resolvedCount: resolved.length,
      harvestedCount: harvested.length,
      resolutionRate,
      resolutionRateIsFallback,
      resolutionRateFallbackReason,
      offsetPercents,
      offsetPercentsIsFallback,
    });
  }

  return { bySetWeek, pooled };
}
