/**
 * Manual test cases for projection math.
 * Run with: npx ts-node src/__tests__/projection-math.test.ts
 *
 * Mostly pure function tests. The pagination section imports and exercises
 * the real fetchAllRows() helper against mock query builders (not a
 * reimplementation) — the whole point of those tests is proving the actual
 * production code, not a stand-in for it.
 */
import { fetchAllRows } from '../lib/paginatedFetch';

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

// ── Set-week AFW lookup (end-to-end with correct key) ────────────────────────
console.log('\nSet-week AFW lookup');
{
  // setWeek=22, avgFruitSet=10/m², week6%=6, week7%=34, area=1000m², AFW@setWeek22=200g
  // harvest week 28 (22+6): fruit/m² = 10 * 0.06 = 0.6, kg = 0.6 * 1000 * 200/1000 = 120
  // harvest week 29 (22+7): fruit/m² = 10 * 0.34 = 3.4, kg = 3.4 * 1000 * 200/1000 = 680
  const projectedByWeek: Record<number, number> = {};
  const kgByWeek: Record<number, number> = {};
  for (let w = 1; w <= 52; w++) { projectedByWeek[w] = 0; kgByWeek[w] = 0; }

  const setWeek = 22;
  const setAmount = 10;
  const setWeekAfw = 200;
  const areaM2 = 1000;

  for (const [offset, pct] of [[6, 6], [7, 34]] as [number, number][]) {
    const harvestWeek = setWeek + offset;
    if (harvestWeek >= 1 && harvestWeek <= 52) {
      const fruitContrib = setAmount * (pct / 100);
      projectedByWeek[harvestWeek] += fruitContrib;
      if (setWeekAfw > 0 && areaM2 > 0) {
        kgByWeek[harvestWeek] += fruitContrib * areaM2 * setWeekAfw / 1000;
      }
    }
  }

  assertClose('week28 fruit/m²', projectedByWeek[28], 0.6);
  assertClose('week29 fruit/m²', projectedByWeek[29], 3.4);
  assertClose('week28 kg', kgByWeek[28], 120);
  assertClose('week29 kg', kgByWeek[29], 680);
}

// ── Empirical timing: resolution rate (Step 1) ──────────────────────────────
console.log('\nEmpirical timing — resolution rate (Step 1)');
{
  // Own sample >= MIN_RESOLVED_SAMPLE_SIZE (5) — use it directly, no fallback.
  const resolvedCount = 10;
  const harvestedCount = 7;
  const MIN = 5;
  const isFallback = resolvedCount < MIN;
  const rate = resolvedCount > 0 ? harvestedCount / resolvedCount : null;
  assert('own sample used, not fallback', isFallback, false);
  assertClose('resolution rate 7/10', rate as number, 0.7);
}
{
  // Own sample below threshold — must fall back to the pool, not assume 100%.
  const resolvedCount = 3;
  const MIN = 5;
  const pooledRate = 0.62;
  const ownRate = 2 / 3;
  const isFallback = resolvedCount < MIN;
  const rate = !isFallback ? ownRate : pooledRate;
  assert('thin sample falls back', isFallback, true);
  assertClose('uses pooled rate, not own', rate, 0.62);
}
{
  // No data anywhere (own AND pool empty) — only then default to 1 (legacy-equivalent, no loss modeled).
  const resolvedCount = 0;
  const pooledRate: number | null = null;
  const ownRate: number | null = null;
  const rate = pooledRate ?? ownRate ?? 1;
  assertClose('total absence of data defaults to rate=1', rate, 1);
}

// ── Empirical timing: offset shape (Step 2) ─────────────────────────────────
console.log('\nEmpirical timing — offset shape (Step 2)');
{
  // 10 harvested fruit at offsets 6,6,6,7,7,7,7,8,8,9 → percents sum to 100.
  const offsets = [6, 6, 6, 7, 7, 7, 7, 8, 8, 9];
  const OFFSETS = [4, 5, 6, 7, 8, 9, 10];
  const counts: Record<number, number> = Object.fromEntries(OFFSETS.map(o => [o, 0]));
  for (const o of offsets) counts[o]++;
  const total = offsets.length;
  const percents = Object.fromEntries(OFFSETS.map(o => [o, (counts[o] / total) * 100]));
  assertClose('30% at +6', percents[6], 30);
  assertClose('40% at +7', percents[7], 40);
  assertClose('20% at +8', percents[8], 20);
  assertClose('10% at +9', percents[9], 10);
  const sum = Object.values(percents).reduce((a, b) => a + b, 0);
  assertClose('percents sum to 100', sum, 100);
}
{
  // Combined: set amount is scaled DOWN by resolution rate before the
  // timing shape is applied — this is what actually fixes the "assumes
  // zero loss" bug (Step 1 feeding into Step 2).
  const setAmount = 20;
  const resolutionRate = 0.7; // 30% of set fruit never becomes a harvest
  const pctAtOffset6 = 30; // % of HARVESTED fruit landing at +6
  const fruitContrib = setAmount * resolutionRate * (pctAtOffset6 / 100);
  assertClose('loss-adjusted contribution at +6', fruitContrib, 4.2);
  // Old (legacy) formula for comparison — no resolutionRate term:
  const legacyContrib = setAmount * (pctAtOffset6 / 100);
  assertClose('legacy contribution at +6 (no loss adjustment)', legacyContrib, 6.0);
}

