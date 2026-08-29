/**
 * Proves the recomputation closure is sufficient across REAL gaps (not just
 * the tidy no-gap case rollup-order-independence.test.ts covers): a reading
 * at 10:00 with nothing at 11:00/12:00 and the next reading at 13:00 must
 * have its radiation/irrigation delta computed against 10:00 (answer B, not
 * A), and a job reprocessing just 10:00 must automatically reach forward to
 * correct 13:00 -- confirmed from the actual code (computeCumulativeDelta's
 * `sameDay` check, not an adjacent-hour check) before any fix was written.
 *
 * Run with: npx tsx src/__tests__/rollup-gap-closure.test.ts
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
const ZONE_2 = { id: 'zone-2', import_key: 'Zone 2', phase_id: PHASE_A };
const VARIETY_X = 'variety-x';

function topology(): ZoneTopology {
  return {
    zoneByImportKey: new Map([['Zone 1', ZONE_1], ['Zone 2', ZONE_2]]),
    varietyToZoneLabels: new Map([[VARIETY_X, ['Zone 1', 'Zone 2']]]),
  };
}
function topologySingleZone(): ZoneTopology {
  return {
    zoneByImportKey: new Map([['Zone 1', ZONE_1]]),
    varietyToZoneLabels: new Map([[VARIETY_X, ['Zone 1']]]),
  };
}

function reading(zone: string, ts: string, metric: string, value: number): ReadingLike {
  return { zone_label: zone, measured_at: ts, metric_name: metric, value, unit: null };
}

/** Same FakeSystem pattern as the other test files -- mirrors rollupClimateReadingRange's real algorithm exactly. */
class FakeSystem {
  allReadings: ReadingLike[] = [];
  phase = new Map<string, PhaseHourlyRowOut>();
  variety = new Map<string, VarietyHourlyRowOut>();
  features = new Map<string, { ecDelta: number | null; phDelta: number | null }>();
  private topo: ZoneTopology;

  constructor(topo: ZoneTopology = topology()) { this.topo = topo; }

  seedReadings(readings: ReadingLike[]) { this.allReadings.push(...readings); }

  runJob(startIso: string, endIso: string) {
    const { readStart, readEnd } = computeRollupReadWindow(startIso, endIso);
    const readStartMs = new Date(readStart).getTime();
    const readEndMs = new Date(readEnd).getTime();
    const windowReadings = this.allReadings.filter((r) => {
      const ms = new Date(r.measured_at).getTime();
      return ms >= readStartMs && ms <= readEndMs;
    });
    if (windowReadings.length === 0) return;

    const { phaseHourlyRows: allPhase, varietyHourlyRows: allVariety } = computePhaseAndVarietyHourlyRows({
      readings: windowReadings, topology: this.topo, existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: null,
    });

    const { core: corePhase } = partitionCoreRows(allPhase, startIso);
    const { core: coreVariety } = partitionCoreRows(allVariety, startIso);

    for (const r of corePhase) this.phase.set(`${r.phase_id}|${r.measured_at}`, r);
    for (const r of coreVariety) this.variety.set(`${r.variety_id}|${r.measured_at}`, r);

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
      for (const [, r] of this.variety) { if (r.variety_id === varietyId && r.measured_at >= lookbackStart && r.measured_at <= latest) byKey.set(r.measured_at, r); }
      for (const r of allVariety) { if (r.variety_id === varietyId && r.measured_at >= lookbackStart && r.measured_at <= latest) byKey.set(r.measured_at, r); }
      const rows = Array.from(byKey.values()).sort((a, b) => (a.measured_at < b.measured_at ? -1 : 1));

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.measured_at < earliest) continue;
        const previousRow = i > 0 ? rows[i - 1] : null;
        const toLike = (r: VarietyHourlyRowOut): VarietyClimateHourlyRowLike => ({
          variety_id: r.variety_id, measured_at: r.measured_at,
          air_temperature_avg_c: r.air_temperature_avg_c, relative_humidity_avg_pct: r.relative_humidity_avg_pct,
          vpd_avg_kpa: r.vpd_avg_kpa, co2_avg_ppm: r.co2_avg_ppm, ec_avg: r.ec_avg, ph_avg: r.ph_avg,
          irrigation_interval_delta_ml: r.irrigation_interval_delta_ml, irrigation_interval_minutes: r.irrigation_interval_minutes,
          radiation_interval_delta_j_cm2: r.radiation_interval_delta_j_cm2,
        });
        const computed: HourlyClimateFeatures = computeHourlyFeatures(toLike(row), previousRow ? toLike(previousRow) : null);
        this.features.set(`${varietyId}|${row.measured_at}`, { ecDelta: computed.ecDelta, phDelta: computed.phDelta });
      }
    }
  }

  snapshot(): string {
    return JSON.stringify({ phase: [...this.phase.entries()].sort(), variety: [...this.variety.entries()].sort(), features: [...this.features.entries()].sort() });
  }
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== Confirmed from the actual code: which semantics apply ===\n');
console.log('  radiation/irrigation (computeCumulativeDelta): answer B -- uses the previous AVAILABLE reading, gated only by same greenhouse-local day (confirmed: no adjacent-hour check in the source)');
console.log('  EC/pH (computeHourlyFeatures.adjacentHour): answer A -- requires EXACTLY 3,600,000ms prior; any gap nulls the delta (confirmed: `=== 3600000` in the source)');

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== One missing hour: 10:00 reading, GAP at 11:00, next reading at 12:00 ===');
{
  const sys = new FakeSystem(topologySingleZone());
  sys.seedReadings([
    reading('Zone 1', '2026-07-10T10:00:00Z', 'radiation_sum_j_cm2', 500),
    reading('Zone 1', '2026-07-10T12:00:00Z', 'radiation_sum_j_cm2', 560),
  ]);
  sys.runJob('2026-07-10T10:00:00Z', '2026-07-10T12:00:00Z');
  const at12 = sys.phase.get(`${PHASE_A}|2026-07-10T12:00:00Z`)!;
  assert(at12.radiation_interval_delta_j_cm2 === 60, `12:00 delta uses 10:00 as predecessor (560-500=60), not first_reading_of_day (got ${at12.radiation_interval_delta_j_cm2})`);
  assert(at12.radiation_quality_flag === 'ok', '12:00 correctly flagged ok, not first_reading_of_day');
}

