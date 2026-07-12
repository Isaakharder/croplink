// Phase 2 — model-ready dataset builder. Joins fruit_instances (per-fruit
// set/breaker/harvest lifecycle) to the Phase 1 climate feature engine to
// produce one row per fruit instance (and, rolled up, per set-week cohort)
// with accumulated climate exposure for each lifecycle window. Pure
// aggregation of already-computed deterministic features — no ML, and not
// consumed by any predictive model yet.
import { supabase } from './supabase';
import { fetchAllRows } from './fetchAllRows';
import { zonedTimeToUtc, GREENHOUSE_TIME_ZONE } from './ridderParser';
import {
  aggregateExposureWindow,
  wholeHoursBetween,
  type ExposureHourlyInput,
  type ExposureWindowFeatures,
  type HourlyClimateFeatures,
  type VpdBandKey,
} from './climateFeatures';

interface FruitInstanceRow {
  id: string;
  variety_id: string;
  plant_node_id: string;
  set_year: number;
  set_week_number: number;
  set_date: string;
  breaker_year: number | null;
  breaker_week_number: number | null;
  breaker_date: string | null;
  harvested_year: number | null;
  harvested_week_number: number | null;
  harvested_date: string | null;
  status: string;
}

interface HourlyRow {
  measured_at: string;
  ec_avg: number | null;
  ph_avg: number | null;
  air_temperature_avg_c: number | null;
}

interface FeatureRow {
  variety_id: string;
  measured_at: string;
  degree_hours: number | null;
  vpd_kpa: number | null;
  vpd_band: VpdBandKey | null;
  is_daylight: boolean;
  ec_delta: number | null;
  ph_delta: number | null;
  co2_avg_ppm: number | null;
  radiation_interval_delta_j_cm2: number | null;
  irrigation_interval_delta_ml: number | null;
  irrigation_interval_minutes: number | null;
  degree_hour_base_temp_c: number;
  degree_hour_upper_cap_c: number;
  vpd_band_config_version: string;
  feature_engine_version: string;
}

export interface DateWindow {
  startIso: string;
  /** Exclusive. */
  endIso: string;
}

/** Local-midnight UTC bounds for a single greenhouse-local calendar date (YYYY-MM-DD). */
function localDayBoundsUtc(dateStr: string): DateWindow {
  const [y, m, d] = dateStr.split('-').map(Number);
  const startIso = zonedTimeToUtc(y, m, d, 0, 0, 0, GREENHOUSE_TIME_ZONE).toISOString();
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const endIso = zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, GREENHOUSE_TIME_ZONE).toISOString();
  return { startIso, endIso };
}

/** Full-day window spanning [startDate 00:00 local, endDate+1day 00:00 local) — inclusive of both boundary dates. */
function fullDayWindow(startDate: string, endDate: string): DateWindow {
  return { startIso: localDayBoundsUtc(startDate).startIso, endIso: localDayBoundsUtc(endDate).endIso };
}

export interface FruitInstanceWindows {
  setToCurrent: DateWindow | null;
  setToBreaker: DateWindow | null;
  breakerToHarvest: DateWindow | null;
  setToHarvest: DateWindow | null;
}

/**
 * Resolves the four lifecycle date windows for a fruit instance. `setToCurrent`
 * is only populated for instances still open (status 'set', no breaker yet)
 * and runs through `nowIso`.
 */
export function resolveWindowBounds(instance: FruitInstanceRow, nowIso: string = new Date().toISOString()): FruitInstanceWindows {
  const hasBreaker = instance.breaker_date != null;
  const hasHarvest = instance.harvested_date != null;
  return {
    setToCurrent: instance.status === 'set' && !hasBreaker ? { startIso: localDayBoundsUtc(instance.set_date).startIso, endIso: nowIso } : null,
    setToBreaker: hasBreaker ? fullDayWindow(instance.set_date, instance.breaker_date as string) : null,
    breakerToHarvest: hasBreaker && hasHarvest ? fullDayWindow(instance.breaker_date as string, instance.harvested_date as string) : null,
    setToHarvest: hasHarvest ? fullDayWindow(instance.set_date, instance.harvested_date as string) : null,
  };
}

