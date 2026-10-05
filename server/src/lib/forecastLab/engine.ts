// Forecast Lab engine — pure (no I/O). Produces, for one variety and one
// "as of" week, the legacy forecast plus each EXPERIMENTAL candidate model,
// with prediction ranges, the inputs used, evidence and warnings.
//
// Rules this module enforces:
//  - Only data known at the forecast cutoff is used (statuses for weeks <= asOf
//    entered by the forecast date; AFW rows known by then).
//  - AFW is resolved PER TARGET WEEK (lib/afwForecast.ts): grower-entered AFW
//    forecast for that week → most recent earlier AFW forecast → latest
//    settled GrowLink AFW → the existing fallback (latest GrowLink AFW, else
//    CropLink's manual AFW — flagged as a fallback, and flagged stale when
//    old). AFW forecasts count only if entered by the forecast's knowledge
//    time, and a week never uses a forecast for a later week.
//  - Breaker/MatureGreen statuses never add fruit (lifecycle replay counts set
//    fruit once).
//  - Missed harvest surveys are interval-censored (IC model); recent unfinished
//    cohorts enter only through right-censoring.
//  - Harvest after the variety's pull-out date is truncated.
//  - Weeks are ISO-week indexes (W53 and year rollover are exact).
//  - Model outputs are SURVEY/BIOLOGICAL harvest weeks; the IC model maps them
//    onto GrowLink PACKING weeks with an explicit, recorded shift parameter.
import {
  StatusEvent, ForecastInput, ForecastResult, forecastCutoff, replayFruitLifecycles, summarizeWeeks, forecastHarvest,
} from '../harvestForecast';
import {
  inferHarvestCheckWeeks, buildFruitObservations, fitIntervalHazards, forecastOpenFruit, resampleStems, mulberry32, harvestProbabilities, FruitObservation,
} from '../intervalSurvival';
import { harvestWindowFraction } from '../cropWindow';
import { IsoWeek, isoWeekIndex, fromIsoWeekIndex, greenhouseIsoWeek } from '../isoWeek';
import { ManualAfwEntry, TargetAfw, TargetAfwSource, effectiveManualAfw, latestSettledGrowlinkAfw, resolveTargetAfw } from '../afwForecast';

export const LAB_HORIZON = 8;
export const BOOTSTRAP_DRAWS = 40;
export const RECENT_PERIOD_WEEKS = 6;
/** Share of a Friday survey week's harvest packed in the previous ISO week (Sat/Sun of a uniform 7-day harvest). */
export const PACK_SHIFT = 2 / 7;
/** AFW older than this many weeks before the forecast's as-of week is flagged stale. */
export const AFW_STALE_WEEKS = 2;

export const LAB_MODELS = {
  legacy: { id: 'legacy', version: 'legacy/harvest-projections', label: 'Legacy forecast', experimental: false },
  'open-fruit-d': { id: 'open-fruit-d', version: 'open-fruit-d/1.0.0', label: 'Open-fruit model D', experimental: true },
  'interval-censored-recent': { id: 'interval-censored-recent', version: 'ic-recent/1.0.0', label: 'Interval-censored, recent cohorts', experimental: true },
} as const;
export type LabModelId = keyof typeof LAB_MODELS;

export interface AfwPoint {
  /** ISO-week index of the (packing) week the AFW was measured in. */
  index: number;
  grams: number;
  source: 'growlink-v2' | 'croplink-manual';
  /** When this value became known (GrowLink updated_at / CropLink created_at). */
  knownAt: string;
  settled: boolean | null;
}

export interface LabVariety {
  id: string;
  name: string;
  areaM2: number;
  totalStems: number;
  plantCount: number | null;
  pullOutDate: string | null;
  configUpdatedAt: string | null;
}

export interface LabInputs {
  variety: LabVariety;
  events: StatusEvent[];
  afw: AfwPoint[];
  /** Stored manual fruit-set (fruit/m²) by set-week index — used only for weeks without measurements. */
  manualFruitSetPerM2: Map<number, number>;
  /** Current legacy endpoint output by harvest-week index. */
  legacyByIndex: Map<number, { kg: number; fruitPerM2: number }>;
  /** Every grower-entered AFW forecast row for the variety (append-only history). */
  manualAfw?: ManualAfwEntry[];
}

export interface LabTarget {
  index: number;
  year: number;
  week: number;
  horizon: number;
  kg: number | null;
  low: number | null;
  high: number | null;
  fruitPerM2: number | null;
  harvestWindow: number;
  coverage: number | null;
  /** AFW used for this week's kg (null for legacy, or when none is known). */
  afw: TargetAfw | null;
  warnings: string[];
}