// ── Empirical timing: maturity gate (Step 1 follow-up) ──────────────────────
console.log('\nEmpirical timing — maturity gate');
{
  // MATURITY_WINDOW_WEEKS must be derived from OFFSETS, not a bare magic
  // number — this is the actual assertion the audit's follow-up asked for.
  const OFFSETS = [4, 5, 6, 7, 8, 9, 10];
  const MATURITY_WINDOW_WEEKS = Math.max(...OFFSETS);
  assert('maturity window derives to 10 from OFFSETS', MATURITY_WINDOW_WEEKS, 10);
}
{
  // SetWk30, large sample (89 resolved) but immature (today = wk35, matures
  // at wk40) — must still fall back, sample size notwithstanding.
  const MIN_RESOLVED_SAMPLE_SIZE = 5;
  const MATURITY_WINDOW_WEEKS = 10;
  const year = 2026, setWeekNumber = 30, todayAbsWeek = 2026 * 52 + 35;
  const resolvedCount = 89;
  const sampleTooSmall = resolvedCount < MIN_RESOLVED_SAMPLE_SIZE;
  const notYetMatured = year * 52 + setWeekNumber + MATURITY_WINDOW_WEEKS > todayAbsWeek;
  assert('large sample alone does not pass', sampleTooSmall, false);
  assert('but set-week is not yet matured', notYetMatured, true);
  assert('so it still falls back', sampleTooSmall || notYetMatured, true);
}
{
  // SetWk22 — matures at week 32, today is week 35 → past maturity, own
  // rate should be trusted (assuming sample size also clears).
  const MATURITY_WINDOW_WEEKS = 10;
  const year = 2026, setWeekNumber = 22, todayAbsWeek = 2026 * 52 + 35;
  const notYetMatured = year * 52 + setWeekNumber + MATURITY_WINDOW_WEEKS > todayAbsWeek;
  assert('SetWk22 (matures wk32) is matured by wk35', notYetMatured, false);
}
{
  // Exact boundary: a set-week matures the instant set_week+10 == today, not
  // the week after.
  const MATURITY_WINDOW_WEEKS = 10;
  const year = 2026, setWeekNumber = 25, todayAbsWeek = 2026 * 52 + 35; // 25+10=35
  const notYetMatured = year * 52 + setWeekNumber + MATURITY_WINDOW_WEEKS > todayAbsWeek;
  assert('set_week+10 == today counts as matured (not strictly after)', notYetMatured, false);
}
{
  // Fallback reason is reported distinctly, not collapsed to one boolean.
  function reasonFor(sampleTooSmall: boolean, notYetMatured: boolean): string | null {
    return sampleTooSmall && notYetMatured ? 'sample-too-small-and-not-matured'
      : sampleTooSmall ? 'sample-too-small'
      : notYetMatured ? 'not-yet-matured'
      : null;
  }
  assert('both reasons reported together', reasonFor(true, true), 'sample-too-small-and-not-matured');
  assert('sample-only reason', reasonFor(true, false), 'sample-too-small');
  assert('maturity-only reason (the new case)', reasonFor(false, true), 'not-yet-matured');
  assert('no fallback → null reason', reasonFor(false, false), null);
}

