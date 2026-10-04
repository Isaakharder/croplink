// Harvest forecast models + the chronological replay that feeds them.
//
// Everything here is pure (no Supabase, no clock): callers pass in the raw
// weekly node statuses and the week the forecast is made "as of". That one
// property is what makes the backtest honest — the same function that
// would serve growers is evaluated at each past week using only what had
// been recorded by then (week <= asOf AND entered by the forecast date).
//
// Weeks are handled as ISO-week indexes (see isoWeek.ts), so set→harvest
// offsets, maturity ages, and forecast horizons are exact across W52/W53
// and year boundaries.
import { IsoWeek, isoWeekIndex, fromIsoWeekIndex, isoWeekMonday } from './isoWeek';
import { harvestWindowFraction } from './cropWindow';
import { computeEmpiricalHarvestTimingFromRows, FruitInstanceRow, OFFSETS } from './empiricalHarvestTiming';

/** A cohort (all fruit set in one week) is mature once this many full weeks have passed — the same window as empiricalHarvestTiming's MATURITY_WINDOW_WEEKS. */
export const MATURITY_WEEKS = 10;
/** Weeks after which a still-open cohort counts as "near-mature" for the conservative lower-bound fallback. */
export const NEAR_MATURE_WEEKS = 8;
/** Minimum fruit behind any learned rate (survival, timing curve, or a per-age hazard). */
export const MIN_SAMPLE = 30;
/** Longest set→harvest offset modelled. Observed max in 2026 data is +14 (rare). */
export const MAX_AGE = 14;
/** The curve stored in harvest_timing_profiles today (20/40/40 at +6/+7/+8). */
export const FIXED_CURVE: Record<number, number> = { 6: 0.2, 7: 0.4, 8: 0.4 };

// ── Replay ────────────────────────────────────────────────────────────────

export interface StatusEvent {
  plantNodeId: string;
  stemId: string;
  year: number;
  week: number;
  status: string;
  createdAt: string;
}

export type FruitOutcome = 'open' | 'harvested' | 'aborted' | 'pruned';

export interface FruitLifecycle {
  nodeId: string;
  /** isoWeekIndex of the set week. */
  setIndex: number;
  outcome: FruitOutcome;
  /** isoWeekIndex of the harvest/abort/prune week; null while open. */
  endIndex: number | null;
}

export interface KnowledgeCutoff {
  asOfIndex: number;
  /** Status rows created after this instant were not yet known. */
  enteredBy: Date;
}

/**
 * What a forecast made for week `asOf` could see: statuses for weeks up to
 * and including asOf, entered by the end of the Monday after it (the
 * forecast is run the Monday following the measurement week; the extra day
 * absorbs Sunday-evening entries in North American time zones).
 */
export function forecastCutoff(asOf: IsoWeek): KnowledgeCutoff {
  const nextMonday = isoWeekMonday(asOf.year, asOf.week).getTime() + 7 * 86_400_000;
  return { asOfIndex: isoWeekIndex(asOf.year, asOf.week), enteredBy: new Date(nextMonday + 86_400_000) };
}

function visible(events: StatusEvent[], cutoff?: KnowledgeCutoff): StatusEvent[] {
  if (!cutoff) return events;
  return events.filter(
    (e) => isoWeekIndex(e.year, e.week) <= cutoff.asOfIndex && new Date(e.createdAt) <= cutoff.enteredBy
  );
}

/**
 * Rebuilds fruit lifecycles from raw statuses with exactly the rules
 * routes/weeklyStatuses.ts applies when it maintains fruit_instances, in
 * entry order: one open fruit per node; a SetFruit for an earlier week
 * moves the open fruit's set week back; Harvested/Aborted/Pruned close the
 * open fruit; BreakerFruit (and every other status) changes nothing here —
 * breaker-stage fruit is already counted as open set fruit, never added
 * on top.
 */
