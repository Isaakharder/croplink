/**
 * Interval-censored competing-risk survival (lib/intervalSurvival.ts).
 *
 * Run with: npx tsx src/__tests__/interval-survival.test.ts
 */
import { StatusEvent, forecastCutoff } from '../lib/harvestForecast';
import {
  inferHarvestCheckWeeks, buildFruitObservations, fitIntervalHazards, forecastOpenFruit, harvestProbabilities, redistributeHarvests, HazardFit,
} from '../lib/intervalSurvival';
import { isoWeekIndex, isoWeekMonday } from '../lib/isoWeek';

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
const W = (w: number) => isoWeekIndex(Y, w);
let seq = 0;
const at = (week: number) => new Date(isoWeekMonday(Y, week).getTime() + 4 * 86_400_000).toISOString();
const ev = (node: string, week: number, status: string, stem = 'S1'): StatusEvent => ({ plantNodeId: node, stemId: stem, year: Y, week, status, createdAt: at(week) });

/**
 * One fruit: set at `set`, MatureGreen 2 weeks before its true event, and a
 * terminal status recorded at the first survey on/after the true event week
 * where that kind of event is checked (`harvestChecked(week)` for harvests;
 * losses are checked every week).
 */
function fruit(set: number, kind: 'harvest' | 'loss' | 'open', trueWeek: number, harvestChecked: (w: number) => boolean, stem = 'S1'): StatusEvent[] {
  const n = `n${++seq}`;
  const out = [ev(n, set, 'SetFruit', stem)];
  if (kind === 'harvest' && trueWeek - 2 > set) out.push(ev(n, trueWeek - 2, 'MatureGreen', stem));
  if (kind === 'harvest') { let w = trueWeek; while (!harvestChecked(w)) w++; out.push(ev(n, w, 'Harvested', stem)); }
  if (kind === 'loss') out.push(ev(n, trueWeek, 'Aborted', stem));
  return out;
}

console.log('harvest-check inference');
{
  const everyWeek = () => true;
  const events: StatusEvent[] = [];
  for (let s = 10; s <= 24; s++) for (let i = 0; i < 20; i++) events.push(...fruit(s, 'harvest', s + 6, (w) => w !== 22 && everyWeek()));
  const checked = inferHarvestCheckWeeks(events);
  assert('a week with ripe fruit but no harvest records is flagged unchecked', checked.has(W(22)), false);
  assert('neighbouring weeks are checked', [checked.has(W(21)), checked.has(W(23))], [true, true]);
}

console.log('observations');
{
  const checks = new Set([W(30), W(31), W(32), W(33), W(34), W(36)]);
  const ev1 = [ev('a', 30, 'SetFruit'), ev('a', 34, 'BreakerFruit'), ev('a', 36, 'Harvested')];
  const [o] = buildFruitObservations(ev1, undefined, checks);
  assert('harvest recorded W36 after unchecked W35 → interval (W34, W36]', [o.lo - W(0) , o.hi! - W(0)], [34, 36]);
  const [naive] = buildFruitObservations(ev1, undefined, 'all');
  assert('naive reading pins it to W36 alone', [naive.lo - W(0), naive.hi! - W(0)], [35, 36]);
  const [noBreaker] = buildFruitObservations([ev('a', 30, 'SetFruit'), ev('a', 36, 'Harvested')], undefined, checks);
  assert('without the breaker sighting the interval starts at the last checked week (W34)', noBreaker.lo - W(0), 34);
  const [loss] = buildFruitObservations([ev('b', 30, 'SetFruit'), ev('b', 33, 'Pruned')], undefined, checks);
  assert('loss is a single-week interval', [loss.outcome, loss.lo - W(0), loss.hi! - W(0)], ['lost', 32, 33]);
  const open = buildFruitObservations([ev('c', 30, 'SetFruit'), ev('c', 33, 'MatureGreen')], forecastCutoff({ year: Y, week: 35 }), checks);
  assert('open fruit is right-censored at its last sighting / checked week', [open[0].outcome, open[0].lo - W(0), open[0].hi], ['open', 34, null]);
  const withBreaker = buildFruitObservations([...ev1, ev('a', 35, 'MatureGreen')], undefined, checks);
  assert('extra ripening statuses never add fruit', withBreaker.length, 1);
  const future = buildFruitObservations([...ev1, ev('z', 37, 'SetFruit')], forecastCutoff({ year: Y, week: 35 }), checks);
  assert('nothing after the cutoff is visible (fruit still open, no W37 fruit)', future.map((f) => [f.outcome, f.hi]), [['open', null]]);
}