export interface LabForecast {
  modelId: LabModelId;
  version: string;
  experimental: boolean;
  asOf: IsoWeek;
  asOfIndex: number;
  inputCutoff: string;
  /** AFW of the first target week (each target carries its own in `targets[].afw`). */
  afw: { grams: number; source: TargetAfwSource; asOfIndex: number; ageWeeks: number } | null;
  areaM2: number;
  totalStems: number;
  measuredStems: number;
  pullOutDate: string | null;
  params: Record<string, unknown>;
  evidence: Record<string, unknown>;
  warnings: string[];
  targets: LabTarget[];
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const p = (s.length - 1) * q;
  const lo = Math.floor(p);
  return s[lo] + (s[Math.ceil(p)] - s[lo]) * (p - lo);
}

/** Latest AFW known at the cutoff for a week <= asOf; GrowLink v2 preferred over CropLink's manual series. */
export function selectAfw(afw: AfwPoint[], asOfIndex: number, enteredBy: Date): { point: AfwPoint | null; warnings: string[] } {
  const known = afw.filter((p) => p.index <= asOfIndex && Date.parse(p.knownAt) <= enteredBy.getTime() && p.grams > 0);
  const latest = (src: AfwPoint['source']) => known.filter((p) => p.source === src).sort((a, b) => b.index - a.index)[0] ?? null;
  const point = latest('growlink-v2') ?? latest('croplink-manual');
  const warnings: string[] = [];
  if (!point) warnings.push('no-afw: no fruit weight known — kg cannot be computed');
  else {
    if (point.source === 'croplink-manual') warnings.push('afw-fallback: no GrowLink AFW available; using CropLink manual AFW');
    if (asOfIndex - point.index > AFW_STALE_WEEKS) warnings.push(`afw-stale: AFW is from W${fromIsoWeekIndex(point.index).week}, ${asOfIndex - point.index} weeks before the forecast week`);
    if (point.settled === false) warnings.push('afw-provisional: AFW comes from a GrowLink week that is not settled yet');
  }
  return { point, warnings };
}

/** Resample tracked stems (with replacement), relabelling so duplicated stems stay distinct. */
export function resampleEventsByStem(events: StatusEvent[], rand: () => number): StatusEvent[] {
  const byStem = new Map<string, StatusEvent[]>();
  for (const e of events) {
    if (!byStem.has(e.stemId)) byStem.set(e.stemId, []);
    byStem.get(e.stemId)!.push(e);
  }
  const stems = [...byStem.keys()];
  const out: StatusEvent[] = [];
  for (let k = 0; k < stems.length; k++) {
    const pick = stems[Math.floor(rand() * stems.length)];
    for (const e of byStem.get(pick)!) out.push({ ...e, stemId: `${pick}#${k}`, plantNodeId: `${e.plantNodeId}#${k}` });
  }
  return out;
}

function fallbackWarnings(ev: ForecastResult['evidence']): string[] {
  const w: string[] = [];
  if (ev.survival.tier !== 'mature-pool') w.push(`survival-fallback: ${ev.survival.tier} (n=${ev.survival.sample})`);
  if (ev.curve.tier !== 'mature-pool') w.push(`timing-fallback: ${ev.curve.tier}`);
  if (ev.hazards && ev.hazards.tier !== 'mature-hazards') w.push(`hazards-fallback: ${ev.hazards.tier}`);
  if (ev.cohortsFromManual > 0) w.push(`manual-fruit-set: ${ev.cohortsFromManual} cohort(s) from stored manual values`);
  return w;
}

interface Context {
  inputs: LabInputs;
  asOf: IsoWeek;
  asOfIndex: number;
  cutoff: ReturnType<typeof forecastCutoff>;
  afw: ReturnType<typeof selectAfw>;
  targetAfw: Map<number, TargetAfw | null>;
  afwWarnings: string[];
  manualAfwKnownBy: Date;
  measuredStems: number;
  baseWarnings: string[];
}

function targetsShell(ctx: Context): LabTarget[] {
  return Array.from({ length: LAB_HORIZON }, (_, k) => {
    const index = ctx.asOfIndex + k + 1;
    const w = fromIsoWeekIndex(index);
    return { index, year: w.year, week: w.week, horizon: k + 1, kg: null, low: null, high: null, fruitPerM2: null, harvestWindow: harvestWindowFraction(index, ctx.inputs.variety.pullOutDate), coverage: null, afw: null, warnings: [] };
  });
}

