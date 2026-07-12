import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { fetchAllRows } from '../lib/fetchAllRows';
import { GREENHOUSE_TIME_ZONE } from '../lib/ridderParser';
import { localCalendarDateKey } from '../lib/climateAveraging';
import { aggregateExposureWindow, wholeHoursBetween, type ExposureHourlyInput, type HourlyClimateFeatures, type VpdBandKey } from '../lib/climateFeatures';
import { recomputeVarietyClimateFeatures } from '../lib/climateFeatureRecompute';

const router = Router();

type Granularity = 'hourly' | 'daily' | 'weekly';

function isoWeekKey(utcDate: Date, timeZone: string): string {
  const dateStr = localCalendarDateKey(utcDate, timeZone);
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function meanOfValid(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v != null);
  if (valid.length === 0) return null;
  return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 1000) / 1000;
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

interface HourlyRow {
  measured_at: string;
  ec_avg: number | null;
  ph_avg: number | null;
  air_temperature_avg_c: number | null;
  relative_humidity_avg_pct: number | null;
}

function toExposureInput(h: HourlyRow, f: FeatureRow): ExposureHourlyInput {
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
  return { measuredAt: h.measured_at, ecAvg: h.ec_avg, phAvg: h.ph_avg, features };
}

// GET /?varietyId=&start=&end=&granularity=hourly|daily|weekly
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, start, end } = req.query;
    const granularity = (req.query.granularity as Granularity) || 'hourly';
    if (!varietyId) return res.status(400).json({ error: 'varietyId is required' });

    let query = supabase
      .from('variety_climate_hourly_features')
      .select('*')
      .eq('variety_id', varietyId as string)
      .order('measured_at', { ascending: true });
    if (start) query = query.gte('measured_at', start as string);
    if (end) query = query.lte('measured_at', end as string);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as FeatureRow[];

    if (granularity === 'hourly') {
      return res.json({ granularity, rows });
    }

    // Daily/weekly buckets return the full ExposureWindowFeatures shape (VPD
    // avg/min/max/bands, EC/pH avg/min/max/stddev, radiation-weighted CO2,
    // coverage, etc.) by reusing aggregateExposureWindow per bucket — the
    // exact same aggregator /exposure uses — rather than hand-rolling a
    // second, narrower rollup. Needs the raw variety_climate_hourly rows too
    // (EC/pH/temp/RH aren't stored on the features table).
    const hourlyRows = await fetchAllRows<HourlyRow>((from, to) => {
      let q = supabase
        .from('variety_climate_hourly')
        .select('measured_at, ec_avg, ph_avg, air_temperature_avg_c, relative_humidity_avg_pct')
        .eq('variety_id', varietyId as string)
        .order('measured_at', { ascending: true });
      if (start) q = q.gte('measured_at', start as string);
      if (end) q = q.lte('measured_at', end as string);
      return q.range(from, to);
    });
    const hourlyByTs = new Map(hourlyRows.map((h) => [h.measured_at, h]));

    const bucketKey = (measuredAt: string) =>
      granularity === 'daily'
        ? localCalendarDateKey(new Date(measuredAt), GREENHOUSE_TIME_ZONE)
        : isoWeekKey(new Date(measuredAt), GREENHOUSE_TIME_ZONE);

    const buckets = new Map<string, { hourly: HourlyRow; feature: FeatureRow }[]>();
    for (const f of rows) {
      const h = hourlyByTs.get(f.measured_at);
      if (!h) continue; // shouldn't happen — features are 1:1 with hourly rows
      const key = bucketKey(f.measured_at);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push({ hourly: h, feature: f });
    }

    const hoursExpectedPerBucket = granularity === 'daily' ? 24 : 168;
    const aggregated = Array.from(buckets.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([bucket, bucketRows]) => ({
        bucket,
        hourCount: bucketRows.length,
        airTemperatureAvgC: meanOfValid(bucketRows.map((r) => r.hourly.air_temperature_avg_c)),
        relativeHumidityAvgPct: meanOfValid(bucketRows.map((r) => r.hourly.relative_humidity_avg_pct)),
        ...aggregateExposureWindow(bucketRows.map((r) => toExposureInput(r.hourly, r.feature)), hoursExpectedPerBucket),
      }));

    res.json({
      granularity,
      rows: aggregated,
      note: 'Each bucket is the full exposure-window aggregate for its hours (same math as /exposure) — coveragePct/hoursObserved/hoursExpected are against a fixed 24h (daily) or 168h (weekly) expectation, not just the hours returned in this range.',
    });
  } catch (e) {
    next(e);
  }
});

// GET /exposure?varietyId=&start=&end= — start inclusive, end exclusive.
// Joins variety_climate_hourly (for raw EC/pH stability) with
// variety_climate_hourly_features (for derived features) and returns one
// aggregated ExposureWindowFeatures object for the range.
router.get('/exposure', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, start, end } = req.query;
    if (!varietyId || !start || !end) return res.status(400).json({ error: 'varietyId, start, and end are required' });

    const [hourlyRows, featureRows] = await Promise.all([
      fetchAllRows<HourlyRow>((from, to) =>
        supabase
          .from('variety_climate_hourly')
          .select('measured_at, ec_avg, ph_avg, air_temperature_avg_c, relative_humidity_avg_pct')
          .eq('variety_id', varietyId as string)
          .gte('measured_at', start as string)
          .lt('measured_at', end as string)
          .range(from, to)
      ),
      fetchAllRows<FeatureRow>((from, to) =>
        supabase
          .from('variety_climate_hourly_features')
          .select('*')
          .eq('variety_id', varietyId as string)
          .gte('measured_at', start as string)
          .lt('measured_at', end as string)
          .range(from, to)
      ),
    ]);

    const featuresByTs = new Map(featureRows.map((r) => [r.measured_at, r]));
    const inputs: ExposureHourlyInput[] = hourlyRows
      .map((h) => {
        const f = featuresByTs.get(h.measured_at);
        return f ? toExposureInput(h, f) : null;
      })
      .filter((v): v is ExposureHourlyInput => v != null);

    const hoursExpected = wholeHoursBetween(start as string, end as string);
    const result = aggregateExposureWindow(inputs, hoursExpected);
    res.json({ varietyId, start, end, ...result });
  } catch (e) {
    next(e);
  }
});

// POST /recompute — { varietyId, start, end } (both inclusive). Backfills or
// repairs variety_climate_hourly_features from variety_climate_hourly for
// every hour already committed in that range.
router.post('/recompute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, start, end } = req.body ?? {};
    if (!varietyId || !start || !end) return res.status(400).json({ error: 'varietyId, start, and end are required' });

    const rows = await fetchAllRows<{ measured_at: string }>((from, to) =>
      supabase
        .from('variety_climate_hourly')
        .select('measured_at')
        .eq('variety_id', varietyId)
        .gte('measured_at', start)
        .lte('measured_at', end)
        .range(from, to)
    );

    await recomputeVarietyClimateFeatures(rows.map((r) => ({ varietyId, measuredAt: r.measured_at })));
    res.json({ status: 'recomputed', hoursProcessed: rows.length });
  } catch (e) {
    next(e);
  }
});

export default router;
