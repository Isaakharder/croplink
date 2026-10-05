/**
 * Greenhouse local time (America/Toronto): the current ISO week, the AFW
 * editor window, the cycle's latest survey week, forecast data cutoffs and
 * settlement all follow the Toronto wall clock — not UTC. Boundary cases at
 * Sunday 7:59 PM, 8:00 PM, 11:59 PM and Monday 12:00 AM, in EDT, in EST, on
 * both 2026 DST-change Sundays, and across the 2026-W53 → 2027-W01 rollover.
 *
 * Run with: npx tsx src/__tests__/greenhouse-time.test.ts
 */
import { greenhouseIsoWeek, greenhouseWeekStart, zonedMidnight, isoWeekIndex } from '../lib/isoWeek';
import { forecastCutoff, isSettled, StatusEvent } from '../lib/harvestForecast';
import { editableWeeks, validateAfwChanges } from '../lib/afwForecast';
import { latestSurveyIndex } from '../lib/forecastLab/cycle';

let pass = 0;
let fail = 0;
function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); fail++; }
}
const wk = (t: string) => { const w = greenhouseIsoWeek(new Date(t)); return `${w.year}-W${String(w.week).padStart(2, '0')}`; };

// [label, Sunday 7:59 PM, Sunday 8:00 PM, Sunday 11:59 PM, Monday 12:00 AM (all as UTC instants), week before, week after]
const cases: [string, string, string, string, string, string, string][] = [
  ['EDT (UTC−4), Sun Oct 4 2026', '2026-10-04T23:59:00Z', '2026-10-05T00:00:00Z', '2026-10-05T03:59:00Z', '2026-10-05T04:00:00Z', '2026-W40', '2026-W41'],
  ['EST (UTC−5), Sun Dec 6 2026', '2026-12-07T00:59:00Z', '2026-12-07T01:00:00Z', '2026-12-07T04:59:00Z', '2026-12-07T05:00:00Z', '2026-W49', '2026-W50'],
  ['DST starts that morning, Sun Mar 8 2026 (evening is EDT)', '2026-03-08T23:59:00Z', '2026-03-09T00:00:00Z', '2026-03-09T03:59:00Z', '2026-03-09T04:00:00Z', '2026-W10', '2026-W11'],
  ['DST ends that morning, Sun Nov 1 2026 (evening is EST)', '2026-11-02T00:59:00Z', '2026-11-02T01:00:00Z', '2026-11-02T04:59:00Z', '2026-11-02T05:00:00Z', '2026-W44', '2026-W45'],
  ['W53 → next ISO year, Sun Jan 3 2027 (EST)', '2027-01-04T00:59:00Z', '2027-01-04T01:00:00Z', '2027-01-04T04:59:00Z', '2027-01-04T05:00:00Z', '2026-W53', '2027-W01'],
];

console.log('current ISO week follows the Toronto wall clock');
for (const [label, t759, t800, t1159, tMon, before, after] of cases) {
  assert(`${label}: 7:59 PM, 8:00 PM, 11:59 PM Sunday stay in ${before}; Monday 12:00 AM is ${after}`, [wk(t759), wk(t800), wk(t1159), wk(tMon)], [before, before, before, after]);
  const [by, bw] = before.split('-W').map(Number);
  const [ay, aw] = after.split('-W').map(Number);
  assert(`${label}: AFW editor window starts at ${before} until Monday 12:00 AM`, [t759, t800, t1159, tMon].map((t) => editableWeeks(new Date(t), null).from), [isoWeekIndex(by, bw), isoWeekIndex(by, bw), isoWeekIndex(by, bw), isoWeekIndex(ay, aw)]);
  assert(`${label}: greenhouse week starts exactly at Monday 12:00 AM local`, greenhouseWeekStart(ay, aw).toISOString(), new Date(tMon).toISOString());
}

