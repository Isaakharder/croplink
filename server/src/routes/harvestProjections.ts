import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { resolveAfwCarryForward, AfwRow } from '../lib/afwCarryForward';
import { computeEmpiricalHarvestTiming, OFFSETS, EmpiricalHarvestTimingResult } from '../lib/empiricalHarvestTiming';
import { computeFlowFruitSetDebug, SetWeekFruitSetDebug } from '../lib/flowFruitSet';

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

// Extracted so the projection-snapshot service (Round 10, Phase 6) can call
// exactly the same computation the live route serves, byte-for-byte — never
// a reimplementation that could quietly drift from what growers see. This
// function's behavior must stay identical to what it was inline in the route
// handler; the only change here is *where* the result is returned rather
// than json()'d directly.
export async function computeHarvestProjections(yearNum: number, varietyId: string | undefined, debug: boolean) {
  {
    // Resolve season IDs for this year
    const { data: seasons, error: sErr } = await supabase
      .from('seasons')
      .select('id')
      .eq('year', yearNum);
    if (sErr) throw new Error(sErr.message);

    const seasonIds = (seasons ?? []).map((s: { id: string }) => s.id);
    if (seasonIds.length === 0) {
      return { varieties: [], weeklyTotals: [], varietyTotals: [], colorTotals: {} };
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
      return { varieties: [], weeklyTotals: [], varietyTotals: [], colorTotals: {} };
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
        .from('harvest_afw_by_week')
        .select('variety_id, week_number, weight_grams, source')
        .in('variety_id', allVarietyIds)
        .eq('year', yearNum),
    ]);

    if (profilesResult.error) throw new Error(profilesResult.error.message);
    if (weightsResult.error) throw new Error(weightsResult.error.message);

    const allProfiles = profilesResult.data ?? [];
    const allWeights = weightsResult.data ?? [];

    // Empirical timing (Steps 1+2 of the projection audit) — only computed
    // when explicitly requested. One extra fruit_instances query per
    // variety; skipped entirely on the normal (non-debug) request path so
    // this can never change latency or behavior for what growers see today.
    const empiricalByVariety = new Map<string, EmpiricalHarvestTimingResult>();
    // Round 6 — corrected flow-based fruit-set count (fixes the stock-vs-flow
    // defect: production's avg_fruit_set is fed by a weekly SetFruit CENSUS,
    // which recounts a node every week it stays in that status, not a FLOW of
    // newly-set fruit). See lib/flowFruitSet.ts for the full trace. Debug-only,
    // one extra query set per variety, never touches what growers see today.
    const flowFruitSetByVariety = new Map<string, Map<number, SetWeekFruitSetDebug>>();
    if (debug) {
      const results = await Promise.all(
        varieties.map((v: { id: string }) => computeEmpiricalHarvestTiming(supabase, v.id, yearNum))
      );
      varieties.forEach((v: { id: string }, i: number) => empiricalByVariety.set(v.id, results[i]));

      const flowResults = await Promise.all(
        varieties.map((v: { id: string }) => {
          const storedAvgFruitSetByWeek = new Map<number, number>();
          for (const p of allProfiles) {
            if (p.variety_id === v.id) storedAvgFruitSetByWeek.set(p.set_week_number, Number(p.avg_fruit_set) || 0);
          }
          return computeFlowFruitSetDebug({ supabase, varietyId: v.id, year: yearNum, storedAvgFruitSetByWeek });
        })
      );
      varieties.forEach((v: { id: string }, i: number) => flowFruitSetByVariety.set(v.id, flowResults[i]));
    }

    // Group AFW rows by variety — resolved to a per-harvest-week
    // carry-forward map further down, once per variety.
    const afwRowsByVariety: Record<string, AfwRow[]> = {};
    for (const w of allWeights) {
      if (!afwRowsByVariety[w.variety_id]) afwRowsByVariety[w.variety_id] = [];
      afwRowsByVariety[w.variety_id].push({
        week_number: w.week_number,
        weight_grams: w.weight_grams,
        source: w.source,
      });
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
      totalKgEmpirical?: number;
      totalKgFlowLegacy?: number;
      totalKgFlowEmpirical?: number;
      totalKgFlowPooled?: number;
      weeks: {
        week: number;
        projectedFruitPerM2: number;
        projectedKg: number;
        projectedFruitPerM2Empirical?: number;
        projectedKgEmpirical?: number;
        // Round 6 — candidates C/D/E, all built on the corrected flow fruit-set
        // count instead of the stock-contaminated stored/census figure.
        projectedKgFlowLegacy?: number;
        projectedKgFlowEmpirical?: number;
        projectedKgFlowPooled?: number;
      }[];
      fruitSetDebug?: SetWeekFruitSetDebug[];
      timingDebug?: {
        setWeekNumber: number;
        avgFruitSet: number;
        resolvedCount: number;
        harvestedCount: number;
        resolutionRate: number;
        resolutionRateIsFallback: boolean;
        resolutionRateFallbackReason: 'sample-too-small' | 'not-yet-matured' | 'sample-too-small-and-not-matured' | null;
        offsetPercents: Record<number, number>;
        offsetPercentsIsFallback: boolean;
      }[];
      poolDebug?: {
        resolutionRate: number | null;
        resolutionRateSampleSize: number;
        sampleSetWeeks: number;
        isThin: boolean;
        offsetPercentsSampleSize: number;
      };
    }[] = [];

    for (const variety of varieties) {
      const profiles = allProfiles.filter((p: { variety_id: string }) => p.variety_id === variety.id);
      const area = Number(variety.area_m2) || 0;
      const colorKey = variety.color ?? 'Unknown';
      const resolvedAfw = resolveAfwCarryForward(afwRowsByVariety[variety.id] ?? []);

      // Fruit timing is unchanged: set-week fruit still distributes into
      // harvest weeks via the learned +4..+10 profile. AFW/kg conversion is
      // separate — it's looked up by HARVEST week, using the latest actual
      // (or manual override) known as of that week, carried forward until a
      // newer one is entered. This is why the same set-week profile can
      // contribute different kg to different harvest weeks even though the
      // fruit count contribution is identical.
      const projectedByWeek: Record<number, number> = {};
      const kgByWeek: Record<number, number> = {};
      for (let w = 1; w <= 52; w++) { projectedByWeek[w] = 0; kgByWeek[w] = 0; }

      for (const profile of profiles) {
        const setWeek = profile.set_week_number as number;
        const setAmount = Number(profile.avg_fruit_set) || 0;

        for (const [field, offset] of percentFields) {
          const pct = Number(profile[field]) || 0;
          if (pct <= 0) continue;
          const harvestWeek = setWeek + offset;
          if (harvestWeek >= 1 && harvestWeek <= 52) {
            const fruitContrib = setAmount * (pct / 100);
            projectedByWeek[harvestWeek] += fruitContrib;
            const afw = resolvedAfw.get(harvestWeek);
            if (afw && afw.weightGrams > 0 && area > 0) {
              kgByWeek[harvestWeek] += fruitContrib * area * afw.weightGrams / 1000;
            }
          }
        }
      }

      // ── Empirical path (debug only) — same avg_fruit_set and same AFW
      // carry-forward as above; only the timing shape differs. Step 1
      // (resolutionRate) scales down the set amount for fruit that never
      // gets harvested; Step 2 (offsetPercents) replaces the fixed
      // 20/40/40 curve with a per-set-week empirical one.
      const empirical = empiricalByVariety.get(variety.id);
      const projectedByWeekEmpirical: Record<number, number> = {};
      const kgByWeekEmpirical: Record<number, number> = {};
      const timingDebug: NonNullable<(typeof varietyResults)[number]['timingDebug']> = [];
      if (debug) {
        for (let w = 1; w <= 52; w++) { projectedByWeekEmpirical[w] = 0; kgByWeekEmpirical[w] = 0; }

        for (const profile of profiles) {
          const setWeek = profile.set_week_number as number;
          const setAmount = Number(profile.avg_fruit_set) || 0;
          const timing = empirical?.bySetWeek.get(setWeek);
          const resolutionRate = timing?.resolutionRate ?? 1;
          const offsetPercents = timing?.offsetPercents ?? {};

          timingDebug.push({
            setWeekNumber: setWeek,
            avgFruitSet: setAmount,
            resolvedCount: timing?.resolvedCount ?? 0,
            harvestedCount: timing?.harvestedCount ?? 0,
            resolutionRate,
            resolutionRateIsFallback: timing?.resolutionRateIsFallback ?? true,
            resolutionRateFallbackReason: timing?.resolutionRateFallbackReason ?? null,
            offsetPercents,
            offsetPercentsIsFallback: timing?.offsetPercentsIsFallback ?? true,
          });

          for (const offset of OFFSETS) {
            const pct = offsetPercents[offset] ?? 0;
            if (pct <= 0) continue;
            const harvestWeek = setWeek + offset;
            if (harvestWeek >= 1 && harvestWeek <= 52) {
              const fruitContrib = setAmount * resolutionRate * (pct / 100);
              projectedByWeekEmpirical[harvestWeek] += fruitContrib;
              const afw = resolvedAfw.get(harvestWeek);
              if (afw && afw.weightGrams > 0 && area > 0) {
                kgByWeekEmpirical[harvestWeek] += fruitContrib * area * afw.weightGrams / 1000;
              }
            }
          }
        }
      }

      // ── Round 6, candidates C/D/E (debug only) — same profiles, same AFW,
      // same survival/timing logic as B2 above; only the fruit-count INPUT
      // changes, from the stock-contaminated stored avg_fruit_set to the
      // corrected flow count (distinct fruit_instances rows per set-week).
      // Isolates the stock/flow fix as its own variable, same way Round 5
      // isolated the timing-shape fix.
      const flowFruitSet = flowFruitSetByVariety.get(variety.id);
      const kgByWeekFlowLegacy: Record<number, number> = {};
      const kgByWeekFlowEmpirical: Record<number, number> = {};
      const kgByWeekFlowPooled: Record<number, number> = {};
      const fruitSetDebug: SetWeekFruitSetDebug[] = [];
      if (debug) {
        for (let w = 1; w <= 52; w++) { kgByWeekFlowLegacy[w] = 0; kgByWeekFlowEmpirical[w] = 0; kgByWeekFlowPooled[w] = 0; }

        for (const profile of profiles) {
          const setWeek = profile.set_week_number as number;
          const flowDebugRow = flowFruitSet?.get(setWeek);
          const flowFruitPerM2 = flowDebugRow?.flowFruitPerM2 ?? 0;
          if (flowDebugRow) fruitSetDebug.push(flowDebugRow);

          const timing = empirical?.bySetWeek.get(setWeek);
          const resolutionRate = timing?.resolutionRate ?? 1;
          const gatedOffsetPercents = timing?.offsetPercents ?? {};
          const pooledOffsetPercents = empirical?.pooled.offsetPercents ?? {};

          for (const [field, offset] of percentFields) {
            const legacyPct = Number(profile[field]) || 0;
            const harvestWeek = setWeek + offset;
            if (harvestWeek < 1 || harvestWeek > 52) continue;
            const afw = resolvedAfw.get(harvestWeek);
            if (!afw || afw.weightGrams <= 0 || area <= 0) continue;

            // C — corrected flow input, legacy timing (no survival — same as legacy's own semantics)
            if (legacyPct > 0) {
              const fruitContrib = flowFruitPerM2 * (legacyPct / 100);
              kgByWeekFlowLegacy[harvestWeek] += fruitContrib * area * afw.weightGrams / 1000;
            }

            // D — corrected flow input, gated empirical timing + Round 4 survival
            const gatedPct = gatedOffsetPercents[offset] ?? 0;
            if (gatedPct > 0) {
              const fruitContrib = flowFruitPerM2 * resolutionRate * (gatedPct / 100);
              kgByWeekFlowEmpirical[harvestWeek] += fruitContrib * area * afw.weightGrams / 1000;
            }

            // E — corrected flow input, mature-pooled timing curve (diagnostic only), + survival
            const pooledPct = pooledOffsetPercents[offset] ?? 0;
            if (pooledPct > 0) {
              const fruitContrib = flowFruitPerM2 * resolutionRate * (pooledPct / 100);
              kgByWeekFlowPooled[harvestWeek] += fruitContrib * area * afw.weightGrams / 1000;
            }
          }
        }
      }

      let totalKg = 0;
      let totalKgEmpirical = 0;
      let totalKgFlowLegacy = 0;
      let totalKgFlowEmpirical = 0;
      let totalKgFlowPooled = 0;
      const weekData: (typeof varietyResults)[number]['weeks'] = [];

      for (let w = 1; w <= 52; w++) {
        const fruitPerM2 = projectedByWeek[w];
        const kg = kgByWeek[w];

        weekData.push({
          week: w,
          projectedFruitPerM2: Math.round(fruitPerM2 * 1000) / 1000,
          projectedKg: Math.round(kg * 10) / 10,
          ...(debug ? {
            projectedFruitPerM2Empirical: Math.round((projectedByWeekEmpirical[w] ?? 0) * 1000) / 1000,
            projectedKgEmpirical: Math.round((kgByWeekEmpirical[w] ?? 0) * 10) / 10,
            projectedKgFlowLegacy: Math.round((kgByWeekFlowLegacy[w] ?? 0) * 10) / 10,
            projectedKgFlowEmpirical: Math.round((kgByWeekFlowEmpirical[w] ?? 0) * 10) / 10,
            projectedKgFlowPooled: Math.round((kgByWeekFlowPooled[w] ?? 0) * 10) / 10,
          } : {}),
        });

        totalKg += kg;
        if (debug) {
          totalKgEmpirical += kgByWeekEmpirical[w] ?? 0;
          totalKgFlowLegacy += kgByWeekFlowLegacy[w] ?? 0;
          totalKgFlowEmpirical += kgByWeekFlowEmpirical[w] ?? 0;
          totalKgFlowPooled += kgByWeekFlowPooled[w] ?? 0;
        }

        // Aggregate — legacy totals only; the empirical path is a
        // per-variety debug view and deliberately not rolled into
        // weeklyTotals/colorTotals yet.
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
        ...(debug ? {
          totalKgEmpirical: Math.round(totalKgEmpirical * 10) / 10,
          totalKgFlowLegacy: Math.round(totalKgFlowLegacy * 10) / 10,
          totalKgFlowEmpirical: Math.round(totalKgFlowEmpirical * 10) / 10,
          totalKgFlowPooled: Math.round(totalKgFlowPooled * 10) / 10,
          timingDebug,
          fruitSetDebug,
          poolDebug: empirical ? {
            resolutionRate: empirical.pooled.resolutionRate,
            resolutionRateSampleSize: empirical.pooled.resolutionRateSampleSize,
            sampleSetWeeks: empirical.pooled.sampleSetWeeks,
            isThin: empirical.pooled.isThin,
            offsetPercentsSampleSize: empirical.pooled.offsetPercentsSampleSize,
          } : undefined,
        } : {}),
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

    return {
      varieties: varietyResults,
      weeklyTotals,
      varietyTotals: varietyResults.map(v => ({
        id: v.id,
        name: v.name,
        color: v.color,
        totalKg: v.totalKg,
      })),
      colorTotals: colorTotalsMap,
    };
  }
}

// GET /harvest-projections?year=&varietyId=optional&debug=true
//
// `debug=true` is additive only — it never changes projectedFruitPerM2 /
// projectedKg / totalKg / weeklyTotals / colorTotals, which stay the
// legacy fixed-curve calculation growers see today. It attaches a parallel
// *Empirical set of numbers (Steps 1+2 of the 2026-08-28 projection audit:
// abort/prune-adjusted resolution rate + a live-computed set→harvest timing
// shape, in place of the static 20/40/40 harvest_timing_profiles columns)
// for side-by-side backtesting. Nothing here is wired into what growers see
// yet — that's a deliberate follow-up once the backtest in
// scripts/backtest-empirical-projection.ts is reviewed.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { year, varietyId } = req.query;
    if (!year) return res.status(400).json({ error: 'year is required' });
    const yearNum = Number(year);
    const debug = req.query.debug === 'true';
    const result = await computeHarvestProjections(yearNum, varietyId as string | undefined, debug);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
