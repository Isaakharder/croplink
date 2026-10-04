/**
 * ISO week arithmetic: 52- vs 53-week years, W52 → W53 → next-year W1.
 *
 * Run with: npx tsx src/__tests__/iso-week.test.ts
 */
import { weeksInIsoYear, isValidIsoWeek, addIsoWeeks, isoWeekIndex, isoWeekOfDate, isoWeekMonday, fromIsoWeekIndex } from '../lib/isoWeek';

let pass = 0;
let fail = 0;
function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); fail++; }
}

console.log('weeksInIsoYear');
assert('2026 has 53 weeks', weeksInIsoYear(2026), 53);
assert('2020 has 53 weeks', weeksInIsoYear(2020), 53);
assert('2025 has 52 weeks', weeksInIsoYear(2025), 52);
assert('2027 has 52 weeks', weeksInIsoYear(2027), 52);

console.log('isValidIsoWeek');
assert('2026-W53 is valid', isValidIsoWeek(2026, 53), true);
assert('2025-W53 is rejected (52-week year)', isValidIsoWeek(2025, 53), false);
assert('2027-W53 is rejected (52-week year)', isValidIsoWeek(2027, 53), false);
assert('W0 is rejected', isValidIsoWeek(2026, 0), false);
assert('W54 is rejected', isValidIsoWeek(2026, 54), false);
assert('non-integer week is rejected', isValidIsoWeek(2026, 12.5), false);
assert('string week is rejected', isValidIsoWeek(2026, '12'), false);

console.log('rollover');
assert('2026-W52 + 1 → 2026-W53', addIsoWeeks(2026, 52, 1), { year: 2026, week: 53 });
assert('2026-W53 + 1 → 2027-W1', addIsoWeeks(2026, 53, 1), { year: 2027, week: 1 });
assert('2025-W52 + 1 → 2026-W1 (no W53 in 2025)', addIsoWeeks(2025, 52, 1), { year: 2026, week: 1 });
assert('2026-W50 + 6 → 2027-W3', addIsoWeeks(2026, 50, 6), { year: 2027, week: 3 });
assert('2027-W1 - 1 → 2026-W53', addIsoWeeks(2027, 1, -1), { year: 2026, week: 53 });
assert('index distance 2026-W52 → 2027-W1 is 2 weeks', isoWeekIndex(2027, 1) - isoWeekIndex(2026, 52), 2);
assert('index distance 2025-W52 → 2026-W1 is 1 week', isoWeekIndex(2026, 1) - isoWeekIndex(2025, 52), 1);
assert('index round-trips', fromIsoWeekIndex(isoWeekIndex(2026, 53)), { year: 2026, week: 53 });

console.log('dates');
assert('2026-W53 starts Mon 2026-12-28', isoWeekMonday(2026, 53).toISOString().slice(0, 10), '2026-12-28');
assert('2027-01-03 is still 2026-W53', isoWeekOfDate(new Date('2027-01-03T12:00:00Z')), { year: 2026, week: 53 });
assert('2027-01-04 is 2027-W1', isoWeekOfDate(new Date('2027-01-04T12:00:00Z')), { year: 2027, week: 1 });
assert('2024-12-30 is 2025-W1 (ISO year ≠ calendar year)', isoWeekOfDate(new Date('2024-12-30T12:00:00Z')), { year: 2025, week: 1 });
assert('2026-10-04 is 2026-W40', isoWeekOfDate(new Date('2026-10-04T12:00:00Z')), { year: 2026, week: 40 });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