export function replayFruitLifecycles(events: StatusEvent[], cutoff?: KnowledgeCutoff): FruitLifecycle[] {
  const ordered = [...visible(events, cutoff)].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      isoWeekIndex(a.year, a.week) - isoWeekIndex(b.year, b.week)
  );
  const fruits: FruitLifecycle[] = [];
  const openByNode = new Map<string, FruitLifecycle>();
  for (const e of ordered) {
    const idx = isoWeekIndex(e.year, e.week);
    const open = openByNode.get(e.plantNodeId);
    if (e.status === 'SetFruit') {
      if (open) {
        if (idx < open.setIndex) open.setIndex = idx;
      } else {
        const f: FruitLifecycle = { nodeId: e.plantNodeId, setIndex: idx, outcome: 'open', endIndex: null };
        fruits.push(f);
        openByNode.set(e.plantNodeId, f);
      }
    } else if (open && (e.status === 'Harvested' || e.status === 'Aborted' || e.status === 'Pruned')) {
      open.outcome = e.status.toLowerCase() as FruitOutcome;
      open.endIndex = idx;
      openByNode.delete(e.plantNodeId);
    }
  }
  return fruits;
}

export interface WeekCoverage {
  /** Distinct stems with any status recorded that week — the fruit-per-m² scaling denominator. */
  measuredStems: number;
  /** Raw SetFruit status count that week (a standing census — what the deployed model uses). */
  censusSetFruit: number;
}

export function summarizeWeeks(events: StatusEvent[], cutoff?: KnowledgeCutoff): Map<number, WeekCoverage> {
  const acc = new Map<number, { stems: Set<string>; census: number }>();
  for (const e of visible(events, cutoff)) {
    const idx = isoWeekIndex(e.year, e.week);
    if (!acc.has(idx)) acc.set(idx, { stems: new Set(), census: 0 });
    const a = acc.get(idx)!;
    a.stems.add(e.stemId);
    if (e.status === 'SetFruit') a.census++;
  }
  return new Map([...acc].map(([idx, a]) => [idx, { measuredStems: a.stems.size, censusSetFruit: a.census }]));
}

// ── Forecast ──────────────────────────────────────────────────────────────

export type ModelId = 'deployed' | 'A' | 'B' | 'C' | 'D';

export interface ForecastInput {
  asOf: IsoWeek;
  /** Already cut to asOf (replayFruitLifecycles with forecastCutoff). */
  lifecycles: FruitLifecycle[];
  /** Already cut to asOf. */
  coverage: Map<number, WeekCoverage>;
  /** Stored manual avg_fruit_set by set-week index — used ONLY for set weeks with no measurement. */
  manualFruitSetPerM2: Map<number, number>;
  /** AFW rows known as of asOf. */
  afw: { index: number; grams: number }[];
  totalStems: number;
  areaM2: number;
  /** Crop pull-out date (YYYY-MM-DD, inclusive). No harvest is forecast after it. */
  pullOutDate?: string | null;
}

export { harvestWindowFraction };

export interface WeekForecast extends IsoWeek {
  index: number;
  fruitPerM2: number;
  /** null when no AFW is known for this week — fruit is still reported. */
  kg: number | null;
  /** Expected share of this week's harvest that comes from cohorts already set by asOf (lower = more of it depends on fruit not set yet). */
  coverage: number;
  /** Share of the week before the crop's pull-out date (harvest after it is truncated). */
  harvestWindow: number;
}

export interface ForecastEvidence {
  matureCohortFruit: number;
  survival: { rate: number; tier: 'mature-pool' | 'near-mature-lower-bound' | 'no-evidence'; sample: number };
  curve: { tier: 'mature-pool' | 'fixed-fallback'; sample: number };
  /** Model D only. */
  hazards?: { tier: 'mature-hazards' | 'no-mature-evidence'; agesWithOwnSample: number; tailPooledFromAge: number | null };
  cohortsFromManual: number;
}

export interface ForecastResult {
  model: ModelId;
  asOf: IsoWeek;
  weeks: WeekForecast[];
  evidence: ForecastEvidence;
}

type Curve = Map<number, number>; // offset → probability

function curveFrom(record: Record<number, number>): Curve {
  return new Map(Object.entries(record).map(([o, p]) => [Number(o), p]));
}

interface Cohort {
  setIndex: number;
  /** fruit/m² per fruit counted on measured stems in this cohort's set week. */
  perFruitM2: number;
  fruits: FruitLifecycle[];
  censusFruitPerM2: number;
  /** Set only for manual cohorts (no measurement that week). */
  manualFruitPerM2: number | null;
}