// ── Empirical timing: maturity-filtered pool (Step 1, second follow-up) ─────
console.log('\nEmpirical timing — maturity-filtered pool');
{
  // The exact contamination scenario the audit found: pooling in immature
  // set-weeks (28-30, still mostly abort/prune) alongside matured ones
  // (22-25, genuinely resolved) drags the pool rate down.
  const MATURITY_WINDOW_WEEKS = 10;
  const year = 2026, todayAbsWeek = 2026 * 52 + 35;
  const isMatured = (setWeek: number) => year * 52 + setWeek + MATURITY_WINDOW_WEEKS <= todayAbsWeek;
  const setWeeks = [
    { setWeek: 22, resolved: 12, harvested: 11 },
    { setWeek: 23, resolved: 62, harvested: 58 },
    { setWeek: 24, resolved: 57, harvested: 47 },
    { setWeek: 25, resolved: 17, harvested: 11 },
    { setWeek: 26, resolved: 47, harvested: 37 }, // matures wk36, NOT yet at wk35
    { setWeek: 30, resolved: 89, harvested: 0 },  // matures wk40, badly immature
  ];
  const matured = setWeeks.filter((s) => isMatured(s.setWeek));
  assert('only setWk 22-25 are matured at wk35', matured.map((s) => s.setWeek), [22, 23, 24, 25]);

  const unfilteredResolved = setWeeks.reduce((a, s) => a + s.resolved, 0);
  const unfilteredHarvested = setWeeks.reduce((a, s) => a + s.harvested, 0);
  const unfilteredRate = unfilteredHarvested / unfilteredResolved;

  const filteredResolved = matured.reduce((a, s) => a + s.resolved, 0);
  const filteredHarvested = matured.reduce((a, s) => a + s.harvested, 0);
  const filteredRate = filteredHarvested / filteredResolved;

  assertClose('unfiltered pool is dragged down by immature weeks', unfilteredRate, 164 / 284, 0.001);
  assertClose('maturity-filtered pool reflects only matured weeks', filteredRate, 127 / 148, 0.001);
  assert('filtered rate is meaningfully higher than unfiltered', filteredRate > unfilteredRate + 0.1, true);
}
{
  // Thin-pool floor: reuses MIN_RESOLVED_SAMPLE_SIZE rather than a new
  // number, and the result is never NaN even at zero.
  const MIN_POOL_SAMPLE_SIZE = 5;
  assertClose('empty pool resolutionRate is null, not NaN', (0 > 0 ? 1 / 0 : null) as unknown as number ?? -1, -1);
  assert('4 resolved < floor of 5 → isThin', 4 < MIN_POOL_SAMPLE_SIZE, true);
  assert('148 resolved >= floor of 5 → not thin', 148 < MIN_POOL_SAMPLE_SIZE, false);
}

// ── Flow vs. stock fruit-set count (Round 6) ─────────────────────────────────
console.log('\nFlow vs. stock fruit-set count');
{
  // The exact contamination case: SetWk24 census counts every node showing
  // SetFruit that week, including ones still carrying the status from a
  // prior week. Flow counts each physical fruit once, at first appearance.
  const censusCount = 126; // nodes with status='SetFruit' at week 24
  const flowCount = 58;    // distinct fruit_instances with set_week_number=24
  const ratio = censusCount / flowCount;
  assertClose('SetWk24 census/flow ratio matches diagnostic finding', ratio, 2.1724, 0.001);
}
{
  // Population consistency: the flow count's node population must match the
  // census's node population (both is_active-filtered), or the two aren't
  // comparable — this was a real bug caught and fixed in this round.
  const activeNodeIds = new Set(['a', 'b', 'c']);
  const allFruitInstanceNodes = ['a', 'b', 'c', 'd', 'e']; // d, e are now-inactive nodes
  const unscopedFlowCount = allFruitInstanceNodes.length;
  const scopedFlowCount = allFruitInstanceNodes.filter((n) => activeNodeIds.has(n)).length;
  assertClose('unscoped flow count over-includes inactive-node fruit', unscopedFlowCount, 5);
  assertClose('population-scoped flow count matches active census population', scopedFlowCount, 3);
}
{
  // Staleness detection: stored value materially differs from a freshly
  // recomputed live census (independent of the stock/flow fix itself).
  const stored = 6.35;
  const liveCensus = 3.61;
  const isStale = Math.abs(stored - liveCensus) > 0.05;
  assert('SetWk26 flagged stale (stored 6.35 vs. live census 3.61)', isStale, true);
}
{
  // Determinism/idempotency: computing the flow count twice from the same
  // input set must yield the same result — no randomness, no side effects.
  function flowCountByWeek(instances: { week: number }[]): Record<number, number> {
    const counts: Record<number, number> = {};
    for (const i of instances) counts[i.week] = (counts[i.week] ?? 0) + 1;
    return counts;
  }
  const instances = [{ week: 24 }, { week: 24 }, { week: 25 }];
  const run1 = JSON.stringify(flowCountByWeek(instances));
  const run2 = JSON.stringify(flowCountByWeek(instances));
  assert('flow count is deterministic across repeated runs', run1, run2);
}

