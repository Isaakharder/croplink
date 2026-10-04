/**
 * GrowLink harvest-actuals sync (lib/growlinkHarvestSync.ts): per-record
 * validation with ISO W53, a bad record never failing the batch, and
 * write failures isolated to the offending rows.
 *
 * Run with: npx tsx src/__tests__/growlink-sync.test.ts
 */
import { validateRemoteHarvestActual, planHarvestActualsSync, writeWithRowFallback, ExistingHarvestActualRow, RemoteHarvestActual } from '../lib/growlinkHarvestSync';

let pass = 0;
let fail = 0;
function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); fail++; }
}

function rec(overrides: Partial<RemoteHarvestActual> = {}): RemoteHarvestActual {
  return { harvestId: 'h1', varietyId: 'gl-mathieu', varietyName: 'Mathieu', harvestDate: null, year: 2026, week: 40, harvestKg: 1000, updatedAt: '2026-10-01T00:00:00Z', ...overrides };
}

console.log('validateRemoteHarvestActual');
assert('valid record', validateRemoteHarvestActual(rec()), null);
assert('2026-W53 is accepted', validateRemoteHarvestActual(rec({ week: 53 })), null);
assert('2025-W53 is rejected with the valid range', validateRemoteHarvestActual(rec({ year: 2025, week: 53 })), 'invalid ISO week 53 for 2025 (valid: 1–52)');
assert('week 0 is rejected', validateRemoteHarvestActual(rec({ week: 0 }))?.startsWith('invalid ISO week 0'), true);
assert('string week is rejected', validateRemoteHarvestActual(rec({ week: '12' as unknown as number }))?.startsWith('invalid ISO week'), true);
assert('negative kg is rejected', validateRemoteHarvestActual(rec({ harvestKg: -1 })), 'invalid harvestKg -1');
assert('null kg is allowed (unknown)', validateRemoteHarvestActual(rec({ harvestKg: null })), null);
assert('malformed date is rejected', validateRemoteHarvestActual(rec({ harvestDate: '2026-13-45' })), 'invalid harvestDate "2026-13-45"');
assert('missing harvestId is rejected', validateRemoteHarvestActual(rec({ harvestId: '' })), 'missing harvestId');

console.log('planHarvestActualsSync — one bad record never sinks the rest');
{
  const remote: unknown[] = [
    rec({ harvestId: 'ok-1', week: 52 }),
    rec({ harvestId: 'ok-w53', week: 53 }),
    rec({ harvestId: 'bad-w53', year: 2025, week: 53 }),
    null,
    rec({ harvestId: 'same', week: 30, harvestKg: 500 }),
    rec({ harvestId: 'changed', week: 31, harvestKg: 700 }),
    rec({ harvestId: 'unlinked', varietyId: 'gl-other' }),
  ];
  const existing = new Map<string, ExistingHarvestActualRow>([
    ['same', { id: 'row-same', growlink_harvest_key: 'same', variety_id: 'v-mathieu', kg: 500, year: 2026, week_number: 30, growlink_variety_key: 'gl-mathieu', source_payload: rec({ harvestId: 'same', week: 30, harvestKg: 500 }) }],
    ['changed', { id: 'row-changed', growlink_harvest_key: 'changed', variety_id: 'v-mathieu', kg: 650, year: 2026, week_number: 31, growlink_variety_key: 'gl-mathieu', source_payload: rec({ harvestId: 'changed', week: 31, harvestKg: 650 }) }],
  ]);
  const plan = planHarvestActualsSync(remote, existing, new Map([['gl-mathieu', 'v-mathieu']]), '2026-10-04T00:00:00Z');
  assert('valid new records are inserted (incl. 2026-W53)', plan.toInsert.map((r) => r.growlink_harvest_key), ['ok-1', 'ok-w53', 'unlinked']);
  assert('W53 harvest_date falls back to its Monday', plan.toInsert.find((r) => r.growlink_harvest_key === 'ok-w53')?.harvest_date, '2026-12-28');
  assert('changed record is updated in place', plan.toUpdate.map((r) => r.id), ['row-changed']);
  assert('unchanged record is a no-op', plan.unchangedCount, 1);
  assert('invalid records are reported, not thrown', plan.rejected.map((r) => [r.harvestId, r.stage]), [['bad-w53', 'validation'], [null, 'validation']]);
  assert('matched / unmatched counts exclude rejected records', [plan.matchedCount, plan.unmatchedCount], [4, 1]);
}

console.log('writeWithRowFallback — partial write failure');
(async () => {
  const rows = [{ growlink_harvest_key: 'a', year: 2026, week_number: 51 }, { growlink_harvest_key: 'b', year: 2026, week_number: 53 }, { growlink_harvest_key: 'c', year: 2026, week_number: 52 }];
  const written: string[] = [];
  // Simulates the pre-migration database: any batch containing W53 fails its CHECK.
  const db = async (batch: Record<string, unknown>[]) => {
    if (batch.some((r) => r.week_number === 53)) return 'new row violates check constraint "growlink_harvest_actuals_week_number_check"';
    written.push(...batch.map((r) => r.growlink_harvest_key as string));
    return null;
  };
  const res = await writeWithRowFallback(rows, db);
  assert('the other rows are still written', [res.written, written], [2, ['a', 'c']]);
  assert('only the failing row is reported, with the database reason', res.failed.map((f) => [f.harvestId, f.stage, f.reason.includes('check constraint')]), [['b', 'write', true]]);

  let calls = 0;
  const ok = await writeWithRowFallback(rows, async () => { calls++; return null; });
  assert('a healthy batch is written in one call', [ok.written, calls], [3, 1]);
  assert('empty input makes no call', (await writeWithRowFallback([], async () => { throw new Error('should not be called'); })).written, 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