function base(ctx: Context, modelId: LabModelId): Omit<LabForecast, 'targets' | 'params' | 'evidence' | 'warnings'> {
  const m = LAB_MODELS[modelId];
  const first = ctx.targetAfw.get(ctx.asOfIndex + 1) ?? null;
  return {
    modelId, version: m.version, experimental: m.experimental, asOf: ctx.asOf, asOfIndex: ctx.asOfIndex, inputCutoff: ctx.cutoff.enteredBy.toISOString(),
    afw: first ? { grams: first.grams, source: first.source, asOfIndex: first.fromIndex, ageWeeks: ctx.asOfIndex - first.fromIndex } : null,
    areaM2: ctx.inputs.variety.areaM2, totalStems: ctx.inputs.variety.totalStems, measuredStems: ctx.measuredStems, pullOutDate: ctx.inputs.variety.pullOutDate,
  };
}

/** Attach each target's resolved AFW and label carried-forward manual values. */
function attachAfw(ctx: Context, targets: LabTarget[]) {
  for (const t of targets) {
    t.afw = ctx.targetAfw.get(t.index) ?? null;
    if (t.afw?.source === 'manual-carried') t.warnings.push(`afw-carried: manual AFW forecast carried forward from W${fromIsoWeekIndex(t.afw.fromIndex).week}`);
  }
}

const AFW_POLICY = 'afw-chain/1: manual forecast (exact week) > manual forecast (latest earlier week) > latest settled GrowLink AFW > existing fallback (latest GrowLink AFW, else CropLink manual AFW)';

function afwParams(ctx: Context) {
  return { afwPolicy: AFW_POLICY, manualAfwKnownBy: ctx.manualAfwKnownBy.toISOString() };
}

function finishTargets(targets: LabTarget[], draws: Map<number, number>[]) {
  for (const t of targets) {
    if (t.kg != null && draws.length) {
      const xs = draws.map((d) => d.get(t.index) ?? 0);
      t.low = quantile(xs, 0.1);
      t.high = quantile(xs, 0.9);
    }
    if (t.harvestWindow < 1) t.warnings.push(t.harvestWindow === 0 ? 'after-pull-out: harvest truncated to 0' : `pull-out-truncated: ${(t.harvestWindow * 7).toFixed(0)}/7 days`);
    if (t.coverage != null && t.coverage < 0.9) t.warnings.push(`partial-coverage: ${(t.coverage * 100).toFixed(0)}% of this week's harvest comes from fruit already set`);
  }
}

function legacyForecast(ctx: Context): LabForecast {
  const targets = targetsShell(ctx);
  for (const t of targets) {
    const v = ctx.inputs.legacyByIndex.get(t.index);
    t.kg = v ? v.kg : 0;
    t.fruitPerM2 = v ? v.fruitPerM2 : 0;
  }
  return {
    ...base(ctx, 'legacy'),
    afw: null, // the legacy endpoint applies CropLink's own harvest_afw_by_week internally
    params: { source: 'GET /harvest-projections (unchanged)', timing: 'stored harvest_timing_profiles (20/40/40 at +6/+7/+8)', afw: 'harvest_afw_by_week carry-forward inside the legacy endpoint — does not use AFW forecasts' },
    evidence: { note: 'Legacy forecast is not chronological: it reflects stored profiles as of issue time and does not apply pull-out truncation.' },
    warnings: [],
    targets,
  };
}

function dInput(ctx: Context, events: StatusEvent[]): ForecastInput {
  const { inputs, asOf, cutoff } = ctx;
  return {
    asOf, lifecycles: replayFruitLifecycles(events, cutoff), coverage: summarizeWeeks(events, cutoff), manualFruitSetPerM2: inputs.manualFruitSetPerM2,
    afw: [...ctx.targetAfw].filter(([, a]) => a != null).map(([index, a]) => ({ index, grams: a!.grams })),
    totalStems: inputs.variety.totalStems, areaM2: inputs.variety.areaM2, pullOutDate: inputs.variety.pullOutDate,
  };
}

