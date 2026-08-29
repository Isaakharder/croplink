/**
 * Validates the variety-level linked-zone aggregation rule against Mathieu's
 * real Zones 1-6 topology, using the actual raw readings captured live for
 * 2026-07-10T14:00:00Z (see round10-phase-zoneagg-audit.ts):
 *
 *   temperature_c:          Z1=24.6 Z2=24.4 Z3=24.8 Z4=24.2 Z5=25.0 Z6=24.6
 *   relative_humidity_pct:  Z1=87   Z2=88   Z3=86   Z4=87   Z5=89   Z6=90
 *   co2_ppm:                Z1=394  Z2=394  Z3=394  Z4=394  Z5=394  Z6=369
 *   ec:                     Z1=2.8  Z2=2.8  Z3=2.8  Z4=2.8  Z5=2.8  Z6=2.8
 *   ph:                     Z1=4.6  Z2=4.9  Z3=4.6  Z4=4.9  Z5=4.6  Z6=4.9
 *   irrigation_cumulative_ml: Z1=218 Z2=237 Z3=218 Z4=237 Z5=218 Z6=237
 *
 * Run with: npx tsx src/__tests__/zone-aggregation.test.ts
 */
import { computeVarietyHourlyRow, computeVpdKpaForZone, type VarietyHourlyInput } from '../lib/climateAveraging';
import { aggregateExposureWindow, type ExposureHourlyInput, type HourlyClimateFeatures } from '../lib/climateFeatures';
import type { ZoneReading } from '../lib/ridderParser';

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}
function assertClose(actual: number | null, expected: number, tol: number, msg: string) {
  assert(actual != null && Math.abs(actual - expected) <= tol, `${msg} (expected ~${expected}, got ${actual})`);
}

const ZONES = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'Zone 5', 'Zone 6'];
const TEMP: Record<string, number> = { 'Zone 1': 24.6, 'Zone 2': 24.4, 'Zone 3': 24.8, 'Zone 4': 24.2, 'Zone 5': 25.0, 'Zone 6': 24.6 };
const RH: Record<string, number> = { 'Zone 1': 87, 'Zone 2': 88, 'Zone 3': 86, 'Zone 4': 87, 'Zone 5': 89, 'Zone 6': 90 };
const CO2: Record<string, number> = { 'Zone 1': 394, 'Zone 2': 394, 'Zone 3': 394, 'Zone 4': 394, 'Zone 5': 394, 'Zone 6': 369 };
const EC: Record<string, number> = { 'Zone 1': 2.8, 'Zone 2': 2.8, 'Zone 3': 2.8, 'Zone 4': 2.8, 'Zone 5': 2.8, 'Zone 6': 2.8 };
const PH: Record<string, number> = { 'Zone 1': 4.6, 'Zone 2': 4.9, 'Zone 3': 4.6, 'Zone 4': 4.9, 'Zone 5': 4.6, 'Zone 6': 4.9 };

function buildReadings(zonesReporting: string[]): ZoneReading[] {
  const readings: ZoneReading[] = [];
  for (const z of zonesReporting) {
    readings.push({ zoneLabel: z, metricName: 'temperature_c', value: TEMP[z], unit: '°C' });
    readings.push({ zoneLabel: z, metricName: 'relative_humidity_pct', value: RH[z], unit: '%' });
    readings.push({ zoneLabel: z, metricName: 'co2_ppm', value: CO2[z], unit: 'ppm' });
    readings.push({ zoneLabel: z, metricName: 'ec', value: EC[z], unit: 'mS/cm' });
    readings.push({ zoneLabel: z, metricName: 'ph', value: PH[z], unit: '' });
  }
  return readings;
}

function run(zonesReporting: string[]): ReturnType<typeof computeVarietyHourlyRow> {
  const input: VarietyHourlyInput = {
    measuredAt: new Date('2026-07-10T14:00:00Z'),
    linkedZoneLabels: ZONES,
    readings: buildReadings(zonesReporting),
    previousIrrigationCumulative: null,
    phaseId: 'phase-a',
    phaseRadiation: null,
    timeZone: 'America/Toronto',
  };
  return computeVarietyHourlyRow(input);
}

// Correct per-zone-then-averaged VPD, computed independently in this test
// (not reusing computeVarietyHourlyRow's own logic) as a ground-truth check.
function expectedVpdAvg(zonesReporting: string[]): number {
  const vpds = zonesReporting.map((z) => computeVpdKpaForZone(TEMP[z], RH[z])!);
  return vpds.reduce((a, b) => a + b, 0) / vpds.length;
}

// ═══════════════════════════════════════════════════════════════════════
console.log('6/6 zones reporting — full coverage, plain average');
{
  const r = run(ZONES);
  assert(r.temporalCovered === true, 'temporalCovered is true');
  assert(r.zonesLinked === 6, 'zonesLinked is 6');
  assert(r.zonesReporting === 6, 'zonesReporting is 6');
  assert(r.zoneParticipationPct === 100, 'zoneParticipationPct is 100');
  assertClose(r.airTemperatureAvgC, (24.6 + 24.4 + 24.8 + 24.2 + 25.0 + 24.6) / 6, 0.01, 'temp avg matches plain mean of all 6');
  assertClose(r.vpdAvgKpa, expectedVpdAvg(ZONES), 0.0005, 'VPD avg matches per-zone-then-averaged ground truth');
}

