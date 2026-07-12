// Pure calculation layer for the variety/phase hourly climate pipeline.
// No DB access here — callers fetch whatever context is needed (linked
// zones, previous cumulative readings) and pass it in, which keeps this
// fully unit-testable and guarantees the browser-upload and future
// agent-import entry points can share the exact same math.
import type { ZoneReading } from './ridderParser';

export type DeltaFlag = 'ok' | 'first_reading_of_day' | 'negative_reset';

export interface CumulativeDeltaResult {
  delta: number | null;
  elapsedMinutes: number | null;
  flag: DeltaFlag;
}

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** Average of valid (non-null, finite) values only — blanks are never treated as zero. */
export function averageValid(values: (number | null | undefined)[]): { avg: number | null; count: number } {
  const valid = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (valid.length === 0) return { avg: null, count: 0 };
  const sum = valid.reduce((a, b) => a + b, 0);
  return { avg: round(sum / valid.length, 4), count: valid.length };
}

/** YYYY-MM-DD in the given IANA time zone — used to detect greenhouse-local day boundaries. */
export function localCalendarDateKey(utcDate: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(utcDate);
}

/**
 * Delta for a cumulative (running-total) metric such as irrigation or
 * radiation. Never subtracts across a greenhouse-local calendar-day
 * boundary — a new day always starts fresh (`first_reading_of_day`), since
 * these counters are expected to reset nightly. A negative result within
 * the same day is flagged rather than saved as a plausible negative amount.
 */
export function computeCumulativeDelta(
  currentValue: number,
  currentMeasuredAt: Date,
  previous: { value: number; measuredAt: Date } | null,
  timeZone: string
): CumulativeDeltaResult {
  if (!previous) return { delta: null, elapsedMinutes: null, flag: 'first_reading_of_day' };
  const sameDay = localCalendarDateKey(currentMeasuredAt, timeZone) === localCalendarDateKey(previous.measuredAt, timeZone);
  if (!sameDay) return { delta: null, elapsedMinutes: null, flag: 'first_reading_of_day' };
  const elapsedMinutes = Math.round((currentMeasuredAt.getTime() - previous.measuredAt.getTime()) / 60000);
  const delta = round(currentValue - previous.value, 4);
  return { delta, elapsedMinutes, flag: delta < 0 ? 'negative_reset' : 'ok' };
}

export interface VarietyHourlyInput {
  measuredAt: Date;
  linkedZoneLabels: string[];
  readings: ZoneReading[]; // all zone-level readings available at this timestamp
  previousIrrigationCumulative: { value: number; measuredAt: Date } | null;
  phaseId: string | null;
  phaseRadiation: { cumulativeJCm2: number | null; intervalDeltaJCm2: number | null } | null;
  timeZone: string;
}

export interface VarietyHourlyResult {
  airTemperatureAvgC: number | null; airTemperatureZoneCount: number;
  relativeHumidityAvgPct: number | null; relativeHumidityZoneCount: number;
  co2AvgPpm: number | null; co2ZoneCount: number;
  ecAvg: number | null; ecZoneCount: number;
  phAvg: number | null; phZoneCount: number;
  irrigationCumulativeAvgMl: number | null; irrigationZoneCount: number;
  irrigationIntervalDeltaMl: number | null; irrigationIntervalMinutes: number | null; irrigationQualityFlag: DeltaFlag | null;
  expectedZoneCount: number;
  phaseId: string | null;
  radiationCumulativeJCm2: number | null;
  radiationIntervalDeltaJCm2: number | null;
  warnings: string[];
}

const METRIC_LABELS: { metric: string; label: string }[] = [
  { metric: 'temperature_c', label: 'Air temperature' },
  { metric: 'relative_humidity_pct', label: 'RH' },
  { metric: 'co2_ppm', label: 'CO2' },
  { metric: 'ec', label: 'EC' },
  { metric: 'ph', label: 'pH' },
  { metric: 'irrigation_cumulative_ml', label: 'Irrigation' },
];

