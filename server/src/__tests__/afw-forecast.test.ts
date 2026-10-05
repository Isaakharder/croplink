/**
 * Grower AFW forecasts: resolution priority (exact week → carried forward →
 * settled GrowLink → existing fallback), no look-ahead (by week and by entry
 * time), W53/year rollover, validation, the editor API, and how the Forecast
 * Lab engine, snapshots, view and cycle use them.
 *
 * Run with: npx tsx src/__tests__/afw-forecast.test.ts
 */
import { AddressInfo } from 'net';
import { StatusEvent } from '../lib/harvestForecast';
import { isoWeekIndex, isoWeekMonday, IsoWeek } from '../lib/isoWeek';
import {
  ManualAfwEntry, effectiveManualAfw, resolveTargetAfw, latestSettledGrowlinkAfw, validateAfwChanges, editableWeeks, AfwChange,
} from '../lib/afwForecast';
import { buildLabForecasts, LabInputs, AfwPoint, LabForecast } from '../lib/forecastLab/engine';
import { toSnapshotRows, SnapshotRow } from '../lib/forecastLab/evaluation';
import { assembleView } from '../lib/forecastLab/view';
import { runForecastLabCycle } from '../lib/forecastLab/cycle';
import type { LabStore, SourceData, VarietyRecord } from '../lib/forecastLab/repository';
import type { AfwForecastDeps } from '../routes/afwForecasts';

let pass = 0;
let fail = 0;
function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); fail++; }
}

const Y = 2026;
const I = (w: number, y = Y) => isoWeekIndex(y, w);
const at = (y: number, w: number, day = 4) => new Date(isoWeekMonday(y, w).getTime() + day * 86_400_000).toISOString();
let n = 0;
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
function season(lastSet: number): StatusEvent[] {
  const ev: StatusEvent[] = [];
  for (let s = 20; s <= lastSet; s++) {
    ev.push(...cohort(22, { year: Y, week: s }, 'Harvested', { year: Y, week: s + 7 }));
    ev.push(...cohort(8, { year: Y, week: s }, 'Aborted', { year: Y, week: s + 2 }));
  }
  return ev;
}
function inputs(events: StatusEvent[], afw: AfwPoint[], manualAfw: ManualAfwEntry[] = [], pullOut: string | null = null): LabInputs {
  return {
    variety: { id: 'v1', name: 'Mathieu', areaM2: 100, totalStems: 6, plantCount: 3, pullOutDate: pullOut, configUpdatedAt: null },
    events, afw, manualFruitSetPerM2: new Map(), legacyByIndex: new Map([[I(41), { kg: 999, fruitPerM2: 1 }]]), manualAfw,
  };
}
const v2 = (week: number, grams: number, knownAt = at(Y, week), settled = true, y = Y): AfwPoint => ({ index: I(week, y), grams, source: 'growlink-v2', knownAt, settled });
let eid = 0;
const entry = (week: number, grams: number | null, enteredAt: string, y = Y): ManualAfwEntry =>
  ({ id: ++eid, varietyId: 'v1', year: y, week, action: grams == null ? 'clear' : 'set', grams, enteredAt });

const NOW = new Date('2026-10-05T12:00:00Z'); // Mon of W41; the W40 forecast's data cutoff is Tue Oct 6 00:00Z
const BEFORE_CUTOFF = '2026-10-04T15:00:00Z';
const AFTER_CUTOFF = '2026-10-09T15:00:00Z';

console.log('effective manual AFW (append-only history)');
{
  const es = [entry(41, 200, '2026-10-01T10:00:00Z'), entry(41, 210, '2026-10-02T10:00:00Z'), entry(43, 230, '2026-10-01T10:00:00Z'), entry(43, null, '2026-10-03T10:00:00Z')];
  const now = effectiveManualAfw(es, new Date('2026-10-04T00:00:00Z'));
  assert('latest entry per week wins; a clear removes the week', [...now].map(([i, v]) => [i - I(0), v.grams]), [[41, 210]]);
  const then = effectiveManualAfw(es, new Date('2026-10-01T12:00:00Z'));
  assert('as of an earlier moment, only entries made by then count', [...then].map(([i, v]) => [i - I(0), v.grams]).sort(), [[41, 200], [43, 230]]);
}

