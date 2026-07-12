/**
 * Regression tests for the shared radiation-accumulation rule
 * (sumAccumulatedRadiationJCm2 in climateFeatures.ts): negative interval
 * deltas — sensor/cumulative-counter resets, confirmed against real data to
 * happen mid-day, not just at the local-day boundary — must never be summed
 * into an accumulated radiation total, in any of the three places that
 * report one (variety-hourly route, variety-features route,
 * aggregateExposureWindow).
 *
 * Run with: npx tsx src/__tests__/radiation-accumulation.test.ts
 *
 * No external dependencies — pure function tests.
 */
import { sumAccumulatedRadiationJCm2, aggregateExposureWindow, type ExposureHourlyInput, type HourlyClimateFeatures } from '../lib/climateFeatures';

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

// ── sumAccumulatedRadiationJCm2 ─────────────────────────────────────────────
console.log('\nsumAccumulatedRadiationJCm2');
{
  assert('sums plain positive deltas', sumAccumulatedRadiationJCm2([100, 50, 30]), 180);
  assert('excludes a single mid-series negative reset (real-world shape: climb, reset, climb again)', sumAccumulatedRadiationJCm2([100, 50, -180, 20, 40]), 210);
  assert('excludes multiple negative resets', sumAccumulatedRadiationJCm2([-3072, 11.5, 61.7, -50, 129.5]), 202.7);
  assert('treats null as absent, not zero', sumAccumulatedRadiationJCm2([100, null, 50]), 150);
  assert('an all-negative series (every reading a reset) sums to null, not 0 or negative', sumAccumulatedRadiationJCm2([-10, -20]), null);
  assert('an empty series sums to null', sumAccumulatedRadiationJCm2([]), null);
  assert('an all-null series sums to null', sumAccumulatedRadiationJCm2([null, null]), null);
  assert('zero deltas are included (a real, valid reading of no radiation)', sumAccumulatedRadiationJCm2([0, 0, 5]), 5);
  assert('rounds to 2 decimals, matching the numeric(10,2) source column', sumAccumulatedRadiationJCm2([1.005, 1.005]), 2.01);
  // The exact real-world case that motivated this fix: Cadalora week 2026-W28
  // summed to -3716.7 J/cm2 before the fix (physically impossible) because a
  // recurring ~06:00-local sensor reset's negative delta was summed in.
  assert(
    'real-world regression case: a week with 6 daily resets no longer sums negative',
    sumAccumulatedRadiationJCm2([200.8, 1142.4, -1311.1, 618.5, -2453.5, -593.6, -3072, -322.1, -2478.4, 43.5, -2403.1]) as number > 0,
    true
  );
}

// ── aggregateExposureWindow uses the same rule for accumulatedRadiationJCm2 ─
console.log('\naggregateExposureWindow radiation accumulation');
{
  function makeRow(measuredAt: string, radiationIntervalDeltaJCm2: number | null): ExposureHourlyInput {
    const features: HourlyClimateFeatures = {
      varietyId: 'test-variety',
      measuredAt,
      degreeHours: 0,
      vpdKpa: null,
      vpdBand: null,
      isDaylight: radiationIntervalDeltaJCm2 != null && radiationIntervalDeltaJCm2 > 0,
      ecDelta: null,
      phDelta: null,
      airTemperatureAvgC: null,
      co2AvgPpm: null,
      radiationIntervalDeltaJCm2,
      irrigationIntervalDeltaMl: null,
      irrigationIntervalMinutes: null,
      degreeHourBaseTempC: 10,
      degreeHourUpperCapC: 30,
      vpdBandConfigVersion: 'test',
      featureEngineVersion: 'test',
    };
    return { measuredAt, ecAvg: null, phAvg: null, features };
  }

  const rows = [
    makeRow('2026-07-09T04:00:00Z', 100),
    makeRow('2026-07-09T05:00:00Z', 200),
    makeRow('2026-07-09T06:00:00Z', -300), // mid-day sensor reset, matches real Zone 1 data shape
    makeRow('2026-07-09T07:00:00Z', 50),
  ];
  const result = aggregateExposureWindow(rows, 4);
  assert('accumulatedRadiationJCm2 excludes the negative reset (100+200+50, not -300 subtracted)', result.accumulatedRadiationJCm2, 350);
  assert('hoursObserved still counts a reset hour if it has other real inputs', result.hoursObserved >= 0, true);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
