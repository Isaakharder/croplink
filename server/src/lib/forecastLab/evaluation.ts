// Forecast Lab evaluation — pure. Resolves GrowLink actuals (packing weeks)
// with their settlement state, turns forecasts into immutable snapshot rows,
// and scores stored snapshots only against SETTLED actuals.
import { isoWeekIndex, fromIsoWeekIndex } from '../isoWeek';
import { isSettled } from '../harvestForecast';
import { LabForecast, LabModelId, LAB_MODELS } from './engine';

// ── Actuals ────────────────────────────────────────────────────────────────

export interface ActualWeek {
  index: number;
  kg: number | null;
  settlement: 'settled' | 'provisional';
  settlementSource: 'growlink-v2' | 'rule-10-days';
  source: 'growlink-v2' | 'growlink-v1';
  updatedAt: string | null;
}

export interface V2ActualRow { packing_year: number; packing_week: number; total_kg: number | string | null; settlement_status: 'settled' | 'provisional'; upstream_status: string; upstream_updated_at: string }
export interface V1ActualRow { year: number; week_number: number; kg: number | string | null; updated_at: string | null }

/** GrowLink v2 (with upstream settlement) wins over v1 (settlement by CropLink's 10-day rule). Rows deleted/missing upstream are ignored. */
export function resolveActuals(v2: V2ActualRow[], v1: V1ActualRow[], now: Date): Map<number, ActualWeek> {
  const out = new Map<number, ActualWeek>();
  for (const r of v1) {
    const index = isoWeekIndex(r.year, r.week_number);
    const kg = r.kg == null ? null : Number(r.kg);
    const prev = out.get(index);
    out.set(index, { index, kg: prev && kg != null ? (prev.kg ?? 0) + kg : kg ?? prev?.kg ?? null, settlement: isSettled(index, now) ? 'settled' : 'provisional', settlementSource: 'rule-10-days', source: 'growlink-v1', updatedAt: r.updated_at });
  }
  const v2ByIndex = new Map<number, ActualWeek>();
  for (const r of v2) {
    if (r.upstream_status !== 'active') continue;
    const index = isoWeekIndex(r.packing_year, r.packing_week);
    const prev = v2ByIndex.get(index);
    const kg = r.total_kg == null ? null : Number(r.total_kg);
    v2ByIndex.set(index, {
      index, kg: prev ? (prev.kg ?? 0) + (kg ?? 0) : kg,
      // a week is settled only if every contributing GrowLink entry is settled
      settlement: prev && prev.settlement === 'provisional' ? 'provisional' : r.settlement_status,
      settlementSource: 'growlink-v2', source: 'growlink-v2', updatedAt: r.upstream_updated_at,
    });
  }
  for (const [i, a] of v2ByIndex) out.set(i, a);
  return out;
}

// ── Snapshots ──────────────────────────────────────────────────────────────

export type SnapshotKind = 'live' | 'hindcast';

export interface SnapshotRow {
  run_id: string;
  kind: SnapshotKind;
  variety_id: string;
  model_id: LabModelId;
  model_version: string;
  experimental: boolean;
  as_of_year: number;
  as_of_week: number;
  as_of_index: number;
  input_cutoff: string;
  issued_at: string;
  code_version: string | null;
  target_year: number;
  target_week: number;
  target_index: number;
  horizon: number;
  forecast_kg: number | null;
  range_low_kg: number | null;
  range_high_kg: number | null;
  fruit_per_m2: number | null;
  afw_g: number | null;
  afw_source: string | null;
  afw_as_of_index: number | null;
  area_m2: number;
  total_stems: number;
  measured_stems: number;
  pull_out_date: string | null;
  harvest_window: number;
  coverage: number | null;
  params: Record<string, unknown>;
  evidence: Record<string, unknown>;
  warnings: string[];
}

/** Natural key — a (variety, model version, kind, as-of, target) forecast is issued once and never rewritten. */
export const SNAPSHOT_KEY = ['variety_id', 'model_id', 'model_version', 'kind', 'as_of_index', 'target_index'] as const;

