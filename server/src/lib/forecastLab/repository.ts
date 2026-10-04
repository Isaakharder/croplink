// Forecast Lab data access (Supabase, server-side only). Every unbounded read is
// paginated; reads of tables that a not-yet-applied migration creates degrade
// to "unavailable" instead of failing the page.
import { supabase } from '../supabase';
import { fetchAllRows } from '../paginatedFetch';
import { chunkArray } from '../chunkArray';
import { StatusEvent } from '../harvestForecast';
import { isoWeekIndex } from '../isoWeek';
import { deriveWeeklyAfw, V2DailyRow } from '../growlinkYieldSync';
import { computeHarvestProjections } from '../../routes/harvestProjections';
import { AfwPoint, LabInputs, LabVariety } from './engine';
import { SnapshotRow, V1ActualRow, V2ActualRow, Exclusion } from './evaluation';

type Err = { code?: string; message?: string } | null | undefined;

/** Table (or its schema-cache entry) does not exist yet — its migration hasn't been applied. */
export function isMissingTable(error: Err): boolean {
  if (!error) return false;
  return error.code === '42P01' || error.code === 'PGRST205' || /does not exist|could not find the table/i.test(error.message ?? '');
}

export interface VarietyRecord { id: string; name: string; area_m2: number | null; total_stem_count: number | null; plant_count: number | null; pull_out_date: string | null; updated_at: string | null; is_active: boolean; season_id: string }

export async function activeVarietiesForYear(year: number): Promise<VarietyRecord[]> {
  const { data: seasons, error: sErr } = await supabase.from('seasons').select('id').eq('year', year);
  if (sErr) throw new Error(sErr.message);
  const ids = (seasons ?? []).map((s: { id: string }) => s.id);
  if (!ids.length) return [];
  const { data, error } = await supabase.from('varieties').select('id, name, area_m2, total_stem_count, plant_count, pull_out_date, updated_at, is_active, season_id').in('season_id', ids).eq('is_active', true).order('name');
  if (error) throw new Error(error.message);
  return (data ?? []) as VarietyRecord[];
}

export function toLabVariety(v: VarietyRecord): LabVariety {
  return { id: v.id, name: v.name, areaM2: Number(v.area_m2) || 0, totalStems: Number(v.total_stem_count) || 0, plantCount: v.plant_count, pullOutDate: v.pull_out_date, configUpdatedAt: v.updated_at };
}

/** Raw weekly statuses for the variety's active rows/stems/nodes, for `years`. */
export async function loadStatusEvents(varietyId: string, years: number[]): Promise<StatusEvent[]> {
  const { data: rows, error: rErr } = await supabase.from('measurement_rows').select('id').eq('variety_id', varietyId).eq('is_active', true);
  if (rErr) throw new Error(rErr.message);
  const rowIds = (rows ?? []).map((r: { id: string }) => r.id);
  if (!rowIds.length) return [];
  const { data: stems, error: sErr } = await supabase.from('measurement_stems').select('id').in('measurement_row_id', rowIds).eq('is_active', true);
  if (sErr) throw new Error(sErr.message);
  const stemIds = (stems ?? []).map((s: { id: string }) => s.id);
  if (!stemIds.length) return [];
  const nodes = await fetchAllRows<{ id: string; measurement_stem_id: string }>(() =>
    supabase.from('plant_nodes').select('id, measurement_stem_id').in('measurement_stem_id', stemIds).eq('is_active', true)
  );
  const stemByNode = new Map(nodes.map((n) => [n.id, n.measurement_stem_id]));
  const batches = await Promise.all(chunkArray(nodes.map((n) => n.id), 100).map((ids) =>
    fetchAllRows<{ id: string; plant_node_id: string; year: number; week_number: number; status: string; created_at: string }>(() =>
      supabase.from('weekly_node_statuses').select('id, plant_node_id, year, week_number, status, created_at').in('plant_node_id', ids).in('year', years)
    )
  ));
  return batches.flat().map((s) => ({ plantNodeId: s.plant_node_id, stemId: stemByNode.get(s.plant_node_id) as string, year: s.year, week: s.week_number, status: s.status, createdAt: s.created_at }));
}

export interface SourceData {
  inputs: LabInputs;
  v1Actuals: V1ActualRow[];
  v2Actuals: V2ActualRow[];
  v2Available: boolean;
  growlinkVarietyKey: string | null;
  lastV2Sync: { finishedAt: string | null; status: string } | null;
  lastV1Sync: string | null;
}

