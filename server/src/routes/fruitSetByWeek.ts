import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { chunkArray } from '../lib/chunkArray';
import { fetchAllRows } from '../lib/paginatedFetch';

const router = Router();

interface WeekEntry {
  weekNumber: number;
  setFruitCount: number;
  measuredStemCount: number;
  fruitSetPerM2: number;
}

function makeEmpty52(): WeekEntry[] {
  return Array.from({ length: 52 }, (_, i) => ({
    weekNumber: i + 1,
    setFruitCount: 0,
    measuredStemCount: 0,
    fruitSetPerM2: 0,
  }));
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, year } = req.query;
    if (!varietyId || !year) {
      return res.status(400).json({ error: 'varietyId and year are required' });
    }

    // Variety scaling factors
    const { data: variety, error: vErr } = await supabase
      .from('varieties')
      .select('total_stem_count, area_m2')
      .eq('id', varietyId as string)
      .single();
    if (vErr) throw new Error(vErr.message);

    const totalStems: number = (variety as { total_stem_count: number | null })?.total_stem_count ?? 0;
    const areaM2: number    = (variety as { area_m2: number | null })?.area_m2 ?? 0;

    // Active rows for this variety
    const { data: rowsData, error: rErr } = await supabase
      .from('measurement_rows')
      .select('id')
      .eq('variety_id', varietyId as string)
      .eq('is_active', true);
    if (rErr) throw new Error(rErr.message);

    const rowIds = (rowsData ?? []).map((r: { id: string }) => r.id);
    if (rowIds.length === 0) return res.json(makeEmpty52());

    // Active stems under those rows
    const { data: stemsData, error: sErr } = await supabase
      .from('measurement_stems')
      .select('id')
      .in('measurement_row_id', rowIds)
      .eq('is_active', true);
    if (sErr) throw new Error(sErr.message);

    const stemIds = (stemsData ?? []).map((s: { id: string }) => s.id);
    if (stemIds.length === 0) return res.json(makeEmpty52());

    // Active nodes under those stems (includes side-shoots).
    // Paginated: a variety's node count is not bounded by its stem count in
    // any way that stays under Supabase's default 1,000-row response cap —
    // side-shoots accumulate through the season on top of main-stem
    // positions (confirmed live: 2,259 nodes under just 56 stems for one
    // variety). An unpaginated select() here silently returned only the
    // first 1,000, skewed toward earlier-created nodes, which corrupted
    // later set-weeks' counts far more than earlier ones. See the
    // 2026-08-28 pagination investigation.
    const nodesData = await fetchAllRows<{ id: string; measurement_stem_id: string }>(() =>
      supabase
        .from('plant_nodes')
        .select('id, measurement_stem_id')
        .in('measurement_stem_id', stemIds)
        .eq('is_active', true)
    );

    const nodeIds = nodesData.map((n) => n.id);
    if (nodeIds.length === 0) return res.json(makeEmpty52());

    // node_id → stem_id lookup for counting measured stems
    const stemByNode: Record<string, string> = {};
    nodesData.forEach(n => {
      stemByNode[n.id] = n.measurement_stem_id;
    });

    // Weekly statuses for those nodes in the requested year. Batched by
    // node (100 at a time — large varieties can have hundreds of nodes,
    // which overflows the URL/header size limit if passed to a single
    // .in() filter) AND paginated within each batch (a single 100-node
    // batch can itself exceed 1,000 status rows across a season). Both
    // limits are independent and both apply.
    const statusBatchResults = await Promise.all(
      chunkArray(nodeIds, 100).map(ids =>
        fetchAllRows<{ week_number: number; status: string; plant_node_id: string }>(() =>
          supabase
            .from('weekly_node_statuses')
            .select('week_number, status, plant_node_id')
            .in('plant_node_id', ids)
            .eq('year', Number(year))
        )
      )
    );
    const statuses = statusBatchResults.flat();

    // Aggregate per week
    const weekMap: Record<number, { setFruitCount: number; measuredStems: Set<string> }> = {};
    for (let w = 1; w <= 52; w++) {
      weekMap[w] = { setFruitCount: 0, measuredStems: new Set() };
    }

    for (const s of statuses) {
      const { week_number: w, status, plant_node_id: pid } = s;
      if (w < 1 || w > 52) continue;
      const stemId = stemByNode[pid];
      if (stemId) weekMap[w].measuredStems.add(stemId);
      if (status === 'SetFruit') weekMap[w].setFruitCount++;
    }

    const result: WeekEntry[] = Array.from({ length: 52 }, (_, i) => {
      const w = i + 1;
      const { setFruitCount, measuredStems } = weekMap[w];
      const measuredStemCount = measuredStems.size;
      let fruitSetPerM2 = 0;
      if (measuredStemCount > 0 && totalStems > 0 && areaM2 > 0) {
        fruitSetPerM2 = (setFruitCount / measuredStemCount) * totalStems / areaM2;
      }
      return { weekNumber: w, setFruitCount, measuredStemCount, fruitSetPerM2 };
    });

    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
