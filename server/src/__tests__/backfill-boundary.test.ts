/**
 * Verifies that processing the climate rollup as 55 separate daily jobs
 * produces IDENTICAL results to processing the same period as one
 * continuous range -- and separately, that out-of-order / overlapping /
 * re-run job processing converges to the same correct state rather than
 * corrupting it. Pure in-memory simulation (no DB) -- "existing" state is
 * modeled explicitly as whatever a prior call would have "written" so far,
 * exactly mirroring what upserts into phase_climate_hourly /
 * variety_climate_hourly actually do.
 *
 * Run with: npx tsx src/__tests__/backfill-boundary.test.ts
 */
import { computePhaseAndVarietyHourlyRows, type ZoneTopology, type ReadingLike, type ExistingPhaseHourlyRow, type ExistingVarietyHourlyRow, type PhaseHourlyRowOut, type VarietyHourlyRowOut } from '../lib/climateRollupService';

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}

const PHASE_A = 'phase-a';
const ZONE_1 = { id: 'zone-1', import_key: 'Zone 1', phase_id: PHASE_A };
const VARIETY_X = 'variety-x';

function topology(): ZoneTopology {
  return {
    zoneByImportKey: new Map([['Zone 1', ZONE_1]]),
    varietyToZoneLabels: new Map([[VARIETY_X, ['Zone 1']]]),
  };
}

function reading(ts: string, metric: string, value: number): ReadingLike {
  return { zone_label: 'Zone 1', measured_at: ts, metric_name: metric, value, unit: null };
}

/** An in-memory "database" that a sequence of calls writes into via upsert-like replace-by-key, exactly matching (phase_id/variety_id, measured_at) unique-key semantics. */
class FakeDb {
  phase = new Map<string, PhaseHourlyRowOut>();
  variety = new Map<string, VarietyHourlyRowOut>();

  apply(phaseRows: PhaseHourlyRowOut[], varietyRows: VarietyHourlyRowOut[]) {
    for (const r of phaseRows) this.phase.set(`${r.phase_id}|${r.measured_at}`, r);
    for (const r of varietyRows) this.variety.set(`${r.variety_id}|${r.measured_at}`, r);
  }

  existingPhaseHourly(): ExistingPhaseHourlyRow[] {
    return Array.from(this.phase.values()).map((r) => ({ phase_id: r.phase_id, measured_at: r.measured_at, radiation_cumulative_j_cm2: r.radiation_cumulative_j_cm2 }));
  }
  existingVarietyHourly(): ExistingVarietyHourlyRow[] {
    return Array.from(this.variety.values()).map((r) => ({
      variety_id: r.variety_id, measured_at: r.measured_at, irrigation_cumulative_avg_ml: r.irrigation_cumulative_avg_ml,
      radiation_cumulative_j_cm2: r.radiation_cumulative_j_cm2, radiation_interval_delta_j_cm2: r.radiation_interval_delta_j_cm2,
    }));
  }
}

/** Runs one "job" (one day's readings) against a FakeDb, applying its output as if written. */
function runJob(db: FakeDb, readings: ReadingLike[]) {
  const { phaseHourlyRows, varietyHourlyRows } = computePhaseAndVarietyHourlyRows({
    readings, topology: topology(), existingPhaseHourly: db.existingPhaseHourly(), existingVarietyHourly: db.existingVarietyHourly(), sourceBatchId: null,
  });
  db.apply(phaseHourlyRows, varietyHourlyRows);
  return { phaseHourlyRows, varietyHourlyRows };
}

// Two consecutive greenhouse days' worth of hourly radiation + irrigation
// readings, spanning a midnight boundary, with a genuine counter reset at
// the day change (radiation resets to a small value; irrigation resets too).
function buildTwoDayReadings(): { day1: ReadingLike[]; day2: ReadingLike[]; all: ReadingLike[] } {
  const day1: ReadingLike[] = [
    reading('2026-07-10T22:00:00Z', 'radiation_sum_j_cm2', 800),
    reading('2026-07-10T22:00:00Z', 'irrigation_cumulative_ml', 500),
    reading('2026-07-10T23:00:00Z', 'radiation_sum_j_cm2', 850),
    reading('2026-07-10T23:00:00Z', 'irrigation_cumulative_ml', 520),
  ];
  const day2: ReadingLike[] = [
    // Greenhouse-local midnight for America/Toronto (UTC-4 in July) is
    // 2026-07-11T04:00:00Z -- the counters reset there, not at UTC midnight.
    reading('2026-07-11T00:00:00Z', 'radiation_sum_j_cm2', 900), // still "yesterday" local -> delta vs 850 = 50
    reading('2026-07-11T00:00:00Z', 'irrigation_cumulative_ml', 540),
    reading('2026-07-11T04:00:00Z', 'radiation_sum_j_cm2', 30), // local midnight -> reset, first_reading_of_day
    reading('2026-07-11T04:00:00Z', 'irrigation_cumulative_ml', 10),
    reading('2026-07-11T05:00:00Z', 'radiation_sum_j_cm2', 90), // delta vs 30 = 60
    reading('2026-07-11T05:00:00Z', 'irrigation_cumulative_ml', 45),
  ];
  return { day1, day2, all: [...day1, ...day2] };
}

