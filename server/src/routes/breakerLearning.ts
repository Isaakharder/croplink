import { Router, Request, Response, NextFunction } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { chunkArray } from '../lib/chunkArray';
import { resolveAfwCarryForward } from '../lib/afwCarryForward';
import { fetchAllRows } from '../lib/paginatedFetch';

const router = Router();

// Below this many historical breaker→harvest observations, the learned
// conversion timing isn't trustworthy enough to drive a kg adjustment.
const MIN_SAMPLE_SIZE_FOR_ADJUSTMENT = 5;

function getIsoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

export interface BreakerLearningResult {
  varietyId: string;
  year: number;
  currentWeek: number;
  nextWeek: number;
  avgBreakerToHarvestWeeks: number;
  harvestedWithinOneWeekPercent: number;
  sampleSize: number;
  varietyTotalStemCount: number;
  varietyAreaM2: number;
  currentWeekBreakerCount: number;
  currentWeekMeasuredStemCount: number;
  currentWeekBreakerFruitPerM2: number;
  nextWeekAfw: number;
  nextWeekBreakerKgEstimate: number;
  nextWeekBreakerKgEstimateRaw: number;
  minSampleSizeForAdjustment: number;
  adjustmentSuppressed: boolean;
  missingAfwWarning: boolean;
  currentWeekHarvestedCount: number;
  currentWeekHarvestedFruitPerM2: number;
  currentWeekAfw: number;
  currentWeekHarvestedKgEstimate: number;
  missingHarvestedAfwWarning: boolean;
}

/**
 * Core calculation, extracted from the route handler so it's directly
 * testable with a mock Supabase client (see __tests__/breakerLearning.test.ts)
 * — the handler below is now a thin wrapper.
 *
 * `today` is injectable (defaults to `new Date()`) so tests can pin a
 * deterministic "current week" instead of depending on wall-clock time.
 *
 * Both fruit_instances queries below are now paginated via fetchAllRows().
 * Neither calculation depends on row order: the breaker→harvest learning is
 * a sum/count over every matching row (order-independent), and the
 * current-week breaker/harvested tally is a set union + count, also
 * order-independent — so the default id-ASC pagination order is sufficient
 * for correctness; no chronological compound order is needed here.
 *
 * The `fruit_instances` learning query is deliberately NOT scoped to a
 * single year — this is "variety-wide, all years" by design (a more robust
 * breaker→harvest average than one season alone would give), matching the
 * identical pattern in ripeningActuals.ts. Preserved exactly; only the
 * pagination is new.
 */