console.log('\n=== Several consecutive missing hours: 10:00, then GAP 11:00-16:00 (6 hours), next reading 17:00 ===');
{
  const sys = new FakeSystem(topologySingleZone());
  sys.seedReadings([
    reading('Zone 1', '2026-07-10T10:00:00Z', 'radiation_sum_j_cm2', 500),
    reading('Zone 1', '2026-07-10T17:00:00Z', 'radiation_sum_j_cm2', 610),
  ]);
  sys.runJob('2026-07-10T10:00:00Z', '2026-07-10T17:00:00Z');
  const at17 = sys.phase.get(`${PHASE_A}|2026-07-10T17:00:00Z`)!;
  assert(at17.radiation_interval_delta_j_cm2 === 110, `17:00 delta uses 10:00 as predecessor across a 6-hour gap (610-500=110) (got ${at17.radiation_interval_delta_j_cm2})`);
}

console.log('\n=== Missing hours across greenhouse-local midnight (04:00 UTC in July): gap straddles the reset ===');
{
  const sys = new FakeSystem(topologySingleZone());
  sys.seedReadings([
    reading('Zone 1', '2026-07-10T02:00:00Z', 'radiation_sum_j_cm2', 700), // before local midnight
    // gap through 03:00, 04:00, 05:00, 06:00 (crosses the 04:00 local-day reset)
    reading('Zone 1', '2026-07-10T07:00:00Z', 'radiation_sum_j_cm2', 90),  // after local midnight, new local day
  ]);
  sys.runJob('2026-07-10T02:00:00Z', '2026-07-10T07:00:00Z');
  const at07 = sys.phase.get(`${PHASE_A}|2026-07-10T07:00:00Z`)!;
  assert(at07.radiation_quality_flag === 'first_reading_of_day', '07:00 (new local day) is first_reading_of_day DESPITE 02:00 having data -- the reset, not the gap, is what breaks this chain');
  assert(at07.radiation_interval_delta_j_cm2 === null, '07:00 delta is null, not 90-700=-610 -- crossing the reset always resets regardless of gap length');
}

console.log('\n=== Next reading BEFORE a reset (same local day, gap, then reading) vs AFTER a reset (new local day) ===');
{
  const sys = new FakeSystem(topologySingleZone());
  sys.seedReadings([
    reading('Zone 1', '2026-07-10T01:00:00Z', 'radiation_sum_j_cm2', 650),
    reading('Zone 1', '2026-07-10T03:00:00Z', 'radiation_sum_j_cm2', 700),  // before reset (still same local day as 01:00) -- gap at 02:00
    reading('Zone 1', '2026-07-10T05:00:00Z', 'radiation_sum_j_cm2', 40),   // after reset (new local day) -- gap at 04:00
  ]);
  sys.runJob('2026-07-10T01:00:00Z', '2026-07-10T05:00:00Z');
  const at03 = sys.phase.get(`${PHASE_A}|2026-07-10T03:00:00Z`)!;
  assert(at03.radiation_interval_delta_j_cm2 === 50, `next reading BEFORE the reset uses the gapped predecessor (700-650=50) (got ${at03.radiation_interval_delta_j_cm2})`);
  const at05 = sys.phase.get(`${PHASE_A}|2026-07-10T05:00:00Z`)!;
  assert(at05.radiation_quality_flag === 'first_reading_of_day', 'next reading AFTER the reset is first_reading_of_day regardless of what came before');
}

