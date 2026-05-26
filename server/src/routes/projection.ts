import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

// GET /projection?varietyId=&year=
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, year } = req.query;
    if (!varietyId || !year) {
      return res.status(400).json({ error: 'varietyId and year are required' });
    }

    const { data: profiles, error } = await supabase
      .from('harvest_timing_profiles')
      .select('*')
      .eq('variety_id', varietyId as string)
      .eq('year', Number(year));
    if (error) throw new Error(error.message);

    // Initialize weeks 1–52
    const projectedByWeek: Record<number, number> = {};
    for (let w = 1; w <= 52; w++) {
      projectedByWeek[w] = 0;
    }

    for (const profile of profiles ?? []) {
      const setWeek = profile.set_week_number as number;
      const setAmount = Number(profile.avg_fruit_set) || 0;

      const percentFields: [string, number][] = [
        ['week4_percent', 4],
        ['week5_percent', 5],
        ['week6_percent', 6],
        ['week7_percent', 7],
        ['week8_percent', 8],
        ['week9_percent', 9],
        ['week10_percent', 10],
      ];

      for (const [field, offset] of percentFields) {
        const pct = Number(profile[field]) || 0;
        if (pct <= 0) continue;
        const harvestWeek = setWeek + offset;
        if (harvestWeek >= 1 && harvestWeek <= 52) {
          projectedByWeek[harvestWeek] += setAmount * (pct / 100);
        }
      }
    }

    const result = Array.from({ length: 52 }, (_, i) => ({
      week: i + 1,
      projected_fruit_per_m2: Math.round(projectedByWeek[i + 1] * 1000) / 1000,
    }));

    const totalProjected = result.reduce((sum, r) => sum + r.projected_fruit_per_m2, 0);
    const peakWeek = result.reduce(
      (best, r) => (r.projected_fruit_per_m2 > best.projected_fruit_per_m2 ? r : best),
      { week: 0, projected_fruit_per_m2: 0 }
    );

    res.json({
      weeks: result,
      total_projected: Math.round(totalProjected * 1000) / 1000,
      peak_week: peakWeek.week,
      peak_projected: peakWeek.projected_fruit_per_m2,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