const round = (v: number | null, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

export function toSnapshotRows(fc: LabForecast, ctx: { runId: string; kind: SnapshotKind; varietyId: string; issuedAt: string; codeVersion: string | null }): SnapshotRow[] {
  return fc.targets.map((t) => ({
    run_id: ctx.runId, kind: ctx.kind, variety_id: ctx.varietyId, model_id: fc.modelId, model_version: fc.version, experimental: fc.experimental,
    as_of_year: fc.asOf.year, as_of_week: fc.asOf.week, as_of_index: fc.asOfIndex, input_cutoff: fc.inputCutoff, issued_at: ctx.issuedAt, code_version: ctx.codeVersion,
    target_year: t.year, target_week: t.week, target_index: t.index, horizon: t.horizon,
    forecast_kg: round(t.kg), range_low_kg: round(t.low), range_high_kg: round(t.high), fruit_per_m2: round(t.fruitPerM2, 4),
    afw_g: t.afw ? round(t.afw.grams, 2) : null, afw_source: t.afw?.source ?? (fc.modelId === 'legacy' ? 'croplink-manual (inside legacy endpoint)' : null), afw_as_of_index: t.afw?.fromIndex ?? null,
    area_m2: fc.areaM2, total_stems: fc.totalStems, measured_stems: fc.measuredStems, pull_out_date: fc.pullOutDate,
    harvest_window: round(t.harvestWindow, 4) as number, coverage: round(t.coverage, 4),
    params: fc.params, evidence: fc.evidence, warnings: [...fc.warnings, ...t.warnings],
  }));
}

// ── Scoring ────────────────────────────────────────────────────────────────

export type SeasonStage = 'ramp-up' | 'main' | 'late';
export const STAGE_WEEKS = 8;

/** ramp-up: first 8 weeks after the first GrowLink harvest; late: final 8 weeks before pull-out; main: between. */
export function seasonStage(index: number, firstHarvestIndex: number | null, pullOutIndex: number | null): SeasonStage {
  if (firstHarvestIndex != null && index < firstHarvestIndex + STAGE_WEEKS) return 'ramp-up';
  if (pullOutIndex != null && index > pullOutIndex - STAGE_WEEKS) return 'late';
  return 'main';
}

export interface Stat { n: number; sumForecastKg: number; sumActualKg: number; biasPct: number | null; wapePct: number | null; maeKg: number | null }

function stat(pairs: { f: number; a: number }[]): Stat {
  const sumA = pairs.reduce((s, p) => s + p.a, 0);
  const sumF = pairs.reduce((s, p) => s + p.f, 0);
  const abs = pairs.reduce((s, p) => s + Math.abs(p.f - p.a), 0);
  return { n: pairs.length, sumForecastKg: sumF, sumActualKg: sumA, biasPct: sumA > 0 ? ((sumF - sumA) / sumA) * 100 : null, wapePct: sumA > 0 ? (abs / sumA) * 100 : null, maeKg: pairs.length ? abs / pairs.length : null };
}

export interface Exclusion { variety_id: string; target_index: number; reason: string }

export const RECOMMENDATION_CRITERIA = {
  minLiveSettledTargetsPerHorizon: 8,
  horizonsToBeatLegacy: 3,
  minIntervals: 20,
  intervalCoverageRange: [0.6, 0.95] as [number, number],
};

export interface ModelReport {
  modelId: LabModelId;
  label: string;
  experimental: boolean;
  versions: string[];
  overall: Stat;
  byHorizon: Record<number, Stat>;
  twoWeekBlocks: Stat;
  intervalCoverage: { n: number; inside: number; rate: number | null };
  byStage: Record<SeasonStage, Stat>;
  byVariety: Record<string, Stat>;
  recommendation: { status: 'baseline' | 'experimental' | 'meets-criteria-review-required'; reasons: string[] };
}

export interface KindReport {
  kind: SnapshotKind;
  scored: number;
  models: ModelReport[];
  exclusions: { reason: string; count: number }[];
}

type ScoredRow = SnapshotRow & { actualKg: number };

export function scoreSnapshots(
  snapshots: SnapshotRow[],
  actualsByVariety: Map<string, Map<number, ActualWeek>>,
  exclusions: Exclusion[],
  stageOf: (varietyId: string, index: number) => SeasonStage
): KindReport[] {
  const manual = new Map(exclusions.map((e) => [`${e.variety_id}:${e.target_index}`, e.reason]));
  return (['live', 'hindcast'] as SnapshotKind[]).map((kind) => {
    const reasons = new Map<string, number>();
    const exclude = (r: string) => reasons.set(r, (reasons.get(r) ?? 0) + 1);
    const scored: ScoredRow[] = [];
    for (const s of snapshots) {
      if (s.kind !== kind || s.horizon > 4) continue;
      const a = actualsByVariety.get(s.variety_id)?.get(s.target_index);
      const m = manual.get(`${s.variety_id}:${s.target_index}`);
      if (m) { exclude(`manual: ${m}`); continue; }
      if (!a || a.kg == null) { exclude('no GrowLink actual yet'); continue; }
      if (a.settlement !== 'settled') { exclude('GrowLink week not settled'); continue; }
      if (s.forecast_kg == null) { exclude('forecast has no kg (no AFW)'); continue; }
      scored.push({ ...s, actualKg: a.kg });
    }
    const models = (Object.keys(LAB_MODELS) as LabModelId[]).map((id) => report(id, scored.filter((r) => r.model_id === id), scored.filter((r) => r.model_id === 'legacy'), stageOf, kind));
    return { kind, scored: scored.length, models, exclusions: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) };
  });
}

