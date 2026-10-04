/**
 * Forecast Lab: engine (models, AFW selection, warnings, pull-out, W53,
 * leakage, breaker), evaluation (actuals, snapshots, scoring, recommendation),
 * view assembly and the cycle (idempotent, insert-only).
 *
 * Run with: npx tsx src/__tests__/forecast-lab.test.ts
 */
import { StatusEvent } from '../lib/harvestForecast';
import { isoWeekIndex, isoWeekMonday, IsoWeek } from '../lib/isoWeek';
import { buildLabForecasts, selectAfw, LabInputs, AfwPoint, LabForecast } from '../lib/forecastLab/engine';
import { resolveActuals, toSnapshotRows, scoreSnapshots, seasonStage, SnapshotRow, ActualWeek, RECOMMENDATION_CRITERIA } from '../lib/forecastLab/evaluation';
import { assembleView } from '../lib/forecastLab/view';
import { runForecastLabCycle, latestSurveyIndex } from '../lib/forecastLab/cycle';
import type { LabStore, SourceData, VarietyRecord } from '../lib/forecastLab/repository';

let pass = 0;
let fail = 0;
function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); fail++; }
}
function assertClose(label: string, actual: number, expected: number, tol = 1e-6): void {
  if (Math.abs(actual - expected) <= tol) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label} — expected ~${expected}, got ${actual}`); fail++; }
}

const Y = 2026;
const I = (w: number, y = Y) => isoWeekIndex(y, w);
let n = 0;
const at = (y: number, w: number) => new Date(isoWeekMonday(y, w).getTime() + 4 * 86_400_000).toISOString();
function cohort(count: number, set: IsoWeek, outcome?: 'Harvested' | 'Aborted', end?: IsoWeek): StatusEvent[] {
  const out: StatusEvent[] = [];
  for (let k = 0; k < count; k++) {
    const node = `n${++n}`;
    const stemId = `S${n % 6}`;
    out.push({ plantNodeId: node, stemId, year: set.year, week: set.week, status: 'SetFruit', createdAt: at(set.year, set.week) });
    if (outcome && end) out.push({ plantNodeId: node, stemId, year: end.year, week: end.week, status: outcome, createdAt: at(end.year, end.week) });
  }
  return out;
}
/** A season: 30 fruit set every week from W20, 75% harvested 7 weeks later, 25% aborted after 2. */
function season(lastSet: number, endYear = Y): StatusEvent[] {
  const ev: StatusEvent[] = [];
  for (let s = 20; s <= lastSet; s++) {
    ev.push(...cohort(22, { year: Y, week: s }, 'Harvested', s + 7 <= 52 ? { year: Y, week: s + 7 } : { year: endYear, week: s + 7 - 53 }));
    ev.push(...cohort(8, { year: Y, week: s }, 'Aborted', { year: Y, week: s + 2 }));
  }
  return ev;
}
function inputs(events: StatusEvent[], afw: AfwPoint[], pullOut: string | null = null): LabInputs {
  return {
    variety: { id: 'v1', name: 'Mathieu', areaM2: 100, totalStems: 6, plantCount: 3, pullOutDate: pullOut, configUpdatedAt: null },
    events, afw, manualFruitSetPerM2: new Map(), legacyByIndex: new Map([[I(41), { kg: 999, fruitPerM2: 1 }]]),
  };
}
const v2 = (week: number, grams: number, knownAt = at(Y, week), settled = true): AfwPoint => ({ index: I(week), grams, source: 'growlink-v2', knownAt, settled });
const manual = (week: number, grams: number): AfwPoint => ({ index: I(week), grams, source: 'croplink-manual', knownAt: at(Y, week), settled: null });
const NOW = new Date('2026-10-05T12:00:00Z');

console.log('AFW selection');
{
  const cutoff = new Date('2026-10-06T00:00:00Z');
  const s = selectAfw([manual(32, 218), v2(39, 180)], I(40), cutoff);
  assert('GrowLink v2 AFW preferred over CropLink manual', [s.point?.source, s.point?.grams, s.warnings], ['growlink-v2', 180, []]);
  const f = selectAfw([manual(32, 218)], I(40), cutoff);
  assert('fallback to CropLink manual is flagged, and flagged stale', [f.point?.grams, f.warnings.map((w) => w.split(':')[0])], [218, ['afw-fallback', 'afw-stale']]);
  const future = selectAfw([manual(32, 218), v2(41, 175)], I(40), cutoff);
  assert('AFW for a week after the forecast week is never used', future.point?.grams, 218);
  const unknownYet = selectAfw([manual(32, 218), v2(39, 180, '2026-10-09T00:00:00Z')], I(40), cutoff);
  assert('AFW not yet known at the cutoff is not used', unknownYet.point?.grams, 218);
  assert('provisional AFW is flagged', selectAfw([v2(40, 181, at(Y, 40), false)], I(40), cutoff).warnings.map((w) => w.split(':')[0]), ['afw-provisional']);
  assert('no AFW at all is flagged', selectAfw([], I(40), cutoff).warnings.map((w) => w.split(':')[0]), ['no-afw']);
}

console.log('engine');
let fcs: LabForecast[];
{
  const events = season(39);
  fcs = buildLabForecasts(inputs(events, [manual(32, 218), v2(39, 180)]), { year: Y, week: 40 }, { now: NOW, draws: 20, seed: 7 });
  assert('legacy + two experimental models', fcs.map((f) => [f.modelId, f.experimental]), [['legacy', false], ['open-fruit-d', true], ['interval-censored-recent', true]]);
  assert('legacy passes through the legacy endpoint value unchanged', fcs[0].targets[0].kg, 999);
  for (const f of fcs.slice(1)) {
    assert(`${f.modelId}: uses GrowLink AFW 180 g`, [f.afw?.grams, f.afw?.source], [180, 'growlink-v2']);
    const t = f.targets.filter((x) => x.kg != null && x.kg > 0);
    assert(`${f.modelId}: has forecasts`, t.length > 0, true);
    assert(`${f.modelId}: every range brackets its forecast`, t.every((x) => x.low! <= x.kg! + 1e-9 && x.kg! <= x.high! + 1e-9), true);
    assert(`${f.modelId}: kg = fruit/m² × area × AFW`, t.every((x) => Math.abs(x.kg! - (x.fruitPerM2! * 100 * 180) / 1000) < 1e-6), true);
  }
  const again = buildLabForecasts(inputs(events, [manual(32, 218), v2(39, 180)]), { year: Y, week: 40 }, { now: NOW, draws: 20, seed: 7 });
  assert('deterministic for a given seed (incl. bootstrap ranges)', JSON.stringify(again.map((f) => f.targets)), JSON.stringify(fcs.map((f) => f.targets)));

  const withFuture = buildLabForecasts(inputs([...events, ...cohort(40, { year: Y, week: 41 }, 'Harvested', { year: Y, week: 42 })], [manual(32, 218), v2(39, 180)]), { year: Y, week: 40 }, { now: NOW, draws: 20, seed: 7 });
  assert('data after the cutoff never changes a forecast', JSON.stringify(withFuture.map((f) => f.targets)), JSON.stringify(fcs.map((f) => f.targets)));

  const openNodes = events.filter((e) => e.week === 39 && e.status === 'SetFruit').map((e) => e.plantNodeId);
  const breaker = buildLabForecasts(inputs([...events, ...openNodes.map((nd) => ({ plantNodeId: nd, stemId: events.find((e) => e.plantNodeId === nd)!.stemId, year: Y, week: 40, status: 'BreakerFruit', createdAt: at(Y, 40) }))], [manual(32, 218), v2(39, 180)]), { year: Y, week: 40 }, { now: NOW, draws: 20, seed: 7 });
  assert('breaker statuses never add fruit (D)', breaker[1].targets.map((t) => t.fruitPerM2), fcs[1].targets.map((t) => t.fruitPerM2));

  const icEvidence = fcs[2].evidence as { agesFromRecentPeriod: number };
  assert('IC records interval-censoring evidence', typeof icEvidence.agesFromRecentPeriod, 'number');
}

console.log('pull-out and W53 rollover');
{
  const events: StatusEvent[] = [];
  for (let s = 36; s <= 50; s++) {
    events.push(...cohort(22, { year: Y, week: s }, s + 7 <= 51 ? 'Harvested' : undefined, s + 7 <= 51 ? { year: Y, week: s + 7 } : undefined));
    events.push(...cohort(8, { year: Y, week: s }, 'Aborted', { year: Y, week: s + 2 }));
  }
  const fc = buildLabForecasts(inputs(events, [v2(50, 175)], '2026-12-31'), { year: Y, week: 51 }, { now: new Date('2026-12-22T12:00:00Z'), draws: 10, seed: 3 });
  const d = fc[1];
  assert('targets roll W52 → W53 → 2027-W1', d.targets.slice(0, 3).map((t) => [t.year, t.week]), [[2026, 52], [2026, 53], [2027, 1]]);
  assert('W53 keeps 4/7 (pull-out Thu Dec 31), 2027 weeks 0', d.targets.slice(0, 3).map((t) => Number(t.harvestWindow.toFixed(4))), [1, Number((4 / 7).toFixed(4)), 0]);
  assert('no kg forecast after the pull-out date (both models)', fc.slice(1).every((f) => f.targets.filter((t) => t.year === 2027).every((t) => (t.kg ?? 0) === 0)), true);
  assert('truncation is reported as a warning', d.targets[1].warnings.some((w) => w.startsWith('pull-out-truncated')), true);
}

console.log('actuals and settlement');
{
  const a = resolveActuals(
    [{ packing_year: Y, packing_week: 38, total_kg: '2777', settlement_status: 'settled', upstream_status: 'active', upstream_updated_at: 'x' },
     { packing_year: Y, packing_week: 39, total_kg: 100, settlement_status: 'settled', upstream_status: 'deleted_upstream', upstream_updated_at: 'x' }],
    [{ year: Y, week_number: 38, kg: 9999, updated_at: null }, { year: Y, week_number: 39, kg: 9860, updated_at: null }, { year: Y, week_number: 40, kg: 4449, updated_at: null }],
    new Date('2026-10-08T12:00:00Z')
  );
  assert('v2 wins over v1 for the same week', [a.get(I(38))?.kg, a.get(I(38))?.source, a.get(I(38))?.settlementSource], [2777, 'growlink-v2', 'growlink-v2']);
  assert('deleted-upstream v2 rows are ignored (v1 used)', [a.get(I(39))?.kg, a.get(I(39))?.source], [9860, 'growlink-v1']);
  // W39 = Sep 21–27 (settled from Oct 8), W40 = Sep 28–Oct 4 (settled from Oct 15)
  assert('v1 settlement by the 10-day rule on Oct 8: W39 settled, W40 provisional', [a.get(I(39))?.settlement, a.get(I(40))?.settlement], ['settled', 'provisional']);
  assert('…W40 settles 10 days after its Sunday', resolveActuals([], [{ year: Y, week_number: 40, kg: 1, updated_at: null }], new Date('2026-10-15T00:00:00Z')).get(I(40))?.settlement, 'settled');
}

console.log('snapshots');
let rows: SnapshotRow[];
{
  rows = fcs.flatMap((f) => toSnapshotRows(f, { runId: 'r1', kind: 'live', varietyId: 'v1', issuedAt: '2026-10-05T12:00:00Z', codeVersion: 'abc' }));
  assert('one row per model per target (3 × 8)', rows.length, 24);
  assert('target = as-of + horizon', rows.every((r) => r.target_index === r.as_of_index + r.horizon), true);
  const keys = new Set(rows.map((r) => [r.variety_id, r.model_id, r.model_version, r.kind, r.as_of_index, r.target_index].join('|')));
  assert('natural keys are unique', keys.size, rows.length);
  const d = rows.find((r) => r.model_id === 'open-fruit-d')!;
  assert('inputs recorded: AFW, area, stems, version, cutoff, params', [d.afw_g, d.afw_source, d.area_m2, d.total_stems, d.model_version, typeof d.input_cutoff, typeof d.params], [180, 'growlink-v2', 100, 6, 'open-fruit-d/1.0.0', 'string', 'object']);
}

console.log('scoring');
{
  const mk = (model: SnapshotRow['model_id'], asOf: number, h: number, kgv: number, low: number | null = null, high: number | null = null, kind: SnapshotRow['kind'] = 'live', v = 'v1'): SnapshotRow => ({
    ...rows[0], model_id: model, model_version: model === 'legacy' ? 'legacy/x' : `${model}/1`, experimental: model !== 'legacy', kind, variety_id: v,
    as_of_index: I(asOf), target_index: I(asOf + h), horizon: h, forecast_kg: kgv, range_low_kg: low, range_high_kg: high,
  });
  const actual = (w: number, kgv: number | null, settled = true): [number, ActualWeek] => [I(w), { index: I(w), kg: kgv, settlement: settled ? 'settled' : 'provisional', settlementSource: 'growlink-v2', source: 'growlink-v2', updatedAt: null }];
  const actuals = new Map([['v1', new Map([actual(31, 100), actual(32, 200), actual(33, 300, false), actual(34, null)])]]);
  const snaps = [
    mk('legacy', 30, 1, 150), mk('legacy', 30, 2, 100),
    mk('open-fruit-d', 30, 1, 110, 90, 130), mk('open-fruit-d', 30, 2, 180, 150, 190), mk('open-fruit-d', 30, 3, 500), mk('open-fruit-d', 30, 4, 10),
    { ...mk('open-fruit-d', 30, 1, 999), kind: 'hindcast' as const },
  ];
  const [live, hind] = scoreSnapshots(snaps, actuals, [{ variety_id: 'v1', target_index: I(32), reason: 'test exclusion' }].slice(0, 0), () => 'main');
  const d = live.models.find((m) => m.modelId === 'open-fruit-d')!;
  assert('only settled actuals scored (W33 provisional, W34 no kg excluded)', d.overall.n, 2);
  assertClose('bias = (290−300)/300', d.overall.biasPct!, (-10 / 300) * 100);
  assertClose('WAPE = (10+20)/300', d.overall.wapePct!, (30 / 300) * 100);
  assertClose('MAE = 15 kg', d.overall.maeKg!, 15);
  assert('per-horizon split', [d.byHorizon[1].n, d.byHorizon[2].n, d.byHorizon[3].n], [1, 1, 0]);
  assert('2-week block (h1+h2 from one as-of): 290 vs 300', [d.twoWeekBlocks.n, d.twoWeekBlocks.sumForecastKg, d.twoWeekBlocks.sumActualKg], [1, 290, 300]);
  assert('interval coverage counted (100 in 90–130 yes; 200 in 150–190 no)', [d.intervalCoverage.n, d.intervalCoverage.inside], [2, 1]);
  assert('exclusion reasons reported', live.exclusions.map((e) => e.reason).sort(), ['GrowLink week not settled', 'no GrowLink actual yet']);
  assert('hindcasts scored separately, never mixed with live', [hind.scored, live.scored], [1, 4]);
  assert('few weeks → stays Experimental with reasons', [d.recommendation.status, d.recommendation.reasons.length > 0], ['experimental', true]);
  const [, h2] = scoreSnapshots(snaps, actuals, [], () => 'main');
  assert('hindcasts never lead to a recommendation', h2.models.find((m) => m.modelId === 'open-fruit-d')!.recommendation.status, 'experimental');
  const [excl] = scoreSnapshots(snaps, actuals, [{ variety_id: 'v1', target_index: I(32), reason: 'GrowLink entry under investigation' }], () => 'main');
  assert('manual exclusion removes the week with its reason', [excl.models.find((m) => m.modelId === 'open-fruit-d')!.overall.n, excl.exclusions.some((e) => e.reason === 'manual: GrowLink entry under investigation')], [1, true]);

  // Enough live, settled weeks, better than legacy at every horizon, calibrated ranges → meets criteria (still needs review).
  const many: SnapshotRow[] = [];
  const act = new Map<number, ActualWeek>();
  for (let t = 10; t < 40; t++) {
    for (let h = 1; h <= 4; h++) {
      const target = t + h;
      const truth = 1000 + 10 * target;
      act.set(I(target), actual(target, truth)[1]);
      many.push(mk('legacy', t, h, truth * 1.5));
      const inside = target % 5 !== 0; // 80% coverage
      many.push(mk('open-fruit-d', t, h, truth * 1.05, inside ? truth * 0.9 : truth * 1.2, inside ? truth * 1.2 : truth * 1.3));
    }
  }
  const [okLive] = scoreSnapshots(many, new Map([['v1', act]]), [], () => 'main');
  assert('meets criteria → "review required", never auto-promoted', okLive.models.find((m) => m.modelId === 'open-fruit-d')!.recommendation.status, 'meets-criteria-review-required');
  assert('legacy is the baseline', okLive.models.find((m) => m.modelId === 'legacy')!.recommendation.status, 'baseline');
  assert('criteria documented', RECOMMENDATION_CRITERIA.minLiveSettledTargetsPerHorizon, 8);

  assert('season stages', [seasonStage(I(17), I(17), I(53)), seasonStage(I(30), I(17), I(53)), seasonStage(I(50), I(17), I(53))], ['ramp-up', 'main', 'late']);
}

console.log('view assembly');
{
  const asOf = I(40);
  const snaps = fcs.flatMap((f) => toSnapshotRows(f, { runId: 'r', kind: 'live', varietyId: 'v1', issuedAt: 'now', codeVersion: null }));
  const past = { ...snaps.find((s) => s.model_id === 'open-fruit-d' && s.horizon === 1)!, kind: 'hindcast' as const, as_of_index: I(38), target_index: I(39), forecast_kg: 111 };
  const pastLive = { ...past, kind: 'live' as const, forecast_kg: 222 };
  const actuals = new Map([[I(39), { index: I(39), kg: 200, settlement: 'settled' as const, settlementSource: 'growlink-v2' as const, source: 'growlink-v2' as const, updatedAt: null }]]);
  const weeks = assembleView({ asOfIndex: asOf, horizon: 1, fromIndex: I(39), current: fcs, snapshots: [...snaps, past, pastLive], actuals, legacyByIndex: new Map([[I(39), { kg: 300 }]]) });
  const w39 = weeks.find((w) => w.index === I(39))!;
  assert('past week: locked live snapshot issued 1 week earlier preferred over hindcast', [w39.models['open-fruit-d']?.kg, w39.models['open-fruit-d']?.kind, w39.models['open-fruit-d']?.locked], [222, 'live', true]);
  assertClose('difference vs actual', w39.models['open-fruit-d']!.diffPct!, 11);
  assert('legacy shown unchanged with its own difference', [w39.legacyKg, w39.legacyDiffKg], [300, 100]);
  const w41 = weeks.find((w) => w.index === I(41))!;
  assert('future week uses the live snapshot for the latest as-of', [w41.models['open-fruit-d']?.locked, !w41.past], [true, true]);
  const noSnap = assembleView({ asOfIndex: asOf, horizon: 1, fromIndex: I(40), current: fcs, snapshots: [], actuals: new Map(), legacyByIndex: new Map() });
  const f41 = noSnap.find((w) => w.index === I(41))!.models['interval-censored-recent']!;
  assert('without a snapshot the current computation is shown, marked not locked', [f41.locked, f41.kind, f41.warnings.some((w) => w.startsWith('not-locked'))], [false, 'current', true]);
}

console.log('cycle (idempotent, insert-only)');
(async () => {
  const stored = new Map<string, SnapshotRow>();
  const runs: { id: string; status?: string }[] = [];
  const keyOf = (r: SnapshotRow) => [r.variety_id, r.model_id, r.model_version, r.kind, r.as_of_index, r.target_index].join('|');
  const store: LabStore = {
    available: async () => true,
    createRun: async (r) => { runs.push({ id: r.id }); },
    finishRun: async (id, p) => { runs.find((r) => r.id === id)!.status = p.status; },
    insertSnapshots: async (rs) => { let k = 0; for (const r of rs) if (!stored.has(keyOf(r))) { stored.set(keyOf(r), r); k++; } return k; },
    snapshotAsOfIndexes: async (vid, kind) => new Set([...stored.values()].filter((r) => r.variety_id === vid && r.kind === kind && r.horizon === 1).map((r) => `${r.model_version}:${r.as_of_index}`)),
    listSnapshots: async () => [...stored.values()],
    listExclusions: async () => [],
    configHistory: async () => [],
  };
  const variety = { id: 'v1', name: 'Mathieu' } as VarietyRecord;
  const events = season(39);
  const src = { inputs: inputs(events, [v2(39, 180)]) } as SourceData;
  let ids = 0;
  const deps = { store, varieties: async () => [variety], load: async () => src, now: () => NOW, newId: () => `run-${++ids}`, codeVersion: 'abc', draws: 5 };
  assert('latest survey week = W40 (latest statuses entered before now)', latestSurveyIndex(events, NOW), I(40));
  assert('statuses entered after now are ignored', latestSurveyIndex(events, new Date('2026-09-28T00:00:00Z')), I(39));
  const first = await runForecastLabCycle(deps, Y);
  const v = first.varieties[0];
  assert('first cycle: live forecast locked for every model and target', [first.status, v.asOf, v.liveInserted], ['succeeded', '2026-W40', 24]);
  assert('…and labelled hindcasts backfilled', v.hindcastInserted > 0 && v.hindcastWeeks > 0, true);
  const before = JSON.stringify([...stored.values()]);
  const second = await runForecastLabCycle(deps, Y);
  assert('re-running inserts nothing and changes nothing', [second.varieties[0].liveInserted, second.varieties[0].hindcastInserted, JSON.stringify([...stored.values()]) === before], [0, 0, true]);
  const syncFail = await runForecastLabCycle({ ...deps, sync: async () => { throw new Error('GrowLink down'); } }, Y);
  assert('a failed sync is recorded and the cycle continues (partial)', [syncFail.status, (syncFail.sync as { error: string }).error], ['partial', 'GrowLink down']);
  const off = await runForecastLabCycle({ ...deps, store: { ...store, available: async () => false } }, Y);
  assert('without the snapshot tables nothing runs', off.status, 'unavailable');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
