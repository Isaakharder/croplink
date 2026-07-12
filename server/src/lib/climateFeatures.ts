// Deterministic climate feature engine — Phase 1 (pure calculations, no DB,
// no ML). Turns the already-zone-averaged `variety_climate_hourly` rows into
// agronomic features (degree-hours, VPD, radiation/CO2 interaction,
// irrigation response, EC/pH stability, coverage). Kept fully separate from
// any future predictive-model code; nothing here trains or scores anything.
//
// Crop: greenhouse bell pepper. Constants below are grower-confirmed
// conventions for this crop, not universal agronomy truths — kept as named,
// overridable exports so they can be recalibrated later without touching the
// math that uses them.

export const DEGREE_HOUR_BASE_TEMP_C = 10;
export const DEGREE_HOUR_UPPER_CAP_C = 30;

// Bumped whenever the math in this file changes in a way that would make an
// old feature row not reproducible from the current code (e.g. a different
// VPD formula, a changed degree-hour cap). Stored on every feature row so
// historical rows stay attributable to the config that produced them even
// after later recalibration.
export const FEATURE_ENGINE_VERSION = 'climate-features-v1';
export const VPD_BAND_CONFIG_VERSION = 'bell-pepper-vpd-bands-v1';

export type VpdBandKey = 'very_low' | 'low' | 'target' | 'elevated' | 'high';

export interface VpdBandDefinition {
  key: VpdBandKey;
  label: string;
  /** Inclusive lower bound in kPa, or null for no lower bound. */
  minKpa: number | null;
  /** Exclusive upper bound in kPa, or null for no upper bound. */
  maxKpa: number | null;
}

// Descriptive/analysis bands only — not proven stress or yield-penalty
// thresholds. Continuous VPD is always preserved alongside the band
// classification so these can be recalibrated from real outcomes later.
export const VPD_BANDS: VpdBandDefinition[] = [
  { key: 'very_low', label: 'Very low (<0.5 kPa)', minKpa: null, maxKpa: 0.5 },
  { key: 'low', label: 'Low (0.5–0.8 kPa)', minKpa: 0.5, maxKpa: 0.8 },
  { key: 'target', label: 'Target (0.8–1.2 kPa)', minKpa: 0.8, maxKpa: 1.2 },
  { key: 'elevated', label: 'Elevated (1.2–1.5 kPa)', minKpa: 1.2, maxKpa: 1.5 },
  { key: 'high', label: 'High (>1.5 kPa)', minKpa: 1.5, maxKpa: null },
];

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/**
 * Saturation vapor pressure deficit (kPa) from air temperature and relative
 * humidity, using the Tetens approximation. This is an air-temperature
 * approximation of VPD (no leaf-temperature sensor exists in this pipeline),
 * consistent with how the raw hourly averages are already computed.
 */
export function computeVpdKpa(tempC: number | null, rhPct: number | null): number | null {
  if (tempC == null || rhPct == null || !Number.isFinite(tempC) || !Number.isFinite(rhPct)) return null;
  const svpKpa = 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
  const vpd = svpKpa * (1 - rhPct / 100);
  return round(vpd, 4);
}

export function classifyVpdBand(vpdKpa: number | null, bands: VpdBandDefinition[] = VPD_BANDS): VpdBandKey | null {
  if (vpdKpa == null) return null;
  for (const band of bands) {
    const aboveMin = band.minKpa == null || vpdKpa >= band.minKpa;
    const belowMax = band.maxKpa == null || vpdKpa < band.maxKpa;
    if (aboveMin && belowMax) return band.key;
  }
  return null;
}

/**
 * Growing degree-hours for one hourly row: temperature above the base
 * accumulates at 1x, clamped at `capTempC` so hours far above the crop's
 * useful range don't contribute unbounded "extra" growth signal.
 */