function report(modelId: LabModelId, rows: ScoredRow[], legacy: ScoredRow[], stageOf: (v: string, i: number) => SeasonStage, kind: SnapshotKind): ModelReport {
  const pairs = (rs: ScoredRow[]) => rs.map((r) => ({ f: r.forecast_kg as number, a: r.actualKg }));
  const byHorizon: Record<number, Stat> = {};
  for (const h of [1, 2, 3, 4]) byHorizon[h] = stat(pairs(rows.filter((r) => r.horizon === h)));
  const blocks = new Map<string, { f: number; a: number; n: number }>();
  for (const r of rows) {
    const k = `${r.variety_id}:${r.model_version}:${r.as_of_index}:${r.horizon <= 2 ? 'h1-2' : 'h3-4'}`;
    const b = blocks.get(k) ?? { f: 0, a: 0, n: 0 };
    b.f += r.forecast_kg as number; b.a += r.actualKg; b.n++;
    blocks.set(k, b);
  }
  const banded = rows.filter((r) => r.range_low_kg != null && r.range_high_kg != null);
  const inside = banded.filter((r) => r.actualKg >= (r.range_low_kg as number) && r.actualKg <= (r.range_high_kg as number)).length;
  const byStage = { 'ramp-up': stat([]), main: stat([]), late: stat([]) } as Record<SeasonStage, Stat>;
  for (const st of Object.keys(byStage) as SeasonStage[]) byStage[st] = stat(pairs(rows.filter((r) => stageOf(r.variety_id, r.target_index) === st)));
  const byVariety: Record<string, Stat> = {};
  for (const v of new Set(rows.map((r) => r.variety_id))) byVariety[v] = stat(pairs(rows.filter((r) => r.variety_id === v)));

  const m = LAB_MODELS[modelId];
  const reasons: string[] = [];
  let status: ModelReport['recommendation']['status'] = m.experimental ? 'experimental' : 'baseline';
  if (m.experimental) {
    const c = RECOMMENDATION_CRITERIA;
    if (kind !== 'live') reasons.push('hindcasts never count toward a recommendation');
    let beats = 0;
    let enough = true;
    for (const h of [1, 2, 3, 4]) {
      const mine = rows.filter((r) => r.horizon === h);
      if (mine.length < c.minLiveSettledTargetsPerHorizon) { enough = false; reasons.push(`h${h}: ${mine.length}/${c.minLiveSettledTargetsPerHorizon} settled targets`); continue; }
      const keys = new Set(mine.map((r) => `${r.variety_id}:${r.as_of_index}:${r.target_index}`));
      const base = legacy.filter((r) => r.horizon === h && keys.has(`${r.variety_id}:${r.as_of_index}:${r.target_index}`));
      const mineW = stat(pairs(mine.filter((r) => base.some((b) => b.variety_id === r.variety_id && b.target_index === r.target_index && b.as_of_index === r.as_of_index)))).wapePct;
      const baseW = stat(pairs(base)).wapePct;
      if (mineW != null && baseW != null && mineW < baseW) beats++;
    }
    const rate = banded.length ? inside / banded.length : null;
    if (enough && beats < c.horizonsToBeatLegacy) reasons.push(`beats legacy WAPE at ${beats}/4 horizons (needs ${c.horizonsToBeatLegacy})`);
    if (banded.length < c.minIntervals) reasons.push(`${banded.length}/${c.minIntervals} scored prediction ranges`);
    else if (rate == null || rate < c.intervalCoverageRange[0] || rate > c.intervalCoverageRange[1]) reasons.push(`p10–p90 coverage ${(100 * (rate ?? 0)).toFixed(0)}% outside ${c.intervalCoverageRange.map((x) => x * 100).join('–')}%`);
    if (kind === 'live' && reasons.length === 0) status = 'meets-criteria-review-required';
  }
  return {
    modelId, label: m.label, experimental: m.experimental, versions: [...new Set(rows.map((r) => r.model_version))],
    overall: stat(pairs(rows)), byHorizon, twoWeekBlocks: stat([...blocks.values()].filter((b) => b.n === 2)),
    intervalCoverage: { n: banded.length, inside, rate: banded.length ? inside / banded.length : null },
    byStage, byVariety, recommendation: { status, reasons },
  };
}

export const weekLabel = (index: number) => { const w = fromIsoWeekIndex(index); return `${w.year}-W${String(w.week).padStart(2, '0')}`; };