export async function loadSourceData(variety: VarietyRecord, year: number): Promise<SourceData> {
  const [events, profilesRes, afwRes, linkRes, v1, legacy] = await Promise.all([
    loadStatusEvents(variety.id, [year - 1, year]),
    supabase.from('harvest_timing_profiles').select('year, set_week_number, avg_fruit_set').eq('variety_id', variety.id).in('year', [year - 1, year]),
    supabase.from('harvest_afw_by_week').select('year, week_number, weight_grams, created_at').eq('variety_id', variety.id).in('year', [year - 1, year]),
    supabase.from('growlink_variety_links').select('growlink_variety_key').eq('variety_id', variety.id).eq('link_status', 'linked').maybeSingle(),
    fetchAllRows<V1ActualRow & { id: string; synced_at: string }>(() => supabase.from('growlink_harvest_actuals').select('id, year, week_number, kg, updated_at, synced_at').eq('variety_id', variety.id)),
    computeHarvestProjections(year, variety.id, false),
  ]);
  for (const r of [profilesRes, afwRes, linkRes]) if (r.error) throw new Error(r.error.message);
  const key = (linkRes.data as { growlink_variety_key: string } | null)?.growlink_variety_key ?? null;

  let v2Rows: (V2ActualRow & { daily: V2DailyRow[]; daily_breakdown_complete: boolean | null; average_fruit_weight_g: number | null })[] = [];
  let v2Available = true;
  if (key) {
    try {
      v2Rows = await fetchAllRows(() => supabase.from('growlink_yield_weeks')
        .select('id, packing_year, packing_week, total_kg, average_fruit_weight_g, daily, daily_breakdown_complete, settlement_status, upstream_status, upstream_updated_at')
        .eq('growlink_variety_id', key));
    } catch (e) {
      if (!isMissingTable(e as Err) && !/growlink_yield_weeks/.test(String((e as Error).message))) throw e;
      v2Available = false;
    }
  }
  let lastV2Sync: SourceData['lastV2Sync'] = null;
  const runs = await supabase.from('growlink_sync_runs').select('finished_at, status').eq('kind', 'yield-weeks').order('started_at', { ascending: false }).limit(1);
  if (!runs.error && runs.data?.[0]) lastV2Sync = { finishedAt: runs.data[0].finished_at, status: runs.data[0].status };

  const afw: AfwPoint[] = [];
  for (const r of v2Rows) {
    if (r.upstream_status !== 'active') continue;
    const d = deriveWeeklyAfw({ totalKg: r.total_kg == null ? null : Number(r.total_kg), averageFruitWeightG: r.average_fruit_weight_g == null ? null : Number(r.average_fruit_weight_g), daily: r.daily ?? [], dailyBreakdownComplete: r.daily_breakdown_complete });
    if (d.afwG) afw.push({ index: isoWeekIndex(r.packing_year, r.packing_week), grams: d.afwG, source: 'growlink-v2', knownAt: r.upstream_updated_at, settled: r.settlement_status === 'settled' });
  }
  for (const r of (afwRes.data ?? []) as { year: number; week_number: number; weight_grams: number; created_at: string }[]) {
    afw.push({ index: isoWeekIndex(r.year, r.week_number), grams: Number(r.weight_grams), source: 'croplink-manual', knownAt: r.created_at, settled: null });
  }
  const legacyByIndex = new Map<number, { kg: number; fruitPerM2: number }>();
  for (const w of legacy.varieties[0]?.weeks ?? []) legacyByIndex.set(isoWeekIndex(year, w.week), { kg: w.projectedKg, fruitPerM2: w.projectedFruitPerM2 });

  return {
    inputs: {
      variety: toLabVariety(variety),
      events,
      afw,
      manualFruitSetPerM2: new Map(((profilesRes.data ?? []) as { year: number; set_week_number: number; avg_fruit_set: number }[]).map((p) => [isoWeekIndex(p.year, p.set_week_number), Number(p.avg_fruit_set) || 0])),
      legacyByIndex,
    },
    v1Actuals: v1,
    v2Actuals: v2Rows,
    v2Available: Boolean(key) && v2Available,
    growlinkVarietyKey: key,
    lastV2Sync,
    lastV1Sync: v1.reduce<string | null>((m, r) => (!m || r.synced_at > m ? r.synced_at : m), null),
  };
}

// ── Snapshots, runs, exclusions, config history ─────────────────────────────