function weeksBetween(startDate: string | null, endDate: string | null): number | null {
  if (!startDate || !endDate) return null;
  const days = (new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86400000;
  return Math.round((days / 7) * 100) / 100;
}

export interface FruitInstanceClimateRow {
  fruitInstanceId: string;
  varietyId: string;
  plantNodeId: string;
  setYear: number;
  setWeekNumber: number;
  setDate: string;
  breakerYear: number | null;
  breakerWeekNumber: number | null;
  breakerDate: string | null;
  harvestedYear: number | null;
  harvestedWeekNumber: number | null;
  harvestedDate: string | null;
  status: string;
  weeksToBreaker: number | null;
  weeksBreakerToHarvest: number | null;
  weeksSetToHarvest: number | null;
  setToCurrent: ExposureWindowFeatures | null;
  setToBreaker: ExposureWindowFeatures | null;
  breakerToHarvest: ExposureWindowFeatures | null;
  setToHarvest: ExposureWindowFeatures | null;
}

export interface SetWeekCohortClimateRow {
  varietyId: string;
  setYear: number;
  setWeekNumber: number;
  instanceCount: number;
  harvestedCount: number;
  abortedCount: number;
  prunedCount: number;
  openCount: number;
  avgWeeksToBreaker: number | null;
  avgWeeksBreakerToHarvest: number | null;
  avgWeeksSetToHarvest: number | null;
  setToCurrent: ExposureWindowFeatures | null;
  setToBreaker: ExposureWindowFeatures | null;
  breakerToHarvest: ExposureWindowFeatures | null;
  setToHarvest: ExposureWindowFeatures | null;
}

/** A variety-season series of joined hourly rows, sliceable by date window. */
class VarietyClimateSeries {
  private rows: ExposureHourlyInput[];

  constructor(hourlyRows: HourlyRow[], featureRows: FeatureRow[]) {
    const featuresByTs = new Map(featureRows.map((r) => [r.measured_at, r]));
    this.rows = hourlyRows
      .map((h) => {
        const f = featuresByTs.get(h.measured_at);
        if (!f) return null;
        const features: HourlyClimateFeatures = {
          varietyId: f.variety_id,
          measuredAt: f.measured_at,
          degreeHours: f.degree_hours,
          vpdKpa: f.vpd_kpa,
          vpdBand: f.vpd_band,
          isDaylight: f.is_daylight,
          ecDelta: f.ec_delta,
          phDelta: f.ph_delta,
          airTemperatureAvgC: h.air_temperature_avg_c,
          co2AvgPpm: f.co2_avg_ppm,
          radiationIntervalDeltaJCm2: f.radiation_interval_delta_j_cm2,
          irrigationIntervalDeltaMl: f.irrigation_interval_delta_ml,
          irrigationIntervalMinutes: f.irrigation_interval_minutes,
          degreeHourBaseTempC: f.degree_hour_base_temp_c,
          degreeHourUpperCapC: f.degree_hour_upper_cap_c,
          vpdBandConfigVersion: f.vpd_band_config_version,
          featureEngineVersion: f.feature_engine_version,
        };
        return { measuredAt: h.measured_at, ecAvg: h.ec_avg, phAvg: h.ph_avg, features } satisfies ExposureHourlyInput;
      })
      .filter((v): v is ExposureHourlyInput => v != null)
      .sort((a, b) => (a.measuredAt < b.measuredAt ? -1 : 1));
  }

  aggregate(window: DateWindow | null): ExposureWindowFeatures | null {
    if (!window) return null;
    const inWindow = this.rows.filter((r) => r.measuredAt >= window.startIso && r.measuredAt < window.endIso);
    return aggregateExposureWindow(inWindow, wholeHoursBetween(window.startIso, window.endIso));
  }
}

function meanValid(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (valid.length === 0) return null;
  return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10000) / 10000;
}

