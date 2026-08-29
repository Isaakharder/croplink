// Append-only forecast snapshot service (Round 10, Phase 6). Freezes the
// output of computeHarvestProjections (imported, never reimplemented, so a
// snapshot can never quietly drift from what the live route actually
// computes) plus the climate coverage known at that moment. Never writes to
// harvest_timing_profiles / avg_fruit_set / anything grower-facing -- this
// only ever inserts new rows into projection_snapshots, which the DB itself
// refuses to let anyone update afterward (see the migration).
import { randomUUID } from 'crypto';
import { supabase } from './supabase';
import { computeHarvestProjections } from '../routes/harvestProjections';

const CALCULATION_VERSION = 'round10-multi-candidate-v1';

export interface RunProjectionSnapshotResult {
  runId: string;
  year: number;
  varietiesSnapshotted: number;
  varietyIds: string[];
}

export async function runProjectionSnapshot(year: number, runId?: string): Promise<RunProjectionSnapshotResult> {
  const snapshotRunId = runId ?? randomUUID();
  const effectiveAt = new Date().toISOString();

  const result = await computeHarvestProjections(year, undefined, true);
  if (result.varieties.length === 0) {
    return { runId: snapshotRunId, year, varietiesSnapshotted: 0, varietyIds: [] };
  }

  const { data: seasons } = await supabase.from('seasons').select('id').eq('year', year);
  const seasonId = seasons?.[0]?.id;
  if (!seasonId) throw new Error(`No season found for year ${year}`);

  const varietyIds = result.varieties.map((v) => v.id);
  const { data: afwRows } = await supabase
    .from('harvest_afw_by_week')
    .select('variety_id, week_number, weight_grams, source')
    .in('variety_id', varietyIds)
    .eq('year', year);
  const afwByVariety = new Map<string, { week_number: number; weight_grams: number; source: string }[]>();
  for (const r of afwRows ?? []) {
    if (!afwByVariety.has(r.variety_id)) afwByVariety.set(r.variety_id, []);
    afwByVariety.get(r.variety_id)!.push({ week_number: r.week_number, weight_grams: r.weight_grams, source: r.source });
  }

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const rows: Record<string, unknown>[] = [];

  for (const v of result.varieties as any[]) {
    const { count: hoursObserved } = await supabase
      .from('variety_climate_hourly_features')
      .select('*', { count: 'exact', head: true })
      .eq('variety_id', v.id)
      .gte('measured_at', sevenDaysAgo.toISOString())
      .lt('measured_at', now.toISOString());
    const hoursExpected = 168;
    const coveragePct = Math.round(((hoursObserved ?? 0) / hoursExpected) * 10000) / 100;

    const projectedKgByWeek = Object.fromEntries(
      v.weeks.map((w: any) => [
        w.week,
        {
          legacy: w.projectedKg,
          empirical: w.projectedKgEmpirical ?? null,
          flowLegacy: w.projectedKgFlowLegacy ?? null,
          flowEmpirical: w.projectedKgFlowEmpirical ?? null,
          flowPooled: w.projectedKgFlowPooled ?? null,
        },
      ])
    );

    rows.push({
      snapshot_run_id: snapshotRunId,
      organization_id: null,
      season_id: seasonId,
      variety_id: v.id,
      year,
      calculation_version: CALCULATION_VERSION,
      effective_at: effectiveAt,
      cohort_counts: v.fruitSetDebug ?? [],
      timing_curve: v.timingDebug ?? [],
      timing_curve_source: 'candidates: legacy=fixed 20/40/40 harvest_timing_profiles; empirical=per-set-week gated empirical (Round 2/3); pooled=mature-pooled empirical (Round 4/5, diagnostic only)',
      survival_factor: v.poolDebug ?? null,
      survival_factor_source: v.poolDebug ? 'Round 3/4 abort/prune-adjusted resolution rate, maturity-gated with pooled fallback' : null,
      afw_by_week: afwByVariety.get(v.id) ?? [],
      afw_source: 'harvest_afw_by_week, carry-forward resolved (see afwCarryForward.ts)',
      climate_exposure_known: { hoursObserved: hoursObserved ?? 0, hoursExpected, windowStart: sevenDaysAgo.toISOString(), windowEnd: now.toISOString() },
      climate_coverage_quality: { coveragePct, note: 'Observational only as of this round -- not used as a model input for any candidate above.' },
      future_climate_assumption: null,
      projected_kg_by_week: projectedKgByWeek,
      total_kg: v.totalKg,
    });
  }

  // ignoreDuplicates so a retried call with the same runId is idempotent —
  // an already-written row for (runId, varietyId) is left exactly as it was
  // (the UPDATE trigger would reject a DO UPDATE attempt anyway; this avoids
  // even trying).
  const { error } = await supabase.from('projection_snapshots').upsert(rows, {
    onConflict: 'snapshot_run_id,variety_id',
    ignoreDuplicates: true,
  });
  if (error) throw new Error(`Failed to write projection_snapshots: ${error.message}`);

  return { runId: snapshotRunId, year, varietiesSnapshotted: rows.length, varietyIds };
}