export interface LabStore {
  available(): Promise<boolean>;
  createRun(run: { id: string; kind: 'cycle' | 'manual'; started_at: string; code_version: string | null }): Promise<void>;
  finishRun(id: string, patch: { status: string; finished_at: string; summary: unknown; error: string | null }): Promise<void>;
  /** Inserts new rows; rows whose natural key already exists are left untouched (never updated). Returns how many were new. */
  insertSnapshots(rows: SnapshotRow[]): Promise<number>;
  snapshotAsOfIndexes(varietyId: string, kind: 'live' | 'hindcast'): Promise<Set<string>>;
  listSnapshots(varietyIds: string[]): Promise<SnapshotRow[]>;
  listExclusions(varietyIds: string[]): Promise<Exclusion[]>;
  configHistory(varietyId: string): Promise<{ field: string; old_value: unknown; new_value: unknown; effective_from: string; changed_at: string; source: string; note: string | null }[]>;
}

export const supabaseLabStore: LabStore = {
  async available() {
    const { error } = await supabase.from('forecast_lab_snapshots').select('id', { head: true, count: 'exact' }).limit(1);
    if (error && isMissingTable(error)) return false;
    if (error) throw new Error(error.message);
    return true;
  },
  async createRun(run) {
    const { error } = await supabase.from('forecast_lab_runs').insert({ ...run, status: 'running' });
    if (error) throw new Error(error.message);
  },
  async finishRun(id, patch) {
    const { error } = await supabase.from('forecast_lab_runs').update(patch).eq('id', id);
    if (error) throw new Error(error.message);
  },
  async insertSnapshots(rows) {
    let inserted = 0;
    for (const chunk of chunkArray(rows, 200)) {
      const { data, error } = await supabase.from('forecast_lab_snapshots')
        .upsert(chunk, { onConflict: 'variety_id,model_id,model_version,kind,as_of_index,target_index', ignoreDuplicates: true })
        .select('id');
      if (error) throw new Error(error.message);
      inserted += data?.length ?? 0;
    }
    return inserted;
  },
  async snapshotAsOfIndexes(varietyId, kind) {
    const rows = await fetchAllRows<{ id: number; model_version: string; as_of_index: number }>(() =>
      supabase.from('forecast_lab_snapshots').select('id, model_version, as_of_index').eq('variety_id', varietyId).eq('kind', kind).eq('horizon', 1)
    );
    return new Set(rows.map((r) => `${r.model_version}:${r.as_of_index}`));
  },
  async listSnapshots(varietyIds) {
    if (!varietyIds.length) return [];
    return fetchAllRows<SnapshotRow & { id: number }>(() => supabase.from('forecast_lab_snapshots').select('*').in('variety_id', varietyIds));
  },
  async listExclusions(varietyIds) {
    if (!varietyIds.length) return [];
    const { data, error } = await supabase.from('forecast_lab_exclusions').select('variety_id, target_year, target_week, reason').in('variety_id', varietyIds);
    if (error) { if (isMissingTable(error)) return []; throw new Error(error.message); }
    return (data ?? []).map((e: { variety_id: string; target_year: number; target_week: number; reason: string }) => ({ variety_id: e.variety_id, target_index: isoWeekIndex(e.target_year, e.target_week), reason: e.reason }));
  },
  async configHistory(varietyId) {
    const { data, error } = await supabase.from('variety_config_history').select('field, old_value, new_value, effective_from, changed_at, source, note').eq('variety_id', varietyId).order('changed_at');
    if (error) { if (isMissingTable(error)) return []; throw new Error(error.message); }
    return data ?? [];
  },
};

/** GrowLink actuals only (no measurement load) — for scoring. */
export async function loadActualRows(varietyId: string): Promise<{ v1: V1ActualRow[]; v2: V2ActualRow[] }> {
  const v1 = await fetchAllRows<V1ActualRow & { id: string }>(() => supabase.from('growlink_harvest_actuals').select('id, year, week_number, kg, updated_at').eq('variety_id', varietyId));
  const { data: link, error } = await supabase.from('growlink_variety_links').select('growlink_variety_key').eq('variety_id', varietyId).eq('link_status', 'linked').maybeSingle();
  if (error) throw new Error(error.message);
  let v2: V2ActualRow[] = [];
  if (link?.growlink_variety_key) {
    try {
      v2 = await fetchAllRows<V2ActualRow & { id: string }>(() => supabase.from('growlink_yield_weeks').select('id, packing_year, packing_week, total_kg, settlement_status, upstream_status, upstream_updated_at').eq('growlink_variety_id', link.growlink_variety_key));
    } catch (e) {
      if (!isMissingTable(e as Err) && !/growlink_yield_weeks/.test(String((e as Error).message))) throw e;
    }
  }
  return { v1, v2 };
}