/** Mean-of-instances rollup for a cohort. Coverage is recomputed from summed hours (not averaged) for accuracy. */
function averageExposureWindows(windows: (ExposureWindowFeatures | null)[]): ExposureWindowFeatures | null {
  const valid = windows.filter((w): w is ExposureWindowFeatures => w != null);
  if (valid.length === 0) return null;

  const vpdBandHours = { very_low: 0, low: 0, target: 0, elevated: 0, high: 0 } as Record<VpdBandKey, number>;
  for (const w of valid) {
    for (const key of Object.keys(vpdBandHours) as VpdBandKey[]) vpdBandHours[key] += w.vpdBandHours[key] ?? 0;
  }
  const hoursObserved = valid.reduce((a, w) => a + w.hoursObserved, 0);
  const hoursExpected = valid.reduce((a, w) => a + w.hoursExpected, 0);

  return {
    hoursObserved,
    hoursExpected,
    coveragePct: hoursExpected > 0 ? Math.round((hoursObserved / hoursExpected) * 10000) / 100 : null,
    accumulatedDegreeHours: meanValid(valid.map((w) => w.accumulatedDegreeHours)),
    accumulatedRadiationJCm2: meanValid(valid.map((w) => w.accumulatedRadiationJCm2)),
    tempAvgC: meanValid(valid.map((w) => w.tempAvgC)),
    tempMinC: meanValid(valid.map((w) => w.tempMinC)),
    tempMaxC: meanValid(valid.map((w) => w.tempMaxC)),
    vpdAvgKpa: meanValid(valid.map((w) => w.vpdAvgKpa)),
    vpdMinKpa: meanValid(valid.map((w) => w.vpdMinKpa)),
    vpdMaxKpa: meanValid(valid.map((w) => w.vpdMaxKpa)),
    vpdBandHours,
    co2AvgPpm: meanValid(valid.map((w) => w.co2AvgPpm)),
    co2AvgDaylightPpm: meanValid(valid.map((w) => w.co2AvgDaylightPpm)),
    co2AvgNightPpm: meanValid(valid.map((w) => w.co2AvgNightPpm)),
    radiationWeightedCo2Ppm: meanValid(valid.map((w) => w.radiationWeightedCo2Ppm)),
    irrigationTotalMl: meanValid(valid.map((w) => w.irrigationTotalMl)),
    irrigationEventCount: Math.round(meanValid(valid.map((w) => w.irrigationEventCount)) ?? 0),
    irrigationAvgIntervalMinutes: meanValid(valid.map((w) => w.irrigationAvgIntervalMinutes)),
    ecAvg: meanValid(valid.map((w) => w.ecAvg)),
    ecMin: meanValid(valid.map((w) => w.ecMin)),
    ecMax: meanValid(valid.map((w) => w.ecMax)),
    ecStdDev: meanValid(valid.map((w) => w.ecStdDev)),
    phAvg: meanValid(valid.map((w) => w.phAvg)),
    phMin: meanValid(valid.map((w) => w.phMin)),
    phMax: meanValid(valid.map((w) => w.phMax)),
    phStdDev: meanValid(valid.map((w) => w.phStdDev)),
  };
}

export interface VarietyClimateDataset {
  instanceRows: FruitInstanceClimateRow[];
  cohortRows: SetWeekCohortClimateRow[];
}

/**
 * Builds the full climate-exposure dataset for one variety/set-year. Fetches
 * the variety's hourly climate series once (not per fruit instance) and
 * slices it per lifecycle window to avoid N+1 queries.
 */
