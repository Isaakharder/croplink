import { computePhaseAndVarietyHourlyRows, type ZoneTopology, type ReadingLike } from '../lib/climateRollupService';

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}
function assertClose(actual: number | null, expected: number, tol: number, msg: string) {
  assert(actual != null && Math.abs(actual - expected) <= tol, `${msg} (expected ~${expected}, got ${actual})`);
}

const PHASE_A = 'phase-a';
const ZONE_1 = { id: 'zone-1', import_key: 'Zone 1', phase_id: PHASE_A };
const ZONE_2 = { id: 'zone-2', import_key: 'Zone 2', phase_id: PHASE_A };
const VARIETY_X = 'variety-x';

function topology(): ZoneTopology {
  return {
    zoneByImportKey: new Map([['Zone 1', ZONE_1], ['Zone 2', ZONE_2]]),
    varietyToZoneLabels: new Map([[VARIETY_X, ['Zone 1', 'Zone 2']]]),
  };
}

function reading(zone: string, ts: string, metric: string, value: number): ReadingLike {
  return { zone_label: zone, measured_at: ts, metric_name: metric, value, unit: null };
}

console.log('computePhaseAndVarietyHourlyRows — identical inputs produce identical output (idempotency)');
{
  const readings: ReadingLike[] = [
    reading('Zone 1', '2026-08-01T10:00:00Z', 'temperature_c', 22.5),
    reading('Zone 2', '2026-08-01T10:00:00Z', 'temperature_c', 23.5),
    reading('Zone 1', '2026-08-01T10:00:00Z', 'radiation_sum_j_cm2', 100),
  ];
  const run1 = computePhaseAndVarietyHourlyRows({ readings, topology: topology(), existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: null });
  const run2 = computePhaseAndVarietyHourlyRows({ readings, topology: topology(), existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: null });
  assert(JSON.stringify(run1) === JSON.stringify(run2), 'two calls with identical inputs produce byte-identical output');
  assertClose(run1.varietyHourlyRows[0].air_temperature_avg_c, 23.0, 0.01, 'variety avg temp is the mean of both zones');
}

console.log('\ncomputePhaseAndVarietyHourlyRows — radiation carry-forward from existing rows');
{
  const readings: ReadingLike[] = [reading('Zone 1', '2026-08-01T11:00:00Z', 'radiation_sum_j_cm2', 150)];
  const existingPhaseHourly = [{ phase_id: PHASE_A, measured_at: '2026-08-01T10:00:00Z', radiation_cumulative_j_cm2: 100 }];
  const { phaseHourlyRows } = computePhaseAndVarietyHourlyRows({ readings, topology: topology(), existingPhaseHourly, existingVarietyHourly: [], sourceBatchId: null });
  assertClose(phaseHourlyRows[0].radiation_interval_delta_j_cm2, 50, 0.01, 'delta computed against the existing prior-hour cumulative (150-100=50), not treated as first-of-day');
}

console.log('\ncomputePhaseAndVarietyHourlyRows — no existing carry-forward row means first_reading_of_day, not a zero delta');
{
  const readings: ReadingLike[] = [reading('Zone 1', '2026-08-01T10:00:00Z', 'radiation_sum_j_cm2', 150)];
  const { phaseHourlyRows } = computePhaseAndVarietyHourlyRows({ readings, topology: topology(), existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: null });
  assert(phaseHourlyRows[0].radiation_interval_delta_j_cm2 === null, 'no prior cumulative -> delta is null, not 0');
  assert(phaseHourlyRows[0].radiation_quality_flag === 'first_reading_of_day', 'flagged first_reading_of_day');
}

console.log('\ncomputePhaseAndVarietyHourlyRows — missing zone reading is excluded from the average, never treated as zero');
{
  const readings: ReadingLike[] = [reading('Zone 1', '2026-08-01T10:00:00Z', 'temperature_c', 20)]; // Zone 2 has no reading this hour
  const { varietyHourlyRows } = computePhaseAndVarietyHourlyRows({ readings, topology: topology(), existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: null });
  assertClose(varietyHourlyRows[0].air_temperature_avg_c, 20, 0.01, 'avg is Zone 1 alone (20), not averaged with an implicit 0 for Zone 2');
  assert(varietyHourlyRows[0].air_temperature_zone_count === 1, 'zone count reflects only the 1 zone that actually reported');
  assert(varietyHourlyRows[0].quality_warnings.some((w) => w.includes('1/2 zones')), 'a partial-coverage warning is recorded');
}