console.log('priority: exact → carried forward → settled GrowLink → existing fallback');
{
  const manual = effectiveManualAfw([entry(41, 200, BEFORE_CUTOFF), entry(44, 240, BEFORE_CUTOFF)], NOW);
  const fallback = { index: I(39), grams: 180, source: 'growlink-v2' as const };
  const r = (w: number) => { const a = resolveTargetAfw(I(w), manual, null, fallback); return a && [a.source, a.grams, a.fromIndex - I(0)]; };
  assert('W41 exact', r(41), ['manual-exact', 200, 41]);
  assert('W42, W43 carried forward from W41', [r(42), r(43)], [['manual-carried', 200, 41], ['manual-carried', 200, 41]]);
  assert('W44 exact (a newer week beats the carried value)', r(44), ['manual-exact', 240, 44]);
  assert('W45 carried from the most recent earlier week (W44)', r(45), ['manual-carried', 240, 44]);
  assert('W40: a later week\'s forecast never reaches an earlier week', r(40), ['growlink-v2', 180, 39]);
  const onlyLater = effectiveManualAfw([entry(44, 240, BEFORE_CUTOFF)], NOW);
  assert('W43 with only a W44 forecast uses the fallback, not W44', resolveTargetAfw(I(43), onlyLater, null, fallback)?.source, 'growlink-v2');
  const settled = { index: I(38), grams: 192, knownAt: '2026-09-25T00:00:00Z', settled: true };
  assert('settled GrowLink beats the existing fallback', resolveTargetAfw(I(41), new Map(), settled, fallback)?.source, 'growlink-settled');
  assert('a manual forecast beats settled GrowLink', resolveTargetAfw(I(41), manual, settled, fallback)?.source, 'manual-exact');
  assert('nothing known → null', resolveTargetAfw(I(41), new Map(), null, null), null);
}

console.log('latest settled GrowLink AFW (as it was at the cutoff)');
{
  const cut = new Date('2026-10-06T00:00:00Z');
  const p = (w: number, g: number, knownAt: string, settled: boolean | null = true) => ({ index: I(w), grams: g, knownAt, settled });
  // W36 settles Sep 16, W38 Sep 30, W39 Oct 7.
  assert('latest week settled at the cutoff', latestSettledGrowlinkAfw([p(36, 190, '2026-09-04T00:00:00Z'), p(38, 192, '2026-09-25T00:00:00Z'), p(39, 185, '2026-09-26T00:00:00Z')], I(40), cut)?.index, I(38));
  assert('changed within 3 days of the cutoff → not settled then', latestSettledGrowlinkAfw([p(36, 190, '2026-09-04T00:00:00Z'), p(38, 192, '2026-10-04T00:00:00Z')], I(40), cut)?.index, I(36));
  assert('changed after the cutoff → its value then is unknown', latestSettledGrowlinkAfw([p(38, 192, '2026-10-08T00:00:00Z')], I(40), cut), null);
  assert('currently provisional → not used', latestSettledGrowlinkAfw([p(38, 192, '2026-09-25T00:00:00Z', false)], I(40), cut), null);
  assert('a week after the as-of week → not used', latestSettledGrowlinkAfw([p(38, 192, '2026-09-25T00:00:00Z')], I(37), cut), null);
}