function buildCohorts(input: ForecastInput, asOfIndex: number, horizon: number): Cohort[] {
  const bySet = new Map<number, FruitLifecycle[]>();
  for (const f of input.lifecycles) {
    if (!bySet.has(f.setIndex)) bySet.set(f.setIndex, []);
    bySet.get(f.setIndex)!.push(f);
  }
  const cohorts: Cohort[] = [];
  for (let s = asOfIndex - MAX_AGE; s <= asOfIndex + horizon; s++) {
    const cov = input.coverage.get(s);
    const measured = s <= asOfIndex && cov != null && cov.measuredStems > 0;
    if (measured) {
      const perFruitM2 = input.areaM2 > 0 ? input.totalStems / cov.measuredStems / input.areaM2 : 0;
      cohorts.push({ setIndex: s, perFruitM2, fruits: bySet.get(s) ?? [], censusFruitPerM2: cov.censusSetFruit * perFruitM2, manualFruitPerM2: null });
    } else if ((input.manualFruitSetPerM2.get(s) ?? 0) > 0) {
      const m = input.manualFruitSetPerM2.get(s)!;
      cohorts.push({ setIndex: s, perFruitM2: 0, fruits: [], censusFruitPerM2: m, manualFruitPerM2: m });
    }
  }
  return cohorts;
}

function pooledSurvival(all: FruitLifecycle[], asOfIndex: number): ForecastEvidence['survival'] {
  const mature = all.filter((f) => f.setIndex + MATURITY_WEEKS <= asOfIndex);
  if (mature.length >= MIN_SAMPLE) {
    // Still-open fruit in a mature cohort counts as NOT harvested — conservative.
    return { rate: mature.filter((f) => f.outcome === 'harvested').length / mature.length, tier: 'mature-pool', sample: mature.length };
  }
  const near = all.filter((f) => f.setIndex + NEAR_MATURE_WEEKS <= asOfIndex);
  if (near.length >= MIN_SAMPLE) {
    // Lower bound: anything not yet harvested is assumed lost.
    return { rate: near.filter((f) => f.outcome === 'harvested').length / near.length, tier: 'near-mature-lower-bound', sample: near.length };
  }
  return { rate: 1, tier: 'no-evidence', sample: near.length };
}

function pooledCurve(all: FruitLifecycle[], asOfIndex: number): { curve: Curve; evidence: ForecastEvidence['curve'] } {
  const harvested = all.filter(
    (f) => f.setIndex + MATURITY_WEEKS <= asOfIndex && f.outcome === 'harvested' && f.endIndex != null && f.endIndex - f.setIndex <= MAX_AGE
  );
  if (harvested.length < MIN_SAMPLE) return { curve: curveFrom(FIXED_CURVE), evidence: { tier: 'fixed-fallback', sample: harvested.length } };
  const curve: Curve = new Map();
  for (const f of harvested) {
    const o = (f.endIndex as number) - f.setIndex;
    curve.set(o, (curve.get(o) ?? 0) + 1 / harvested.length);
  }
  return { curve, evidence: { tier: 'mature-pool', sample: harvested.length } };
}

interface Hazards {
  harvest: number[];
  loss: number[];
  agesWithOwnSample: number;
  tailPooledFromAge: number | null;
}

/**
 * Discrete-time competing-risk hazards by fruit age, learned from mature
 * cohorts only: P(harvested at age j | still open entering age j) and the
 * same for abort/prune. Fruit is "at risk" at age j only if its cohort has
 * actually been observed through age j (proper censoring for ages beyond
 * the maturity window). Any age with fewer than MIN_SAMPLE fruit at risk is
 * pooled with every older age into one tail hazard; if even the pooled
 * tail lacks MIN_SAMPLE fruit-weeks, there is no usable evidence.
 */
function learnHazards(all: FruitLifecycle[], asOfIndex: number): Hazards | null {
  const mature = all.filter((f) => f.setIndex + MATURITY_WEEKS <= asOfIndex);
  const atRisk = new Array(MAX_AGE + 1).fill(0);
  const harv = new Array(MAX_AGE + 1).fill(0);
  const loss = new Array(MAX_AGE + 1).fill(0);
  for (const f of mature) {
    const eventAge = f.endIndex != null ? f.endIndex - f.setIndex : null;
    for (let j = 0; j <= MAX_AGE; j++) {
      if (f.setIndex + j > asOfIndex) break; // not observed at this age yet
      if (eventAge != null && eventAge < j) break; // already resolved
      atRisk[j]++;
      if (eventAge === j) {
        if (f.outcome === 'harvested') harv[j]++;
        else loss[j]++;
        break;
      }
    }
  }
  if (atRisk[0] < MIN_SAMPLE) return null;

  const h: Hazards = { harvest: [], loss: [], agesWithOwnSample: 0, tailPooledFromAge: null };
  for (let j = 0; j <= MAX_AGE; j++) {
    if (atRisk[j] >= MIN_SAMPLE) {
      h.harvest[j] = harv[j] / atRisk[j];
      h.loss[j] = loss[j] / atRisk[j];
      h.agesWithOwnSample++;
      continue;
    }
    const sum = (a: number[]) => a.slice(j).reduce((x, y) => x + y, 0);
    const r = sum(atRisk);
    h.tailPooledFromAge = j;
    for (let k = j; k <= MAX_AGE; k++) {
      h.harvest[k] = r >= MIN_SAMPLE ? sum(harv) / r : 0;
      h.loss[k] = r >= MIN_SAMPLE ? sum(loss) / r : 0;
    }
    break;
  }
  return h;
}

