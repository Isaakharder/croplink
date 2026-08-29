import { SupabaseClient } from '@supabase/supabase-js';
import { chunkArray } from './chunkArray';
import { fetchAllRows } from './paginatedFetch';

/**
 * Corrected, flow-based fruit-set count — the Round 6 fix for the
 * stock-vs-flow defect found in the 2026-08-28 diagnostic.
 *
 * The production fruit-set number (see routes/fruitSetByWeek.ts, and
 * whatever a grower last saved into harvest_timing_profiles.avg_fruit_set
 * from it) counts every node whose weekly_node_statuses row says
 * 'SetFruit' THAT WEEK. Because a node keeps getting recorded as SetFruit
 * for as long as it stays in that stage — not just the week it first
 * transitioned — that is a STANDING CENSUS (stock), not a count of newly
 * set fruit (flow). A node open in SetFruit status for 3 consecutive weeks
 * gets counted 3 times.
 *
 * fruit_instances, by contrast, is a stable per-fruit-lifecycle table: one
 * row per physical fruit, created on its FIRST-ever SetFruit observation
 * and never re-created by later re-observations of the same still-open
 * fruit (see handleSetFruit() in routes/weeklyStatuses.ts, specifically
 * the "open instance" search that only creates a new row when no open
 * 'set' instance already exists on that node). Counting DISTINCT
 * fruit_instances rows per set_week_number is therefore a clean flow
 * count — this is exactly what this module does; it does not need to
 * re-derive first-appearance logic, because weeklyStatuses.ts already
 * implements it, correctly, at write time.
 *
 * Known, confirmed residual limitation (Phase 1 of the Round 6
 * investigation — see phase1-lifecycle-audit.ts): if a status is
 * corrected backward within the same session (e.g. a mis-tapped
 * 'SetFruit' immediately corrected to 'Flower', or 'Harvested' corrected
 * back to 'BreakerFruit'), fruit_instances has no path to reverse what it
 * already wrote — it can end up anchored to the wrong week, or a later
 * genuine transition can get silently dropped because the row already
 * looks resolved. Confirmed present for 4-9 nodes out of ~2,259 for
 * Mathieu (under 0.9%) — a real, narrow gap, not a reason to prefer the
 * census over the flow count.
 *
 * IMPORTANT — Round 7 correction: an earlier version of this module (and
 * the Round 6 report built on it) attributed most of the census/flow gap
 * to "46% of fruit belongs to inactive nodes." That was wrong — retracted
 * after direct verification. The true is_active split for Mathieu is
 * 2,238 active / 21 inactive (0.9%), not 46%. The real cause was a plain
 * Supabase default page-size cap (1,000 rows) on the plant_nodes query
 * below: Mathieu has 2,259 plant_nodes under its 56 tracked stems (many
 * per stem — main positions plus side-shoots accumulated through the
 * season), so an unpaginated `.select()` silently returned an arbitrary
 * ~1,000-node slice, not the true active roster. Because nodes are
 * created progressively through the season, the missing ~1,259 nodes
 * skewed toward LATER set-weeks — which is exactly why weeks 26-30 looked
 * anomalous before this fix. Now paginated via fetchAllRows(); see
 * phase-true-population-recompute.ts for the corrected numbers.
 */

export interface SetWeekFruitSetDebug {
  setWeekNumber: number;
  measuredStemCount: number;
  measuredRowCount: number;
  totalStems: number;
  areaM2: number;
  scaleMultiplier: number;
  /** Raw "status = SetFruit this week" count — the production input's source. */
  censusCount: number;
  censusFruitPerM2: number;
  /** Distinct fruit_instances rows with this set_week_number — the corrected flow count. */
  flowCount: number;
  flowFruitPerM2: number;
  /** Whatever is currently saved in harvest_timing_profiles for this set-week (production's actual input today). */
  storedAvgFruitSet: number;
  ratioStoredToFlow: number | null;
  ratioCensusToFlow: number | null;
  /** |storedAvgFruitSet - censusFruitPerM2| > epsilon — flags a stale manual Calculator save, independent of the stock/flow issue. */
  staleVsLiveCensus: boolean;
  /** measuredStemCount is well below the variety's full tracked-stem count — this week's coverage was thin regardless of which count method is used. */
  lowCoverageFlag: boolean;
}

interface FetchArgs {
  supabase: SupabaseClient;
  varietyId: string;
  year: number;
  storedAvgFruitSetByWeek: Map<number, number>;
}