console.log('\ncomputePhaseAndVarietyHourlyRows — pH sentinel-zero exclusion still applies through the shared path');
{
  const readings: ReadingLike[] = [
    reading('Zone 1', '2026-08-01T10:00:00Z', 'ph', 0),
    reading('Zone 2', '2026-08-01T10:00:00Z', 'ph', 5.2),
  ];
  const { varietyHourlyRows } = computePhaseAndVarietyHourlyRows({ readings, topology: topology(), existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: null });
  assertClose(varietyHourlyRows[0].ph_avg, 5.2, 0.01, 'sentinel-zero pH excluded, avg is the one real reading (5.2)');
  assert(varietyHourlyRows[0].ph_zone_count === 1, 'sentinel-zero pH not counted as a contributing zone');
}

console.log('\ncomputePhaseAndVarietyHourlyRows — a variety with no reporting zone this hour produces no row');
{
  const readings: ReadingLike[] = [reading('Zone 3', '2026-08-01T10:00:00Z', 'temperature_c', 20)]; // unmapped zone
  const { varietyHourlyRows, phaseHourlyRows } = computePhaseAndVarietyHourlyRows({ readings, topology: topology(), existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: null });
  assert(varietyHourlyRows.length === 0, 'no variety row for a zone with no variety_zones mapping');
  assert(phaseHourlyRows.length === 0, 'no phase row either — Zone 3 has no phase mapping and no radiation/drain reading');
}

console.log('\ncomputePhaseAndVarietyHourlyRows — sourceBatchId threads through to every output row');
{
  const readings: ReadingLike[] = [
    reading('Zone 1', '2026-08-01T10:00:00Z', 'temperature_c', 22),
    reading('Zone 1', '2026-08-01T10:00:00Z', 'radiation_sum_j_cm2', 100),
  ];
  const { phaseHourlyRows, varietyHourlyRows } = computePhaseAndVarietyHourlyRows({ readings, topology: topology(), existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: 'batch-123' });
  assert(phaseHourlyRows[0].source_batch_id === 'batch-123', 'phase row carries the batch id');
  assert(varietyHourlyRows[0].source_batch_id === 'batch-123', 'variety row carries the batch id');
}

console.log('\ncomputePhaseAndVarietyHourlyRows — null sourceBatchId (automated/backfill callers) is preserved as null, not coerced');
{
  const readings: ReadingLike[] = [reading('Zone 1', '2026-08-01T10:00:00Z', 'temperature_c', 22)];
  const { varietyHourlyRows } = computePhaseAndVarietyHourlyRows({ readings, topology: topology(), existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: null });
  assert(varietyHourlyRows[0].source_batch_id === null, 'null threads through unchanged');
}

console.log('\nA variety-hourly row can legitimately exist with no matching phase-hourly row (Round 10 preflight finding, traced to 2026-07-07T05:00Z in real Mathieu data)');
{
  // Zone 1 is the sole radiation/drain sensor for its phase. This hour it
  // reports temperature/RH but NOT radiation or drain -- the phase-hourly
  // branch requires at least one radiation/drain reading and gets none, so
  // no phase row is produced. The variety-hourly branch only requires ANY
  // metric from ANY linked zone, which temperature satisfies, so a variety
  // row IS produced. This is correct: a gap in one sensor's radiation/drain
  // reporting must not block temperature/RH/CO2 data from being captured.
  const readings: ReadingLike[] = [
    reading('Zone 1', '2026-07-07T05:00:00Z', 'temperature_c', 20.2),
    reading('Zone 1', '2026-07-07T05:00:00Z', 'relative_humidity_pct', 82),
  ];
  const { phaseHourlyRows, varietyHourlyRows } = computePhaseAndVarietyHourlyRows({
    readings, topology: topology(), existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: null,
  });
  assert(phaseHourlyRows.length === 0, 'no phase-hourly row is produced (no radiation/drain reading this hour)');
  assert(varietyHourlyRows.length === 1, 'a variety-hourly row IS produced (temperature/RH were reported)');
  assert(varietyHourlyRows[0].air_temperature_avg_c === 20.2, 'the variety row carries the real temperature value');
  assert(varietyHourlyRows[0].radiation_cumulative_j_cm2 === null, 'radiation fields on the variety row are null, not silently zeroed or borrowed from elsewhere');
  assert(varietyHourlyRows[0].temporal_covered === true, 'the hour is still temporally covered despite having no phase-hourly counterpart');
}

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