export async function buildVarietyClimateDataset(varietyId: string, setYear: number): Promise<VarietyClimateDataset> {
  const instances = await fetchAllRows<FruitInstanceRow>((from, to) =>
    supabase
      .from('fruit_instances')
      .select(
        'id, variety_id, plant_node_id, set_year, set_week_number, set_date, breaker_year, breaker_week_number, breaker_date, harvested_year, harvested_week_number, harvested_date, status'
      )
      .eq('variety_id', varietyId)
      .eq('set_year', setYear)
      .range(from, to)
  );

  if (instances.length === 0) return { instanceRows: [], cohortRows: [] };

  const nowIso = new Date().toISOString();
  const windowsByInstance = new Map(instances.map((i) => [i.id, resolveWindowBounds(i, nowIso)]));

  const allBounds = Array.from(windowsByInstance.values()).flatMap((w) => [w.setToCurrent, w.setToBreaker, w.breakerToHarvest, w.setToHarvest].filter((x): x is DateWindow => x != null));
  const spanStart = allBounds.length > 0 ? allBounds.map((w) => w.startIso).sort()[0] : new Date().toISOString();
  const spanEnd = allBounds.length > 0 ? allBounds.map((w) => w.endIso).sort().slice(-1)[0] : nowIso;

  const [hourlyRows, featureRows] = await Promise.all([
    fetchAllRows<HourlyRow>((from, to) =>
      supabase.from('variety_climate_hourly').select('measured_at, ec_avg, ph_avg, air_temperature_avg_c').eq('variety_id', varietyId).gte('measured_at', spanStart).lt('measured_at', spanEnd).range(from, to)
    ),
    fetchAllRows<FeatureRow>((from, to) =>
      supabase.from('variety_climate_hourly_features').select('*').eq('variety_id', varietyId).gte('measured_at', spanStart).lt('measured_at', spanEnd).range(from, to)
    ),
  ]);

  const series = new VarietyClimateSeries(hourlyRows, featureRows);

  const instanceRows: FruitInstanceClimateRow[] = instances.map((instance) => {
    const windows = windowsByInstance.get(instance.id)!;
    return {
      fruitInstanceId: instance.id,
      varietyId: instance.variety_id,
      plantNodeId: instance.plant_node_id,
      setYear: instance.set_year,
      setWeekNumber: instance.set_week_number,
      setDate: instance.set_date,
      breakerYear: instance.breaker_year,
      breakerWeekNumber: instance.breaker_week_number,
      breakerDate: instance.breaker_date,
      harvestedYear: instance.harvested_year,
      harvestedWeekNumber: instance.harvested_week_number,
      harvestedDate: instance.harvested_date,
      status: instance.status,
      weeksToBreaker: weeksBetween(instance.set_date, instance.breaker_date),
      weeksBreakerToHarvest: weeksBetween(instance.breaker_date, instance.harvested_date),
      weeksSetToHarvest: weeksBetween(instance.set_date, instance.harvested_date),
      setToCurrent: series.aggregate(windows.setToCurrent),
      setToBreaker: series.aggregate(windows.setToBreaker),
      breakerToHarvest: series.aggregate(windows.breakerToHarvest),
      setToHarvest: series.aggregate(windows.setToHarvest),
    };
  });

  const cohortMap = new Map<number, FruitInstanceClimateRow[]>();
  for (const row of instanceRows) {
    if (!cohortMap.has(row.setWeekNumber)) cohortMap.set(row.setWeekNumber, []);
    cohortMap.get(row.setWeekNumber)!.push(row);
  }

  const cohortRows: SetWeekCohortClimateRow[] = Array.from(cohortMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([setWeekNumber, rows]) => ({
      varietyId,
      setYear,
      setWeekNumber,
      instanceCount: rows.length,
      harvestedCount: rows.filter((r) => r.status === 'harvested').length,
      abortedCount: rows.filter((r) => r.status === 'aborted').length,
      prunedCount: rows.filter((r) => r.status === 'pruned').length,
      openCount: rows.filter((r) => r.status === 'set').length,
      avgWeeksToBreaker: meanValid(rows.map((r) => r.weeksToBreaker)),
      avgWeeksBreakerToHarvest: meanValid(rows.map((r) => r.weeksBreakerToHarvest)),
      avgWeeksSetToHarvest: meanValid(rows.map((r) => r.weeksSetToHarvest)),
      setToCurrent: averageExposureWindows(rows.map((r) => r.setToCurrent)),
      setToBreaker: averageExposureWindows(rows.map((r) => r.setToBreaker)),
      breakerToHarvest: averageExposureWindows(rows.map((r) => r.breakerToHarvest)),
      setToHarvest: averageExposureWindows(rows.map((r) => r.setToHarvest)),
    }));

  return { instanceRows, cohortRows };
}