function openFruitD(ctx: Context, draws: number, seed: number): LabForecast {
  const res = forecastHarvest(dInput(ctx, ctx.inputs.events), 'D', LAB_HORIZON);
  const targets = targetsShell(ctx);
  for (const t of targets) {
    const w = res.weeks.find((x) => x.index === t.index)!;
    t.kg = w.kg;
    t.fruitPerM2 = w.fruitPerM2;
    t.coverage = w.coverage;
  }
  attachAfw(ctx, targets);
  const rand = mulberry32(seed);
  const boot: Map<number, number>[] = [];
  if (targets.some((t) => t.afw)) {
    for (let b = 0; b < draws; b++) {
      const r = forecastHarvest(dInput(ctx, resampleEventsByStem(ctx.inputs.events, rand)), 'D', LAB_HORIZON);
      boot.push(new Map(r.weeks.map((w) => [w.index, w.kg ?? 0])));
    }
  }
  finishTargets(targets, boot);
  return {
    ...base(ctx, 'open-fruit-d'),
    params: { timing: 'survey week (recorded) — not shifted to packing week', maturityWeeks: 10, minSample: 30, bootstrapDraws: draws, interval: 'p10–p90 stem bootstrap', seed, ...afwParams(ctx) },
    evidence: res.evidence as unknown as Record<string, unknown>,
    warnings: [...ctx.baseWarnings, ...ctx.afwWarnings, ...fallbackWarnings(res.evidence)],
    targets,
  };
}

function icFruit(ctx: Context, obs: FruitObservation[], maxIter?: number) {
  const fit = fitIntervalHazards(obs, ctx.asOfIndex, RECENT_PERIOD_WEEKS, maxIter);
  if (!fit) return null;
  const cov = summarizeWeeks(ctx.inputs.events, ctx.cutoff);
  const { totalStems, areaM2, pullOutDate } = ctx.inputs.variety;
  const perFruit = (s: number) => { const m = cov.get(s)?.measuredStems ?? 0; return m > 0 && areaM2 > 0 ? totalStems / m / areaM2 : 0; };
  return { fit, fruit: forecastOpenFruit(obs, fit, ctx.asOfIndex, perFruit, PACK_SHIFT, LAB_HORIZON, pullOutDate) };
}

function intervalCensoredRecent(ctx: Context, draws: number, seed: number): LabForecast {
  const checks = inferHarvestCheckWeeks(ctx.inputs.events, ctx.cutoff);
  const obs = buildFruitObservations(ctx.inputs.events, ctx.cutoff, checks);
  const main = icFruit(ctx, obs);
  const targets = targetsShell(ctx);
  const warnings = [...ctx.baseWarnings, ...ctx.afwWarnings];
  attachAfw(ctx, targets);
  const gramsAt = (i: number) => ctx.targetAfw.get(i)?.grams ?? null;
  const area = ctx.inputs.variety.areaM2;
  const boot: Map<number, number>[] = [];
  let evidence: Record<string, unknown> = {};
  if (!main) {
    warnings.push('ic-insufficient-data: fewer than 30 fruit at risk — no forecast');
  } else {
    const p = [...harvestProbabilities(main.fit, 0)];
    const total = p.reduce((s, [, v]) => s + v, 0);
    for (const t of targets) {
      const f = main.fruit.get(t.index) ?? 0;
      const g = gramsAt(t.index);
      t.fruitPerM2 = f;
      t.kg = g != null ? (f * area * g) / 1000 : null;
      t.coverage = total > 0 ? p.filter(([a]) => a >= t.horizon).reduce((s, [, v]) => s + v, 0) / total : null;
    }
    if (targets.some((t) => t.afw)) {
      const rand = mulberry32(seed);
      for (let b = 0; b < draws; b++) {
        const r = icFruit(ctx, resampleStems(obs, rand), 60);
        boot.push(new Map([...(r?.fruit ?? new Map<number, number>())].map(([i, f]) => [i, (f * area * (gramsAt(i) ?? 0)) / 1000])));
      }
    }
    const unchecked: string[] = [];
    const firstSet = Math.min(...obs.map((o) => o.setIndex));
    for (let i = firstSet; i <= ctx.asOfIndex; i++) if (!checks.has(i)) unchecked.push(`W${fromIsoWeekIndex(i).week}`);
    evidence = { uncheckedHarvestWeeks: unchecked, agesFromRecentPeriod: main.fit.agesFromRecentPeriod, tailPooledFromAge: main.fit.tailPooledFromAge, emIterations: main.fit.iterations, lifetimeHarvestProbability: total };
    if (main.fit.agesFromRecentPeriod < 3) warnings.push(`recent-period-thin: only ${main.fit.agesFromRecentPeriod} fruit ages have enough recent exposure; older periods used`);
    if (unchecked.length) warnings.push(`interval-censored: harvest not checked in ${unchecked.join(', ')} — those harvests are spread over their survey interval`);
  }
  finishTargets(targets, boot);
  return {
    ...base(ctx, 'interval-censored-recent'),
    params: { timing: `biological week → GrowLink packing week, shift ${PACK_SHIFT.toFixed(4)} to previous week`, recentPeriodWeeks: RECENT_PERIOD_WEEKS, minSample: 30, bootstrapDraws: draws, interval: 'p10–p90 stem bootstrap', seed, ...afwParams(ctx) },
    evidence,
    warnings,
    targets,
  };
}

