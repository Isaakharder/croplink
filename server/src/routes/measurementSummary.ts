import { Router, Request, Response, NextFunction } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { chunkArray } from '../lib/chunkArray';
import { fetchAllRows } from '../lib/paginatedFetch';

type SummaryStatus =
  | 'Aborted'
  | 'Pruned'
  | 'Flower'
  | 'SetFruit'
  | 'MatureGreen'
  | 'BreakerFruit'
  | 'Harvested'
  | 'Missing'
  | 'Empty';

type BiologicalStatus = Exclude<SummaryStatus, 'Missing' | 'Empty'>;
const BIOLOGICAL_STATUSES: BiologicalStatus[] = [
  'Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit', 'Harvested', 'Pruned', 'Aborted',
];

const router = Router();

export interface MeasurementSummaryResult {
  summary: {
    totalMeasuredRows: number;
    totalMeasuredStems: number;
    totalNodesRecorded: number;
    statusCounts: Record<SummaryStatus, number>;
    measuredStemCount: number;
    varietyAreaM2: number;
    varietyTotalStemCount: number;
    perM2ByStatus: Record<BiologicalStatus, number>;
  };
  records: unknown[];
}

function emptyStatusCounts(): Record<SummaryStatus, number> {
  return { Aborted: 0, Pruned: 0, Flower: 0, SetFruit: 0, MatureGreen: 0, BreakerFruit: 0, Harvested: 0, Missing: 0, Empty: 0 };
}

/**
 * Core calculation, extracted from the route handler for direct testing
 * with a mock Supabase client.
 *
 * The `plant_nodes` query is now paginated (was unbounded — same defect
 * class as fruitSetByWeek.ts's fixed bug: 2,259 nodes for Mathieu alone,
 * vs. a 1,000-row default cap). Row/stem/node ordering doesn't depend on
 * page-return order: the final `records` array is explicitly re-sorted by
 * (rowSortOrder, rowName, stemSortOrder, stemName, nodeSortOrder,
 * nodeNumber) below, same as before this fix — so id-ASC pagination order
 * for plant_nodes is sufficient; nothing relies on it.
 *
 * The two `weekly_node_statuses` lookups (current week, previous week) stay
 * unpaginated deliberately: each is chunked to 100 node IDs and filtered to
 * one exact (year, week_number) pair, so a chunk can return at most 100
 * rows (one status per node per week) — structurally incapable of
 * exceeding the page cap.
 */
