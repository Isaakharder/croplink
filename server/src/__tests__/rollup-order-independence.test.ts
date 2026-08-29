/**
 * Proves the climate rollup is order-independent: 10 reordering/concurrency
 * scenarios, run against a full simulation of rollupClimateReadingRange's
 * actual algorithm (using its real exported pure pieces --
 * computeRollupReadWindow, computePhaseAndVarietyHourlyRows,
 * partitionCoreRows -- against an in-memory FakeDb standing in for
 * Supabase), compared field-for-field against a continuous single-pass
 * reference. Also covers the EC/pH cross-day-adjacency case specifically,
 * since that's the one dependency NOT bounded by the greenhouse-local-day
 * reset that radiation/irrigation rely on.
 *
 * Run with: npx tsx src/__tests__/rollup-order-independence.test.ts
 */
import {
  computeRollupReadWindow, partitionCoreRows,
  computePhaseAndVarietyHourlyRows, type ZoneTopology, type ReadingLike,
  type PhaseHourlyRowOut, type VarietyHourlyRowOut,
} from '../lib/climateRollupService';
import { computeHourlyFeatures, type VarietyClimateHourlyRowLike, type HourlyClimateFeatures } from '../lib/climateFeatures';

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

interface FeatureRowSim { variety_id: string; measured_at: string; ecDelta: number | null; phDelta: number | null; vpdKpa: number | null }

/** Simulates the full rollupClimateReadingRange algorithm against a FakeDb + a global "climate_readings" array, using the SAME exported pure pieces the real implementation uses. */
class FakeSystem {
  allReadings: ReadingLike[] = [];
  phase = new Map<string, PhaseHourlyRowOut>();
  variety = new Map<string, VarietyHourlyRowOut>();
  features = new Map<string, FeatureRowSim>();

  seedReadings(readings: ReadingLike[]) {
    this.allReadings.push(...readings);
  }