console.log('\n5/6 zones reporting (Zone 6 missing) — still fully covered, averages the 5 that reported');
{
  const reporting = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'Zone 5'];
  const r = run(reporting);
  assert(r.temporalCovered === true, 'temporalCovered is true (5/6 is not missing)');
  assert(r.zonesReporting === 5, 'zonesReporting is 5');
  assertClose(r.zoneParticipationPct!, (5 / 6) * 100, 0.01, 'zoneParticipationPct is 83.33%, not reduced to 0');
  assertClose(r.airTemperatureAvgC, (24.6 + 24.4 + 24.8 + 24.2 + 25.0) / 5, 0.01, 'temp avg is the 5-zone average, not diluted by a phantom Zone 6');
  assert(r.airTemperatureZoneCount === 5, 'air_temperature_zone_count is 5');
  assertClose(r.vpdAvgKpa, expectedVpdAvg(reporting), 0.0005, 'VPD avg is the 5-zone per-zone-then-averaged value');
  assert(r.warnings.some((w) => w.includes('5/6')), 'a low-participation warning is recorded (informational, not a missing-hour flag)');
}

console.log('\n1/6 zones reporting (only Zone 1) — still covered, but low participation');
{
  const r = run(['Zone 1']);
  assert(r.temporalCovered === true, 'temporalCovered is true (1/6 is still covered, per the explicit rule)');
  assert(r.zonesReporting === 1, 'zonesReporting is 1');
  assertClose(r.zoneParticipationPct!, (1 / 6) * 100, 0.01, 'zoneParticipationPct is 16.67%');
  assertClose(r.airTemperatureAvgC, 24.6, 0.01, 'temp avg is Zone 1 alone, not averaged against 5 phantom zeros');
  assertClose(r.vpdAvgKpa, computeVpdKpaForZone(24.6, 87)!, 0.0005, 'VPD is Zone 1\'s own per-zone value');
  assert(r.warnings.some((w) => w.toLowerCase().includes('low')), 'a low-zone-participation warning is recorded');
}

console.log('\n0/6 zones reporting — the ONLY condition that makes the hour missing');
{
  const r = run([]);
  assert(r.temporalCovered === false, 'temporalCovered is false');
  assert(r.zonesReporting === 0, 'zonesReporting is 0');
  assert(r.zoneParticipationPct === 0, 'zoneParticipationPct is 0');
  assert(r.airTemperatureAvgC === null, 'temp avg is null, not 0');
  assert(r.vpdAvgKpa === null, 'VPD avg is null, not 0');
}