console.log('\n=== Late insertion into the BEGINNING of a gap (the gap-starting hour arrives late) ===');
{
  const sys = new FakeSystem(topologySingleZone());
  sys.seedReadings([reading('Zone 1', '2026-07-10T15:00:00Z', 'radiation_sum_j_cm2', 620)]); // only the far side of the gap exists initially
  sys.runJob('2026-07-10T15:00:00Z', '2026-07-10T15:00:00Z');
  assert(sys.phase.get(`${PHASE_A}|2026-07-10T15:00:00Z`)!.radiation_quality_flag === 'first_reading_of_day', 'before the late reading, 15:00 has no predecessor');

  sys.seedReadings([reading('Zone 1', '2026-07-10T10:00:00Z', 'radiation_sum_j_cm2', 500)]); // the late reading: the START of what will become a gap
  sys.runJob('2026-07-10T10:00:00Z', '2026-07-10T10:00:00Z'); // reprocess just the late hour -- closure must reach all the way to 15:00
  const at15 = sys.phase.get(`${PHASE_A}|2026-07-10T15:00:00Z`)!;
  assert(at15.radiation_interval_delta_j_cm2 === 120, `after the late insertion, reprocessing ONLY 10:00 automatically corrects 15:00's delta (620-500=120) across the 5-hour gap (got ${at15.radiation_interval_delta_j_cm2})`);
}

console.log('\n=== Late insertion into the MIDDLE of a gap ===');
{
  const sys = new FakeSystem(topologySingleZone());
  sys.seedReadings([
    reading('Zone 1', '2026-07-10T10:00:00Z', 'radiation_sum_j_cm2', 500),
    reading('Zone 1', '2026-07-10T15:00:00Z', 'radiation_sum_j_cm2', 620),
  ]);
  sys.runJob('2026-07-10T10:00:00Z', '2026-07-10T15:00:00Z');
  assert(sys.phase.get(`${PHASE_A}|2026-07-10T15:00:00Z`)!.radiation_interval_delta_j_cm2 === 120, 'before the late reading, 15:00 delta spans the full original gap (620-500=120)');

  sys.seedReadings([reading('Zone 1', '2026-07-10T12:00:00Z', 'radiation_sum_j_cm2', 550)]); // late reading lands in the MIDDLE of the gap
  sys.runJob('2026-07-10T12:00:00Z', '2026-07-10T12:00:00Z'); // reprocess just the new middle hour -- closure must reach forward to 15:00 (the NEXT actual reading), not stop at a fixed +1h
  const at12 = sys.phase.get(`${PHASE_A}|2026-07-10T12:00:00Z`)!;
  assert(at12.radiation_interval_delta_j_cm2 === 50, `the new middle hour's own delta is correct against 10:00 (550-500=50) (got ${at12.radiation_interval_delta_j_cm2})`);
  const at15 = sys.phase.get(`${PHASE_A}|2026-07-10T15:00:00Z`)!;
  assert(at15.radiation_interval_delta_j_cm2 === 70, `15:00 is automatically corrected to use the NEW middle reading as its predecessor (620-550=70), not left at the stale 120 (got ${at15.radiation_interval_delta_j_cm2})`);
}

console.log('\n=== Late insertion into the END of a gap (right before the next existing reading) ===');
{
  const sys = new FakeSystem(topologySingleZone());
  sys.seedReadings([
    reading('Zone 1', '2026-07-10T10:00:00Z', 'radiation_sum_j_cm2', 500),
    reading('Zone 1', '2026-07-10T15:00:00Z', 'radiation_sum_j_cm2', 620),
  ]);
  sys.runJob('2026-07-10T10:00:00Z', '2026-07-10T15:00:00Z');

  sys.seedReadings([reading('Zone 1', '2026-07-10T14:00:00Z', 'radiation_sum_j_cm2', 610)]); // late reading lands right before 15:00
  sys.runJob('2026-07-10T14:00:00Z', '2026-07-10T14:00:00Z');
  const at14 = sys.phase.get(`${PHASE_A}|2026-07-10T14:00:00Z`)!;
  assert(at14.radiation_interval_delta_j_cm2 === 110, `14:00's own delta against 10:00 (610-500=110) (got ${at14.radiation_interval_delta_j_cm2})`);
  const at15 = sys.phase.get(`${PHASE_A}|2026-07-10T15:00:00Z`)!;
  assert(at15.radiation_interval_delta_j_cm2 === 10, `15:00 is corrected to use the new 14:00 reading (620-610=10), not the stale 10:00-based value (got ${at15.radiation_interval_delta_j_cm2})`);
}

