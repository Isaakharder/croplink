/**
 * Harvest forecast models (lib/harvestForecast.ts): replay pipeline,
 * chronological cutoff (no future-data leakage), fallbacks, maturity gate,
 * no breaker double-counting, W53 and year rollover, kg calibration.
 *
 * Synthetic setup: one tracked stem, totalStems = 1, area = 1 m², AFW =
 * 1000 g — so fruit/m² equals the fruit count and kg equals fruit/m².
 *
 * Run with: npx tsx src/__tests__/harvest-forecast.test.ts
 */
import {
  StatusEvent, ForecastInput, ModelId, forecastCutoff, replayFruitLifecycles, summarizeWeeks,
  forecastHarvest, forecastHarvestCalibrated, isSettled, harvestWindowFraction, MIN_SAMPLE,
} from '../lib/harvestForecast';
import { IsoWeek, isoWeekIndex, isoWeekMonday, addIsoWeeks } from '../lib/isoWeek';

let pass = 0;
let fail = 0;
function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); fail++; }
}
function assertClose(label: string, actual: number, expected: number, tol = 1e-6): void {
  if (Math.abs(actual - expected) < tol) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label} — expected ~${expected}, got ${actual}`); fail++; }
}

const Y = 2026;
let nodeSeq = 0;
function enteredDuring(year: number, week: number, day = 2): string {
  return new Date(isoWeekMonday(year, week).getTime() + day * 86_400_000 + 3_600_000).toISOString();
}
function ev(node: string, year: number, week: number, status: string, createdAt = enteredDuring(year, week)): StatusEvent {
  return { plantNodeId: node, stemId: 'S', year, week, status, createdAt };
}
/** `count` fruits set in `setWeek`, each optionally resolved with `outcome` in `end`. */
function cohort(count: number, setWeek: number, outcome?: 'Harvested' | 'Aborted' | 'Pruned', end?: IsoWeek, setYear = Y): StatusEvent[] {
  const out: StatusEvent[] = [];
  for (let i = 0; i < count; i++) {
    const node = `n${++nodeSeq}`;
    out.push(ev(node, setYear, setWeek, 'SetFruit'));
    if (outcome && end) out.push(ev(node, end.year, end.week, outcome));
  }
  return out;
}
const wk = (week: number, year = Y): IsoWeek => ({ year, week });
function inputFor(events: StatusEvent[], asOf: IsoWeek, extra: Partial<ForecastInput> = {}): ForecastInput {
  const cutoff = forecastCutoff(asOf);
  return {
    asOf,
    lifecycles: replayFruitLifecycles(events, cutoff),
    coverage: summarizeWeeks(events, cutoff),
    manualFruitSetPerM2: new Map(),
    afw: [{ index: isoWeekIndex(Y, 1), grams: 1000 }],
    totalStems: 1,
    areaM2: 1,
    ...extra,
  };
}
const total = (r: { weeks: { fruitPerM2: number }[] }) => r.weeks.reduce((s, w) => s + w.fruitPerM2, 0);
const at = (r: { weeks: { year: number; week: number; fruitPerM2: number }[] }, w: IsoWeek) =>
  r.weeks.find((x) => x.year === w.year && x.week === w.week)?.fruitPerM2 ?? 0;
const MODELS: ModelId[] = ['deployed', 'A', 'B', 'C', 'D'];

// ── Replay pipeline ───────────────────────────────────────────────────────
console.log('replayFruitLifecycles — mirrors weeklyStatuses.ts fruit_instances rules');
{
  const events = [
    // A: re-recorded SetFruit + breaker + harvest → one fruit, set W10, harvested W17
    ev('A', Y, 10, 'SetFruit'), ev('A', Y, 11, 'SetFruit'), ev('A', Y, 15, 'BreakerFruit'), ev('A', Y, 17, 'Harvested'),
    // B: SetFruit W12 entered first, then an out-of-order W11 entry → set week moves back to 11; aborted W13
    ev('B', Y, 12, 'SetFruit', enteredDuring(Y, 12, 1)), ev('B', Y, 11, 'SetFruit', enteredDuring(Y, 12, 2)), ev('B', Y, 13, 'Aborted'),
    // C: Harvested with nothing open → no fruit
    ev('C', Y, 14, 'Harvested'),
    // D: two cycles on one node
    ev('D', Y, 10, 'SetFruit'), ev('D', Y, 16, 'Harvested'), ev('D', Y, 18, 'SetFruit'),
  ];
  const f = replayFruitLifecycles(events).map((x) => [x.nodeId, x.setIndex - isoWeekIndex(Y, 0 + 1) + 1, x.outcome, x.endIndex == null ? null : x.endIndex - isoWeekIndex(Y, 1) + 1]);
  assert('lifecycles', f, [['A', 10, 'harvested', 17], ['D', 10, 'harvested', 16], ['B', 11, 'aborted', 13], ['D', 18, 'open', null]]);

  const cut = replayFruitLifecycles(events, forecastCutoff(wk(14)));
  assert('as of W14, A is still open (its W17 harvest is in the future)', cut.find((x) => x.nodeId === 'A')?.outcome, 'open');
  const backfill = [...events, ev('E', Y, 13, 'SetFruit', enteredDuring(Y, 20))];
  assert('a W13 status entered in W20 is invisible to a W14 forecast', replayFruitLifecycles(backfill, forecastCutoff(wk(14))).some((x) => x.nodeId === 'E'), false);
}

// ── Chronological cutoff: no leakage ──────────────────────────────────────
console.log('forecast at T is unaffected by anything after T');
{
  const past = [...cohort(40, 10, 'Harvested', wk(17)), ...cohort(20, 25), ...cohort(15, 28, 'Aborted', wk(29))];
  const future = [
    ...cohort(30, 31, 'Harvested', wk(38)),           // later weeks
    ...past.filter((e) => e.week === 25).slice(0, 10).map((e) => ({ ...e, week: 32, status: 'Harvested', createdAt: enteredDuring(Y, 32) })), // outcomes after T
    ev('late', Y, 29, 'SetFruit', enteredDuring(Y, 33)), // backfilled after the forecast date
  ];
  for (const m of MODELS) {
    const a = forecastHarvest(inputFor(past, wk(30)), m);
    const b = forecastHarvest(inputFor([...past, ...future], wk(30)), m);
    assert(`model ${m}: identical with and without future data`, b.weeks, a.weeks);
  }
}

// ── No breaker double counting ────────────────────────────────────────────
console.log('breaker / mature-green statuses never add fruit on top of set fruit');
{
  const base = [...cohort(40, 10, 'Harvested', wk(17)), ...cohort(12, 26)];
  const openNodes = base.filter((e) => e.week === 26).map((e) => e.plantNodeId);
  const withBreaker = [...base, ...openNodes.map((n) => ev(n, Y, 29, 'MatureGreen')), ...openNodes.map((n) => ev(n, Y, 30, 'BreakerFruit'))];
  for (const m of MODELS) {
    assert(`model ${m}: same forecast with breaker statuses`, forecastHarvest(inputFor(withBreaker, wk(30)), m).weeks.map((w) => w.fruitPerM2), forecastHarvest(inputFor(base, wk(30)), m).weeks.map((w) => w.fruitPerM2));
  }
}

// ── Flow vs census input ──────────────────────────────────────────────────
console.log('set fruit is counted once (flow), not once per week it stays set (census)');
{
  const node = 'F1';
  const events = [ev(node, Y, 20, 'SetFruit'), ev(node, Y, 21, 'SetFruit'), ev(node, Y, 22, 'SetFruit')];
  assertClose('deployed (census) projects 3 fruit', total(forecastHarvest(inputFor(events, wk(22)), 'deployed')), 3);
  assertClose('model A (flow) projects 1 fruit', total(forecastHarvest(inputFor(events, wk(22)), 'A')), 1);
}

// ── Manual fruit-set fallback ─────────────────────────────────────────────
console.log('stored manual fruit-set is used only where no measurement exists');
{
  const events = cohort(1, 20);
  const manual = new Map([[isoWeekIndex(Y, 20), 5], [isoWeekIndex(Y, 25), 7]]);
  const r = forecastHarvest(inputFor(events, wk(22), { manualFruitSetPerM2: manual }), 'A');
  assertClose('measured W20 (1 fruit) wins over manual 5; unmeasured W25 uses manual 7', total(r), 8);
  assert('evidence reports one manual cohort', r.evidence.cohortsFromManual, 1);
}

// ── Survival: maturity gate, minimum sample, conservative fallbacks ───────
console.log('survival');
{
  const mature = [...cohort(30, 10, 'Harvested', wk(17)), ...cohort(10, 10, 'Aborted', wk(12))];
  const r = forecastHarvest(inputFor(mature, wk(25)), 'A');
  assert('mature pool: 30/40 harvested', [r.evidence.survival.tier, r.evidence.survival.rate, r.evidence.survival.sample], ['mature-pool', 0.75, 40]);

  const immatureAllLost = cohort(40, 20, 'Aborted', wk(21));
  const r2 = forecastHarvest(inputFor([...mature, ...immatureAllLost], wk(25)), 'A');
  assert('immature cohorts never feed survival', r2.evidence.survival.rate, 0.75);

  const near = [...cohort(20, 10, 'Harvested', wk(17)), ...cohort(20, 10)];
  const r3 = forecastHarvest(inputFor(near, wk(19)), 'A');
  assert('no mature cohort yet → near-mature lower bound (open counts as lost)', [r3.evidence.survival.tier, r3.evidence.survival.rate], ['near-mature-lower-bound', 0.5]);

  const r4 = forecastHarvest(inputFor(cohort(MIN_SAMPLE - 1, 10, 'Harvested', wk(17)), wk(25)), 'A');
  assert(`fewer than ${MIN_SAMPLE} fruit → no-evidence, flagged`, r4.evidence.survival.tier, 'no-evidence');
}

// ── Timing curve fallback ─────────────────────────────────────────────────
console.log('timing curve');
{
  const mature = [...cohort(30, 10, 'Harvested', wk(17)), ...cohort(10, 10, 'Aborted', wk(12))];
  const r = forecastHarvest(inputFor([...mature, ...cohort(10, 24)], wk(25)), 'C');
  assert('C learns the mature curve (all harvests at +7)', r.evidence.curve.tier, 'mature-pool');
  assertClose('C: 10 fruit × 0.75 survival land in W31', at(r, wk(31)), 7.5);
  const thin = forecastHarvest(inputFor([...cohort(MIN_SAMPLE - 1, 10, 'Harvested', wk(17)), ...cohort(10, 24)], wk(25)), 'C');
  assert('fewer than MIN_SAMPLE harvested → fixed 20/40/40 fallback', thin.evidence.curve.tier, 'fixed-fallback');
}

// ── Model D: open-fruit hazards ───────────────────────────────────────────
console.log('model D');
{
  const mature = [...cohort(30, 10, 'Harvested', wk(17)), ...cohort(10, 10, 'Aborted', wk(12))];
  const young = [...cohort(10, 22, 'Aborted', wk(23)), ...cohort(10, 22)];
  const d = forecastHarvest(inputFor([...mature, ...young], wk(25)), 'D');
  assert('hazards learned from mature cohorts, tail pooled where < MIN_SAMPLE at risk', [d.evidence.hazards?.tier, d.evidence.hazards?.tailPooledFromAge], ['mature-hazards', 8]);
  assertClose('D forecasts only the 10 still-open fruit (all survivors of age 3 were harvested at +7)', total(d), 10);
  assertClose('…in W29', at(d, wk(29)), 10);
  const a = forecastHarvest(inputFor([...mature, ...young], wk(25)), 'A');
  assertClose('A ignores the already-aborted half: 20 × 0.75', total(a), 15);

  const none = forecastHarvest(inputFor(cohort(10, 22), wk(25)), 'D');
  assert('no mature cohorts → explicit no-mature-evidence tier', none.evidence.hazards?.tier, 'no-mature-evidence');
}

// ── W53 and year rollover ─────────────────────────────────────────────────
console.log('W53 and year rollover');
{
  const r = forecastHarvest(inputFor(cohort(30, 46), wk(51), { afw: [{ index: isoWeekIndex(Y, 40), grams: 200 }] }), 'A');
  assert('weeks after 2026-W51 run W52 → W53 → 2027-W1', r.weeks.slice(0, 3).map((w) => [w.year, w.week]), [[2026, 52], [2026, 53], [2027, 1]]);
  assertClose('set W46 +6 → W52 (20%)', at(r, wk(52)), 6);
  assertClose('set W46 +7 → W53 (40%)', at(r, wk(53)), 12);
  assertClose('set W46 +8 → 2027-W1 (40%), not dropped', at(r, wk(1, 2027)), 12);
  assertClose('2027-W1 kg uses AFW carried across the year boundary', r.weeks.find((w) => w.year === 2027 && w.week === 1)!.kg as number, 12 * 200 / 1000);

  const cross = forecastHarvest(inputFor([...cohort(30, 40, 'Harvested', wk(47)), ...cohort(10, 40, 'Aborted', wk(42)), ...cohort(10, 53)], wk(1, 2027)), 'D');
  // Open at age 1, it still faces the learned age-2 abort hazard (10/40), then harvest at +7.
  assertClose('a W53 cohort ages correctly into 2027: +7 → 2027-W7 (10 open × 0.75)', at(cross, addIsoWeeks(2026, 53, 7)), 7.5);
  assertClose('…and nothing lands a week early or late', at(cross, addIsoWeeks(2026, 53, 6)) + at(cross, addIsoWeeks(2026, 53, 8)), 0);
}

// ── Crop pull-out date ────────────────────────────────────────────────────
console.log('pull-out date truncates harvest');
{
  assert('2026-W52 fully before a Dec 31 pull-out', harvestWindowFraction(isoWeekIndex(2026, 52), '2026-12-31'), 1);
  assertClose('2026-W53 (Mon Dec 28–Sun Jan 3) keeps Mon–Thu = 4/7', harvestWindowFraction(isoWeekIndex(2026, 53), '2026-12-31'), 4 / 7);
  assert('2027-W1 is after the pull-out', harvestWindowFraction(isoWeekIndex(2027, 1), '2026-12-31'), 0);
  assert('no pull-out date → no truncation', harvestWindowFraction(isoWeekIndex(2027, 1), null), 1);
  const r = forecastHarvest(inputFor(cohort(30, 46), wk(51), { pullOutDate: '2026-12-31' }), 'A');
  assertClose('W52 untouched (6)', at(r, wk(52)), 6);
  assertClose('W53 truncated to 4/7 of 12', at(r, wk(53)), 12 * 4 / 7);
  assertClose('2027-W1 harvest removed', at(r, wk(1, 2027)), 0);
  assert('weeks report their harvest window', r.weeks.slice(0, 3).map((w) => Number(w.harvestWindow.toFixed(4))), [1, Number((4 / 7).toFixed(4)), 0]);
}

// ── kg calibration ────────────────────────────────────────────────────────
console.log('kg calibration — settled actuals only');
{
  // Steady state: 10 fruit set every week W10..W30, all harvested at +7.
  const events: StatusEvent[] = [];
  for (let s = 10; s <= 30; s++) events.push(...cohort(10, s, 'Harvested', wk(s + 7)));
  const build = (asOf: IsoWeek) => inputFor(events, asOf);
  const half = new Map<number, number>();
  for (let w = 10; w <= 30; w++) half.set(isoWeekIndex(Y, w), 5); // actual = half the model
  const weeksOf = (r: { calibration: { weeks: { index: number }[] } }) => r.calibration.weeks.map((p) => p.index - isoWeekIndex(Y, 1) + 1);

  // W28 ends Mon Jul 13 00:00 Toronto (EDT) = 04:00Z; settled 10 days later, Jul 23 04:00Z.
  assert('isSettled: a week is final 10 days after its Sunday ends in Toronto', [isSettled(isoWeekIndex(Y, 28), new Date('2026-07-23T03:59:59Z')), isSettled(isoWeekIndex(Y, 28), new Date('2026-07-23T04:00:00Z'))], [false, true]);

  const rolling = forecastHarvestCalibrated(build, 'C', wk(30), half, 'rolling');
  // Forecast date is Tue of W31; W29 and W30 are not settled yet.
  assert('rolling: the 4 most recent SETTLED weeks (W25–W28)', weeksOf(rolling), [25, 26, 27, 28]);
  assertClose('factor = actual / model = 0.5', rolling.calibration.factor, 0.5);
  assertClose('calibrated W31 = 10 × 0.5', at(rolling, wk(31)), 5);

  const stable = forecastHarvestCalibrated(build, 'C', wk(30), half, 'stable');
  assert('stable: every settled, fully-measured week (W20–W28)', weeksOf(stable), [20, 21, 22, 23, 24, 25, 26, 27, 28]);

  const leaked = new Map(half);
  leaked.set(isoWeekIndex(Y, 29), 1_000_000);
  leaked.set(isoWeekIndex(Y, 30), 1_000_000);
  assertClose('unsettled recent actuals (W29, W30) are ignored', forecastHarvestCalibrated(build, 'C', wk(30), leaked, 'rolling').calibration.factor, 0.5);

  const none = forecastHarvestCalibrated(build, 'C', wk(30), new Map());
  assert('no actuals → factor 1, flagged insufficient, no band', [none.calibration.tier, none.calibration.factor, none.calibration.ratioBand], ['insufficient-actuals', 1, null]);

  // Measurement starts at set week W10, so week w is usable only once cohorts w-10..w-4 were all measured (w >= 20).
  assert('weeks whose harvest could predate measurement are not used', weeksOf(forecastHarvestCalibrated(build, 'C', wk(19), half)), []);
  const boundary = forecastHarvestCalibrated(build, 'C', wk(23), half);
  assert('first usable weeks are exactly W20–W21', [weeksOf(boundary), boundary.calibration.tier], [[20, 21], 'settled-actuals']);
  assert('fewer than 4 calibration weeks → no uncertainty band', boundary.calibration.ratioBand, null);

  const noisy = new Map<number, number>();
  for (let w = 10; w <= 30; w++) noisy.set(isoWeekIndex(Y, w), w % 2 ? 4 : 6); // ratios 0.4 / 0.6
  const band = forecastHarvestCalibrated(build, 'C', wk(30), noisy, 'stable');
  const w31 = band.weeks.find((w) => w.week === 31)!;
  assert('band brackets the point forecast', (w31.kgLow as number) <= (w31.kg as number) && (w31.kg as number) <= (w31.kgHigh as number), true);
  assertClose('band low = 10 × p10 ratio (0.4)', w31.kgLow as number, 4);
  assertClose('band high = 10 × p90 ratio (0.6)', w31.kgHigh as number, 6);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