export async function computeFlowFruitSetDebug({
  supabase, varietyId, year, storedAvgFruitSetByWeek,
}: FetchArgs): Promise<Map<number, SetWeekFruitSetDebug>> {
  const { data: variety, error: vErr } = await supabase
    .from('varieties')
    .select('total_stem_count, area_m2')
    .eq('id', varietyId)
    .single();
  if (vErr) throw new Error(vErr.message);

  const totalStems: number = variety?.total_stem_count ?? 0;
  const areaM2: number = variety?.area_m2 ?? 0;

  const { data: rowsData, error: rErr } = await supabase
    .from('measurement_rows')
    .select('id')
    .eq('variety_id', varietyId)
    .eq('is_active', true);
  if (rErr) throw new Error(rErr.message);
  const rowIds = (rowsData ?? []).map((r: { id: string }) => r.id);
  if (rowIds.length === 0) return new Map();

  const { data: stemsData, error: sErr } = await supabase
    .from('measurement_stems')
    .select('id, measurement_row_id')
    .in('measurement_row_id', rowIds)
    .eq('is_active', true);
  if (sErr) throw new Error(sErr.message);
  const stemIds = (stemsData ?? []).map((s: { id: string }) => s.id);
  const rowByStem = new Map((stemsData ?? []).map((s: { id: string; measurement_row_id: string }) => [s.id, s.measurement_row_id]));
  if (stemIds.length === 0) return new Map();

  // Paginated — see the Round 7 correction note above. Mathieu alone has
  // 2,259 plant_nodes under 56 stems; an unpaginated select() here was the
  // actual defect behind what Round 6 misdiagnosed as an is_active issue.
  const nodesData = await fetchAllRows<{ id: string; measurement_stem_id: string }>(() =>
    supabase.from('plant_nodes').select('id, measurement_stem_id').in('measurement_stem_id', stemIds).eq('is_active', true)
  );
  const nodeIds = nodesData.map((n) => n.id);
  const stemByNode = new Map(nodesData.map((n) => [n.id, n.measurement_stem_id]));
  if (nodeIds.length === 0) return new Map();

  const statusBatches = await Promise.all(
    chunkArray(nodeIds, 100).map((ids) =>
      fetchAllRows<{ week_number: number; status: string; plant_node_id: string }>(() =>
        supabase.from('weekly_node_statuses').select('week_number, status, plant_node_id').in('plant_node_id', ids).eq('year', year)
      )
    )
  );
  const statuses = statusBatches.flat();

  // Scoped to the SAME active-node population as the census above
  // (nodeIds, already is_active-filtered and now fully paginated) — not
  // just variety_id. Restricting to the same population isolates
  // stock-vs-flow as the only variable, matching every other candidate
  // comparison in this investigation.
  const fiBatches = await Promise.all(
    chunkArray(nodeIds, 100).map((ids) =>
      fetchAllRows<{ set_week_number: number; plant_node_id: string }>(() =>
        supabase.from('fruit_instances').select('set_week_number, plant_node_id').eq('variety_id', varietyId).eq('set_year', year).in('plant_node_id', ids)
      )
    )
  );
  const fruitInstances = fiBatches.flat();

  const censusByWeek = new Map<number, { count: number; stems: Set<string>; rows: Set<string> }>();
  for (let w = 1; w <= 52; w++) censusByWeek.set(w, { count: 0, stems: new Set(), rows: new Set() });
  for (const s of statuses) {
    if (s.week_number < 1 || s.week_number > 52) continue;
    const stemId = stemByNode.get(s.plant_node_id);
    if (!stemId) continue;
    const entry = censusByWeek.get(s.week_number)!;
    entry.stems.add(stemId);
    const rowId = rowByStem.get(stemId);
    if (rowId) entry.rows.add(rowId);
    if (s.status === 'SetFruit') entry.count++;
  }

  const flowByWeek = new Map<number, number>();
  for (const fi of fruitInstances) {
    flowByWeek.set(fi.set_week_number, (flowByWeek.get(fi.set_week_number) ?? 0) + 1);
  }

  const totalTrackedStems = stemIds.length;
  const result = new Map<number, SetWeekFruitSetDebug>();
  for (let w = 1; w <= 52; w++) {
    const census = censusByWeek.get(w)!;
    const measuredStemCount = census.stems.size;
    const measuredRowCount = census.rows.size;
    const scaleMultiplier = measuredStemCount > 0 && totalStems > 0 ? totalStems / measuredStemCount : 0;
    const censusFruitPerM2 = measuredStemCount > 0 && areaM2 > 0 ? (census.count / measuredStemCount) * totalStems / areaM2 : 0;
    const flowCount = flowByWeek.get(w) ?? 0;
    const flowFruitPerM2 = measuredStemCount > 0 && areaM2 > 0 ? (flowCount / measuredStemCount) * totalStems / areaM2 : 0;
    const storedAvgFruitSet = storedAvgFruitSetByWeek.get(w) ?? 0;

    if (census.count === 0 && flowCount === 0 && storedAvgFruitSet === 0) continue;

    result.set(w, {
      setWeekNumber: w,
      measuredStemCount,
      measuredRowCount,
      totalStems,
      areaM2,
      scaleMultiplier,
      censusCount: census.count,
      censusFruitPerM2,
      flowCount,
      flowFruitPerM2,
      storedAvgFruitSet,
      ratioStoredToFlow: flowFruitPerM2 > 0 ? storedAvgFruitSet / flowFruitPerM2 : null,
      ratioCensusToFlow: flowFruitPerM2 > 0 ? censusFruitPerM2 / flowFruitPerM2 : (census.count > 0 ? Infinity : null),
      staleVsLiveCensus: Math.abs(storedAvgFruitSet - censusFruitPerM2) > 0.05,
      lowCoverageFlag: totalTrackedStems > 0 && measuredStemCount < totalTrackedStems * 0.5,
    });
  }
  return result;
}
