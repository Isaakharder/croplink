/**
 * Verifies whether the manual batch-commit path (which seeds carry-forward
 * from EXISTING derived rows, unchanged from before this round) and the
 * automated/backfill path (raw-context, this round's fix) converge to the
 * same output given the same underlying raw data, including gap scenarios.
 *
 * Run with: npx tsx src/__tests__/manual-vs-automated-convergence.test.ts
 */
import {
  computePhaseAndVarietyHourlyRows, computeRollupReadWindow, partitionCoreRows,
  type ZoneTopology, type ReadingLike, type ExistingPhaseHourlyRow, type PhaseHourlyRowOut,
} from '../lib/climateRollupService';

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}

const PHASE_A = 'phase-a';
const ZONE_1 = { id: 'zone-1', import_key: 'Zone 1', phase_id: PHASE_A };
function topology(): ZoneTopology {
  return { zoneByImportKey: new Map([['Zone 1', ZONE_1]]), varietyToZoneLabels: new Map() };
}
function reading(ts: string, metric: string, value: number): ReadingLike {
  return { zone_label: 'Zone 1', measured_at: ts, metric_name: metric, value, unit: null };
}

console.log('=== Case 1: both readings in the SAME batch/call -- manual and automated already agree ===');
{
  const readings = [
    reading('2026-07-10T10:00:00Z', 'radiation_sum_j_cm2', 500),
    reading('2026-07-10T13:00:00Z', 'radiation_sum_j_cm2', 560),
  ];
  // Automated: one call, widened raw context, empty existing rows.
  const automated = computePhaseAndVarietyHourlyRows({ readings, topology: topology(), existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: null });
  // Manual, same-batch case: a human uploads both files together -- same
  // `readings` array, same single call. This is the NORMAL case for a
  // manual upload (a batch is typically a contiguous set of files).
  const manualSameBatch = computePhaseAndVarietyHourlyRows({ readings, topology: topology(), existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: 'batch-1' });

  const autoAt13 = automated.phaseHourlyRows.find((r) => r.measured_at === '2026-07-10T13:00:00Z')!;
  const manualAt13 = manualSameBatch.phaseHourlyRows.find((r) => r.measured_at === '2026-07-10T13:00:00Z')!;
  assert(autoAt13.radiation_interval_delta_j_cm2 === 60, `automated: 13:00 delta correct (60) (got ${autoAt13.radiation_interval_delta_j_cm2})`);
  assert(manualAt13.radiation_interval_delta_j_cm2 === 60, `manual (same batch): 13:00 delta ALSO correct (60) (got ${manualAt13.radiation_interval_delta_j_cm2})`);
  assert(autoAt13.radiation_interval_delta_j_cm2 === manualAt13.radiation_interval_delta_j_cm2, 'both paths converge for the same-batch case -- expected, since both feed the SAME computePhaseAndVarietyHourlyRows with equivalent context');
}

console.log('\n=== Case 2: 10:00 already committed and exists in phase_climate_hourly BEFORE the 13:00 batch -- manual finds it via existing-row lookback ===');
{
  const existingPhaseHourly: ExistingPhaseHourlyRow[] = [
    { phase_id: PHASE_A, measured_at: '2026-07-10T10:00:00Z', radiation_cumulative_j_cm2: 500 },
  ];
  const batch2Readings = [reading('2026-07-10T13:00:00Z', 'radiation_sum_j_cm2', 560)];
  const manual = computePhaseAndVarietyHourlyRows({ readings: batch2Readings, topology: topology(), existingPhaseHourly, existingVarietyHourly: [], sourceBatchId: 'batch-2' });
  const manualAt13 = manual.phaseHourlyRows.find((r) => r.measured_at === '2026-07-10T13:00:00Z')!;
  assert(manualAt13.radiation_interval_delta_j_cm2 === 60, `manual, 10:00 already committed: 13:00 delta correct via existing-row lookback (60) (got ${manualAt13.radiation_interval_delta_j_cm2})`);
}

