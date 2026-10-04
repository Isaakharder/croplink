/**
 * Crop pull-out truncation (lib/cropWindow.ts).
 *
 * Run with: npx tsx src/__tests__/crop-window.test.ts
 */
import { harvestWindowFraction } from '../lib/cropWindow';
import { isoWeekIndex } from '../lib/isoWeek';

let pass = 0;
let fail = 0;
function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); fail++; }
}

console.log('harvestWindowFraction');
assert('2026-W52 fully before a Dec 31 pull-out', harvestWindowFraction(isoWeekIndex(2026, 52), '2026-12-31'), 1);
assert('2026-W53 (Mon Dec 28–Sun Jan 3) keeps Mon–Thu = 4/7', harvestWindowFraction(isoWeekIndex(2026, 53), '2026-12-31'), 4 / 7);
assert('2027-W1 is after the pull-out', harvestWindowFraction(isoWeekIndex(2027, 1), '2026-12-31'), 0);
assert('pull-out on a Monday keeps 1/7 of that week', harvestWindowFraction(isoWeekIndex(2026, 49), '2026-11-30'), 1 / 7);
assert('pull-out on a Sunday keeps the whole week', harvestWindowFraction(isoWeekIndex(2026, 49), '2026-12-06'), 1);
assert('no pull-out date → no truncation', harvestWindowFraction(isoWeekIndex(2027, 1), null), 1);
assert('unparseable date → no truncation (never silently zero)', harvestWindowFraction(isoWeekIndex(2027, 1), 'December'), 1);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
