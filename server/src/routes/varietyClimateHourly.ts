import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { GREENHOUSE_TIME_ZONE } from '../lib/ridderParser';
import { localCalendarDateKey } from '../lib/climateAveraging';
import { sumAccumulatedRadiationJCm2 } from '../lib/climateFeatures';
import { fetchAllRows } from '../lib/paginatedFetch';

const router = Router();

type Granularity = 'hourly' | 'daily' | 'weekly';

interface HourlyClimateRow {
  measured_at: string;
  air_temperature_avg_c: number | null;
  relative_humidity_avg_pct: number | null;
  co2_avg_ppm: number | null;
  ec_avg: number | null;
  ph_avg: number | null;
  irrigation_interval_delta_ml: number | null;
  irrigation_cumulative_avg_ml: number | null;
  radiation_interval_delta_j_cm2: number | null;
  radiation_cumulative_j_cm2: number | null;
}

function isoWeekKey(utcDate: Date, timeZone: string): string {
  // Uses the greenhouse-local calendar date to bucket into ISO weeks, so a
  // reading just after local midnight isn't attributed to the wrong week.
  const dateStr = localCalendarDateKey(utcDate, timeZone); // YYYY-MM-DD
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
  return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 100) / 100;
}

function sumOfValid(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v != null);
  if (valid.length === 0) return null;
  return Math.round(valid.reduce((a, b) => a + b, 0) * 100) / 100;
}

// GET /variety-hourly?varietyId=&start=&end=&granularity=hourly|daily|weekly
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, start, end } = req.query;
    const granularity = (req.query.granularity as Granularity) || 'hourly';
    if (!varietyId) return res.status(400).json({ error: 'varietyId is required' });

    // Paginated (was unbounded): a full-season, unfiltered request for one
    // variety can exceed 1,000 hourly rows well before the season ends
    // (24/day × even a few weeks). Truncation here is a worse failure mode
    // than most — it silently drops the LATEST hours (default order was
    // ascending measured_at with no .range()), making a chart look like it
    // just stops partway through with no error. Paginated by `id` (the
    // helper's default, guaranteed unique) rather than `measured_at`
    // directly, then explicitly re-sorted by measured_at afterward — same
    // deterministic-tiebreaker approach requirement #2 asks for, without
    // assuming measured_at itself is collision-free.
    const rowsUnsorted = await fetchAllRows<HourlyClimateRow>(() => {
      let q = supabase.from('variety_climate_hourly').select('*').eq('variety_id', varietyId as string);
      if (start) q = q.gte('measured_at', start as string);
      if (end) q = q.lte('measured_at', end as string);
      return q;
    });
    const rows = rowsUnsorted.sort((a, b) => (a.measured_at < b.measured_at ? -1 : a.measured_at > b.measured_at ? 1 : 0));

    if (granularity === 'hourly') {
      return res.json({ granularity, rows });
    }

    const bucketKey = (r: (typeof rows)[number]) =>
      granularity === 'daily'
        ? localCalendarDateKey(new Date(r.measured_at), GREENHOUSE_TIME_ZONE)
        : isoWeekKey(new Date(r.measured_at), GREENHOUSE_TIME_ZONE);

    const buckets = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = bucketKey(r);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(r);
    }

    const aggregated = Array.from(buckets.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([bucket, bucketRows]) => {
        const lastByTime = [...bucketRows].sort((a, b) => new Date(a.measured_at).getTime() - new Date(b.measured_at).getTime());
        const last = lastByTime[lastByTime.length - 1];
        return {
          bucket,
          hourCount: bucketRows.length,
          airTemperatureAvgC: meanOfValid(bucketRows.map((r) => r.air_temperature_avg_c)),
          relativeHumidityAvgPct: meanOfValid(bucketRows.map((r) => r.relative_humidity_avg_pct)),
          co2AvgPpm: meanOfValid(bucketRows.map((r) => r.co2_avg_ppm)),
          ecAvg: meanOfValid(bucketRows.map((r) => r.ec_avg)),
          phAvg: meanOfValid(bucketRows.map((r) => r.ph_avg)),
          irrigationIntervalTotalMl: sumOfValid(bucketRows.map((r) => r.irrigation_interval_delta_ml)),
          irrigationCumulativeEndOfPeriodMl: last?.irrigation_cumulative_avg_ml ?? null,
          // The true accumulated radiation for this bucket — use this, not
          // radiationCumulativeEndOfPeriodJCm2 below, for totals/charts/model
          // inputs (see sumAccumulatedRadiationJCm2's doc comment).
          radiationIntervalTotalJCm2: sumAccumulatedRadiationJCm2(bucketRows.map((r) => r.radiation_interval_delta_j_cm2)),
          // Raw sensor counter reading at the bucket's last hour — NOT a true
          // accumulated total. The counter can reset mid-day (confirmed
          // against real data), so this can read lower than the period's
          // actual accumulated radiation. Diagnostic/audit value only.
          radiationCumulativeEndOfPeriodJCm2: last?.radiation_cumulative_j_cm2 ?? null,
        };
      });

    res.json({
      granularity,
      rows: aggregated,
      note: 'Daily/weekly point-in-time metrics (temp/RH/CO2/EC/pH) are a simple mean of the hourly averages in the bucket. irrigationIntervalTotalMl and radiationIntervalTotalJCm2 are the true accumulated totals for the bucket (summed interval deltas; radiation excludes negative sensor-reset deltas). irrigationCumulativeEndOfPeriodMl and radiationCumulativeEndOfPeriodJCm2 are raw sensor counter readings at the bucket\'s last hour, not accumulated totals — the radiation counter in particular can reset mid-day, so prefer radiationIntervalTotalJCm2 for anything that needs "how much radiation this period."',
    });
  } catch (e) {
    next(e);
  }
});

export default router;