/** P(harvested at age o | open at the end of age a), for o in a+1..MAX_AGE. a = -1 means "unconditional, from set". */
function conditionalHarvest(h: Hazards, a: number): Curve {
  const out: Curve = new Map();
  let survive = 1;
  for (let o = a + 1; o <= MAX_AGE; o++) {
    out.set(o, survive * h.harvest[o]);
    survive *= 1 - h.harvest[o] - h.loss[o];
    if (survive <= 0) break;
  }
  return out;
}

function restrictCurve(curve: Curve, minOffset: number): Curve {
  const kept = [...curve].filter(([o]) => o >= minOffset);
  const total = kept.reduce((s, [, p]) => s + p, 0);
  return new Map(total > 0 ? kept.map(([o, p]) => [o, p / total]) : []);
}

function resolveAfw(rows: ForecastInput['afw']): (index: number) => number | null {
  const sorted = [...rows].sort((a, b) => a.index - b.index);
  return (index: number) => {
    let found: number | null = null;
    for (const r of sorted) {
      if (r.index > index) break;
      if (r.grams > 0) found = r.grams;
    }
    return found;
  };
}

export function forecastHarvest(input: ForecastInput, model: ModelId, horizon = MAX_AGE): ForecastResult {
  const asOfIndex = isoWeekIndex(input.asOf.year, input.asOf.week);
  const cohorts = buildCohorts(input, asOfIndex, horizon);
  const survival = pooledSurvival(input.lifecycles, asOfIndex);
  const { curve: matureCurve, evidence: curveEvidence } = pooledCurve(input.lifecycles, asOfIndex);
  const evidence: ForecastEvidence = {
    matureCohortFruit: input.lifecycles.filter((f) => f.setIndex + MATURITY_WEEKS <= asOfIndex).length,
    survival,
    curve: curveEvidence,
    cohortsFromManual: cohorts.filter((c) => c.manualFruitPerM2 != null).length,
  };

  const fruitByWeek = new Map<number, number>();
  const add = (harvestIndex: number, fruitPerM2: number) => {
    if (harvestIndex <= asOfIndex || harvestIndex > asOfIndex + horizon || fruitPerM2 <= 0) return;
    fruitByWeek.set(harvestIndex, (fruitByWeek.get(harvestIndex) ?? 0) + fruitPerM2);
  };
  const spread = (setIndex: number, fruitPerM2: number, curve: Curve) => {
    for (const [o, p] of curve) add(setIndex + o, fruitPerM2 * p);
  };
  const flowFruitPerM2 = (c: Cohort) => c.manualFruitPerM2 ?? c.fruits.length * c.perFruitM2;
  const fixed = curveFrom(FIXED_CURVE);

  if (model === 'deployed') {
    for (const c of cohorts) spread(c.setIndex, c.censusFruitPerM2, fixed);
  } else if (model === 'A') {
    for (const c of cohorts) spread(c.setIndex, flowFruitPerM2(c) * survival.rate, fixed);
  } else if (model === 'C') {
    for (const c of cohorts) spread(c.setIndex, flowFruitPerM2(c) * survival.rate, matureCurve);
  } else if (model === 'B') {
    // The existing debug-only gated empirical model, evaluated as of asOf
    // through its own code. It keys by calendar year*52+week and takes the
    // census fruit-set input, exactly as /harvest-projections?debug=true does.
    const rows: FruitInstanceRow[] = input.lifecycles.map((f) => {
      const set = fromIsoWeekIndex(f.setIndex);
      const end = f.endIndex != null ? fromIsoWeekIndex(f.endIndex) : null;
      return { set_year: set.year, set_week_number: set.week, status: f.outcome, harvested_year: f.outcome === 'harvested' ? end!.year : null, harvested_week_number: f.outcome === 'harvested' ? end!.week : null };
    });
    const timing = computeEmpiricalHarvestTimingFromRows(rows, input.asOf.year, input.asOf.year * 52 + input.asOf.week);
    for (const c of cohorts) {
      const set = fromIsoWeekIndex(c.setIndex);
      const t = set.year === input.asOf.year ? timing.bySetWeek.get(set.week) : undefined;
      const rate = t?.resolutionRate ?? timing.pooled.resolutionRate ?? 1;
      const offsets = t?.offsetPercents ?? timing.pooled.offsetPercents ?? {};
      const curve: Curve = new Map(OFFSETS.map((o) => [o, (offsets[o] ?? 0) / 100]));
      spread(c.setIndex, c.censusFruitPerM2 * rate, curve);
    }
  } else {
    const hazards = learnHazards(input.lifecycles, asOfIndex);
    evidence.hazards = hazards
      ? { tier: 'mature-hazards', agesWithOwnSample: hazards.agesWithOwnSample, tailPooledFromAge: hazards.tailPooledFromAge }
      : { tier: 'no-mature-evidence', agesWithOwnSample: 0, tailPooledFromAge: null };
    for (const c of cohorts) {
      if (c.manualFruitPerM2 != null || c.setIndex > asOfIndex) {
        // No lifecycle data — unconditional from set.
        const curve = hazards ? conditionalHarvest(hazards, -1) : new Map([...fixed].map(([o, p]) => [o, p * survival.rate]));
        spread(c.setIndex, flowFruitPerM2(c), curve);
        continue;
      }
      const age = asOfIndex - c.setIndex;
      const open = c.fruits.filter((f) => f.outcome === 'open').length;
      if (open === 0) continue;
      const curve = hazards
        ? conditionalHarvest(hazards, age)
        : new Map([...restrictCurve(fixed, age + 1)].map(([o, p]) => [o, p * survival.rate]));
      spread(c.setIndex, open * c.perFruitM2, curve);
    }
  }

  const afwAt = resolveAfw(input.afw);
  const typicalCurve = curveEvidence.tier === 'mature-pool' ? matureCurve : fixed;
  const weeks: WeekForecast[] = [];
  for (let i = asOfIndex + 1; i <= asOfIndex + horizon; i++) {
    const harvestWindow = harvestWindowFraction(i, input.pullOutDate);
    const fruitPerM2 = (fruitByWeek.get(i) ?? 0) * harvestWindow;
    const afw = afwAt(i);
    const lead = i - asOfIndex;
    const coverage = [...typicalCurve].reduce((s, [o, p]) => s + (o >= lead ? p : 0), 0);
    weeks.push({ ...fromIsoWeekIndex(i), index: i, fruitPerM2, kg: afw != null ? (fruitPerM2 * input.areaM2 * afw) / 1000 : null, coverage, harvestWindow });
  }
  return { model, asOf: input.asOf, weeks, evidence };
}

