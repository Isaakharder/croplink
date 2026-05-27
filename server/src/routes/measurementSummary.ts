import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

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

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { year, varietyId, weekNumber } = req.query;
    if (!year || !varietyId || !weekNumber) {
      return res.status(400).json({ error: 'year, varietyId, and weekNumber are required' });
    }

    const yearValue = Number(year);
    const weekValue = Number(weekNumber);

    // Fetch variety so we can compute per-m² values
    const { data: variety } = await supabase
      .from('varieties')
      .select('area_m2, total_stem_count')
      .eq('id', varietyId as string)
      .single();
    const areaM2: number = variety?.area_m2 ?? 0;
    const totalStemCount: number = variety?.total_stem_count ?? 0;

    const emptyPerM2 = Object.fromEntries(BIOLOGICAL_STATUSES.map(s => [s, 0])) as Record<BiologicalStatus, number>;
    const emptyStatusCounts: Record<SummaryStatus, number> = {
      Aborted: 0, Pruned: 0, Flower: 0, SetFruit: 0,
      MatureGreen: 0, BreakerFruit: 0, Harvested: 0, Missing: 0, Empty: 0,
    };
    const emptyResponse = {
      summary: {
        totalMeasuredRows: 0,
        totalMeasuredStems: 0,
        totalNodesRecorded: 0,
        statusCounts: { ...emptyStatusCounts },
        measuredStemCount: 0,
        varietyAreaM2: areaM2,
        varietyTotalStemCount: totalStemCount,
        perM2ByStatus: { ...emptyPerM2 },
      },
      records: [] as unknown[],
    };

    const { data: rows, error: rowsError } = await supabase
      .from('measurement_rows')
      .select('id, row_name, sort_order, is_active')
      .eq('variety_id', varietyId as string)
      .order('sort_order')
      .order('row_name');
    if (rowsError) throw new Error(rowsError.message);

    const rowMap = new Map((rows ?? []).map(row => [row.id, row]));
    const rowIds = (rows ?? []).map(row => row.id);
    if (rowIds.length === 0) return res.json(emptyResponse);

    const { data: stems, error: stemsError } = await supabase
      .from('measurement_stems')
      .select('id, measurement_row_id, stem_name, sort_order, is_active')
      .in('measurement_row_id', rowIds)
      .order('sort_order')
      .order('stem_name');
    if (stemsError) throw new Error(stemsError.message);

    const stemMap = new Map((stems ?? []).map(stem => [stem.id, stem]));
    const stemIds = (stems ?? []).map(stem => stem.id);
    if (stemIds.length === 0) return res.json(emptyResponse);

    const { data: nodes, error: nodesError } = await supabase
      .from('plant_nodes')
      .select('id, measurement_stem_id, node_number, sort_order, is_active')
      .in('measurement_stem_id', stemIds)
      .order('sort_order')
      .order('node_number');
    if (nodesError) throw new Error(nodesError.message);

    const nodeIds = (nodes ?? []).map(node => node.id);
    const statusByNode = new Map<string, SummaryStatus>();
    if (nodeIds.length > 0) {
      const { data: statuses, error: statusError } = await supabase
        .from('weekly_node_statuses')
        .select('plant_node_id, status')
        .in('plant_node_id', nodeIds)
        .eq('year', yearValue)
        .eq('week_number', weekValue);
      if (statusError) throw new Error(statusError.message);
      for (const row of statuses ?? []) {
        statusByNode.set(row.plant_node_id, row.status as SummaryStatus);
      }
    }

    const records = (nodes ?? [])
      .map(node => {
        const stem = stemMap.get(node.measurement_stem_id);
        const row = stem ? rowMap.get(stem.measurement_row_id) : undefined;
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
          status: statusByNode.get(node.id) ?? 'Not Recorded',
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

    const statusCounts: Record<SummaryStatus, number> = { ...emptyStatusCounts };
    for (const record of recorded) {
      const status = record.status as SummaryStatus;
      if (status in statusCounts) statusCounts[status] += 1;
    }

    // Per-m² calculation: only active records count
    const activeRecorded = recorded.filter(r => r.isActive);
    const activeMeasuredStems = new Set(activeRecorded.map(r => r.stemId).filter(Boolean));
    const measuredStemCount = activeMeasuredStems.size;

    const activeStatusCounts: Partial<Record<string, number>> = {};
    for (const r of activeRecorded) {
      activeStatusCounts[r.status] = (activeStatusCounts[r.status] ?? 0) + 1;
    }

    function toPerM2(count: number): number {
      if (measuredStemCount === 0 || areaM2 === 0) return 0;
      return Math.round((count / measuredStemCount) * totalStemCount / areaM2 * 100) / 100;
    }

    const perM2ByStatus: Record<BiologicalStatus, number> = {
      Flower:       toPerM2(activeStatusCounts['Flower']       ?? 0),
      SetFruit:     toPerM2(activeStatusCounts['SetFruit']     ?? 0),
      MatureGreen:  toPerM2(activeStatusCounts['MatureGreen']  ?? 0),
      BreakerFruit: toPerM2(activeStatusCounts['BreakerFruit'] ?? 0),
      Harvested:    toPerM2(activeStatusCounts['Harvested']    ?? 0),
      Pruned:       toPerM2(activeStatusCounts['Pruned']       ?? 0),
      Aborted:      toPerM2(activeStatusCounts['Aborted']      ?? 0),
    };

    res.json({
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
    });
  } catch (e) {
    next(e);
  }
});

export default router;