console.log('engine: per-week AFW in both experimental models');
const events = season(39);
const base = buildLabForecasts(inputs(events, [v2(39, 180)]), { year: Y, week: 40 }, { now: NOW, draws: 10, seed: 5 });
const exp = (fcs: LabForecast[]) => fcs.filter((f) => f.experimental);
{
  const fcs = buildLabForecasts(inputs(events, [v2(39, 180)], [entry(41, 200, BEFORE_CUTOFF), entry(44, 240, BEFORE_CUTOFF)]), { year: Y, week: 40 }, { now: NOW, draws: 10, seed: 5 });
  for (const f of exp(fcs)) {
    assert(`${f.modelId}: AFW by week W41–W48`, f.targets.map((t) => [t.week, t.afw?.source, t.afw?.grams]), [
      [41, 'manual-exact', 200], [42, 'manual-carried', 200], [43, 'manual-carried', 200], [44, 'manual-exact', 240],
      [45, 'manual-carried', 240], [46, 'manual-carried', 240], [47, 'manual-carried', 240], [48, 'manual-carried', 240],
    ]);
    const t = f.targets.filter((x) => x.kg != null && x.kg > 0);
    assert(`${f.modelId}: kg = fruit/m² × area × that week's AFW`, t.length > 0 && t.every((x) => Math.abs(x.kg! - (x.fruitPerM2! * 100 * x.afw!.grams) / 1000) < 1e-6), true);
    assert(`${f.modelId}: fruit counts unchanged by AFW`, f.targets.map((x) => x.fruitPerM2), base.find((b) => b.modelId === f.modelId)!.targets.map((x) => x.fruitPerM2));
    assert(`${f.modelId}: ranges still bracket the forecast`, t.every((x) => x.low! <= x.kg! + 1e-9 && x.kg! <= x.high! + 1e-9), true);
    assert(`${f.modelId}: carried weeks are labelled`, f.targets[1].warnings.some((w) => w.startsWith('afw-carried: manual AFW forecast carried forward from W41')), true);
    assert(`${f.modelId}: AFW policy recorded in params`, String(f.params.afwPolicy).startsWith('afw-chain/1'), true);
  }
  assert('legacy is untouched by AFW forecasts', fcs[0].targets.map((t) => t.kg), base[0].targets.map((t) => t.kg));

  const onlyW44 = buildLabForecasts(inputs(events, [v2(39, 180)], [entry(44, 240, BEFORE_CUTOFF)]), { year: Y, week: 40 }, { now: NOW, draws: 10, seed: 5 });
  for (const f of exp(onlyW44)) {
    const b = base.find((x) => x.modelId === f.modelId)!;
    assert(`${f.modelId}: a W44 forecast leaves W41–W43 exactly as without it`, f.targets.slice(0, 3).map((t) => [t.kg, t.low, t.high, t.afw?.source]), b.targets.slice(0, 3).map((t) => [t.kg, t.low, t.high, t.afw?.source]));
  }

  const late = [entry(41, 200, AFTER_CUTOFF)];
  const asOfCutoff = buildLabForecasts(inputs(events, [v2(39, 180)], late), { year: Y, week: 40 }, { now: NOW, draws: 10, seed: 5 });
  assert('entered after the as-of cutoff → ignored by default (no time look-ahead)', JSON.stringify(exp(asOfCutoff).map((f) => f.targets)), JSON.stringify(exp(base).map((f) => f.targets)));
  const live = buildLabForecasts(inputs(events, [v2(39, 180)], late), { year: Y, week: 40 }, { now: new Date('2026-10-10T00:00:00Z'), draws: 10, seed: 5, afwKnownBy: new Date('2026-10-10T00:00:00Z') });
  assert('…but used by a live forecast issued after it was entered', exp(live).map((f) => f.targets[0].afw?.source), ['manual-exact', 'manual-exact']);

  const hind = buildLabForecasts(inputs(season(35), [v2(34, 180, at(Y, 34))], [entry(37, 200, BEFORE_CUTOFF)]), { year: Y, week: 36 }, { now: NOW, draws: 5, seed: 5 });
  assert('a hindcast (as of W36) never sees a forecast entered in W40', exp(hind).every((f) => f.targets.every((t) => t.afw?.source !== 'manual-exact' && t.afw?.source !== 'manual-carried')), true);

  const settled = buildLabForecasts(inputs(events, [v2(36, 190, '2026-09-04T00:00:00Z'), v2(39, 180, at(Y, 39), false)]), { year: Y, week: 40 }, { now: NOW, draws: 5, seed: 5 });
  assert('without forecasts: settled GrowLink W36 (190 g) beats the provisional W39 fallback', exp(settled).map((f) => [f.targets[0].afw?.source, f.targets[0].afw?.grams]), [['growlink-settled', 190], ['growlink-settled', 190]]);

  const rows = fcs.flatMap((f) => toSnapshotRows(f, { runId: 'r', kind: 'live', varietyId: 'v1', issuedAt: NOW.toISOString(), codeVersion: null }));
  const d = rows.filter((r) => r.model_id === 'open-fruit-d');
  assert('snapshots store the AFW used for each target week', d.slice(0, 4).map((r) => [r.target_week, r.afw_g, r.afw_source, r.afw_as_of_index! - I(0)]),
    [[41, 200, 'manual-exact', 41], [42, 200, 'manual-carried', 41], [43, 200, 'manual-carried', 41], [44, 240, 'manual-exact', 44]]);
  assert('legacy snapshots keep their own AFW label', rows.find((r) => r.model_id === 'legacy')?.afw_source, 'croplink-manual (inside legacy endpoint)');
}