console.log('\nA missing zone never contributes zero to any average');
{
  const withZone6 = run(ZONES);
  const withoutZone6 = run(['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'Zone 5']);
  // If a missing zone were silently treated as 0, dropping Zone 6 (whose
  // temp/RH/CO2 are all well above zero) would DECREASE the average sharply
  // toward zero. Instead it should shift only slightly, matching the
  // 5-zone-only mean, because the missing zone is excluded, not zeroed.
  assertClose(withoutZone6.airTemperatureAvgC, (24.6 + 24.4 + 24.8 + 24.2 + 25.0) / 5, 0.01, 'dropping a zone reduces the divisor, not the numerator toward a phantom 0');
  assert(withoutZone6.airTemperatureAvgC! > 20, 'temp avg stays in a physically plausible range, nowhere near 0');
}

console.log('\nVPD: per-zone-then-averaged vs. the old (buggy) averaged-T/RH-first approach');
{
  const r = run(ZONES);
  const avgT = (24.6 + 24.4 + 24.8 + 24.2 + 25.0 + 24.6) / 6;
  const avgRh = (87 + 88 + 86 + 87 + 89 + 90) / 6;
  const buggyVpd = computeVpdKpaForZone(avgT, avgRh); // what the old code computed: VPD(avg(T), avg(RH))
  const correctVpd = expectedVpdAvg(ZONES); // avg(VPD(T_i, RH_i)) — the corrected math
  assertClose(r.vpdAvgKpa, correctVpd, 0.0005, 'computeVarietyHourlyRow returns the CORRECT per-zone-averaged VPD');
  console.log(`      (for reference: old buggy method would have given ${buggyVpd}, corrected gives ${correctVpd} — for Mathieu's tightly-clustered zones the gap is small, but the direction of the fix is what matters for zones that diverge more)`);
}

console.log('\nOutlier flagging: one extreme sensor reading is flagged, never silently excluded from the average');
{
  const extremeTemp: Record<string, number> = { ...TEMP, 'Zone 3': 45.0 }; // Zone 3 implausibly hot vs. its neighbors (24.2-25.0)
  const readings: ZoneReading[] = ZONES.flatMap((z) => [
    { zoneLabel: z, metricName: 'temperature_c', value: extremeTemp[z], unit: '°C' } as ZoneReading,
    { zoneLabel: z, metricName: 'relative_humidity_pct', value: RH[z], unit: '%' } as ZoneReading,
  ]);
  const input: VarietyHourlyInput = {
    measuredAt: new Date('2026-07-10T14:00:00Z'), linkedZoneLabels: ZONES, readings,
    previousIrrigationCumulative: null, phaseId: 'phase-a', phaseRadiation: null, timeZone: 'America/Toronto',
  };
  const r = computeVarietyHourlyRow(input);
  const expectedAvgWithOutlier = (24.6 + 24.4 + 45.0 + 24.2 + 25.0 + 24.6) / 6;
  assertClose(r.airTemperatureAvgC, expectedAvgWithOutlier, 0.01, 'the outlier IS included in the average — flagged, not silently dropped');
  assert(r.zoneDiagnostics.temperature_c.outlierFlagged === true, 'temperature outlier is flagged');
  assert(r.zoneDiagnostics.temperature_c.outlierZone === 'Zone 3', 'the flagged zone is correctly identified as Zone 3');
  assert(r.zoneDiagnostics.temperature_c.max === 45.0, 'zone max reflects the extreme reading');
  assert(r.zoneDiagnostics.temperature_c.min === 24.2, 'zone min reflects the coolest real zone');
  assertClose(r.zoneDiagnostics.temperature_c.spread!, 45.0 - 24.2, 0.01, 'spread is max-min across all reporting zones');
  assert(r.warnings.some((w) => w.includes('Zone 3') && w.includes('disagrees')), 'a human-readable disagreement warning is recorded');
  assert(r.zonesReporting === 6, 'the outlier zone still counts toward zonesReporting/temporalCovered — an implausible value is not the same as a missing one');
}

console.log('\nNo outlier flag when zones genuinely agree (tight real-world spread)');
{
  const r = run(ZONES);
  assert(r.zoneDiagnostics.temperature_c.outlierFlagged === false, 'no temperature outlier flagged for the real, tightly-clustered data');
  assert(r.zoneDiagnostics.relative_humidity_pct.outlierFlagged === false, 'no RH outlier flagged');
}

console.log('\nWeighting method is documented as equal averaging (no area data exists to weight by)');
{
  const r = run(ZONES);
  assert(r.zoneDiagnostics.weightingMethod === 'equal', "weightingMethod is 'equal'");
}

console.log('\nEC/pH duplicate-zone-pair pattern (Zones 1/3/5 vs 2/4/6 mirror each other in real data) does not distort the average');
{
  const r = run(ZONES);
  // (2.8*6)/6 = 2.8 exactly; (4.6*3 + 4.9*3)/6 = 4.75 exactly — both match a
  // plain mean, confirming the duplication (if it reflects only 2 physical
  // sensors, not 6) doesn't bias the CENTRAL value, even though zonesReporting=6
  // overstates independent confirmation. See the round's report for the caveat.
  assertClose(r.ecAvg, 2.8, 0.001, 'EC avg unaffected by the duplicate pattern');
  assertClose(r.phAvg, 4.75, 0.001, 'pH avg is the midpoint of the two distinct underlying values');
}

console.log('\nEnd-to-end: coveragePct is NOT reduced from 100% by a 5/6-zone hour, only by a genuinely missing hour');
{
  function makeInput(hour: number, temporalCovered: boolean): ExposureHourlyInput {
    const features: HourlyClimateFeatures = {
      varietyId: 'v', measuredAt: `2026-07-10T${String(hour).padStart(2, '0')}:00:00Z`,
      degreeHours: temporalCovered ? 5 : null, vpdKpa: null, vpdSource: 'per_zone_averaged', vpdBand: null,
      isDaylight: false, ecDelta: null, phDelta: null, airTemperatureAvgC: null, co2AvgPpm: null,
      radiationIntervalDeltaJCm2: null, irrigationIntervalDeltaMl: null, irrigationIntervalMinutes: null,
      degreeHourBaseTempC: 10, degreeHourUpperCapC: 30, vpdBandConfigVersion: 'v1', featureEngineVersion: 'v1',
    };
    return { measuredAt: features.measuredAt, ecAvg: null, phAvg: null, features, temporalCovered };
  }
  // 24 hours, every one of them only 5/6-zone-covered (temporalCovered=true
  // regardless of partial participation) -- should read as 100% coverage.
  const allPartiallyCovered = Array.from({ length: 24 }, (_, h) => makeInput(h, true));
  const fullDayResult = aggregateExposureWindow(allPartiallyCovered, 24);
  assert(fullDayResult.coveragePct === 100, `24 hours, all temporalCovered=true (even if only 5/6 zones each) -> 100% coverage, got ${fullDayResult.coveragePct}%`);

  // Same 24 hours, but 6 of them are genuinely missing (0/6 zones, temporalCovered=false).
  const withGaps = Array.from({ length: 24 }, (_, h) => makeInput(h, h % 4 !== 0));
  const gapsResult = aggregateExposureWindow(withGaps, 24);
  assertClose(gapsResult.coveragePct, 75, 0.01, '6/24 genuinely missing hours -> 75% coverage');
}

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