  /** One "job" -- exactly mirrors rollupClimateReadingRange's algorithm. */
  runJob(startIso: string, endIso: string) {
    const { readStart, readEnd } = computeRollupReadWindow(startIso, endIso);
    // Epoch-ms comparison, not raw string comparison: computeRollupReadWindow
    // uses Date#toISOString() (always ".000Z"-suffixed), while synthetic
    // fixture timestamps below intentionally omit milliseconds (matching
    // this repo's real timestamp shapes elsewhere) -- lexicographic string
    // comparison of differently-formatted-but-equal instants is exactly the
    // bug class this whole preflight has been hunting for elsewhere, so this
    // harness must not reintroduce it. The real system doesn't have this
    // issue: Supabase's .gte()/.lte() compare actual Postgres timestamptz
    // values, not JS strings.
    const readStartMs = new Date(readStart).getTime();
    const readEndMs = new Date(readEnd).getTime();
    const windowReadings = this.allReadings.filter((r) => {
      const ms = new Date(r.measured_at).getTime();
      return ms >= readStartMs && ms <= readEndMs;
    });
    if (windowReadings.length === 0) return;

    const { phaseHourlyRows: allPhase, varietyHourlyRows: allVariety } = computePhaseAndVarietyHourlyRows({
      readings: windowReadings, topology: topology(), existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: null,
    });

    const { core: corePhase } = partitionCoreRows(allPhase, startIso);
    const { core: coreVariety } = partitionCoreRows(allVariety, startIso);

    for (const r of corePhase) this.phase.set(`${r.phase_id}|${r.measured_at}`, r);
    for (const r of coreVariety) this.variety.set(`${r.variety_id}|${r.measured_at}`, r);

    // Features step: DB-fetch simulation (this.variety, already-written rows)
    // merged with in-memory contextRows (allVariety, the full widened set),
    // context taking precedence -- mirrors recomputeVarietyClimateFeatures's
    // real merge logic exactly.
    const byVariety = new Map<string, string[]>();
    for (const r of coreVariety) {
      if (!byVariety.has(r.variety_id)) byVariety.set(r.variety_id, []);
      byVariety.get(r.variety_id)!.push(r.measured_at);
    }
    for (const [varietyId, timestamps] of byVariety) {
      const sorted = [...timestamps].sort();
      const earliest = sorted[0];
      const latest = sorted[sorted.length - 1];
      const lookbackStart = new Date(new Date(earliest).getTime() - 3600000).toISOString();

      const byKey = new Map<string, VarietyHourlyRowOut>();
      for (const [key, r] of this.variety) {
        if (r.variety_id !== varietyId) continue;
        if (r.measured_at < lookbackStart || r.measured_at > latest) continue;
        byKey.set(r.measured_at, r);
      }
      for (const r of allVariety) {
        if (r.variety_id !== varietyId) continue;
        if (r.measured_at < lookbackStart || r.measured_at > latest) continue;
        byKey.set(r.measured_at, r); // context takes precedence
      }
      const rows = Array.from(byKey.values()).sort((a, b) => (a.measured_at < b.measured_at ? -1 : 1));

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.measured_at < earliest) continue;
        const previousRow = i > 0 ? rows[i - 1] : null;
        const rowLike: VarietyClimateHourlyRowLike = {
          variety_id: row.variety_id, measured_at: row.measured_at,
          air_temperature_avg_c: row.air_temperature_avg_c, relative_humidity_avg_pct: row.relative_humidity_avg_pct,
          vpd_avg_kpa: row.vpd_avg_kpa, co2_avg_ppm: row.co2_avg_ppm, ec_avg: row.ec_avg, ph_avg: row.ph_avg,
          irrigation_interval_delta_ml: row.irrigation_interval_delta_ml, irrigation_interval_minutes: row.irrigation_interval_minutes,
          radiation_interval_delta_j_cm2: row.radiation_interval_delta_j_cm2,
        };
        const prevLike: VarietyClimateHourlyRowLike | null = previousRow ? {
          variety_id: previousRow.variety_id, measured_at: previousRow.measured_at,
          air_temperature_avg_c: previousRow.air_temperature_avg_c, relative_humidity_avg_pct: previousRow.relative_humidity_avg_pct,
          vpd_avg_kpa: previousRow.vpd_avg_kpa, co2_avg_ppm: previousRow.co2_avg_ppm, ec_avg: previousRow.ec_avg, ph_avg: previousRow.ph_avg,
          irrigation_interval_delta_ml: previousRow.irrigation_interval_delta_ml, irrigation_interval_minutes: previousRow.irrigation_interval_minutes,
          radiation_interval_delta_j_cm2: previousRow.radiation_interval_delta_j_cm2,
        } : null;
        const computed: HourlyClimateFeatures = computeHourlyFeatures(rowLike, prevLike);
        this.features.set(`${varietyId}|${row.measured_at}`, { variety_id: varietyId, measured_at: row.measured_at, ecDelta: computed.ecDelta, phDelta: computed.phDelta, vpdKpa: computed.vpdKpa });
      }
    }
  }

  snapshot(): string {
    return JSON.stringify({
      phase: Array.from(this.phase.entries()).sort(),
      variety: Array.from(this.variety.entries()).sort(),
      features: Array.from(this.features.entries()).sort(),
    });
  }
}

// 3 greenhouse-local days of hourly radiation/irrigation/EC/pH readings,
// spanning local-midnight (04:00 UTC) boundaries twice, with a genuine
// counter reset at each local midnight and a distinct EC/pH value each hour
// (so cross-hour deltas are all non-trivial and comparable).
function buildThreeDayReadings(): { day1: ReadingLike[]; day2: ReadingLike[]; day3: ReadingLike[]; all: ReadingLike[] } {
  const hours: { ts: string; rad: number; irr: number; ec: number }[] = [
    { ts: '2026-07-10T02:00:00Z', rad: 700, irr: 400, ec: 2.0 },
    { ts: '2026-07-10T03:00:00Z', rad: 750, irr: 420, ec: 2.1 }, // last hour of local day 1
    { ts: '2026-07-10T04:00:00Z', rad: 20, irr: 5, ec: 2.2 },    // local midnight -> reset, day 2 starts
    { ts: '2026-07-10T05:00:00Z', rad: 60, irr: 30, ec: 2.3 },
    { ts: '2026-07-11T02:00:00Z', rad: 690, irr: 410, ec: 2.4 },
    { ts: '2026-07-11T03:00:00Z', rad: 730, irr: 435, ec: 2.5 }, // last hour of local day 2
    { ts: '2026-07-11T04:00:00Z', rad: 15, irr: 8, ec: 2.6 },    // local midnight -> reset, day 3 starts
    { ts: '2026-07-11T05:00:00Z', rad: 55, irr: 33, ec: 2.7 },
  ];
  const toReadings = (h: typeof hours[number]) => [
    reading(h.ts, 'radiation_sum_j_cm2', h.rad),
    reading(h.ts, 'irrigation_cumulative_ml', h.irr),
    reading(h.ts, 'ec', h.ec),
  ];
  const day1 = hours.slice(0, 2).flatMap(toReadings); // 07-10 02:00, 03:00 (still local day starting 07-09T04:00)
  const day2 = hours.slice(2, 6).flatMap(toReadings); // 07-10 04:00,05:00 + 07-11 02:00,03:00 (one full local day)
  const day3 = hours.slice(6, 8).flatMap(toReadings); // 07-11 04:00, 05:00 (next local day)
  return { day1, day2, day3, all: hours.flatMap(toReadings) };
}