console.log('\n=== Case 3 (the PRE-FIX divergence, kept as a regression guard): the OLD manual algorithm (existing-row lookback scoped to [dayStart, maxTs], no forward closure) really did diverge ===');
{
  // Batch A (13:00's file) committed first -- no existing row for 10:00 yet.
  const batchAReadings = [reading('2026-07-10T13:00:00Z', 'radiation_sum_j_cm2', 560)];
  const batchA = computePhaseAndVarietyHourlyRows({ readings: batchAReadings, topology: topology(), existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: 'batch-A' });
  const writtenAfterBatchA = new Map<string, PhaseHourlyRowOut>();
  for (const r of batchA.phaseHourlyRows) writtenAfterBatchA.set(r.measured_at, r);
  const at13AfterBatchA = writtenAfterBatchA.get('2026-07-10T13:00:00Z')!;
  assert(at13AfterBatchA.radiation_quality_flag === 'first_reading_of_day', 'batch A (13:00 alone, committed first): 13:00 has no predecessor yet, correctly first_reading_of_day at this point');

  // Batch B (10:00's file) committed second. The manual flow's OWN commit
  // for batch B only ever writes what batch B's OWN readings imply (10:00
  // itself) -- it has no mechanism analogous to the automated path's
  // forward-closure (+1h / rest-of-day) that would go back and ALSO
  // recompute 13:00 now that 10:00 exists.
  const batchBReadings = [reading('2026-07-10T10:00:00Z', 'radiation_sum_j_cm2', 500)];
  const existingForBatchB: ExistingPhaseHourlyRow[] = Array.from(writtenAfterBatchA.values()).map((r) => ({ phase_id: r.phase_id, measured_at: r.measured_at, radiation_cumulative_j_cm2: r.radiation_cumulative_j_cm2 }));
  const batchB = computePhaseAndVarietyHourlyRows({ readings: batchBReadings, topology: topology(), existingPhaseHourly: existingForBatchB, existingVarietyHourly: [], sourceBatchId: 'batch-B' });
  for (const r of batchB.phaseHourlyRows) writtenAfterBatchA.set(r.measured_at, r); // simulates the batch-B commit's own writes landing in the DB

  const at13Final = writtenAfterBatchA.get('2026-07-10T13:00:00Z')!; // whatever batch A originally wrote -- batch B's commit never touches 13:00
  assert(at13Final.radiation_quality_flag === 'first_reading_of_day', 'PRE-FIX: after both manual commits, 13:00 is STILL stuck at first_reading_of_day -- the old manual flow never revisited it');
  assert(at13Final.radiation_interval_delta_j_cm2 === null, 'PRE-FIX: 13:00 delta stays null (stale), not the correct 60 -- confirms the divergence was real before the fix');
}

console.log('\n=== Case 4 (THE FIX): buildCommitPlan\'s new algorithm -- raw-context merge + partitionCoreRows, mirroring the automated path exactly ===');
{
  // Simulates climateImportBatches.ts's buildCommitPlan as it now works:
  // fetch raw context readings from climate_readings STRICTLY outside
  // [minTs, maxTs] (before AND after), merge with the batch's own readings,
  // compute once, keep only rows >= minTs as "core" (conflict-diffed and
  // written) -- the exact same computeRollupReadWindow + partitionCoreRows
  // pattern as rollupClimateReadingRange, just with an added forward
  // context fetch reaching into ALREADY-EXISTING raw readings (which
  // "batch A committed" implies now exist in climate_readings).
  const climateReadingsTable: ReadingLike[] = [reading('2026-07-10T13:00:00Z', 'radiation_sum_j_cm2', 560)]; // what batch A's commit already wrote to climate_readings

  // Batch B arrives: just 10:00's file.
  const batchBOwnReadings = [reading('2026-07-10T10:00:00Z', 'radiation_sum_j_cm2', 500)];
  const minTs = '2026-07-10T10:00:00Z';
  const maxTs = '2026-07-10T10:00:00Z';
  const window = computeRollupReadWindow(minTs, maxTs);
  const rawContext = climateReadingsTable.filter((r) => (r.measured_at < minTs || r.measured_at > maxTs) && r.measured_at >= window.readStart && r.measured_at <= window.readEnd);
  const merged = [...rawContext, ...batchBOwnReadings];

  const { phaseHourlyRows: allComputed } = computePhaseAndVarietyHourlyRows({ readings: merged, topology: topology(), existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: 'batch-B' });
  const { core } = partitionCoreRows(allComputed, minTs);
  const at13Fixed = core.find((r) => r.measured_at === '2026-07-10T13:00:00Z');
  assert(at13Fixed !== undefined, 'FIXED: batch B\'s commit now computes a core row for 13:00 too (would surface as a conflict for human review, since a stored row already exists there)');
  assert(at13Fixed?.radiation_interval_delta_j_cm2 === 60, `FIXED: 13:00's delta is now correctly 560-500=60, matching the automated path exactly (got ${at13Fixed?.radiation_interval_delta_j_cm2})`);
}

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