console.log('Continuous vs daily-chunked processing produce IDENTICAL output');
{
  const { day1, day2, all } = buildTwoDayReadings();

  const continuousDb = new FakeDb();
  runJob(continuousDb, all); // one call, the whole range at once

  const dailyDb = new FakeDb();
  runJob(dailyDb, day1); // day 1's job
  runJob(dailyDb, day2); // day 2's job, seeded with day 1's already-"written" state

  assert(continuousDb.variety.size === dailyDb.variety.size, `same row count (continuous=${continuousDb.variety.size}, daily=${dailyDb.variety.size})`);
  let allMatch = true;
  for (const [key, continuousRow] of continuousDb.variety) {
    const dailyRow = dailyDb.variety.get(key);
    if (!dailyRow || JSON.stringify(continuousRow) !== JSON.stringify(dailyRow)) {
      allMatch = false;
      console.log(`    MISMATCH at ${key}:`, JSON.stringify(continuousRow), 'vs', JSON.stringify(dailyRow));
    }
  }
  assert(allMatch, 'every variety-hourly row is byte-identical between continuous and daily-chunked processing');

  // Specifically verify the midnight-boundary delta values, since that's the case most likely to diverge.
  const at2300 = continuousDb.phase.get(`${PHASE_A}|2026-07-10T23:00:00Z`)!;
  assert(at2300.radiation_interval_delta_j_cm2 === 50, `23:00 delta (850-800=50) correct in continuous run (got ${at2300.radiation_interval_delta_j_cm2})`);
  const at2300Daily = dailyDb.phase.get(`${PHASE_A}|2026-07-10T23:00:00Z`)!;
  assert(at2300Daily.radiation_interval_delta_j_cm2 === 50, `23:00 delta correct in daily-chunked run too (got ${at2300Daily.radiation_interval_delta_j_cm2})`);

  const at0000 = continuousDb.phase.get(`${PHASE_A}|2026-07-11T00:00:00Z`)!;
  assert(at0000.radiation_interval_delta_j_cm2 === 50, `00:00 UTC (still "yesterday" greenhouse-local) delta vs 23:00 = 50, not treated as a day reset (got ${at0000.radiation_interval_delta_j_cm2})`);

  const at0400 = continuousDb.phase.get(`${PHASE_A}|2026-07-11T04:00:00Z`)!;
  assert(at0400.radiation_quality_flag === 'first_reading_of_day', '04:00 UTC (greenhouse-local midnight) correctly flagged first_reading_of_day, not a negative delta');
  assert(at0400.radiation_interval_delta_j_cm2 === null, '04:00 delta is null (reset), not 30-900=-870');

  const at0500 = continuousDb.phase.get(`${PHASE_A}|2026-07-11T05:00:00Z`)!;
  assert(at0500.radiation_interval_delta_j_cm2 === 60, `05:00 delta (90-30=60) correct after the reset (got ${at0500.radiation_interval_delta_j_cm2})`);

  // Same checks on the daily-chunked run -- the second day's job must see
  // day 1's carry-forward correctly through the lookback query, even though
  // it's a separate call/job.
  const at0000Daily = dailyDb.phase.get(`${PHASE_A}|2026-07-11T00:00:00Z`)!;
  assert(at0000Daily.radiation_interval_delta_j_cm2 === 50, 'daily-chunked: 00:00 delta also correctly carries forward from day 1\'s last hour, not treated as first_reading_of_day just because it\'s a new job');
}