const { day1, day2, day3, all } = buildThreeDayReadings();

function reference(): FakeSystem {
  const sys = new FakeSystem();
  sys.seedReadings(all);
  sys.runJob('2026-07-10T02:00:00Z', '2026-07-11T05:00:00Z'); // one continuous job covering everything
  return sys;
}
const referenceSnapshot = reference().snapshot();

function checkScenario(name: string, run: (sys: FakeSystem) => void) {
  const sys = new FakeSystem();
  sys.seedReadings(all);
  run(sys);
  const snap = sys.snapshot();
  assert(snap === referenceSnapshot, `${name}: byte-identical to continuous reference`);
  if (snap !== referenceSnapshot) {
    console.log('    reference:', referenceSnapshot.slice(0, 500));
    console.log('    actual:   ', snap.slice(0, 500));
  }
}

console.log('=== 10 reordering/concurrency scenarios vs. continuous reference ===\n');

checkScenario('1. Continuous (sanity check — same as reference)', (sys) => {
  sys.runJob('2026-07-10T02:00:00Z', '2026-07-11T05:00:00Z');
});

checkScenario('2. Daily jobs, ascending order', (sys) => {
  sys.runJob('2026-07-10T02:00:00Z', '2026-07-10T03:00:00Z');
  sys.runJob('2026-07-10T04:00:00Z', '2026-07-11T03:00:00Z');
  sys.runJob('2026-07-11T04:00:00Z', '2026-07-11T05:00:00Z');
});

checkScenario('3. Daily jobs, descending order', (sys) => {
  sys.runJob('2026-07-11T04:00:00Z', '2026-07-11T05:00:00Z');
  sys.runJob('2026-07-10T04:00:00Z', '2026-07-11T03:00:00Z');
  sys.runJob('2026-07-10T02:00:00Z', '2026-07-10T03:00:00Z');
});

checkScenario('4. Fixed random shuffle', (sys) => {
  sys.runJob('2026-07-10T04:00:00Z', '2026-07-11T03:00:00Z');
  sys.runJob('2026-07-10T02:00:00Z', '2026-07-10T03:00:00Z');
  sys.runJob('2026-07-11T04:00:00Z', '2026-07-11T05:00:00Z');
});

checkScenario('5. "Odd days first, then even" (day1, day3, then day2)', (sys) => {
  sys.runJob('2026-07-10T02:00:00Z', '2026-07-10T03:00:00Z');
  sys.runJob('2026-07-11T04:00:00Z', '2026-07-11T05:00:00Z');
  sys.runJob('2026-07-10T04:00:00Z', '2026-07-11T03:00:00Z');
});

checkScenario('6a. Two overlapping ranges, A then B', (sys) => {
  sys.runJob('2026-07-10T02:00:00Z', '2026-07-10T04:00:00Z'); // overlaps into day2 by 1 hour
  sys.runJob('2026-07-10T04:00:00Z', '2026-07-11T05:00:00Z');
});
checkScenario('6b. Two overlapping ranges, B then A', (sys) => {
  sys.runJob('2026-07-10T04:00:00Z', '2026-07-11T05:00:00Z');
  sys.runJob('2026-07-10T02:00:00Z', '2026-07-10T04:00:00Z');
});