export function computeDegreeHours(
  avgTempC: number | null,
  baseTempC: number = DEGREE_HOUR_BASE_TEMP_C,
  capTempC: number = DEGREE_HOUR_UPPER_CAP_C
): number | null {
  if (avgTempC == null || !Number.isFinite(avgTempC)) return null;
  const clamped = Math.min(Math.max(avgTempC, baseTempC), capTempC);
  return round(clamped - baseTempC, 4);
}

/** A daylight hour is one where the phase radiation sensor recorded any measurable accumulation. */
export function isDaylightHour(radiationIntervalDeltaJCm2: number | null): boolean {
  return radiationIntervalDeltaJCm2 != null && radiationIntervalDeltaJCm2 > 0;
}

// Shape mirrors the subset of `variety_climate_hourly` columns this module
// needs — callers pass rows from that table (snake_case, matching the DB).
export interface VarietyClimateHourlyRowLike {
  variety_id: string;
  measured_at: string;
  air_temperature_avg_c: number | null;
  relative_humidity_avg_pct: number | null;
  co2_avg_ppm: number | null;
  ec_avg: number | null;
  ph_avg: number | null;
  irrigation_interval_delta_ml: number | null;
  irrigation_interval_minutes: number | null;
  radiation_interval_delta_j_cm2: number | null;
}

export interface HourlyClimateFeatures {
  varietyId: string;
  measuredAt: string;
  degreeHours: number | null;
  vpdKpa: number | null;
  vpdBand: VpdBandKey | null;
  isDaylight: boolean;
  ecDelta: number | null;
  phDelta: number | null;
  airTemperatureAvgC: number | null;
  co2AvgPpm: number | null;
  radiationIntervalDeltaJCm2: number | null;
  irrigationIntervalDeltaMl: number | null;
  irrigationIntervalMinutes: number | null;

  // Provenance — the exact config used to derive this row, so historical
  // rows stay unambiguous after a later recalibration.
  degreeHourBaseTempC: number;
  degreeHourUpperCapC: number;
  vpdBandConfigVersion: string;
  featureEngineVersion: string;
}

/**
 * Derives one hour of features. `previousRow` is the immediately preceding
 * hourly row for the same variety (used only for the EC/pH deltas) — pass
 * null at a series start or across a gap larger than one hour so the delta
 * isn't computed across missing data.
 */
