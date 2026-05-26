/**
 * Manual test cases for projection math.
 * Run with: npx ts-node src/__tests__/projection-math.test.ts
 *
 * No external dependencies — pure function tests.
 */

let pass = 0;
let fail = 0;

function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    console.error(`      actual:   ${JSON.stringify(actual)}`);
    fail++;
  }
}

function assertClose(label: string, actual: number, expected: number, tol = 0.0001): void {
  const ok = Math.abs(actual - expected) < tol;
  if (ok) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.error(`  ✗ ${label} — expected ~${expected}, got ${actual}`);
    fail++;
  }
}

// ── Fruit set / m² formula ────────────────────────────────────────────────────
console.log('\nFruit Set / m²');
{
  const setFruitCount = 10;
  const measuredStemCount = 5;
  const totalStems = 100;
  const areaM2 = 50;
  // (10/5) * 100/50 = 2 * 2 = 4
  const result = (setFruitCount / measuredStemCount) * totalStems / areaM2;
  assertClose('basic formula', result, 4.0);
}
{
  // divide-by-zero guard
  const result = (10 / 0) * 100 / 50;
  assert('divide by zero produces Infinity (code guards before this)', isFinite(result), false);
}
{
  // zero area_m2 — code guards: measuredStemCount > 0 && totalStems > 0 && areaM2 > 0
  const calc = (sc: number, msc: number, ts: number, am: number) =>
    msc > 0 && ts > 0 && am > 0 ? (sc / msc) * ts / am : 0;
  assertClose('zero areaM2 → 0', calc(10, 5, 100, 0), 0);
  assertClose('zero totalStems → 0', calc(10, 5, 0, 50), 0);
  assertClose('zero measuredStemCount → 0', calc(10, 0, 100, 50), 0);
}

// ── Base projection math ──────────────────────────────────────────────────────
console.log('\nBase projection (fruit/m² accumulation)');
{
  // setWeek=10, 100% at +6 → harvestWeek=16
  const projectedByWeek: Record<number, number> = {};
  for (let w = 1; w <= 52; w++) projectedByWeek[w] = 0;
  const setWeek = 10;
  const setAmount = 2.0;
  const pct = 100;
  const offset = 6;
  const harvestWeek = setWeek + offset;
  projectedByWeek[harvestWeek] += setAmount * (pct / 100);
  assertClose('single profile 100% at +6', projectedByWeek[16], 2.0);
  assertClose('no leakage to other weeks', projectedByWeek[15] + projectedByWeek[17], 0);
}
{
  // Week > 52 is silently dropped (no crash)
  const projectedByWeek: Record<number, number> = {};
  for (let w = 1; w <= 52; w++) projectedByWeek[w] = 0;
  const harvestWeek = 50 + 6; // = 56
  if (harvestWeek >= 1 && harvestWeek <= 52) {
    projectedByWeek[harvestWeek] += 1;
  }
  assertClose('week 56 dropped, total stays 0', Object.values(projectedByWeek).reduce((a, b) => a + b, 0), 0);
}
{
  // Split profile: 50% at +5, 50% at +6 from setWeek=10
  const projectedByWeek: Record<number, number> = {};
  for (let w = 1; w <= 52; w++) projectedByWeek[w] = 0;
  const setAmount = 4.0;
  for (const [offset, pct] of [[5, 50], [6, 50]]) {
    const hw = 10 + offset;
    projectedByWeek[hw] += setAmount * (pct / 100);
  }
  assertClose('50/50 split week 15', projectedByWeek[15], 2.0);
  assertClose('50/50 split week 16', projectedByWeek[16], 2.0);
}

// ── KG projection formula ─────────────────────────────────────────────────────
console.log('\nKG projection');
{
  const fruitPerM2 = 4.0;
  const areaM2 = 100;
  const weightGrams = 200;
  const kg = fruitPerM2 * areaM2 * weightGrams / 1000;
  assertClose('basic kg formula', kg, 80.0);
}
{
  // Missing AFW → 0, no bad math
  const fruitPerM2 = 4.0;
  const areaM2 = 100;
  const weightGrams = 0;
  const kg = fruitPerM2 > 0 && areaM2 > 0 && weightGrams > 0
    ? fruitPerM2 * areaM2 * weightGrams / 1000
    : 0;
  assertClose('missing AFW → 0 kg', kg, 0);
}

// ── Ripening actuals offset ───────────────────────────────────────────────────
console.log('\nRipening actuals offset');
{
  // Same year: set wk 10 harvested wk 16 → offset 6
  const setYear = 2025;
  const setWeek = 10;
  const harvYear = 2025;
  const harvWeek = 16;
  const offset = (harvYear - setYear) * 52 + harvWeek - setWeek;
  assert('same-year offset', offset, 6);
}
{
  // Year crossover: set wk 50 harvested wk 4 next year → offset 6
  const setYear = 2025;
  const setWeek = 50;
  const harvYear = 2026;
  const harvWeek = 4;
  const offset = (harvYear - setYear) * 52 + harvWeek - setWeek;
  assert('year-crossover offset', offset, 6);
}
{
  // Offset outside 4–10 is filtered
  const offsets = [3, 4, 7, 10, 11];
  const kept = offsets.filter(o => o >= 4 && o <= 10);
  assert('offsets 4–10 only', kept, [4, 7, 10]);
}

// ── Breaker learning formula ──────────────────────────────────────────────────
console.log('\nBreaker learning');
{
  const breakerCount = 8;
  const measuredStemCount = 20;
  const totalStemCount = 200;
  const areaM2 = 100;
  const bfPerM2 = (breakerCount / measuredStemCount) * totalStemCount / areaM2;
  assertClose('breakerFruitPerM2', bfPerM2, 0.8);

  const afwG = 200;
  const kgEstimate = bfPerM2 * areaM2 * afwG / 1000;
  assertClose('nextWeekKgEstimate', kgEstimate, 16.0);
}
{
  // nextWeek year wraparound fix: queryWeek=52 → nextWeek=1, nextWeekYear=yearNum+1
  const yearNum = 2025;
  const queryWeek = 52;
  const nextWeekWraps = queryWeek === 52;
  const nextWeek = nextWeekWraps ? 1 : queryWeek + 1;
  const nextWeekYear = nextWeekWraps ? yearNum + 1 : yearNum;
  assert('nextWeek wraps to 1', nextWeek, 1);
  assert('nextWeekYear increments to 2026', nextWeekYear, 2026);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