console.log('\n=== Different zones having different next-reading timestamps (variety-level irrigation, cross-zone average) ===');
{
  const sys = new FakeSystem(topology()); // 2-zone topology
  sys.seedReadings([
    reading('Zone 1', '2026-07-10T10:00:00Z', 'irrigation_cumulative_ml', 300),
    reading('Zone 2', '2026-07-10T10:00:00Z', 'irrigation_cumulative_ml', 320),
    // Zone 1 reports again at 12:00, Zone 2 doesn't report until 14:00 -- different next-reading times per zone
    reading('Zone 1', '2026-07-10T12:00:00Z', 'irrigation_cumulative_ml', 340),
    reading('Zone 2', '2026-07-10T14:00:00Z', 'irrigation_cumulative_ml', 360),
  ]);
  sys.runJob('2026-07-10T10:00:00Z', '2026-07-10T14:00:00Z');

  // 12:00: only Zone 1 reports -> variety avg = 340 (Zone 1 alone). Predecessor avg at 10:00 = (300+320)/2 = 310.
  const at12 = sys.variety.get(`${VARIETY_X}|2026-07-10T12:00:00Z`)!;
  assert(at12.irrigation_cumulative_avg_ml === 340, `12:00 variety avg is Zone 1 alone (340) since Zone 2 didn't report (got ${at12.irrigation_cumulative_avg_ml})`);
  assert(at12.irrigation_interval_delta_ml === 30, `12:00 delta vs the 10:00 two-zone average (340-310=30) (got ${at12.irrigation_interval_delta_ml})`);

  // 14:00: only Zone 2 reports -> variety avg = 360. Predecessor is 12:00's avg (340, not 310) -- the MOST RECENT available, per-variety, not per-zone.
  const at14 = sys.variety.get(`${VARIETY_X}|2026-07-10T14:00:00Z`)!;
  assert(at14.irrigation_cumulative_avg_ml === 360, `14:00 variety avg is Zone 2 alone (360) (got ${at14.irrigation_cumulative_avg_ml})`);
  assert(at14.irrigation_interval_delta_ml === 20, `14:00 delta vs the MOST RECENT variety-level average (12:00's 340), not per-zone (360-340=20) (got ${at14.irrigation_interval_delta_ml})`);
}

console.log('\n=== EC/pH cross-midnight adjacency: reaches across local midnight when hours are truly adjacent (no gap), unlike radiation/irrigation ===');
{
  const sys = new FakeSystem(topologySingleZone());
  sys.seedReadings([
    reading('Zone 1', '2026-07-10T03:00:00Z', 'ec', 2.0), // last hour of local day N
    reading('Zone 1', '2026-07-10T04:00:00Z', 'ec', 2.3), // first hour of local day N+1, exactly 1h later, no gap
  ]);
  sys.runJob('2026-07-10T03:00:00Z', '2026-07-10T04:00:00Z');
  const f04 = sys.features.get(`${VARIETY_X}|2026-07-10T04:00:00Z`)!;
  assert(f04.ecDelta !== null && Math.abs(f04.ecDelta - 0.3) < 0.001, `EC delta crosses local midnight when truly adjacent (2.3-2.0=0.3), confirming the edge-case fix (endIso+1h) was necessary (got ${f04.ecDelta})`);
}

console.log('\n=== Continuous vs. gap-aware daily-chunked processing, full comparison ===');
{
  const readings: ReadingLike[] = [
    reading('Zone 1', '2026-07-10T09:00:00Z', 'radiation_sum_j_cm2', 480),
    reading('Zone 1', '2026-07-10T10:00:00Z', 'radiation_sum_j_cm2', 500),
    // gap 11:00-12:00
    reading('Zone 1', '2026-07-10T13:00:00Z', 'radiation_sum_j_cm2', 580),
    reading('Zone 1', '2026-07-10T14:00:00Z', 'radiation_sum_j_cm2', 600),
  ];
  const ref = new FakeSystem(topologySingleZone());
  ref.seedReadings(readings);
  ref.runJob('2026-07-10T09:00:00Z', '2026-07-10T14:00:00Z');

  const daily = new FakeSystem(topologySingleZone());
  daily.seedReadings(readings);
  daily.runJob('2026-07-10T09:00:00Z', '2026-07-10T10:00:00Z');
  daily.runJob('2026-07-10T13:00:00Z', '2026-07-10T14:00:00Z');

  assert(ref.snapshot() === daily.snapshot(), 'continuous and gap-spanning-daily-chunked processing converge to byte-identical output');
}

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