export async function computeBreakerLearning(
  supabaseClient: SupabaseClient,
  varietyId: string,
  yearNum: number,
  today: Date = new Date()
): Promise<BreakerLearningResult> {
  const currentYear = today.getFullYear();
  const currentWeek = getIsoWeek(today);
  // For past years there is no "live" week — use the last week as a reference
  const queryWeek = yearNum === currentYear ? currentWeek : 52;
  const nextWeekWraps = queryWeek === 52;
  const nextWeek = nextWeekWraps ? 1 : queryWeek + 1;
  const nextWeekYear = nextWeekWraps ? yearNum + 1 : yearNum;

  // ── 1. Variety meta ──────────────────────────────────────────────────────
  const { data: variety, error: vErr } = await supabaseClient
    .from('varieties')
    .select('id, total_stem_count, area_m2')
    .eq('id', varietyId)
    .single();
  if (vErr || !variety) throw new Error(vErr?.message ?? 'Variety not found');

  const totalStemCount = Number(variety.total_stem_count) || 0;
  const areaM2 = Number(variety.area_m2) || 0;

  // ── 2. Historical breaker→harvest learning (paginated — was unbounded) ──
  const learnRows = await fetchAllRows<{
    breaker_year: number | null; breaker_week_number: number | null;
    harvested_year: number | null; harvested_week_number: number | null;
  }>(() =>
    supabaseClient
      .from('fruit_instances')
      .select('breaker_year, breaker_week_number, harvested_year, harvested_week_number')
      .eq('variety_id', varietyId)
      .not('breaker_week_number', 'is', null)
      .not('harvested_week_number', 'is', null)
  );

  let sampleSize = 0;
  let offsetSum = 0;
  let withinOneCount = 0;

  for (const row of learnRows) {
    if (row.breaker_week_number == null || row.harvested_week_number == null) continue;
    const offset =
      (row.harvested_year! - row.breaker_year!) * 52 +
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
  const { data: rows } = await supabaseClient
    .from('measurement_rows')
    .select('id')
    .eq('variety_id', varietyId)
    .eq('is_active', true);

  const rowIds = (rows ?? []).map((r: { id: string }) => r.id);

  let breakerCount = 0;
  let harvestedCount = 0;
  let measuredStemCount = 0;
  let breakerFruitPerM2 = 0;
  let harvestedFruitPerM2 = 0;

  if (rowIds.length > 0) {
    const { data: stems } = await supabaseClient
      .from('measurement_stems')
      .select('id')
      .in('measurement_row_id', rowIds)
      .eq('is_active', true);

    const stemIds = (stems ?? []).map((s: { id: string }) => s.id);

    if (stemIds.length > 0) {
      // Paginated — was unbounded, same defect class as fruitSetByWeek.ts's
      // fixed bug. A node lookup map only; order doesn't matter.
      const nodes = await fetchAllRows<{ id: string; measurement_stem_id: string }>(() =>
        supabaseClient
          .from('plant_nodes')
          .select('id, measurement_stem_id')
          .in('measurement_stem_id', stemIds)
          .eq('is_active', true)
      );

      const nodeIds = nodes.map((n) => n.id);
      const nodeToStem: Record<string, string> = {};
      for (const n of nodes) nodeToStem[n.id] = n.measurement_stem_id;

      if (nodeIds.length > 0) {
        // Bounded by construction: one row per node for a single exact
        // (year, week_number) — a 100-node chunk can return at most 100
        // rows, well under any page cap. No pagination needed here.
        const chunkResults = await Promise.all(
          chunkArray(nodeIds, 100).map(ids =>
            supabaseClient
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
        harvestedCount = statuses.filter(
          (s: { status: string }) => s.status === 'Harvested'
        ).length;

        const stemSet = new Set(
          statuses
            .map((s: { plant_node_id: string }) => nodeToStem[s.plant_node_id])
            .filter(Boolean)
        );
        measuredStemCount = stemSet.size;

        if (measuredStemCount > 0 && totalStemCount > 0 && areaM2 > 0) {
          breakerFruitPerM2 = (breakerCount / measuredStemCount) * totalStemCount / areaM2;
          harvestedFruitPerM2 = (harvestedCount / measuredStemCount) * totalStemCount / areaM2;
        }
      }
    }
  }

  // ── 4. Next-week AFW and kg estimate ─────────────────────────────────────
  const { data: nextWeekAfwRows } = await supabaseClient
    .from('harvest_afw_by_week')
    .select('week_number, weight_grams, source')
    .eq('variety_id', varietyId)
    .eq('year', nextWeekYear);

  const nextWeekAfw = resolveAfwCarryForward(nextWeekAfwRows ?? []).get(nextWeek)?.weightGrams ?? 0;
  const missingAfwWarning = nextWeekAfw === 0;

  const hasEnoughSample = sampleSize >= MIN_SAMPLE_SIZE_FOR_ADJUSTMENT;
  const conversionRateScalar = harvestedWithinOneWeekPercent / 100;

  const nextWeekBreakerKgEstimateRaw =
    breakerFruitPerM2 > 0 && nextWeekAfw > 0 && areaM2 > 0
      ? Math.round((breakerFruitPerM2 * areaM2 * nextWeekAfw) / 1000 * 10) / 10
      : 0;

  const nextWeekBreakerKgEstimate = hasEnoughSample
    ? Math.round(nextWeekBreakerKgEstimateRaw * conversionRateScalar * 10) / 10
    : 0;

  const adjustmentSuppressed = nextWeekBreakerKgEstimateRaw > 0 && !hasEnoughSample;

  // ── 5. Current-week Harvested kg (display only) ──────────────────────────
  const currentWeekAfwRows =
    yearNum === nextWeekYear
      ? nextWeekAfwRows
      : (await supabaseClient
          .from('harvest_afw_by_week')
          .select('week_number, weight_grams, source')
          .eq('variety_id', varietyId)
          .eq('year', yearNum)).data;

  const currentWeekAfw = resolveAfwCarryForward(currentWeekAfwRows ?? []).get(queryWeek)?.weightGrams ?? 0;
  const currentWeekHarvestedKgEstimate =
    harvestedFruitPerM2 > 0 && currentWeekAfw > 0 && areaM2 > 0
      ? Math.round((harvestedFruitPerM2 * areaM2 * currentWeekAfw) / 1000 * 10) / 10
      : 0;

  return {
    varietyId,
    year: yearNum,
    currentWeek: queryWeek,
    nextWeek,
    avgBreakerToHarvestWeeks,
    harvestedWithinOneWeekPercent,
    sampleSize,
    varietyTotalStemCount: totalStemCount,
    varietyAreaM2: areaM2,
    currentWeekBreakerCount: breakerCount,
    currentWeekMeasuredStemCount: measuredStemCount,
    currentWeekBreakerFruitPerM2: Math.round(breakerFruitPerM2 * 1000) / 1000,
    nextWeekAfw,
    nextWeekBreakerKgEstimate,
    nextWeekBreakerKgEstimateRaw,
    minSampleSizeForAdjustment: MIN_SAMPLE_SIZE_FOR_ADJUSTMENT,
    adjustmentSuppressed,
    missingAfwWarning,
    currentWeekHarvestedCount: harvestedCount,
    currentWeekHarvestedFruitPerM2: Math.round(harvestedFruitPerM2 * 1000) / 1000,
    currentWeekAfw,
    currentWeekHarvestedKgEstimate,
    missingHarvestedAfwWarning: harvestedFruitPerM2 > 0 && currentWeekAfw === 0,
  };
}

// GET /breaker-learning?year=&varietyId=
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { year, varietyId } = req.query;
    if (!year || !varietyId) {
      return res.status(400).json({ error: 'year and varietyId are required' });
    }
    const result = await computeBreakerLearning(supabase, varietyId as string, Number(year));
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