export async function computeMeasurementSummary(
  supabaseClient: SupabaseClient,
  varietyId: string,
  yearValue: number,
  weekValue: number
): Promise<MeasurementSummaryResult> {
  const { data: variety } = await supabaseClient
    .from('varieties')
    .select('area_m2, total_stem_count')
    .eq('id', varietyId)
    .single();
  const areaM2: number = variety?.area_m2 ?? 0;
  const totalStemCount: number = variety?.total_stem_count ?? 0;

  const emptyPerM2 = Object.fromEntries(BIOLOGICAL_STATUSES.map(s => [s, 0])) as Record<BiologicalStatus, number>;
  const emptyResponse: MeasurementSummaryResult = {
    summary: {
      totalMeasuredRows: 0,
      totalMeasuredStems: 0,
      totalNodesRecorded: 0,
      statusCounts: emptyStatusCounts(),
      measuredStemCount: 0,
      varietyAreaM2: areaM2,
      varietyTotalStemCount: totalStemCount,
      perM2ByStatus: { ...emptyPerM2 },
    },
    records: [],
  };

  const { data: rows, error: rowsError } = await supabaseClient
    .from('measurement_rows')
    .select('id, row_name, sort_order, is_active')
    .eq('variety_id', varietyId)
    .order('sort_order')
    .order('row_name');
  if (rowsError) throw new Error(rowsError.message);

  const rowMap = new Map((rows ?? []).map(row => [row.id, row]));
  const rowIds = (rows ?? []).map(row => row.id);
  if (rowIds.length === 0) return emptyResponse;

  const { data: stems, error: stemsError } = await supabaseClient
    .from('measurement_stems')
    .select('id, measurement_row_id, stem_name, sort_order, is_active')
    .in('measurement_row_id', rowIds)
    .order('sort_order')
    .order('stem_name');
  if (stemsError) throw new Error(stemsError.message);

  const stemMap = new Map((stems ?? []).map(stem => [stem.id, stem]));
  const stemIds = (stems ?? []).map(stem => stem.id);
  if (stemIds.length === 0) return emptyResponse;

  // Paginated — was unbounded.
  const nodes = await fetchAllRows<{ id: string; measurement_stem_id: string; node_number: number; sort_order: number | null; is_active: boolean }>(() =>
    supabaseClient
      .from('plant_nodes')
      .select('id, measurement_stem_id, node_number, sort_order, is_active')
      .in('measurement_stem_id', stemIds)
  );

  const nodeIds = nodes.map(node => node.id);
  const statusByNode = new Map<string, SummaryStatus>();
  if (nodeIds.length > 0) {
    const chunkResults = await Promise.all(
      chunkArray(nodeIds, 100).map(ids =>
        supabaseClient
          .from('weekly_node_statuses')
          .select('plant_node_id, status')
          .in('plant_node_id', ids)
          .eq('year', yearValue)
          .eq('week_number', weekValue)
      )
    );

    for (const { data: statuses, error: statusError } of chunkResults) {
      if (statusError) throw new Error(statusError.message);
      for (const row of statuses ?? []) {
        statusByNode.set(row.plant_node_id, row.status as SummaryStatus);
      }
    }
  }

  // For nodes with no status this week, check if they were Harvested last week so
  // the frontend can display them in a collapsed "recently harvested" section.
  const prevWeekNum = weekValue === 1 ? 52 : weekValue - 1;
  const prevWeekYear = weekValue === 1 ? yearValue - 1 : yearValue;
  const prevStatusByNode = new Map<string, SummaryStatus>();
  const unrecordedIds = nodeIds.filter(id => !statusByNode.has(id));
  if (unrecordedIds.length > 0) {
    const prevChunkResults = await Promise.all(
      chunkArray(unrecordedIds, 100).map(ids =>
        supabaseClient
          .from('weekly_node_statuses')
          .select('plant_node_id, status')
          .in('plant_node_id', ids)
          .eq('year', prevWeekYear)
          .eq('week_number', prevWeekNum)
      )
    );
    for (const { data: statuses, error: statusError } of prevChunkResults) {
      if (statusError) throw new Error(statusError.message);
      for (const row of statuses ?? []) {
        prevStatusByNode.set(row.plant_node_id, row.status as SummaryStatus);
      }
    }
  }

  const records = nodes
    .map(node => {
      const stem = stemMap.get(node.measurement_stem_id);
      const row = stem ? rowMap.get(stem.measurement_row_id) : undefined;
      const currentStatus = statusByNode.get(node.id);
      const recentlyHarvested = !currentStatus && prevStatusByNode.get(node.id) === 'Harvested';
      return {
        rowId: row?.id ?? '',
        rowName: row?.row_name ?? 'Unknown Row',
        rowSortOrder: row?.sort_order ?? 0,
        stemId: stem?.id ?? '',
        stemName: stem?.stem_name ?? 'Unknown Stem',
        stemSortOrder: stem?.sort_order ?? 0,
        nodeId: node.id,
        nodeNumber: node.node_number,
        nodeSortOrder: node.sort_order ?? node.node_number,
        status: currentStatus ?? 'Not Recorded',
        recentlyHarvested,
        isActive: Boolean(node.is_active && stem?.is_active && row?.is_active),
      };
    })
    .sort((a, b) => {
      if (a.rowSortOrder !== b.rowSortOrder) return a.rowSortOrder - b.rowSortOrder;
      if (a.rowName !== b.rowName) return a.rowName.localeCompare(b.rowName);
      if (a.stemSortOrder !== b.stemSortOrder) return a.stemSortOrder - b.stemSortOrder;
      if (a.stemName !== b.stemName) return a.stemName.localeCompare(b.stemName);
      if (a.nodeSortOrder !== b.nodeSortOrder) return a.nodeSortOrder - b.nodeSortOrder;
      return a.nodeNumber - b.nodeNumber;
    })
    .map(({ rowSortOrder, stemSortOrder, nodeSortOrder, ...record }) => record);

  const recorded = records.filter(record => record.status !== 'Not Recorded');
  const measuredRows = new Set(recorded.map(record => record.rowId).filter(Boolean));
  const measuredStems = new Set(recorded.map(record => record.stemId).filter(Boolean));

  const statusCounts: Record<SummaryStatus, number> = emptyStatusCounts();
  for (const record of recorded) {
    const status = record.status as SummaryStatus;
    if (status in statusCounts) statusCounts[status] += 1;
  }

  const measuredStemCount = measuredStems.size;

  function toPerM2(count: number): number {
    if (measuredStemCount === 0 || areaM2 === 0) return 0;
    return Math.round((count / measuredStemCount) * totalStemCount / areaM2 * 100) / 100;
  }

  const perM2ByStatus: Record<BiologicalStatus, number> = {
    Flower:       toPerM2(statusCounts['Flower']       ?? 0),
    SetFruit:     toPerM2(statusCounts['SetFruit']     ?? 0),
    MatureGreen:  toPerM2(statusCounts['MatureGreen']  ?? 0),
    BreakerFruit: toPerM2(statusCounts['BreakerFruit'] ?? 0),
    Harvested:    toPerM2(statusCounts['Harvested']    ?? 0),
    Pruned:       toPerM2(statusCounts['Pruned']       ?? 0),
    Aborted:      toPerM2(statusCounts['Aborted']      ?? 0),
  };

  console.log(
    '[measurementSummary] year=%d week=%d recorded=%d measuredStems=%d totalStems=%d areaM2=%d',
    yearValue, weekValue, recorded.length, measuredStemCount, totalStemCount, areaM2,
  );
  console.log('[measurementSummary] statusCounts:', Object.fromEntries(Object.entries(statusCounts).filter(([, v]) => v > 0)));
  console.log('[measurementSummary] perM2ByStatus:', Object.fromEntries(Object.entries(perM2ByStatus).filter(([, v]) => v > 0)));

  return {
    summary: {
      totalMeasuredRows: measuredRows.size,
      totalMeasuredStems: measuredStems.size,
      totalNodesRecorded: recorded.length,
      statusCounts,
      measuredStemCount,
      varietyAreaM2: areaM2,
      varietyTotalStemCount: totalStemCount,
      perM2ByStatus,
    },
    records,
  };
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { year, varietyId, weekNumber } = req.query;
    if (!year || !varietyId || !weekNumber) {
      return res.status(400).json({ error: 'year, varietyId, and weekNumber are required' });
    }
    const result = await computeMeasurementSummary(supabase, varietyId as string, Number(year), Number(weekNumber));
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
