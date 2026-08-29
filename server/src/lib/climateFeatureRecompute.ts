// Bridges the pure calculations in climateFeatures.ts to the database:
// (re)derives variety_climate_hourly_features rows from variety_climate_hourly
// for a given set of (variety_id, measured_at) pairs. Called non-fatally
// after a climate import batch commits or a timestamp correction is applied,
// and directly by the manual recompute/backfill route.
import { supabase } from './supabase';
import { fetchAllRows } from './paginatedFetch';
import { computeHourlyFeatures, type VarietyClimateHourlyRowLike } from './climateFeatures';

export interface VarietyMeasuredAtPair {
  varietyId: string;
  measuredAt: string;
}

interface VarietyHourlyRow extends VarietyClimateHourlyRowLike {
  id: string;
  organization_id: string | null;
}

const HOURLY_SELECT =
  'id, organization_id, variety_id, measured_at, air_temperature_avg_c, relative_humidity_avg_pct, vpd_avg_kpa, co2_avg_ppm, ec_avg, ph_avg, irrigation_interval_delta_ml, irrigation_interval_minutes, radiation_interval_delta_j_cm2';

/**
 * Recomputes and upserts variety_climate_hourly_features for every hour in
 * `pairs`, grouped per variety. Fetches one hour before the earliest
 * requested timestamp per variety so the first row's EC/pH delta has a
 * previous value to compare against.
 *
 * `contextRows` (optional): additional variety-hourly rows the caller has
 * already computed in memory but may not have persisted (e.g. the rollup
 * service's own backward-lookback hour, computed fresh from raw data but
 * outside the job's own written range). These fill in for the DB fetch when
 * a lookback hour isn't in variety_climate_hourly yet -- without this, the
 * DB fetch above would silently see nothing for that hour and treat the
 * first requested hour as a fresh series start, which is exactly the
 * processing-order dependency this exists to remove. Context rows take
 * precedence over the DB fetch when both exist for the same hour, since
 * they reflect the caller's most recent computation; for the CORE hours
 * (already written earlier in the same call) the DB fetch is equally fresh,
 * so precedence only matters where it's needed. Context rows never get an
 * `id` (they're not being written here) -- safe, since `row.id` is only
 * ever read for hours that pass the `earliest` cutoff below and get a
 * feature row written, and a context row by construction falls before that
 * cutoff.
 */
export async function recomputeVarietyClimateFeatures(
  pairs: VarietyMeasuredAtPair[],
  contextRows: (VarietyClimateHourlyRowLike & { variety_id: string })[] = []
): Promise<void> {
  const byVariety = new Map<string, string[]>();
  for (const p of pairs) {
    if (!byVariety.has(p.varietyId)) byVariety.set(p.varietyId, []);
    byVariety.get(p.varietyId)!.push(p.measuredAt);
  }

  for (const [varietyId, timestamps] of byVariety) {
    const sorted = [...timestamps].sort();
    const earliest = sorted[0];
    const latest = sorted[sorted.length - 1];
    const lookbackStart = new Date(new Date(earliest).getTime() - 3600000).toISOString();

    const rowsUnsorted = await fetchAllRows<VarietyHourlyRow>(() =>
      supabase
        .from('variety_climate_hourly')
        .select(HOURLY_SELECT)
        .eq('variety_id', varietyId)
        .gte('measured_at', lookbackStart)
        .lte('measured_at', latest)
    );

    const byKey = new Map<string, VarietyHourlyRow>();
    for (const r of rowsUnsorted) byKey.set(r.measured_at, r);
    for (const r of contextRows) {
      if (r.variety_id !== varietyId) continue;
      if (r.measured_at < lookbackStart || r.measured_at > latest) continue;
      byKey.set(r.measured_at, { ...r, id: '', organization_id: null } as VarietyHourlyRow);
    }
    // The loop below indexes rows[i-1] as "the previous hour" — chronological
    // order is load-bearing here, not cosmetic, since the new helper's
    // default page ordering is by id, not measured_at.
    const rows = Array.from(byKey.values()).sort((a, b) => (a.measured_at < b.measured_at ? -1 : a.measured_at > b.measured_at ? 1 : 0));

    const featureRows: Record<string, unknown>[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (new Date(row.measured_at).getTime() < new Date(earliest).getTime()) continue; // lookback-only row, not a target to upsert
      const previousRow = i > 0 ? rows[i - 1] : null;
      const computed = computeHourlyFeatures(row, previousRow);
      featureRows.push({
        organization_id: row.organization_id,
        variety_id: varietyId,
        measured_at: row.measured_at,
        degree_hours: computed.degreeHours,
        vpd_kpa: computed.vpdKpa,
        vpd_source: computed.vpdSource,
        vpd_band: computed.vpdBand,
        is_daylight: computed.isDaylight,
        ec_delta: computed.ecDelta,
        ph_delta: computed.phDelta,
        co2_avg_ppm: computed.co2AvgPpm,
        radiation_interval_delta_j_cm2: computed.radiationIntervalDeltaJCm2,
        irrigation_interval_delta_ml: computed.irrigationIntervalDeltaMl,
        irrigation_interval_minutes: computed.irrigationIntervalMinutes,
        source_variety_hourly_id: row.id,
        degree_hour_base_temp_c: computed.degreeHourBaseTempC,
        degree_hour_upper_cap_c: computed.degreeHourUpperCapC,
        vpd_band_config_version: computed.vpdBandConfigVersion,
        feature_engine_version: computed.featureEngineVersion,
      });
    }

    if (featureRows.length === 0) continue;
    const { error } = await supabase
      .from('variety_climate_hourly_features')
      .upsert(featureRows, { onConflict: 'variety_id,measured_at' });
    if (error) throw new Error(`Failed to upsert variety_climate_hourly_features for variety ${varietyId}: ${error.message}`);
  }
}