console.log('EM recovers known hazards from interval-censored data');
{
  // Truth: loss at age 2 (20%); of survivors, harvest at age 6 (50%) and age 7 (rest).
  // Harvest is only checked on even weeks, so odd-week harvests are recorded a week late.
  const evenOnly = (w: number) => w % 2 === 0;
  const events: StatusEvent[] = [];
  for (let s = 10; s <= 21; s++) {
    for (let i = 0; i < 10; i++) events.push(...fruit(s, 'loss', s + 2, evenOnly, `S${i % 5}`));
    for (let i = 0; i < 20; i++) events.push(...fruit(s, 'harvest', s + 6, evenOnly, `S${i % 5}`));
    for (let i = 0; i < 20; i++) events.push(...fruit(s, 'harvest', s + 7, evenOnly, `S${i % 5}`));
  }
  const checks = new Set([...Array(40).keys()].filter((w) => w % 2 === 0).map((w) => W(w)));
  const obs = buildFruitObservations(events, undefined, checks);
  const fit = fitIntervalHazards(obs, W(30)) as HazardFit;
  assertClose('loss hazard at age 2 ≈ 0.20', fit.loss[2], 0.2, 0.01);
  assertClose('harvest hazard at age 6 ≈ 0.50', fit.harvest[6], 0.5, 0.05);
  assertClose('harvest hazard at age 7 ≈ 1.00', fit.harvest[7], 1, 0.05);
  const naive = fitIntervalHazards(buildFruitObservations(events, undefined, 'all'), W(30)) as HazardFit;
  assert('the naive recorded-week fit is visibly distorted at age 6', Math.abs(naive.harvest[6] - 0.5) > 0.1, true);

  const p = harvestProbabilities(fit, 0);
  assertClose('lifetime harvest probability ≈ 0.80', [...p.values()].reduce((a, b) => a + b, 0), 0.8, 0.02);

  const redistributed = redistributeHarvests(obs, fit);
  const s12 = redistributed.get(W(12))!;
  assertClose('redistribution splits set-W12 harvests ≈ 50/50 between W18 and W19', (s12.get(W(18)) ?? 0) / ((s12.get(W(18)) ?? 0) + (s12.get(W(19)) ?? 0)), 0.5, 0.06);
}

console.log('right-censoring and the recent period window');
{
  const all = () => true;
  const events: StatusEvent[] = [];
  // Old cohorts: 10% lost at age 2. Recent cohorts (set W27–W29): 50% lost at age 2, rest still open.
  for (let s = 10; s <= 20; s++) {
    for (let i = 0; i < 10; i++) events.push(...fruit(s, 'loss', s + 2, all));
    for (let i = 0; i < 90; i++) events.push(...fruit(s, 'harvest', s + 6, all));
  }
  for (let s = 27; s <= 29; s++) {
    for (let i = 0; i < 50; i++) events.push(...fruit(s, 'loss', s + 2, all));
    for (let i = 0; i < 50; i++) events.push(...fruit(s, 'open', 0, all));
  }
  const cutoff = forecastCutoff({ year: Y, week: 32 });
  const obs = buildFruitObservations(events, cutoff, 'all');
  const allPeriods = fitIntervalHazards(obs, W(32)) as HazardFit;
  const recent = fitIntervalHazards(obs, W(32), 6) as HazardFit;
  assert('recent immature cohorts inform the early-age loss hazard (all periods: between 0.1 and 0.5)', allPeriods.loss[2] > 0.1 && allPeriods.loss[2] < 0.5, true);
  assertClose('the recent window tracks the new loss rate (0.5)', recent.loss[2], 0.5, 1e-6);
  assertClose('…but they add no exposure past the age they have reached (age-6 harvest still from old cohorts)', recent.harvest[6], 1, 1e-6);

  const fc = forecastOpenFruit(obs, recent, W(32), () => 1);
  const total = [...fc.values()].reduce((a, b) => a + b, 0);
  assertClose('forecast = open fruit (150) × harvest probability (1, no further loss hazard learned past age 2)', total, 150, 1e-6);
  assert('nothing is forecast for weeks at or before asOf', [...fc.keys()].every((k) => k > W(32)), true);
  const shifted = forecastOpenFruit(obs, recent, W(32), () => 1, 2 / 7);
  assertClose('pack shift moves 2/7 of W35 harvest (set W29 + 6) into W34', shifted.get(W(34)) ?? 0, (fc.get(W(34)) ?? 0) * 5 / 7 + (fc.get(W(35)) ?? 0) * 2 / 7, 1e-6);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
