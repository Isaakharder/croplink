// Bridges the pure calculations in climateFeatures.ts to the database:
// (re)derives variety_climate_hourly_features rows from variety_climate_hourly
// for a given set of (variety_id, measured_at) pairs. Called non-fatally
// after a climate import batch commits or a timestamp correction is applied,
// and directly by the manual recompute/backfill route.
import { supabase } from './supabase';
import { fetchAllRows } from './fetchAllRows';
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
  'id, organization_id, variety_id, measured_at, air_temperature_avg_c, relative_humidity_avg_pct, co2_avg_ppm, ec_avg, ph_avg, irrigation_interval_delta_ml, irrigation_interval_minutes, radiation_interval_delta_j_cm2';

/**
 * Recomputes and upserts variety_climate_hourly_features for every hour in
 * `pairs`, grouped per variety. Fetches one hour before the earliest
 * requested timestamp per variety so the first row's EC/pH delta has a
 * previous value to compare against.
 */
export async function recomputeVarietyClimateFeatures(pairs: VarietyMeasuredAtPair[]): Promise<void> {
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

    const rows = await fetchAllRows<VarietyHourlyRow>((from, to) =>
      supabase
        .from('variety_climate_hourly')
        .select(HOURLY_SELECT)
        .eq('variety_id', varietyId)
        .gte('measured_at', lookbackStart)
        .lte('measured_at', latest)
        .order('measured_at', { ascending: true })
        .range(from, to)
    );

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