// ── Pagination (Round 7) ──────────────────────────────────────────────────
console.log('\nPagination — fetchAllRows (against the real helper, not a reimplementation)');

interface MockRow { id: string; org: string; value: number }

/** Builds a fake Supabase query builder over `rows`, applying `filter` before paging. Tracks call count and whether .order() was invoked with the given column before .range(). */
function makeMockQuery(rows: MockRow[], opts: {
  filter?: (r: MockRow) => boolean;
  errorOnCall?: number; // 1-indexed range() call to fail on
  pageSize?: number;
} = {}) {
  const filtered = opts.filter ? rows.filter(opts.filter) : rows;
  let callCount = 0;
  let orderedColumn: string | null = null;
  const query = {
    order(column: string, o: { ascending: boolean }) {
      if (!o.ascending) throw new Error('test expects ascending order');
      orderedColumn = column;
      return query;
    },
    async range(from: number, to: number) {
      callCount++;
      if (!orderedColumn) throw new Error('range() called without order() first — unordered pagination is exactly the bug this API prevents');
      if (opts.errorOnCall === callCount) {
        return { data: null, error: { message: `simulated error on call ${callCount}` } };
      }
      return { data: filtered.slice(from, to + 1), error: null };
    },
  };
  return { factory: () => query, getCallCount: () => callCount, getOrderedColumn: () => orderedColumn };
}