console.log('AFW forecast validation at the boundary (2026-W40 → W41)');
{
  const save = (t: string) => validateAfwChanges([{ year: 2026, week: 40, grams: 190 }], { now: new Date(t), pullOutDate: '2026-12-31', current: new Map() });
  assert('Sun 8:00 PM: W40 is still the current week → accepted', save('2026-10-05T00:00:00Z').accepted.length, 1);
  assert('Sun 11:59 PM: still accepted', save('2026-10-05T03:59:00Z').accepted.length, 1);
  assert('Mon 12:00 AM: W40 is now in the past → rejected', save('2026-10-05T04:00:00Z').errors.map((e) => e.reason.includes('in the past')), [true]);
}

console.log('cycle: latest survey week never runs ahead of the greenhouse week');
{
  const ev = (week: number, createdAt: string): StatusEvent => ({ plantNodeId: `n${week}`, stemId: 's', year: 2026, week, status: 'SetFruit', createdAt });
  const events = [ev(40, '2026-10-02T15:00:00Z'), ev(41, '2026-10-05T00:30:00Z')]; // a W41 survey row saved at Sun 8:30 PM
  assert('Sun 9:00 PM: latest survey week is W40 (the greenhouse is still in W40)', latestSurveyIndex(events, new Date('2026-10-05T01:00:00Z')), isoWeekIndex(2026, 40));
  assert('Mon 12:00 AM: W41 becomes eligible', latestSurveyIndex(events, new Date('2026-10-05T04:00:00Z')), isoWeekIndex(2026, 41));
}

console.log('forecast data cutoff = Tuesday 12:00 AM Toronto after the as-of week');
{
  assert('as of W40 (EDT): Tue Oct 6 00:00 EDT = 04:00Z', forecastCutoff({ year: 2026, week: 40 }).enteredBy.toISOString(), '2026-10-06T04:00:00.000Z');
  assert('as of W44 (clocks fall back on its Sunday): Tue Nov 3 00:00 EST = 05:00Z', forecastCutoff({ year: 2026, week: 44 }).enteredBy.toISOString(), '2026-11-03T05:00:00.000Z');
  assert('as of W10 (clocks spring forward on its Sunday): Tue Mar 10 00:00 EDT = 04:00Z', forecastCutoff({ year: 2026, week: 10 }).enteredBy.toISOString(), '2026-03-10T04:00:00.000Z');
  assert('as of 2026-W53: Tue Jan 5 2027 00:00 EST = 05:00Z', forecastCutoff({ year: 2026, week: 53 }).enteredBy.toISOString(), '2027-01-05T05:00:00.000Z');
}

console.log('settlement = 10 days after the week ends in Toronto (same as GrowLink iso_week_end_local)');
{
  const s = (y: number, w: number, t: string) => isSettled(isoWeekIndex(y, w), new Date(t));
  assert('W40 (ends Mon Oct 5 00:00 EDT): provisional at Oct 15 03:59Z, settled at 04:00Z', [s(2026, 40, '2026-10-15T03:59:59Z'), s(2026, 40, '2026-10-15T04:00:00Z')], [false, true]);
  assert('W44 (ends Mon Nov 2 00:00 EST): provisional at Nov 12 04:59Z, settled at 05:00Z', [s(2026, 44, '2026-11-12T04:59:59Z'), s(2026, 44, '2026-11-12T05:00:00Z')], [false, true]);
}

console.log('local midnight across DST');
{
  assert('Mar 8 2026 (spring-forward day) starts 05:00Z; Mar 9 at 04:00Z', [zonedMidnight(2026, 3, 8).toISOString(), zonedMidnight(2026, 3, 9).toISOString()], ['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z']);
  assert('Nov 1 2026 (fall-back day) starts 04:00Z; Nov 2 at 05:00Z', [zonedMidnight(2026, 11, 1).toISOString(), zonedMidnight(2026, 11, 2).toISOString()], ['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