export function computeHourlyFeatures(
  row: VarietyClimateHourlyRowLike,
  previousRow: VarietyClimateHourlyRowLike | null
): HourlyClimateFeatures {
  const vpdKpa = computeVpdKpa(row.air_temperature_avg_c, row.relative_humidity_avg_pct);
  const adjacentHour =
    previousRow != null &&
    new Date(row.measured_at).getTime() - new Date(previousRow.measured_at).getTime() === 3600000;

  return {
    varietyId: row.variety_id,
    measuredAt: row.measured_at,
    degreeHours: computeDegreeHours(row.air_temperature_avg_c),
    vpdKpa,
    vpdBand: classifyVpdBand(vpdKpa),
    isDaylight: isDaylightHour(row.radiation_interval_delta_j_cm2),
    ecDelta: adjacentHour && row.ec_avg != null && previousRow!.ec_avg != null ? round(row.ec_avg - previousRow!.ec_avg, 4) : null,
    phDelta: adjacentHour && row.ph_avg != null && previousRow!.ph_avg != null ? round(row.ph_avg - previousRow!.ph_avg, 4) : null,
    airTemperatureAvgC: row.air_temperature_avg_c,
    co2AvgPpm: row.co2_avg_ppm,
    radiationIntervalDeltaJCm2: row.radiation_interval_delta_j_cm2,
    irrigationIntervalDeltaMl: row.irrigation_interval_delta_ml,
    irrigationIntervalMinutes: row.irrigation_interval_minutes,
    degreeHourBaseTempC: DEGREE_HOUR_BASE_TEMP_C,
    degreeHourUpperCapC: DEGREE_HOUR_UPPER_CAP_C,
    vpdBandConfigVersion: VPD_BAND_CONFIG_VERSION,
    featureEngineVersion: FEATURE_ENGINE_VERSION,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Exposure-window rollup — the shared aggregator behind both the daily/
// weekly feature API and the Phase 2 dataset builder. Anything that can't be
// summed hour-by-hour (min/max/stddev, band-hour counts, radiation-weighted
// CO2) is computed here directly from the set of hourly rows in the window.
// ─────────────────────────────────────────────────────────────────────────

/** A joined hourly row: raw averages (for EC/pH stability) plus the derived features for that same hour. */
export interface ExposureHourlyInput {
  measuredAt: string;
  ecAvg: number | null;
  phAvg: number | null;
  features: HourlyClimateFeatures;
}

export interface ExposureWindowFeatures {
  hoursObserved: number;
  hoursExpected: number;
  coveragePct: number | null;

  accumulatedDegreeHours: number | null;
  accumulatedRadiationJCm2: number | null;

  tempAvgC: number | null;
  tempMinC: number | null;
  tempMaxC: number | null;

  vpdAvgKpa: number | null;
  vpdMinKpa: number | null;
  vpdMaxKpa: number | null;
  vpdBandHours: Record<VpdBandKey, number>;

  co2AvgPpm: number | null;
  co2AvgDaylightPpm: number | null;
  co2AvgNightPpm: number | null;
  radiationWeightedCo2Ppm: number | null;

  irrigationTotalMl: number | null;
  irrigationEventCount: number;
  irrigationAvgIntervalMinutes: number | null;

  ecAvg: number | null;
  ecMin: number | null;
  ecMax: number | null;
  ecStdDev: number | null;
  phAvg: number | null;
  phMin: number | null;
  phMax: number | null;
  phStdDev: number | null;
}

function stats(values: number[]): { avg: number | null; min: number | null; max: number | null; stdDev: number | null } {
  if (values.length === 0) return { avg: null, min: null, max: null, stdDev: null };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) / values.length;
  return {
    avg: round(avg, 4),
    min: round(Math.min(...values), 4),
    max: round(Math.max(...values), 4),
    stdDev: round(Math.sqrt(variance), 4),
  };
}

function sum(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (valid.length === 0) return null;
  return round(valid.reduce((a, b) => a + b, 0), 4);
}

function meanValid(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (valid.length === 0) return null;
  return round(valid.reduce((a, b) => a + b, 0) / valid.length, 4);
}

/**
 * The single accumulation rule for radiation, shared by every daily/weekly
 * rollup and exposure-window aggregate in the app (variety-hourly route,
 * variety-features route, aggregateExposureWindow below). Do not reimplement
 * this locally.
 *
 * A negative radiation interval delta is a sensor/cumulative-counter reset
 * (confirmed against raw data: the underlying phase sensor's own cumulative
 * counter genuinely drops mid-day, not just at the local-day boundary that
 * computeCumulativeDelta guards), not a real decrease — radiation cannot
 * accumulate backwards. Excluded from the sum rather than allowed to
 * subtract from the total; the hour's own stored delta is left untouched so
 * the reset stays visible for audit.
 *
 * Rounded to 2 decimals to match the numeric(10,2) precision of the
 * underlying radiation_interval_delta_j_cm2 column, so every caller reports
 * the same total for the same input.
 */
export function sumAccumulatedRadiationJCm2(deltas: (number | null)[]): number | null {
  const valid = deltas.filter((v): v is number => v != null && Number.isFinite(v) && v >= 0);
  if (valid.length === 0) return null;
  return round(valid.reduce((a, b) => a + b, 0), 2);
}

export function aggregateExposureWindow(rows: ExposureHourlyInput[], hoursExpected: number): ExposureWindowFeatures {
  const tempValues = rows.map((r) => r.features.airTemperatureAvgC).filter((v): v is number => v != null);
  const tempStats = stats(tempValues);

  const vpdValues = rows.map((r) => r.features.vpdKpa).filter((v): v is number => v != null);
  const vpdStats = stats(vpdValues);

  const vpdBandHours = Object.fromEntries(VPD_BANDS.map((b) => [b.key, 0])) as Record<VpdBandKey, number>;
  for (const r of rows) {
    if (r.features.vpdBand) vpdBandHours[r.features.vpdBand] += 1;
  }

  const daylightRows = rows.filter((r) => r.features.isDaylight);
  const nightRows = rows.filter((r) => !r.features.isDaylight);

  const totalRadiation = sumAccumulatedRadiationJCm2(rows.map((r) => r.features.radiationIntervalDeltaJCm2));
  let radiationWeightedCo2: number | null = null;
  if (totalRadiation != null && totalRadiation > 0) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (const r of rows) {
      const rad = r.features.radiationIntervalDeltaJCm2;
      const co2 = r.features.co2AvgPpm;
      if (rad != null && rad > 0 && co2 != null) {
        weightedSum += rad * co2;
        weightTotal += rad;
      }
    }
    radiationWeightedCo2 = weightTotal > 0 ? round(weightedSum / weightTotal, 4) : null;
  }
  if (radiationWeightedCo2 == null) {
    radiationWeightedCo2 = meanValid(rows.map((r) => r.features.co2AvgPpm));
  }

  const irrigationEvents = rows.filter((r) => (r.features.irrigationIntervalDeltaMl ?? 0) > 0);

  const ecValues = rows.map((r) => r.ecAvg).filter((v): v is number => v != null);
  const phValues = rows.map((r) => r.phAvg).filter((v): v is number => v != null);
  const ecStats = stats(ecValues);
  const phStats = stats(phValues);

  const hoursObserved = rows.filter(
    (r) => r.ecAvg != null || r.phAvg != null || r.features.co2AvgPpm != null || r.features.degreeHours != null
  ).length;

  return {
    hoursObserved,
    hoursExpected,
    coveragePct: hoursExpected > 0 ? round((hoursObserved / hoursExpected) * 100, 2) : null,

    accumulatedDegreeHours: sum(rows.map((r) => r.features.degreeHours)),
    accumulatedRadiationJCm2: totalRadiation,

    tempAvgC: tempStats.avg,
    tempMinC: tempStats.min,
    tempMaxC: tempStats.max,

    vpdAvgKpa: vpdStats.avg,
    vpdMinKpa: vpdStats.min,
    vpdMaxKpa: vpdStats.max,
    vpdBandHours,

    co2AvgPpm: meanValid(rows.map((r) => r.features.co2AvgPpm)),
    co2AvgDaylightPpm: meanValid(daylightRows.map((r) => r.features.co2AvgPpm)),
    co2AvgNightPpm: meanValid(nightRows.map((r) => r.features.co2AvgPpm)),
    radiationWeightedCo2Ppm: radiationWeightedCo2,

    irrigationTotalMl: sum(rows.map((r) => r.features.irrigationIntervalDeltaMl)),
    irrigationEventCount: irrigationEvents.length,
    irrigationAvgIntervalMinutes: meanValid(irrigationEvents.map((r) => r.features.irrigationIntervalMinutes)),

    ecAvg: ecStats.avg,
    ecMin: ecStats.min,
    ecMax: ecStats.max,
    ecStdDev: ecStats.stdDev,
    phAvg: phStats.avg,
    phMin: phStats.min,
    phMax: phStats.max,
    phStdDev: phStats.stdDev,
  };
}

/** Whole hours between two ISO instants (inclusive-exclusive), used to size `hoursExpected` for a window. */
export function wholeHoursBetween(startIso: string, endIsoExclusive: string): number {
  return Math.round((new Date(endIsoExclusive).getTime() - new Date(startIso).getTime()) / 3600000);
}