export interface BuildOptions {
  now: Date;
  draws?: number;
  seed?: number;
  /**
   * Grower AFW forecasts entered after this moment are ignored. Defaults to the
   * as-of week's data cutoff (no look-ahead — what hindcasts must use); live
   * forecasts pass their issue time so a just-saved AFW forecast applies.
   */
  afwKnownBy?: Date;
}

/** Per-target AFW for targets asOf+1..asOf+horizon, plus the warnings that apply to the AFW actually used. */
export function resolveLabAfw(inputs: LabInputs, asOfIndex: number, cutoffAt: Date, manualKnownBy: Date) {
  const selected = selectAfw(inputs.afw, asOfIndex, cutoffAt);
  const manual = effectiveManualAfw(inputs.manualAfw ?? [], manualKnownBy);
  const settled = latestSettledGrowlinkAfw(inputs.afw.filter((p) => p.source === 'growlink-v2'), asOfIndex, cutoffAt);
  const targetAfw = new Map<number, TargetAfw | null>();
  for (let k = 1; k <= LAB_HORIZON; k++) targetAfw.set(asOfIndex + k, resolveTargetAfw(asOfIndex + k, manual, settled, selected.point));
  const used = [...targetAfw.values()];
  const warnings: string[] = [];
  if (used.every((a) => a == null)) warnings.push('no-afw: no fruit weight known — kg cannot be computed');
  else {
    if (used.some((a) => a && (a.source === 'growlink-v2' || a.source === 'croplink-manual'))) warnings.push(...selected.warnings);
    const manualN = used.filter((a) => a && (a.source === 'manual-exact' || a.source === 'manual-carried')).length;
    if (manualN > 0) warnings.push(`afw-manual-forecast: ${manualN} of ${LAB_HORIZON} weeks use grower-entered AFW forecasts`);
  }
  return { selected, targetAfw, warnings };
}

/** Legacy + every experimental candidate for one variety, as of `asOf`. Deterministic for a given seed. */
export function buildLabForecasts(inputs: LabInputs, asOf: IsoWeek, opts: BuildOptions): LabForecast[] {
  const asOfIndex = isoWeekIndex(asOf.year, asOf.week);
  const cutoff = forecastCutoff(asOf);
  const cov = summarizeWeeks(inputs.events, cutoff);
  const latestMeasured = Math.max(-Infinity, ...[...cov.keys()]);
  const nowWeek = greenhouseIsoWeek(opts.now);
  const baseWarnings: string[] = [];
  if (!isFinite(latestMeasured)) baseWarnings.push('no-measurements: no survey data before the cutoff');
  else if (latestMeasured < asOfIndex) baseWarnings.push(`measurements-stale: last survey W${fromIsoWeekIndex(latestMeasured).week}, forecast as of W${asOf.week}`);
  if (isoWeekIndex(nowWeek.year, nowWeek.week) - asOfIndex > 1) baseWarnings.push(`forecast-old: as of W${asOf.week}, now W${nowWeek.week}`);
  const manualAfwKnownBy = opts.afwKnownBy ?? cutoff.enteredBy;
  const afw = resolveLabAfw(inputs, asOfIndex, cutoff.enteredBy, manualAfwKnownBy);
  const ctx: Context = {
    inputs, asOf, asOfIndex, cutoff, afw: afw.selected, targetAfw: afw.targetAfw, afwWarnings: afw.warnings, manualAfwKnownBy,
    measuredStems: isFinite(latestMeasured) ? cov.get(latestMeasured)?.measuredStems ?? 0 : 0, baseWarnings,
  };
  const draws = opts.draws ?? BOOTSTRAP_DRAWS;
  const seed = opts.seed ?? asOfIndex;
  return [legacyForecast(ctx), openFruitD(ctx, draws, seed), intervalCensoredRecent(ctx, draws, seed + 1)];
}
