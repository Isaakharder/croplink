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

/**
 * Saturation vapor pressure deficit (kPa) for ONE zone's own temperature +
 * RH reading (Tetens approximation). The canonical VPD formula — called once
 * per reporting zone before averaging, never on already-cross-zone-averaged
 * temperature/RH, since VPD is nonlinear in temperature and averaging first
 * would compute a biased number, not just an approximation. Re-exported from
 * climateFeatures.ts as `computeVpdKpa` for that module's own callers.
 */
export function computeVpdKpaForZone(tempC: number | null, rhPct: number | null): number | null {
  if (tempC == null || rhPct == null || !Number.isFinite(tempC) || !Number.isFinite(rhPct)) return null;
  const svpKpa = 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
  const vpd = svpKpa * (1 - rhPct / 100);
  return round(vpd, 4);
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

/** Per-metric zone-level diagnostics: how many linked zones actually contributed, the spread across them, and whether one looks like an outlier. Reported alongside the average, never used to silently discard a zone. */
export interface MetricZoneDiagnostics {
  count: number;
  min: number | null;
  max: number | null;
  spread: number | null;
  outlierZone: string | null;
  outlierFlagged: boolean;
}

export interface VarietyHourlyResult {
  airTemperatureAvgC: number | null; airTemperatureZoneCount: number;
  relativeHumidityAvgPct: number | null; relativeHumidityZoneCount: number;
  vpdAvgKpa: number | null; vpdZoneCount: number;
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

  /** At least one linked zone reported ANY metric this hour. The ONLY condition that makes an hour missing is zero reporting zones — a 5/6 or 1/6 hour is still temporally covered. */
  temporalCovered: boolean;
  zonesLinked: number;
  /** Union of zones that reported at least one metric this hour (not summed per-metric — see the individual *ZoneCount fields for that). */
  zonesReporting: number;
  zoneParticipationPct: number | null;
  /** Per-metric count/min/max/spread/outlier-flag, plus how cross-zone weighting was done (always 'equal' today — zones table has no area/weight column to derive anything else from). */
  zoneDiagnostics: {
    weightingMethod: 'equal';
    temperature_c: MetricZoneDiagnostics;
    relative_humidity_pct: MetricZoneDiagnostics;
    vpd_kpa: MetricZoneDiagnostics;
    co2_ppm: MetricZoneDiagnostics;
    ec: MetricZoneDiagnostics;
    ph: MetricZoneDiagnostics;
    irrigation_cumulative_ml: MetricZoneDiagnostics;
  };
}

const METRIC_LABELS: { metric: string; label: string }[] = [
  { metric: 'temperature_c', label: 'Air temperature' },
  { metric: 'relative_humidity_pct', label: 'RH' },
  { metric: 'co2_ppm', label: 'CO2' },
  { metric: 'ec', label: 'EC' },
  { metric: 'ph', label: 'pH' },
  { metric: 'irrigation_cumulative_ml', label: 'Irrigation' },
];

/**
 * Metrics where a raw reading of exactly 0 is a known sensor/fault sentinel,
 * not a real measurement — confirmed against real data: pH holds a genuine
 * value (4.4-5.1) during active-irrigation hours and drops to exactly 0.00
 * for a recurring ~8-hour block every day (inactive irrigation overnight),
 * while every OTHER metric at the same zone+hour (temperature, RH, CO2, EC)
 * stays normal. A real nutrient-solution pH of 0.00 is not physically
 * plausible. EC was checked for the same pattern and did NOT show it
 * (system-wide, only 1.8% of EC readings are exactly 0, with no recurring
 * daily block, vs. 37.5% for pH) — so EC is deliberately excluded here.
 * Only add a metric to this set with the same kind of clear evidence.
 */
const SENTINEL_ZERO_METRICS = new Set(['ph']);

function isSentinelZero(metricName: string, value: number): boolean {
  return SENTINEL_ZERO_METRICS.has(metricName) && value === 0;
}

// Starting operational thresholds for "zones disagree enough to flag," not
// proven fault-detection cutoffs — same status as the Round 9 cohort-
// readiness gate. Zones 1-6 share climate setpoints and sit close together,
// so real between-zone spread should normally be small; a single value this
// far from the rest is flagged for a human to look at, never auto-discarded.
const OUTLIER_ABS_THRESHOLD: Record<string, number> = {
  temperature_c: 3.0,
  relative_humidity_pct: 15,
  vpd_kpa: 0.3,
  co2_ppm: 100,
  ec: 0.5,
  ph: 0.5,
  irrigation_cumulative_ml: 50,
};

/**
 * Averages valid zone-level values for one metric and reports how spread out
 * they were. With >=3 valid zones, flags the single value furthest from the
 * median if that gap exceeds the metric's threshold — a *diagnostic* signal
 * only; the flagged zone is never removed from the average itself, per the
 * explicit instruction not to auto-discard a zone without human review.
 */
function aggregateMetricWithDiagnostics(
  metric: string,
  zoneValues: { zone: string; value: number }[]
): { avg: number | null; count: number; diagnostics: MetricZoneDiagnostics } {
  const { avg, count } = averageValid(zoneValues.map((z) => z.value));
  if (zoneValues.length === 0) {
    return { avg, count, diagnostics: { count: 0, min: null, max: null, spread: null, outlierZone: null, outlierFlagged: false } };
  }
  const values = zoneValues.map((z) => z.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.round((max - min) * 10000) / 10000;

  let outlierZone: string | null = null;
  let outlierFlagged = false;
  if (zoneValues.length >= 3) {
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    let worstGap = -1;
    for (const z of zoneValues) {
      const gap = Math.abs(z.value - median);
      if (gap > worstGap) { worstGap = gap; outlierZone = z.zone; }
    }
    const threshold = OUTLIER_ABS_THRESHOLD[metric] ?? Infinity;
    outlierFlagged = worstGap > threshold;
    if (!outlierFlagged) outlierZone = null;
  }

  return { avg, count, diagnostics: { count, min, max, spread, outlierZone, outlierFlagged } };
}

export function computeVarietyHourlyRow(input: VarietyHourlyInput): VarietyHourlyResult {
  const expectedZoneCount = input.linkedZoneLabels.length;

  // Per-zone valid readings for one metric — sentinel-zero excluded BEFORE
  // averaging or diagnostics, never replaced with another number, never
  // counted toward zone coverage, exactly like a genuinely absent reading.
  const zoneValuesFor = (metricName: string): { zone: string; value: number }[] =>
    input.linkedZoneLabels
      .map((zl) => {
        const raw = input.readings.find((r) => r.zoneLabel === zl && r.metricName === metricName)?.value ?? null;
        return raw != null && !isSentinelZero(metricName, raw) ? { zone: zl, value: raw } : null;
      })
      .filter((v): v is { zone: string; value: number } => v != null);

  const byMetric = Object.fromEntries(METRIC_LABELS.map(({ metric }) => [metric, aggregateMetricWithDiagnostics(metric, zoneValuesFor(metric))]));

  const warnings: string[] = [];
  for (const { metric, label } of METRIC_LABELS) {
    const res = byMetric[metric];
    if (res.count === 0) warnings.push(`${label}: no valid linked-zone reading`);
    else if (expectedZoneCount > 0 && res.count < expectedZoneCount) warnings.push(`${label}: ${res.count}/${expectedZoneCount} zones contributed`);
    if (res.diagnostics.outlierFlagged) warnings.push(`${label}: zone ${res.diagnostics.outlierZone} disagrees with the others by ${res.diagnostics.spread} (spread) — flagged, not excluded`);
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

  // VPD computed PER ZONE (from that zone's own temperature + RH reading
  // this hour), then averaged — not from the cross-zone-averaged temp/RH
  // above. VPD is nonlinear in temperature (Tetens formula), so averaging
  // temp and RH first and computing VPD from the averages is a different,
  // biased number, not just a simplification — biggest when zones diverge
  // (a fault, a door open, partial reporting), smallest when they're
  // tightly clustered under shared setpoints (as Zones 1-6 normally are).
  const tempByZone = new Map(zoneValuesFor('temperature_c').map((z) => [z.zone, z.value]));
  const rhByZone = new Map(zoneValuesFor('relative_humidity_pct').map((z) => [z.zone, z.value]));
  const vpdZoneValues: { zone: string; value: number }[] = [];
  for (const zl of input.linkedZoneLabels) {
    const t = tempByZone.get(zl);
    const rhVal = rhByZone.get(zl);
    if (t == null || rhVal == null) continue; // both required for that zone's own VPD — never mix one zone's temp with another's RH
    const vpd = computeVpdKpaForZone(t, rhVal);
    if (vpd != null) vpdZoneValues.push({ zone: zl, value: vpd });
  }
  const vpd = aggregateMetricWithDiagnostics('vpd_kpa', vpdZoneValues);

  const zonesReportingSet = new Set<string>();
  for (const { metric } of METRIC_LABELS) {
    for (const z of zoneValuesFor(metric)) zonesReportingSet.add(z.zone);
  }
  for (const z of vpdZoneValues) zonesReportingSet.add(z.zone);
  const zonesReporting = zonesReportingSet.size;
  const temporalCovered = zonesReporting > 0;
  const zoneParticipationPct = expectedZoneCount > 0 ? Math.round((zonesReporting / expectedZoneCount) * 10000) / 100 : null;
  if (temporalCovered && expectedZoneCount > 0 && zonesReporting < expectedZoneCount) {
    warnings.push(`Only ${zonesReporting}/${expectedZoneCount} linked zones reported this hour — still counted as covered (low zone participation), not missing`);
  }

  return {
    airTemperatureAvgC: temp.avg, airTemperatureZoneCount: temp.count,
    relativeHumidityAvgPct: rh.avg, relativeHumidityZoneCount: rh.count,
    vpdAvgKpa: vpd.avg, vpdZoneCount: vpd.count,
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
    temporalCovered,
    zonesLinked: expectedZoneCount,
    zonesReporting,
    zoneParticipationPct,
    zoneDiagnostics: {
      weightingMethod: 'equal', // zones table has no area/weight column to derive anything else from
      temperature_c: temp.diagnostics,
      relative_humidity_pct: rh.diagnostics,
      vpd_kpa: vpd.diagnostics,
      co2_ppm: co2.diagnostics,
      ec: ec.diagnostics,
      ph: ph.diagnostics,
      irrigation_cumulative_ml: irrigation.diagnostics,
    },
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