export function computeVarietyHourlyRow(input: VarietyHourlyInput): VarietyHourlyResult {
  const expectedZoneCount = input.linkedZoneLabels.length;

  const forMetric = (metricName: string) =>
    averageValid(
      input.linkedZoneLabels.map(
        (zl) => input.readings.find((r) => r.zoneLabel === zl && r.metricName === metricName)?.value ?? null
      )
    );

  const byMetric = Object.fromEntries(METRIC_LABELS.map(({ metric }) => [metric, forMetric(metric)]));

  const warnings: string[] = [];
  for (const { metric, label } of METRIC_LABELS) {
    const res = byMetric[metric];
    if (res.count === 0) warnings.push(`${label}: no valid linked-zone reading`);
    else if (expectedZoneCount > 0 && res.count < expectedZoneCount) warnings.push(`${label}: ${res.count}/${expectedZoneCount} zones contributed`);
  }
  if (expectedZoneCount === 0) warnings.push('No zones linked to this variety');

  const irrigation = byMetric['irrigation_cumulative_ml'];
  let irrigationDelta: CumulativeDeltaResult = { delta: null, elapsedMinutes: null, flag: 'first_reading_of_day' };
  if (irrigation.avg != null) {
    irrigationDelta = computeCumulativeDelta(irrigation.avg, input.measuredAt, input.previousIrrigationCumulative, input.timeZone);
    if (irrigationDelta.flag === 'negative_reset') {
      warnings.push(`Irrigation: negative delta (${irrigationDelta.delta} ml) — likely daily reset, source correction, or bad ordering`);
    }
  }

  const temp = byMetric['temperature_c'];
  const rh = byMetric['relative_humidity_pct'];
  const co2 = byMetric['co2_ppm'];
  const ec = byMetric['ec'];
  const ph = byMetric['ph'];

  return {
    airTemperatureAvgC: temp.avg, airTemperatureZoneCount: temp.count,
    relativeHumidityAvgPct: rh.avg, relativeHumidityZoneCount: rh.count,
    co2AvgPpm: co2.avg, co2ZoneCount: co2.count,
    ecAvg: ec.avg, ecZoneCount: ec.count,
    phAvg: ph.avg, phZoneCount: ph.count,
    irrigationCumulativeAvgMl: irrigation.avg, irrigationZoneCount: irrigation.count,
    irrigationIntervalDeltaMl: irrigationDelta.delta,
    irrigationIntervalMinutes: irrigationDelta.elapsedMinutes,
    irrigationQualityFlag: irrigation.avg != null ? irrigationDelta.flag : null,
    expectedZoneCount,
    phaseId: input.phaseId,
    radiationCumulativeJCm2: input.phaseRadiation?.cumulativeJCm2 ?? null,
    radiationIntervalDeltaJCm2: input.phaseRadiation?.intervalDeltaJCm2 ?? null,
    warnings,
  };
}

export interface PhaseHourlyInput {
  measuredAt: Date;
  radiationValue: number | null;
  drainValue: number | null;
  sourceZoneLabel: string | null;
  previousRadiationCumulative: { value: number; measuredAt: Date } | null;
  timeZone: string;
}

export interface PhaseHourlyResult {
  radiationCumulativeJCm2: number | null;
  radiationIntervalDeltaJCm2: number | null;
  radiationIntervalMinutes: number | null;
  radiationQualityFlag: DeltaFlag | null;
  drainWaterPct: number | null;
  sourceZoneLabel: string | null;
}

export function computePhaseHourlyRow(input: PhaseHourlyInput): PhaseHourlyResult {
  let delta: CumulativeDeltaResult = { delta: null, elapsedMinutes: null, flag: 'first_reading_of_day' };
  if (input.radiationValue != null) {
    delta = computeCumulativeDelta(input.radiationValue, input.measuredAt, input.previousRadiationCumulative, input.timeZone);
  }
  return {
    radiationCumulativeJCm2: input.radiationValue,
    radiationIntervalDeltaJCm2: delta.delta,
    radiationIntervalMinutes: delta.elapsedMinutes,
    radiationQualityFlag: input.radiationValue != null ? delta.flag : null,
    drainWaterPct: input.drainValue,
    sourceZoneLabel: input.sourceZoneLabel,
  };
}