// ── Calibration to actual harvested kg ────────────────────────────────────
//
// Set-based models can be right about fruit and still wrong about kg: the
// tracked stems may run ahead of (or behind) the whole crop, and AFW is
// carried forward from the last weighed week. This scales a model's output
// by actual / model-forecast over past weeks, using ONLY information a
// forecast made on asOf could have: the model's own 1-week-ahead forecasts
// for those weeks (each made as of the week before), and only actuals that
// had SETTLED by the forecast date. GrowLink weekly totals keep changing for
// up to 9 days after the week ends (observed max, 2026), so a week counts
// as settled ACTUALS_SETTLE_DAYS after its Sunday.

export const ACTUALS_SETTLE_DAYS = 10;
export const CALIBRATION_WINDOW_WEEKS = 4;
export const CALIBRATION_MIN_WEEKS = 2;
/** Minimum calibration weeks before an uncertainty band is reported. */
export const INTERVAL_MIN_WEEKS = 4;
/** Earliest set→harvest offset considered when checking that a calibration week is fully covered by measured cohorts. */
export const CALIBRATION_MIN_OFFSET = 4;

/** 'rolling' = trailing CALIBRATION_WINDOW_WEEKS settled weeks; 'stable' = every settled, fully-measured week to date. */
export type CalibrationMode = 'rolling' | 'stable';

