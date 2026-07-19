/**
 * Regression tests for the pH sentinel-zero exclusion
 * (SENTINEL_ZERO_METRICS in climateAveraging.ts): a raw pH reading of
 * exactly 0 is a known sensor/fault sentinel (confirmed against real data —
 * see the comment on SENTINEL_ZERO_METRICS), not a real measurement, and
 * must be excluded before averaging rather than treated as a real zero.
 * Also proves EC deliberately does NOT get this treatment (investigated,
 * found not to have the same pattern), and that the exclusion rule applies
 * identically no matter what "source" the readings came from — there is no
 * source/organization field on ZoneReading for it to branch on.
 *
 * Run with: npx tsx src/__tests__/ph-sentinel-zero.test.ts
 *
 * No external dependencies — pure function tests.
 */
import { computeVarietyHourlyRow, type VarietyHourlyInput } from '../lib/climateAveraging';
import type { ZoneReading } from '../lib/ridderParser';

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

const ZONES = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'Zone 5', 'Zone 6'];
const MEASURED_AT = new Date('2026-07-17T06:00:00Z');

function reading(zoneLabel: string, metricName: string, value: number): ZoneReading {
  return { zoneLabel, metricName, value, unit: '' };
}

function baseInput(readings: ZoneReading[]): VarietyHourlyInput {
  return {
    measuredAt: MEASURED_AT,
    linkedZoneLabels: ZONES,
    readings,
    previousIrrigationCumulative: null,
    phaseId: null,
    phaseRadiation: null,
    timeZone: 'America/Toronto',
  };
}

console.log('\npH sentinel-zero exclusion');
{
  // Real-world shape: all 6 zones report a sensor-fault 0 during an inactive
  // irrigation window — every other metric at the same hour stays normal.
  const readings: ZoneReading[] = ZONES.flatMap((z) => [
    reading(z, 'ph', 0),
    reading(z, 'temperature_c', 19.7),
    reading(z, 'ec', 2.2),
  ]);
  const result = computeVarietyHourlyRow(baseInput(readings));
  assert('all-zero pH hour -> phAvg is null, not 0', result.phAvg, null);
  assert('all-zero pH hour -> phZoneCount is 0, not 6', result.phZoneCount, 0);
  assert('other metrics at the same hour are unaffected', result.airTemperatureAvgC, 19.7);
  assert('a warning is recorded for the missing pH reading', result.warnings.includes('pH: no valid linked-zone reading'), true);
}

{
  // Mixed hour: half the zones sentinel-zero, half real — the real ones
  // must be averaged on their own, not dragged down by the zeros.
  const readings: ZoneReading[] = [
    reading('Zone 1', 'ph', 0),
    reading('Zone 2', 'ph', 0),
    reading('Zone 3', 'ph', 0),
    reading('Zone 4', 'ph', 4.8),
    reading('Zone 5', 'ph', 4.8),
    reading('Zone 6', 'ph', 5.0),
  ];
  const result = computeVarietyHourlyRow(baseInput(readings));
  assert('mixed hour -> phAvg averages only the 3 valid zones', result.phAvg, 4.8667);
  assert('mixed hour -> phZoneCount counts only the 3 valid zones', result.phZoneCount, 3);
  assert('a partial-coverage warning is recorded', result.warnings.includes('pH: 3/6 zones contributed'), true);
}

{
  // No zero involved at all — must average normally, unaffected by the fix.
  const readings: ZoneReading[] = ZONES.map((z) => reading(z, 'ph', 4.9));
  const result = computeVarietyHourlyRow(baseInput(readings));
  assert('all-real pH hour -> phAvg is the plain average', result.phAvg, 4.9);
  assert('all-real pH hour -> phZoneCount is 6', result.phZoneCount, 6);
}

console.log('\nEC — deliberately NOT given the same treatment (investigated, pattern not found)');
{
  const readings: ZoneReading[] = ZONES.map((z) => reading(z, 'ec', 0));
  const result = computeVarietyHourlyRow(baseInput(readings));
  assert('an all-zero EC hour is still averaged as a real 0, unlike pH', result.ecAvg, 0);
  assert('an all-zero EC hour still counts all 6 zones as contributing, unlike pH', result.ecZoneCount, 6);
}

console.log('\nSource-agnostic aggregation — the same math regardless of where readings came from');
{
  // ZoneReading has no source/organization field for the function to branch
  // on — this proves readings representing a manual-CSV-import provenance
  // and readings representing a Synopta-Agent provenance (modeled here as
  // two independently-built reading sets with the same shape, since the
  // pure calculation layer has no way to tell them apart) produce identical
  // output when they carry the same values.
  const manualProvenanceReadings: ZoneReading[] = [
    reading('Zone 1', 'ph', 0), reading('Zone 2', 'ph', 4.8), reading('Zone 3', 'ph', 4.8),
    reading('Zone 4', 'ph', 4.8), reading('Zone 5', 'ph', 4.8), reading('Zone 6', 'ph', 4.8),
  ];
  const agentProvenanceReadings: ZoneReading[] = manualProvenanceReadings.map((r) => ({ ...r }));

  const manualResult = computeVarietyHourlyRow(baseInput(manualProvenanceReadings));
  const agentResult = computeVarietyHourlyRow(baseInput(agentProvenanceReadings));
  assert('identical input values produce byte-identical phAvg regardless of provenance', manualResult.phAvg, agentResult.phAvg);
  assert('identical input values produce byte-identical phZoneCount regardless of provenance', manualResult.phZoneCount, agentResult.phZoneCount);
  assert('the sentinel-zero exclusion itself is applied identically either way', manualResult.phZoneCount, 5);
}

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