console.log('W53 and year rollover');
{
  const ev: StatusEvent[] = [];
  for (let s = 36; s <= 50; s++) {
    ev.push(...cohort(22, { year: Y, week: s }, s + 7 <= 50 ? 'Harvested' : undefined, s + 7 <= 50 ? { year: Y, week: s + 7 } : undefined));
    ev.push(...cohort(8, { year: Y, week: s }, 'Aborted', { year: Y, week: s + 2 }));
  }
  const now = new Date('2026-12-15T12:00:00Z');
  const es = [entry(52, 200, '2026-12-10T00:00:00Z'), entry(53, 210, '2026-12-10T00:00:00Z')];
  const fc = buildLabForecasts(inputs(ev, [v2(49, 175)], es, '2027-01-15'), { year: Y, week: 50 }, { now, draws: 5, seed: 3, afwKnownBy: now });
  const d = fc[1];
  assert('W51 fallback, W52 & W53 exact, 2027-W01..W02 carried from 2026-W53', d.targets.slice(0, 5).map((t) => [t.year, t.week, t.afw?.source, t.afw?.grams]), [
    [2026, 51, 'growlink-v2', 175], [2026, 52, 'manual-exact', 200], [2026, 53, 'manual-exact', 210], [2027, 1, 'manual-carried', 210], [2027, 2, 'manual-carried', 210],
  ]);
  const only52 = buildLabForecasts(inputs(ev, [v2(49, 175)], [es[0]], '2027-01-15'), { year: Y, week: 50 }, { now, draws: 5, seed: 3, afwKnownBy: now });
  assert('carry crosses W53 into the next ISO year', only52[1].targets.slice(1, 4).map((t) => [t.week, t.afw?.source, t.afw!.fromIndex === I(52)]), [[52, 'manual-exact', true], [53, 'manual-carried', true], [1, 'manual-carried', true]]);
}