export interface CalibrationEvidence {
  mode: CalibrationMode;
  tier: 'settled-actuals' | 'insufficient-actuals';
  factor: number;
  /** Per-week actual/model ratio quantiles over the calibration weeks (null until INTERVAL_MIN_WEEKS). */
  ratioBand: { p10: number; p90: number } | null;
  weeks: { index: number; modelKg: number; actualKg: number }[];
}

export interface CalibratedWeekForecast extends WeekForecast {
  kgLow: number | null;
  kgHigh: number | null;
}

export interface CalibratedForecastResult extends Omit<ForecastResult, 'weeks'> {
  weeks: CalibratedWeekForecast[];
  calibration: CalibrationEvidence;
}

/** True once week `index`'s actual can be treated as final on `date`. */
export function isSettled(index: number, date: Date): boolean {
  const w = fromIsoWeekIndex(index);
  const weekEnd = isoWeekMonday(w.year, w.week).getTime() + 7 * 86_400_000; // end of Sunday
  return weekEnd + ACTUALS_SETTLE_DAYS * 86_400_000 <= date.getTime();
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function forecastHarvestCalibrated(
  buildInput: (asOf: IsoWeek) => ForecastInput,
  model: ModelId,
  asOf: IsoWeek,
  actualKgByIndex: Map<number, number>,
  mode: CalibrationMode = 'stable',
  horizon = MAX_AGE
): CalibratedForecastResult {
  const input = buildInput(asOf);
  const base = forecastHarvest(input, model, horizon);
  const asOfIndex = isoWeekIndex(asOf.year, asOf.week);
  const forecastDate = forecastCutoff(asOf).enteredBy;
  const afwAt = resolveAfw(input.afw); // AFW as known on the forecast date

  const eligible: CalibrationEvidence['weeks'] = [];
  for (let w = asOfIndex - 1; w >= asOfIndex - 52; w--) {
    if (mode === 'rolling' && eligible.length >= CALIBRATION_WINDOW_WEEKS) break;
    if (!isSettled(w, forecastDate)) continue;
    const actualKg = actualKgByIndex.get(w);
    const afw = afwAt(w);
    if (actualKg == null || afw == null) continue;
    // Only weeks whose harvest could come entirely from measured cohorts —
    // otherwise (e.g. the first weeks after tracking starts) the actual
    // includes fruit set before measurement began and the ratio is inflated.
    let fullyMeasured = true;
    for (let s = w - MATURITY_WEEKS; s <= w - CALIBRATION_MIN_OFFSET; s++) {
      if ((input.coverage.get(s)?.measuredStems ?? 0) === 0) { fullyMeasured = false; break; }
    }
    if (!fullyMeasured) continue;
    const prior = forecastHarvest(buildInput(fromIsoWeekIndex(w - 1)), model, 1).weeks[0];
    const modelKg = (prior.fruitPerM2 * input.areaM2 * afw) / 1000;
    if (modelKg > 0) eligible.push({ index: w, modelKg, actualKg });
  }
  eligible.reverse();

  const sumModel = eligible.reduce((s, p) => s + p.modelKg, 0);
  const ok = eligible.length >= CALIBRATION_MIN_WEEKS && sumModel > 0;
  const ratios = eligible.map((p) => p.actualKg / p.modelKg).sort((a, b) => a - b);
  const calibration: CalibrationEvidence = {
    mode,
    tier: ok ? 'settled-actuals' : 'insufficient-actuals',
    factor: ok ? eligible.reduce((s, p) => s + p.actualKg, 0) / sumModel : 1,
    ratioBand: ok && ratios.length >= INTERVAL_MIN_WEEKS ? { p10: quantile(ratios, 0.1), p90: quantile(ratios, 0.9) } : null,
    weeks: eligible,
  };

  return {
    ...base,
    weeks: base.weeks.map((w) => ({
      ...w,
      fruitPerM2: w.fruitPerM2 * calibration.factor,
      kg: w.kg != null ? w.kg * calibration.factor : null,
      kgLow: w.kg != null && calibration.ratioBand ? w.kg * calibration.ratioBand.p10 : null,
      kgHigh: w.kg != null && calibration.ratioBand ? w.kg * calibration.ratioBand.p90 : null,
    })),
    calibration,
  };
}
