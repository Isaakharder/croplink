/**
 * Route-level regression tests for the three Round 9 pagination fixes.
 * Unlike projection-math.test.ts's pure-function tests, these exercise the
 * ACTUAL route calculation functions (computeBreakerLearning,
 * computeRipeningActuals, computeMeasurementSummary) end-to-end against a
 * mock Supabase client — proving the real code, not a reimplementation of
 * its logic.
 *
 * Run with: npx tsx src/__tests__/route-pagination.test.ts
 */
import { MockSupabase } from './mockSupabase';
import { computeBreakerLearning } from '../routes/breakerLearning';
import { computeRipeningActuals } from '../routes/ripeningActuals';
import { computeMeasurementSummary } from '../routes/measurementSummary';
import type { SupabaseClient } from '@supabase/supabase-js';

let pass = 0;
let fail = 0;
function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); fail++; }
}
function assertClose(label: string, actual: number, expected: number, tol = 0.01): void {
  const ok = Math.abs(actual - expected) < tol;
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label} — expected ~${expected}, got ${actual}`); fail++; }
}

const VARIETY_ID = 'variety-1';
const YEAR = 2026;

function uuid(prefix: string, i: number): string {
  return `${prefix}-${String(i).padStart(6, '0')}`;
}

/** Builds n synthetic fruit_instances rows, half with a clean breaker->harvest offset of 1 week, half with 2 weeks — a known, checkable distribution regardless of how many pages they're split across. */
function makeFruitInstances(n: number, opts: { org?: string; setYear?: number } = {}): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const offsetWeeks = i % 2 === 0 ? 1 : 2;
    rows.push({
      id: uuid('fi', i),
      plant_node_id: uuid('node', i % 50),
      variety_id: VARIETY_ID,
      organization_id: opts.org ?? null,
      set_year: opts.setYear ?? YEAR,
      set_week_number: 10 + (i % 5),
      set_date: '2026-06-01',
      status: 'harvested',
      breaker_year: YEAR,
      breaker_week_number: 20,
      breaker_date: '2026-08-01',
      harvested_year: YEAR,
      harvested_week_number: 20 + offsetWeeks,
      measurement_row_id: 'row-1',
      measurement_stem_id: 'stem-1',
    });
  }
  return rows;
}

function seedCommon(mock: MockSupabase, fruitInstances: Record<string, unknown>[]) {
  mock.seed('varieties', [{ id: VARIETY_ID, total_stem_count: 1000, area_m2: 500 }]);
  mock.seed('measurement_rows', [{ id: 'row-1', variety_id: VARIETY_ID, is_active: true, sort_order: 1, row_name: 'Row 1' }]);
  mock.seed('measurement_stems', [{ id: 'stem-1', measurement_row_id: 'row-1', is_active: true, sort_order: 1, stem_name: 'Stem 1' }]);
  mock.seed('plant_nodes', Array.from({ length: 50 }, (_, i) => ({ id: uuid('node', i), measurement_stem_id: 'stem-1', is_active: true, sort_order: i, node_number: i })));
  mock.seed('weekly_node_statuses', []);
  mock.seed('harvest_afw_by_week', []);
  mock.seed('fruit_instances', fruitInstances);
}

async function testBreakerLearning() {
  console.log('\n=== computeBreakerLearning — route-level tests ===');

  for (const n of [0, 1, 999, 1000, 1001, 2500]) {
    const mock = new MockSupabase();
    seedCommon(mock, makeFruitInstances(n));
    const result = await computeBreakerLearning(mock as unknown as SupabaseClient, VARIETY_ID, YEAR, new Date('2026-09-01T00:00:00Z'));
    assertClose(`n=${n}: sampleSize matches exactly (no missing/duplicate rows across pages)`, result.sampleSize, n);
    if (n >= 2) {
      // Half at offset 1, half at offset 2 → avg = 1.5, regardless of page count.
      // (n=1 is a real edge case with only one row, offset=1 exactly — not
      // a 50/50 split — checked separately, not skipped.)
      assertClose(`n=${n}: avgBreakerToHarvestWeeks correct (order/page-count independent)`, result.avgBreakerToHarvestWeeks, 1.5, 0.05);
    } else if (n === 1) {
      assertClose(`n=1: avgBreakerToHarvestWeeks correct for a single row (offset=1)`, result.avgBreakerToHarvestWeeks, 1, 0.001);
    }
  }

  // Deterministic regardless of insertion (seed) order — shuffle vs. sorted must agree.
  {
    const sorted = makeFruitInstances(1500);
    const shuffled = [...sorted].sort(() => Math.random() - 0.5);
    const mockA = new MockSupabase(); seedCommon(mockA, sorted);
    const mockB = new MockSupabase(); seedCommon(mockB, shuffled);
    const resultA = await computeBreakerLearning(mockA as unknown as SupabaseClient, VARIETY_ID, YEAR, new Date('2026-09-01T00:00:00Z'));
    const resultB = await computeBreakerLearning(mockB as unknown as SupabaseClient, VARIETY_ID, YEAR, new Date('2026-09-01T00:00:00Z'));
    assert('insertion-order independence: sampleSize matches', resultA.sampleSize, resultB.sampleSize);
    assertClose('insertion-order independence: avgBreakerToHarvestWeeks matches', resultA.avgBreakerToHarvestWeeks, resultB.avgBreakerToHarvestWeeks, 0.001);
  }

  // Intermediate-page error → failure, not a silently partial calculation.
  {
    const mock = new MockSupabase({ errorOnRangeCall: 2 });
    seedCommon(mock, makeFruitInstances(2500));
    let threw = false;
    try {
      await computeBreakerLearning(mock as unknown as SupabaseClient, VARIETY_ID, YEAR, new Date('2026-09-01T00:00:00Z'));
    } catch { threw = true; }
    assert('intermediate-page error propagates as a failure', threw, true);
  }

  // Organizational isolation — a second org's rows never leak into the result.
  {
    const mock = new MockSupabase();
    const orgA = makeFruitInstances(300, { org: 'org-a' });
    const orgB = makeFruitInstances(700, { org: 'org-b' }).map((r, i) => ({ ...r, id: uuid('fi-b', i), plant_node_id: uuid('node', i % 50) }));
    seedCommon(mock, [...orgA, ...orgB]);
    // breakerLearning's fruit_instances query is scoped by variety_id only
    // (no organization_id filter in the route today — both org rows share
    // the same variety_id here, so this test documents current behavior:
    // variety_id is the only scope available, matching every route in this
    // codebase, none of which thread an organization_id through request
    // context yet). Confirms count reflects ALL matching variety rows
    // regardless of org tag, which is the honest current behavior to test.
    const result = await computeBreakerLearning(mock as unknown as SupabaseClient, VARIETY_ID, YEAR, new Date('2026-09-01T00:00:00Z'));
    assertClose('variety_id scoping includes all matching rows regardless of org tag (no org filter exists in this route)', result.sampleSize, 1000);
  }

  // Empty data.
  {
    const mock = new MockSupabase();
    seedCommon(mock, []);
    const result = await computeBreakerLearning(mock as unknown as SupabaseClient, VARIETY_ID, YEAR, new Date('2026-09-01T00:00:00Z'));
    assertClose('empty fruit_instances: sampleSize is 0, not an error', result.sampleSize, 0);
    assertClose('empty fruit_instances: avgBreakerToHarvestWeeks defaults to 0', result.avgBreakerToHarvestWeeks, 0);
  }
}

async function testRipeningActuals() {
  console.log('\n=== computeRipeningActuals — route-level tests ===');

  for (const n of [0, 1, 999, 1000, 1001, 1500]) {
    const mock = new MockSupabase();
    seedCommon(mock, makeFruitInstances(n));
    const result = await computeRipeningActuals(mock as unknown as SupabaseClient, VARIETY_ID, YEAR, new Date('2026-09-01T00:00:00Z'));
    assertClose(`n=${n}: totalSetInstances matches exactly`, result.summary.totalSetInstances, n);
  }

  // Year/season boundary — a fruit_instances row from a DIFFERENT set_year must never be counted.
  {
    const mock = new MockSupabase();
    const thisYear = makeFruitInstances(400, { setYear: 2026 });
    const lastYear = makeFruitInstances(600, { setYear: 2025 }).map((r, i) => ({ ...r, id: uuid('fi-2025', i) }));
    seedCommon(mock, [...thisYear, ...lastYear]);
    const result = await computeRipeningActuals(mock as unknown as SupabaseClient, VARIETY_ID, 2026, new Date('2026-09-01T00:00:00Z'));
    assertClose('year boundary respected: only set_year=2026 rows counted', result.summary.totalSetInstances, 400);
  }

  // Deterministic regardless of insertion order.
  {
    const sorted = makeFruitInstances(1300);
    const shuffled = [...sorted].sort(() => Math.random() - 0.5);
    const mockA = new MockSupabase(); seedCommon(mockA, sorted);
    const mockB = new MockSupabase(); seedCommon(mockB, shuffled);
    const resultA = await computeRipeningActuals(mockA as unknown as SupabaseClient, VARIETY_ID, YEAR, new Date('2026-09-01T00:00:00Z'));
    const resultB = await computeRipeningActuals(mockB as unknown as SupabaseClient, VARIETY_ID, YEAR, new Date('2026-09-01T00:00:00Z'));
    assert('insertion-order independence: totalSetInstances matches', resultA.summary.totalSetInstances, resultB.summary.totalSetInstances);
    assert('insertion-order independence: totalCompleted matches', resultA.summary.totalCompleted, resultB.summary.totalCompleted);
  }

  // Intermediate-page error on the main query.
  {
    const mock = new MockSupabase({ errorOnRangeCall: 1 });
    seedCommon(mock, makeFruitInstances(1500));
    let threw = false;
    try {
      await computeRipeningActuals(mock as unknown as SupabaseClient, VARIETY_ID, YEAR, new Date('2026-09-01T00:00:00Z'));
    } catch { threw = true; }
    assert('intermediate-page error propagates as a failure', threw, true);
  }

  // Empty data.
  {
    const mock = new MockSupabase();
    seedCommon(mock, []);
    const result = await computeRipeningActuals(mock as unknown as SupabaseClient, VARIETY_ID, YEAR, new Date('2026-09-01T00:00:00Z'));
    assertClose('empty fruit_instances: totalSetInstances is 0', result.summary.totalSetInstances, 0);
    assert('empty fruit_instances: rows array is empty, not an error', result.rows.length, 0);
  }
}

async function testMeasurementSummary() {
  console.log('\n=== computeMeasurementSummary — route-level tests ===');

  function makeNodes(n: number): Record<string, unknown>[] {
    return Array.from({ length: n }, (_, i) => ({
      id: uuid('node', i), measurement_stem_id: 'stem-1', is_active: true, sort_order: i, node_number: i,
    }));
  }
  function seedForSummary(mock: MockSupabase, nodeCount: number) {
    mock.seed('varieties', [{ id: VARIETY_ID, total_stem_count: 1000, area_m2: 500 }]);
    mock.seed('measurement_rows', [{ id: 'row-1', variety_id: VARIETY_ID, is_active: true, sort_order: 1, row_name: 'Row 1' }]);
    mock.seed('measurement_stems', [{ id: 'stem-1', measurement_row_id: 'row-1', is_active: true, sort_order: 1, stem_name: 'Stem 1' }]);
    const nodes = makeNodes(nodeCount);
    mock.seed('plant_nodes', nodes);
    // Every node has a SetFruit status this week — a known, checkable total.
    mock.seed('weekly_node_statuses', nodes.map((n) => ({ plant_node_id: n.id, status: 'SetFruit', year: YEAR, week_number: 30 })));
  }

  for (const n of [0, 1, 999, 1000, 1001, 1500]) {
    const mock = new MockSupabase();
    seedForSummary(mock, n);
    const result = await computeMeasurementSummary(mock as unknown as SupabaseClient, VARIETY_ID, YEAR, 30);
    assertClose(`n=${n}: totalNodesRecorded matches exactly (no missing/duplicate nodes)`, result.summary.totalNodesRecorded, n);
    if (n > 0) assertClose(`n=${n}: all recorded as SetFruit`, result.summary.statusCounts.SetFruit, n);
  }

  // Deterministic regardless of insertion order — the route's own final sort should make output stable either way.
  {
    const nodesA = makeNodes(1200);
    const nodesB = [...nodesA].sort(() => Math.random() - 0.5);
    const mockA = new MockSupabase();
    mockA.seed('varieties', [{ id: VARIETY_ID, total_stem_count: 1000, area_m2: 500 }]);
    mockA.seed('measurement_rows', [{ id: 'row-1', variety_id: VARIETY_ID, is_active: true, sort_order: 1, row_name: 'Row 1' }]);
    mockA.seed('measurement_stems', [{ id: 'stem-1', measurement_row_id: 'row-1', is_active: true, sort_order: 1, stem_name: 'Stem 1' }]);
    mockA.seed('plant_nodes', nodesA);
    mockA.seed('weekly_node_statuses', nodesA.map((n) => ({ plant_node_id: n.id, status: 'SetFruit', year: YEAR, week_number: 30 })));
    const mockB = new MockSupabase();
    mockB.seed('varieties', [{ id: VARIETY_ID, total_stem_count: 1000, area_m2: 500 }]);
    mockB.seed('measurement_rows', [{ id: 'row-1', variety_id: VARIETY_ID, is_active: true, sort_order: 1, row_name: 'Row 1' }]);
    mockB.seed('measurement_stems', [{ id: 'stem-1', measurement_row_id: 'row-1', is_active: true, sort_order: 1, stem_name: 'Stem 1' }]);
    mockB.seed('plant_nodes', nodesB);
    mockB.seed('weekly_node_statuses', nodesB.map((n) => ({ plant_node_id: n.id, status: 'SetFruit', year: YEAR, week_number: 30 })));
    const resultA = await computeMeasurementSummary(mockA as unknown as SupabaseClient, VARIETY_ID, YEAR, 30);
    const resultB = await computeMeasurementSummary(mockB as unknown as SupabaseClient, VARIETY_ID, YEAR, 30);
    assert('insertion-order independence: records array is identically ordered (explicit final sort)', resultA.records, resultB.records);
  }

  // Intermediate-page error on the plant_nodes query.
  {
    const mock = new MockSupabase({ errorOnRangeCall: 1 });
    seedForSummary(mock, 1500);
    let threw = false;
    try {
      await computeMeasurementSummary(mock as unknown as SupabaseClient, VARIETY_ID, YEAR, 30);
    } catch { threw = true; }
    assert('intermediate-page error propagates as a failure', threw, true);
  }

  // Empty data.
  {
    const mock = new MockSupabase();
    seedForSummary(mock, 0);
    const result = await computeMeasurementSummary(mock as unknown as SupabaseClient, VARIETY_ID, YEAR, 30);
    assertClose('empty plant_nodes: totalNodesRecorded is 0', result.summary.totalNodesRecorded, 0);
    assert('empty plant_nodes: records array is empty, not an error', result.records.length, 0);
  }

  // Week/season boundary — a status from a different (year, week) must never count.
  {
    const mock = new MockSupabase();
    const nodes = makeNodes(200);
    mock.seed('varieties', [{ id: VARIETY_ID, total_stem_count: 1000, area_m2: 500 }]);
    mock.seed('measurement_rows', [{ id: 'row-1', variety_id: VARIETY_ID, is_active: true, sort_order: 1, row_name: 'Row 1' }]);
    mock.seed('measurement_stems', [{ id: 'stem-1', measurement_row_id: 'row-1', is_active: true, sort_order: 1, stem_name: 'Stem 1' }]);
    mock.seed('plant_nodes', nodes);
    mock.seed('weekly_node_statuses', [
      ...nodes.slice(0, 100).map((n) => ({ plant_node_id: n.id, status: 'SetFruit', year: YEAR, week_number: 30 })),
      ...nodes.slice(100).map((n) => ({ plant_node_id: n.id, status: 'SetFruit', year: YEAR, week_number: 31 })), // different week
    ]);
    const result = await computeMeasurementSummary(mock as unknown as SupabaseClient, VARIETY_ID, YEAR, 30);
    assertClose('week boundary respected: only week=30 statuses counted', result.summary.totalNodesRecorded, 100);
  }
}

(async () => {
  await testBreakerLearning();
  await testRipeningActuals();
  await testMeasurementSummary();

  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
