import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

const percentFields: [string, number][] = [
  ['week4_percent', 4],
  ['week5_percent', 5],
  ['week6_percent', 6],
  ['week7_percent', 7],
  ['week8_percent', 8],
  ['week9_percent', 9],
  ['week10_percent', 10],
];

// GET /harvest-projections?year=&varietyId=optional
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { year, varietyId } = req.query;
    if (!year) return res.status(400).json({ error: 'year is required' });
    const yearNum = Number(year);

    // Resolve season IDs for this year
    const { data: seasons, error: sErr } = await supabase
      .from('seasons')
      .select('id')
      .eq('year', yearNum);
    if (sErr) throw new Error(sErr.message);

    const seasonIds = (seasons ?? []).map((s: { id: string }) => s.id);
    if (seasonIds.length === 0) {
      return res.json({ varieties: [], weeklyTotals: [], varietyTotals: [], colorTotals: {} });
    }

    // Load active varieties for this year
    let vQuery = supabase
      .from('varieties')
      .select('id, name, color, area_m2')
      .in('season_id', seasonIds)
      .eq('is_active', true);

    if (varietyId) {
      vQuery = vQuery.eq('id', varietyId as string);
    }

    const { data: varieties, error: vErr } = await vQuery;
    if (vErr) throw new Error(vErr.message);
    if (!varieties || varieties.length === 0) {
      return res.json({ varieties: [], weeklyTotals: [], varietyTotals: [], colorTotals: {} });
    }

    const allVarietyIds = varieties.map((v: { id: string }) => v.id);

    // Load harvest timing profiles + fruit weights for all varieties in parallel
    const [profilesResult, weightsResult] = await Promise.all([
      supabase
        .from('harvest_timing_profiles')
        .select('*')
        .in('variety_id', allVarietyIds)
        .eq('year', yearNum),
      supabase
        .from('fruit_weight_by_week')
        .select('variety_id, week_number, weight_grams')
        .in('variety_id', allVarietyIds)
        .eq('year', yearNum),
    ]);

    if (profilesResult.error) throw new Error(profilesResult.error.message);
    if (weightsResult.error) throw new Error(weightsResult.error.message);

    const allProfiles = profilesResult.data ?? [];
    const allWeights = weightsResult.data ?? [];

    // Build weight lookup: varietyId → weekNumber → weight_grams
    const weightMap: Record<string, Record<number, number>> = {};
    for (const w of allWeights) {
      if (!weightMap[w.variety_id]) weightMap[w.variety_id] = {};
      weightMap[w.variety_id][w.week_number] = w.weight_grams;
    }

    // Aggregation maps
    const weeklyTotalsMap: Record<number, {
      totalKg: number;
      byColor: Record<string, number>;
      byVariety: Record<string, number>;
    }> = {};
    for (let w = 1; w <= 52; w++) {
      weeklyTotalsMap[w] = { totalKg: 0, byColor: {}, byVariety: {} };
    }
    const colorTotalsMap: Record<string, number> = {};

    const varietyResults: {
      id: string;
      name: string;
      color: string | null;
      area_m2: number;
      totalKg: number;
      weeks: { week: number; projectedFruitPerM2: number; projectedKg: number }[];
    }[] = [];

    for (const variety of varieties) {
      const profiles = allProfiles.filter((p: { variety_id: string }) => p.variety_id === variety.id);
      const area = Number(variety.area_m2) || 0;
      const weights = weightMap[variety.id] ?? {};
      const colorKey = variety.color ?? 'Unknown';

      // Compute projected fruit/m² per week from timing profiles
      const projectedByWeek: Record<number, number> = {};
      for (let w = 1; w <= 52; w++) projectedByWeek[w] = 0;

      for (const profile of profiles) {
        const setWeek = profile.set_week_number as number;
        const setAmount = Number(profile.avg_fruit_set) || 0;

        for (const [field, offset] of percentFields) {
          const pct = Number(profile[field]) || 0;
          if (pct <= 0) continue;
          const harvestWeek = setWeek + offset;
          if (harvestWeek >= 1 && harvestWeek <= 52) {
            projectedByWeek[harvestWeek] += setAmount * (pct / 100);
          }
        }
      }

      // Convert to kg using AFW for each harvest week
      let totalKg = 0;
      const weekData: { week: number; projectedFruitPerM2: number; projectedKg: number }[] = [];

      for (let w = 1; w <= 52; w++) {
        const fruitPerM2 = projectedByWeek[w];
        const weightGrams = weights[w] ?? 0;
        const kg =
          fruitPerM2 > 0 && area > 0 && weightGrams > 0
            ? (fruitPerM2 * area * weightGrams) / 1000
            : 0;

        weekData.push({
          week: w,
          projectedFruitPerM2: Math.round(fruitPerM2 * 1000) / 1000,
          projectedKg: Math.round(kg * 10) / 10,
        });

        totalKg += kg;

        // Aggregate
        weeklyTotalsMap[w].totalKg += kg;
        if (kg > 0) {
          weeklyTotalsMap[w].byColor[colorKey] = (weeklyTotalsMap[w].byColor[colorKey] ?? 0) + kg;
          weeklyTotalsMap[w].byVariety[variety.id] = (weeklyTotalsMap[w].byVariety[variety.id] ?? 0) + kg;
        }
      }

      totalKg = Math.round(totalKg * 10) / 10;
      colorTotalsMap[colorKey] = Math.round(((colorTotalsMap[colorKey] ?? 0) + totalKg) * 10) / 10;

      varietyResults.push({
        id: variety.id,
        name: variety.name,
        color: variety.color ?? null,
        area_m2: area,
        totalKg,
        weeks: weekData,
      });
    }

    // Round and format weekly totals
    const weeklyTotals = Object.entries(weeklyTotalsMap).map(([w, data]) => ({
      week: Number(w),
      totalKg: Math.round(data.totalKg * 10) / 10,
      byColor: Object.fromEntries(
        Object.entries(data.byColor).map(([c, v]) => [c, Math.round(v * 10) / 10])
      ),
      byVariety: Object.fromEntries(
        Object.entries(data.byVariety).map(([id, v]) => [id, Math.round(v * 10) / 10])
      ),
    }));

    res.json({
      varieties: varietyResults,
      weeklyTotals,
      varietyTotals: varietyResults.map(v => ({
        id: v.id,
        name: v.name,
        color: v.color,
        totalKg: v.totalKg,
      })),
      colorTotals: colorTotalsMap,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