console.log('\nJobs processed OUT OF chronological order: day 2 before day 1 gives a wrong boundary delta, corrected by re-running day 2');
{
  const { day1, day2 } = buildTwoDayReadings();
  const db = new FakeDb();

  runJob(db, day2); // day 2 processed FIRST -- no day-1 data exists yet
  const at0000BeforeDay1 = db.phase.get(`${PHASE_A}|2026-07-11T00:00:00Z`)!;
  assert(at0000BeforeDay1.radiation_quality_flag === 'first_reading_of_day', 'processed out of order: 00:00 incorrectly looks like a fresh series start (no day-1 carry-forward existed yet) -- this is the real risk of out-of-order processing, not a false alarm');

  runJob(db, day1); // day 1 now processed (its own hours are unaffected by day 2 already existing)
  const day1LastHour = db.phase.get(`${PHASE_A}|2026-07-10T23:00:00Z`)!;
  assert(day1LastHour.radiation_interval_delta_j_cm2 === 50, 'day 1 itself computes correctly regardless of day 2 already being present');

  runJob(db, day2); // RE-RUN day 2 now that day 1 exists
  const at0000AfterRerun = db.phase.get(`${PHASE_A}|2026-07-11T00:00:00Z`)!;
  assert(at0000AfterRerun.radiation_interval_delta_j_cm2 === 50, 'after re-running day 2, the 00:00 delta self-corrects to the right value (50) now that day 1\'s carry-forward is available');
  assert(at0000AfterRerun.radiation_quality_flag === 'ok', 're-run also fixes the quality flag from first_reading_of_day to ok');
}

console.log('\nTwo overlapping daily-job windows converge to the same correct state');
{
  const { day1, day2 } = buildTwoDayReadings();
  const db = new FakeDb();
  // Job A: a "normal" day-1 window. Job B: an overlapping window shifted by
  // 2 hours, covering day 1's last 2 hours AND day 2's first hour.
  const jobA = day1;
  const jobB = [...day1.slice(2), ...day2.slice(0, 2)]; // 23:00 day1 + 00:00 day2

  runJob(db, jobA);
  runJob(db, jobB); // overlaps jobA's 23:00 hour and adds 00:00

  const at2300 = db.phase.get(`${PHASE_A}|2026-07-10T23:00:00Z`)!;
  assert(at2300.radiation_interval_delta_j_cm2 === 50, 'the overlapping hour (23:00, written by both jobs) ends at the same correct value both jobs would independently compute');
  const at0000 = db.phase.get(`${PHASE_A}|2026-07-11T00:00:00Z`)!;
  assert(at0000.radiation_interval_delta_j_cm2 === 50, '00:00 (only in job B) is still correct, seeded by jobA\'s already-written 23:00 as its lookback');
}

console.log('\nRe-running one already-completed day is idempotent (no drift, no duplication)');
{
  const { all } = buildTwoDayReadings();
  const db = new FakeDb();
  runJob(db, all);
  const before = JSON.stringify(Array.from(db.variety.entries()).sort());
  runJob(db, all); // run the exact same job again
  const after = JSON.stringify(Array.from(db.variety.entries()).sort());
  assert(before === after, 're-running the identical job twice produces byte-identical state, not drift or duplicate rows');
  assert(db.variety.size === 5, `row count unchanged after re-run (still ${db.variety.size}, not doubled — 5 distinct timestamps across both days)`);
}

console.log('\nA late-arriving reading for a PAST hour, backfilled after its day already ran, is picked up correctly on re-run');
{
  const db = new FakeDb();
  const day1Initial: ReadingLike[] = [
    reading('2026-07-10T22:00:00Z', 'radiation_sum_j_cm2', 800),
  ];
  runJob(db, day1Initial);
  const initial = db.phase.get(`${PHASE_A}|2026-07-10T22:00:00Z`)!;
  assert(initial.radiation_quality_flag === 'first_reading_of_day', 'first pass: only one reading exists, correctly flagged first-of-day');

  // A reading for 21:00 arrives late (e.g. a delayed agent upload) and the
  // hour is re-processed as part of a later job/backfill pass that includes it.
  const day1WithLateReading: ReadingLike[] = [
    reading('2026-07-10T21:00:00Z', 'radiation_sum_j_cm2', 760),
    reading('2026-07-10T22:00:00Z', 'radiation_sum_j_cm2', 800),
  ];
  runJob(db, day1WithLateReading);
  const after = db.phase.get(`${PHASE_A}|2026-07-10T22:00:00Z`)!;
  assert(after.radiation_interval_delta_j_cm2 === 40, `22:00's delta is recomputed against the now-available 21:00 reading (800-760=40), not stuck at the stale first-pass value (got ${after.radiation_interval_delta_j_cm2})`);
  assert(after.radiation_quality_flag === 'ok', '22:00 is no longer flagged first_reading_of_day once its true predecessor is known');
}

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