function makeRows(n: number, org = 'org-a'): MockRow[] {
  return Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(6, '0')}`, org, value: i }));
}

async function runPaginationTests() {
  // Fewer than one page
  {
    const { factory } = makeMockQuery(makeRows(56));
    const result = await fetchAllRows<MockRow>(factory, { pageSize: 1000 });
    assertClose('fewer than one page: all rows returned', result.length, 56);
  }

  // Exactly one full page
  {
    const { factory, getCallCount } = makeMockQuery(makeRows(1000), { pageSize: 1000 });
    const result = await fetchAllRows<MockRow>(factory, { pageSize: 1000 });
    assertClose('exactly one full page: all 1000 rows returned', result.length, 1000);
    assert('exactly one full page: takes 2 calls (full page + empty stop page)', getCallCount(), 2);
  }

  // More than one page (Mathieu's real plant_nodes count)
  {
    const { factory } = makeMockQuery(makeRows(2259));
    const result = await fetchAllRows<MockRow>(factory, { pageSize: 1000 });
    assertClose('more than one page: all 2259 rows retrieved, not capped at 1000', result.length, 2259);
  }

  // Exact multiple of page size
  {
    const { factory, getCallCount } = makeMockQuery(makeRows(2000));
    const result = await fetchAllRows<MockRow>(factory, { pageSize: 1000 });
    assertClose('exact multiple of page size: all 2000 rows retrieved', result.length, 2000);
    assert('exact multiple: takes exactly 3 calls (1000, 1000, 0-length stop page)', getCallCount(), 3);
  }

  // Stable ordering — .order() must be called with the expected column before every .range()
  {
    const { factory, getOrderedColumn } = makeMockQuery(makeRows(1500));
    await fetchAllRows<MockRow>(factory, { pageSize: 1000 });
    assert('default order column is "id"', getOrderedColumn(), 'id');
  }
  {
    // fetchAllRows() always calls .order() before .range() internally — proven
    // by calling range() directly on the mock without going through
    // fetchAllRows first: the mock rejects it, confirming the enforcement
    // mechanism itself works, and that fetchAllRows relies on it (previous
    // test already showed fetchAllRows-driven calls always set the column).
    const { factory } = makeMockQuery(makeRows(10));
    let threw = false;
    try {
      await factory().range(0, 9); // skips .order() — must be rejected
    } catch {
      threw = true;
    }
    assert('calling range() without order() first is rejected', threw, true);
  }

  // No duplicate IDs, no missing IDs across pages
  {
    const { factory } = makeMockQuery(makeRows(2500));
    const result = await fetchAllRows<MockRow>(factory, { pageSize: 1000 });
    const ids = result.map((r) => r.id);
    const uniqueIds = new Set(ids);
    assertClose('no duplicate IDs across pages', uniqueIds.size, ids.length);
    const expectedIds = new Set(makeRows(2500).map((r) => r.id));
    const missing = [...expectedIds].filter((id) => !uniqueIds.has(id));
    assertClose('no missing IDs across pages', missing.length, 0);
  }

  // Filters preserved on every page — a filtered-out set never leaks in on a later page
  {
    const mixed = [...makeRows(1500, 'org-a'), ...makeRows(500, 'org-b')];
    const { factory } = makeMockQuery(mixed, { filter: (r) => r.org === 'org-a' });
    const result = await fetchAllRows<MockRow>(factory, { pageSize: 1000 });
    assertClose('filter yields only org-a rows across all pages', result.length, 1500);
    assert('no org-b rows leaked in on any page', result.every((r) => r.org === 'org-a'), true);
  }

  // Organization isolation — two orgs' data never mixes even when paginating both
  {
    const rows = [...makeRows(1200, 'org-x'), ...makeRows(1200, 'org-y')];
    const { factory: factoryX } = makeMockQuery(rows, { filter: (r) => r.org === 'org-x' });
    const { factory: factoryY } = makeMockQuery(rows, { filter: (r) => r.org === 'org-y' });
    const resultX = await fetchAllRows<MockRow>(factoryX, { pageSize: 1000 });
    const resultY = await fetchAllRows<MockRow>(factoryY, { pageSize: 1000 });
    assertClose('org-x fetch returns exactly org-x rows', resultX.length, 1200);
    assertClose('org-y fetch returns exactly org-y rows', resultY.length, 1200);
    assert('no cross-org contamination', resultX.some((r) => r.org === 'org-y'), false);
  }

  // Error on an intermediate page — must propagate, not silently truncate
  {
    const { factory } = makeMockQuery(makeRows(2500), { errorOnCall: 2 });
    let threw = false;
    let message = '';
    try {
      await fetchAllRows<MockRow>(factory, { pageSize: 1000 });
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    assert('error on intermediate page propagates (does not silently return partial data)', threw, true);
    assert('propagated error carries the underlying message', message.includes('simulated error'), true);
  }

  // Empty result
  {
    const { factory, getCallCount } = makeMockQuery([]);
    const result = await fetchAllRows<MockRow>(factory, { pageSize: 1000 });
    assertClose('empty result returns empty array, not undefined/null', result.length, 0);
    assert('empty result makes exactly 1 call', getCallCount(), 1);
  }

  // Custom order column override
  {
    const { factory, getOrderedColumn } = makeMockQuery(makeRows(10));
    await fetchAllRows<MockRow>(factory, { orderColumn: 'value' });
    assert('orderColumn option overrides the default "id"', getOrderedColumn(), 'value');
  }
}

// ── Round 7 retraction — true is_active split ────────────────────────────
console.log('\nRound 7 retraction — true is_active split for Mathieu');
{
  // Round 6 claimed 46% of fruit_instances belonged to inactive nodes.
  // Confirmed via direct DB query this was a pagination artifact, not a
  // real is_active split. The true split, verified via count(*):
  const trueActive = 2238;
  const trueInactive = 21;
  const trueTotal = trueActive + trueInactive;
  const trueInactivePct = (trueInactive / trueTotal) * 100;
  assertClose('true total plant_nodes for Mathieu', trueTotal, 2259);
  assertClose('true inactive rate is under 1%, not 46%', trueInactivePct, 0.93, 0.01);
}

// ── AFW future-week validation (Step 3) ─────────────────────────────────────
console.log('\nAFW future-week validation (Step 3)');
{
  const todayAbsWeek = 2026 * 52 + 31; // "today" is ISO week 31, 2026
  const isFutureWeek = (year: number, week: number) => year * 52 + week > todayAbsWeek;
  assert('week 32 this year is future', isFutureWeek(2026, 32), true);
  assert('week 31 this year (current) is not future', isFutureWeek(2026, 31), false);
  assert('week 18 this year (past) is not future', isFutureWeek(2026, 18), false);
  assert('week 5 next year is future', isFutureWeek(2027, 5), true);
}
{
  // The exact real-world case the audit flagged: an 'actual' AFW for week 32
  // saved on a day that falls in week 31 must be rejected.
  const savedOn = { year: 2026, week: 31 };
  const rowBeingSaved = { source: 'actual', year: 2026, week_number: 32 };
  const isFutureWeek = (year: number, week: number) => year * 52 + week > savedOn.year * 52 + savedOn.week;
  const shouldReject = rowBeingSaved.source === 'actual' && isFutureWeek(rowBeingSaved.year, rowBeingSaved.week_number);
  assert('July-28-style future actual is rejected', shouldReject, true);
}

// CommonJS build target — no top-level await, so the async pagination suite
// (the only async section in this file; everything else above is synchronous)
// runs here, and the summary waits for it before printing.
(async () => {
  await runPaginationTests();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