console.log('editable window and validation');
{
  const now = new Date('2026-10-04T12:00:00Z'); // Sunday of 2026-W40
  const w = editableWeeks(now, '2026-12-31');
  assert('window: current week W40 → pull-out week 2026-W53', [w.from - I(0), w.to - I(0), w.pullOutKnown], [40, 53, true]);
  const w2 = editableWeeks(now, '2027-01-15');
  assert('pull-out in 2027 → window ends 2027-W02', [w2.to === I(2, 2027)], [true]);
  const w3 = editableWeeks(now, null);
  assert('no pull-out → 12 weeks', [w3.to - w3.from + 1, w3.pullOutKnown], [12, false]);

  const current = effectiveManualAfw([entry(45, 200, '2026-10-01T00:00:00Z')], now);
  const v = validateAfwChanges([
    { year: 2026, week: 40, grams: 205.04 }, { year: 2026, week: 53, grams: 210 }, { year: 2026, week: 48, grams: 500 },
    { year: 2026, week: 39, grams: 200 }, { year: 2027, week: 1, grams: 200 }, { year: 2025, week: 53, grams: 200 },
    { year: 2026, week: 41, grams: 200 }, { year: 2026, week: 41, grams: 201 }, { year: 2026, week: 42, grams: 5 },
    { year: 2026, week: 43, grams: 'abc' }, { year: 2026, week: 44, grams: null }, { year: 2026, week: 45, grams: 200 }, { year: 2026, week: 46, grams: '' },
  ], { now, pullOutDate: '2026-12-31', current });
  assert('accepted: W40 rounded to 0.1 g, W53, W48 (unusual but allowed), first W41', v.accepted.map((c: AfwChange) => [c.week, c.grams]), [[40, 205], [53, 210], [48, 500], [41, 200]]);
  assert('rejected: past week, after pull-out, 2025-W53, duplicate, out of range, not a number, clears with nothing to clear', v.errors.map((e) => `${e.year}-W${e.week}: ${e.reason.split(' ').slice(1, 4).join(' ')}`), [
    '2026-W39: is in the', '2027-W1: is after the', '2025-W53: does not exist', '2026-W41: appears twice', '2026-W42: AFW must be',
    '2026-W43: AFW must be', '2026-W44: has no forecast', '2026-W46: has no forecast',
  ]);
  assert('unchanged value is not re-recorded', v.accepted.some((c) => c.week === 45), false);
  assert('unusual value flagged as a notice', v.notices.length === 1 && v.notices[0].startsWith('2026-W48: 500 g'), true);
  const clear = validateAfwChanges([{ year: 2026, week: 45, grams: null }], { now, pullOutDate: '2026-12-31', current });
  assert('clearing an existing forecast is accepted', clear.accepted, [{ year: 2026, week: 45, grams: null }]);
  assert('empty save rejected', validateAfwChanges([], { now, pullOutDate: null, current }).errors.length, 1);
}

console.log('Lab view: a saved AFW forecast shows immediately; the locked value stays visible');
{
  const issued = '2026-10-05T12:00:00Z';
  const locked: SnapshotRow[] = base.flatMap((f) => toSnapshotRows(f, { runId: 'r', kind: 'live', varietyId: 'v1', issuedAt: issued, codeVersion: null }));
  const same = assembleView({ asOfIndex: I(40), horizon: 1, fromIndex: I(40), current: base, snapshots: locked, actuals: new Map(), legacyByIndex: new Map() });
  assert('inputs unchanged → the locked snapshot is shown', same.find((w) => w.week === 41)!.models['open-fruit-d']!.locked, true);
  const edited = buildLabForecasts(inputs(events, [v2(39, 180)], [entry(41, 200, '2026-10-05T13:00:00Z')]), { year: Y, week: 40 }, { now: NOW, draws: 10, seed: 5, afwKnownBy: new Date('2026-10-05T14:00:00Z') });
  const view = assembleView({ asOfIndex: I(40), horizon: 1, fromIndex: I(40), current: edited, snapshots: locked, actuals: new Map(), legacyByIndex: new Map() });
  const c = view.find((w) => w.week === 41)!.models['open-fruit-d']!;
  const e41 = edited.find((f) => f.modelId === 'open-fruit-d')!.targets[0];
  assert('after an AFW edit the current computation is shown with its AFW source', [c.kg, c.afwG, c.afwSource, c.locked], [e41.kg, 200, 'manual-exact', false]);
  assert('…next to the locked value (which remains the one scored)', [c.lockedKg, c.lockedIssuedAt, c.warnings.some((w) => w.startsWith('changed-since-lock'))], [Number(locked.find((r) => r.model_id === 'open-fruit-d' && r.target_week === 41)!.forecast_kg), issued, true]);
}

