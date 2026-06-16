import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { chunkArray } from '../lib/chunkArray';

const router = Router();

function getIsoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

// GET /breaker-learning?year=&varietyId=
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { year, varietyId } = req.query;
    if (!year || !varietyId) {
      return res.status(400).json({ error: 'year and varietyId are required' });
    }
    const yearNum = Number(year);

    const today = new Date();
    const currentYear = today.getFullYear();
    const currentWeek = getIsoWeek(today);
    // For past years there is no "live" week — use the last week as a reference
    const queryWeek = yearNum === currentYear ? currentWeek : 52;
    const nextWeekWraps = queryWeek === 52;
    const nextWeek = nextWeekWraps ? 1 : queryWeek + 1;
    const nextWeekYear = nextWeekWraps ? yearNum + 1 : yearNum;

    // ── 1. Variety meta ──────────────────────────────────────────────────────
    const { data: variety, error: vErr } = await supabase
      .from('varieties')
      .select('id, total_stem_count, area_m2')
      .eq('id', varietyId as string)
      .single();
    if (vErr || !variety) throw new Error(vErr?.message ?? 'Variety not found');

    const totalStemCount = Number(variety.total_stem_count) || 0;
    const areaM2 = Number(variety.area_m2) || 0;

    // ── 2. Historical breaker→harvest learning ───────────────────────────────
    const { data: learnRows } = await supabase
      .from('fruit_instances')
      .select('breaker_year, breaker_week_number, harvested_year, harvested_week_number')
      .eq('variety_id', varietyId as string)
      .not('breaker_week_number', 'is', null)
      .not('harvested_week_number', 'is', null);

    let sampleSize = 0;
    let offsetSum = 0;
    let withinOneCount = 0;

    for (const row of learnRows ?? []) {
      if (row.breaker_week_number == null || row.harvested_week_number == null) continue;
      const offset =
        (row.harvested_year - row.breaker_year) * 52 +
        row.harvested_week_number -
        row.breaker_week_number;
      sampleSize++;
      offsetSum += offset;
      if (offset <= 1) withinOneCount++;
    }

    const avgBreakerToHarvestWeeks =
      sampleSize > 0 ? Math.round((offsetSum / sampleSize) * 10) / 10 : 0;
    const harvestedWithinOneWeekPercent =
      sampleSize > 0 ? Math.round((withinOneCount / sampleSize) * 1000) / 10 : 0;

    // ── 3. Current-week breaker count ────────────────────────────────────────
    // Walk variety → rows → stems → nodes → weekly_statuses for queryWeek

    const { data: rows } = await supabase
      .from('measurement_rows')
      .select('id')
      .eq('variety_id', varietyId as string)
      .eq('is_active', true);

    const rowIds = (rows ?? []).map((r: { id: string }) => r.id);

    let breakerCount = 0;
    let measuredStemCount = 0;
    let breakerFruitPerM2 = 0;

    if (rowIds.length > 0) {
      const { data: stems } = await supabase
        .from('measurement_stems')
        .select('id')
        .in('measurement_row_id', rowIds)
        .eq('is_active', true);

      const stemIds = (stems ?? []).map((s: { id: string }) => s.id);

      if (stemIds.length > 0) {
        const { data: nodes } = await supabase
          .from('plant_nodes')
          .select('id, measurement_stem_id')
          .in('measurement_stem_id', stemIds)
          .eq('is_active', true);

        const nodeIds = (nodes ?? []).map((n: { id: string }) => n.id);
        const nodeToStem: Record<string, string> = {};
        for (const n of nodes ?? []) {
          nodeToStem[(n as { id: string; measurement_stem_id: string }).id] =
            (n as { id: string; measurement_stem_id: string }).measurement_stem_id;
        }

        if (nodeIds.length > 0) {
          const chunkResults = await Promise.all(
            chunkArray(nodeIds, 100).map(ids =>
              supabase
                .from('weekly_node_statuses')
                .select('plant_node_id, status')
                .in('plant_node_id', ids)
                .eq('year', yearNum)
                .eq('week_number', queryWeek)
            )
          );
          const statuses = chunkResults.flatMap(({ data }) => data ?? []);

          breakerCount = statuses.filter(
            (s: { status: string }) => s.status === 'BreakerFruit'
          ).length;

          const stemSet = new Set(
            (statuses ?? [])
              .map((s: { plant_node_id: string }) => nodeToStem[s.plant_node_id])
              .filter(Boolean)
          );
          measuredStemCount = stemSet.size;

          if (measuredStemCount > 0 && totalStemCount > 0 && areaM2 > 0) {
            breakerFruitPerM2 = (breakerCount / measuredStemCount) * totalStemCount / areaM2;
          }
        }
      }
    }

    // ── 4. Next-week AFW and kg estimate ─────────────────────────────────────
    const { data: weightRow } = await supabase
      .from('fruit_weight_by_week')
      .select('weight_grams')
      .eq('variety_id', varietyId as string)
      .eq('year', nextWeekYear)
      .eq('week_number', nextWeek)
      .maybeSingle();

    const nextWeekAfw = (weightRow as { weight_grams: number } | null)?.weight_grams ?? 0;
    const missingAfwWarning = nextWeekAfw === 0;
    const nextWeekBreakerKgEstimate =
      breakerFruitPerM2 > 0 && nextWeekAfw > 0 && areaM2 > 0
        ? Math.round((breakerFruitPerM2 * areaM2 * nextWeekAfw) / 1000 * 10) / 10
        : 0;

    res.json({
      varietyId,
      year: yearNum,
      currentWeek: queryWeek,
      avgBreakerToHarvestWeeks,
      harvestedWithinOneWeekPercent,
      sampleSize,
      currentWeekBreakerCount: breakerCount,
      currentWeekMeasuredStemCount: measuredStemCount,
      currentWeekBreakerFruitPerM2: Math.round(breakerFruitPerM2 * 1000) / 1000,
      nextWeekBreakerKgEstimate,
      missingAfwWarning,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