checkScenario('7. A later day completed before its predecessor', (sys) => {
  sys.runJob('2026-07-11T04:00:00Z', '2026-07-11T05:00:00Z'); // day 3 first, day 1/2 not processed yet
  sys.runJob('2026-07-10T02:00:00Z', '2026-07-11T03:00:00Z'); // day 1+2 processed after
});

checkScenario('8. Same jobs processed by "overlapping workers" (interleaved, simulating two workers racing)', (sys) => {
  sys.runJob('2026-07-11T04:00:00Z', '2026-07-11T05:00:00Z'); // worker B grabs day 3 first
  sys.runJob('2026-07-10T02:00:00Z', '2026-07-10T03:00:00Z'); // worker A grabs day 1
  sys.runJob('2026-07-10T04:00:00Z', '2026-07-11T03:00:00Z'); // worker A grabs day 2
  sys.runJob('2026-07-11T04:00:00Z', '2026-07-11T05:00:00Z'); // day 3 naturally gets touched again by a later job/retry
});

checkScenario('10. Retry of a completed job (run every job twice)', (sys) => {
  sys.runJob('2026-07-10T02:00:00Z', '2026-07-10T03:00:00Z');
  sys.runJob('2026-07-10T02:00:00Z', '2026-07-10T03:00:00Z');
  sys.runJob('2026-07-10T04:00:00Z', '2026-07-11T03:00:00Z');
  sys.runJob('2026-07-10T04:00:00Z', '2026-07-11T03:00:00Z');
  sys.runJob('2026-07-11T04:00:00Z', '2026-07-11T05:00:00Z');
  sys.runJob('2026-07-11T04:00:00Z', '2026-07-11T05:00:00Z');
});

console.log('\n=== 9. Late reading inserted into a previously completed day, then only the automatically required recomputation ===');
{
  const sys = new FakeSystem();
  sys.seedReadings(all.filter((r) => r.measured_at !== '2026-07-10T03:00:00Z')); // omit one hour initially
  sys.runJob('2026-07-10T02:00:00Z', '2026-07-11T05:00:00Z'); // process everything without it
  const before = sys.features.get(`${VARIETY_X}|2026-07-10T04:00:00Z`);
  console.log('  before late reading, 04:00 ecDelta (predecessor 03:00 missing):', before?.ecDelta);

  // The late reading arrives (03:00's data). Per the closure proof, only
  // reprocessing 03:00's own hour (with the automatic +1h forward
  // extension covering 04:00) is required -- not the whole day, not
  // anything before 03:00.
  sys.seedReadings(all.filter((r) => r.measured_at === '2026-07-10T03:00:00Z'));
  sys.runJob('2026-07-10T03:00:00Z', '2026-07-10T03:00:00Z'); // the "automatically required recomputation" -- just this hour, +1h auto-extension covers 04:00

  const afterSnap = sys.snapshot();
  assert(afterSnap === referenceSnapshot, 'after reprocessing ONLY the late hour (with its automatic +1h extension), state converges to the full reference — no wider manual recomputation was needed');
  if (afterSnap !== referenceSnapshot) {
    const refSys = reference();
    for (const [key, refRow] of refSys.variety) {
      const actualRow = sys.variety.get(key);
      if (JSON.stringify(refRow) !== JSON.stringify(actualRow)) console.log(`    variety MISMATCH ${key}:\n      ref=${JSON.stringify(refRow)}\n      got=${JSON.stringify(actualRow)}`);
    }
    for (const [key, refRow] of refSys.features) {
      const actualRow = sys.features.get(key);
      if (JSON.stringify(refRow) !== JSON.stringify(actualRow)) console.log(`    features MISMATCH ${key}:\n      ref=${JSON.stringify(refRow)}\n      got=${JSON.stringify(actualRow)}`);
    }
    for (const [key, refRow] of refSys.phase) {
      const actualRow = sys.phase.get(key);
      if (JSON.stringify(refRow) !== JSON.stringify(actualRow)) console.log(`    phase MISMATCH ${key}:\n      ref=${JSON.stringify(refRow)}\n      got=${JSON.stringify(actualRow)}`);
    }
  }
}

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