console.log('cycle: live snapshots use forecasts entered by issue time; hindcasts never do');
(async () => {
  {
    const stored: SnapshotRow[] = [];
    const store: LabStore = {
      available: async () => true, createRun: async () => {}, finishRun: async () => {},
      insertSnapshots: async (rs) => { stored.push(...rs); return rs.length; },
      snapshotAsOfIndexes: async () => new Set(), listSnapshots: async () => stored, listExclusions: async () => [], configHistory: async () => [],
    };
    const src = { inputs: inputs(events, [v2(39, 180)], [entry(41, 200, '2026-10-05T11:00:00Z')]) } as SourceData;
    await runForecastLabCycle({ store, varieties: async () => [{ id: 'v1', name: 'Mathieu' } as VarietyRecord], load: async () => src, now: () => NOW, newId: () => 'run', codeVersion: null, draws: 3 }, Y);
    const liveExp = stored.filter((r) => r.kind === 'live' && r.experimental);
    const hind = stored.filter((r) => r.kind === 'hindcast');
    assert('live: every experimental target uses the W41 forecast (exact or carried)', liveExp.length > 0 && liveExp.every((r) => r.afw_source === 'manual-exact' || r.afw_source === 'manual-carried'), true);
    assert('hindcasts: none use a manual AFW forecast', hind.length > 0 && hind.every((r) => !String(r.afw_source).startsWith('manual')), true);
  }

  console.log('editor API');
  {
    const log: ManualAfwEntry[] = [];
    let nextId = 0;
    const glPoints: AfwPoint[] = [v2(38, 192, '2026-09-25T00:00:00Z', true)];
    const glBefore = JSON.stringify(glPoints);
    let available = true;
    const deps: AfwForecastDeps = {
      repo: {
        list: async () => (available ? [...log] : null),
        insertBatch: async (_v, _b, changes) => {
          const rows = changes.map((c) => ({ id: ++nextId, varietyId: 'v1', year: c.year, week: c.week, action: c.grams == null ? 'clear' as const : 'set' as const, grams: c.grams, enteredAt: '2026-10-04T12:00:00.000Z' }));
          log.push(...rows);
          return rows;
        },
      },
      variety: async (id) => (id === '00000000-0000-4000-8000-0000000000aa' ? { id, name: 'Mathieu', pull_out_date: '2026-12-31', is_active: true } : null),
      afwPoints: async () => ({ afw: glPoints, growlinkLinked: true, v2Available: true }),
      now: () => new Date('2026-10-04T12:30:00Z'),
    };
    // Placeholder values so the route module can be imported; nothing connects (deps are in-memory).
    process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy';
    const express = (await import('express')).default;
    const { createAfwForecastsRouter } = await import('../routes/afwForecasts');
    const { createSaveRateLimit } = await import('../middleware/saveRateLimit');
    let clock = Date.parse('2026-10-04T12:30:00Z');
    const LIMIT = 8;
    deps.writeGuard = createSaveRateLimit({ limit: LIMIT, windowMs: 60_000, now: () => clock });
    const app = express();
    app.use(express.json());
    app.use('/api/afw-forecasts', createAfwForecastsRouter(deps));
    const server = app.listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/afw-forecasts`;
    const VID = '00000000-0000-4000-8000-0000000000aa';
    const get = async () => (await fetch(`${url}?varietyId=${VID}`)).json() as Promise<any>;
    const postAs = async (body: unknown, ip = '203.0.113.7') => {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.1, ${ip}` }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() as any };
    };
    const post = (body: unknown) => postAs(body, '198.51.100.1');
    try {
      const g = await get();
      assert('GET: current week through pull-out, W53 included', [g.weeks.length, g.weeks[0].label, g.weeks.at(-1).label, g.window.pullOutKnown], [14, '2026-W40', '2026-W53', true]);
      assert('GET: without forecasts every week uses settled GrowLink W38', g.weeks.every((w: any) => w.used.source === 'growlink-settled' && w.used.fromWeek === '2026-W38'), true);

      assert('GET is open (read API)', (await fetch(`${url}?varietyId=${VID}`)).status, 200);
      const { buildEditorModel } = await import('../routes/afwForecasts');
      const noGl = buildEditorModel({ variety: { id: VID, name: 'Mathieu', pull_out_date: '2026-12-31', is_active: true }, entries: [], now: new Date('2026-10-04T12:00:00Z'), growlinkLinked: true, v2Available: true,
        afw: [{ index: I(32), grams: 218, source: 'croplink-manual', knownAt: '2026-08-08T00:00:00Z', settled: null }] });
      assert('no GrowLink AFW at all → explicit warning, and the CropLink fallback is named', [noGl.warnings.some((w) => w.startsWith('No GrowLink AFW has been received yet')), noGl.warnings.some((w) => w.includes("CropLink's 218 g from 2026-W32")), noGl.baseline?.source], [true, true, 'croplink-manual']);
      const stale = await post({ varietyId: VID, expectedLatestEntryId: 7, changes: [{ year: 2026, week: 41, grams: 200 }] });
      assert('stale editor → 409, nothing saved', [stale.status, log.length], [409, 0]);
      const bad = await post({ varietyId: VID, expectedLatestEntryId: 0, changes: [{ year: 2026, week: 41, grams: 200 }, { year: 2026, week: 39, grams: 200 }] });
      assert('one invalid week → 422 and NOTHING saved (all or none)', [bad.status, bad.body.errors.length, log.length], [422, 1, 0]);

      const ok = await post({ varietyId: VID, expectedLatestEntryId: 0, changes: [{ year: 2026, week: 40, grams: 200 }, { year: 2026, week: 43, grams: 230 }] });
      const u = (b: any, label: string) => b.weeks.find((w: any) => w.label === label).used;
      assert('save with no passcode or auth header → 200 with recalculated sources', [ok.status, ok.body.saved, u(ok.body, '2026-W40').source, u(ok.body, '2026-W41').source, u(ok.body, '2026-W41').fromWeek, u(ok.body, '2026-W43').grams, u(ok.body, '2026-W53').fromWeek],
        [200, 2, 'manual-exact', 'manual-carried', '2026-W40', 230, '2026-W43']);
      const cleared = await post({ varietyId: VID, expectedLatestEntryId: ok.body.latestEntryId, changes: [{ year: 2026, week: 43, grams: null }] });
      assert('clear override → W43 falls back to the carried W40 value; history keeps both', [cleared.status, u(cleared.body, '2026-W43').source, u(cleared.body, '2026-W43').grams, cleared.body.history.map((h: any) => h.action)], [200, 'manual-carried', 200, ['clear', 'set', 'set']]);
      assert('GrowLink actual AFW is never written', JSON.stringify(glPoints), glBefore);
      const sent = log.length;
      const burst = [];
      for (let k = 0; k < LIMIT + 2; k++) burst.push((await postAs({ varietyId: VID, expectedLatestEntryId: -5, changes: [] }, '203.0.113.50')).status);
      assert(`rate limit: ${LIMIT} saves per window per IP, then 429 (nothing stored)`, [burst.filter((x) => x === 429).length, log.length === sent], [2, true]);
      assert('…other IPs are not limited', (await postAs({ varietyId: VID, expectedLatestEntryId: -5, changes: [] }, '192.0.2.77')).status, 409);
      clock += 60_001;
      assert('…the limit resets after the window', (await postAs({ varietyId: VID, expectedLatestEntryId: -5, changes: [] }, '203.0.113.50')).status, 409);
      const { writeGuard: _g, ...defaultDeps } = deps;
      const dflt = express();
      dflt.use(express.json());
      dflt.use('/y', createAfwForecastsRouter(defaultDeps));
      const s3 = dflt.listen(0);
      const r3 = await fetch(`http://127.0.0.1:${(s3.address() as AddressInfo).port}/y`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ varietyId: VID, expectedLatestEntryId: -5, changes: [] }) });
      s3.close();
      assert('default router (no guard injected) applies the save rate limit and reaches the handler', r3.status, 409);
      assert('no GrowLink actual exists for W40+ yet → none shown', g.weeks.every((w: any) => w.growlinkActual === null), true);
      const unknown = await fetch(`${url}?varietyId=00000000-0000-4000-8000-0000000000bb`);
      assert('unknown variety → 404', unknown.status, 404);
      available = false;
      const off = await fetch(`${url}?varietyId=${VID}`);
      assert('migration pending → 503 (editor disabled, nothing breaks)', off.status, 503);
    } finally {
      server.close();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
