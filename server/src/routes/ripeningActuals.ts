import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

// GET /ripening-actuals?varietyId=&year=
// Returns actual set→harvest timing percentages per set week, derived from fruit_instances.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, year } = req.query;
    if (!varietyId || !year) {
      return res.status(400).json({ error: 'varietyId and year are required' });
    }
    const yearNum = Number(year);

    const { data: instances, error } = await supabase
      .from('fruit_instances')
      .select('set_year, set_week_number, harvested_year, harvested_week_number')
      .eq('variety_id', varietyId as string)
      .eq('set_year', yearNum);

    if (error) throw new Error(error.message);

    // Group by set_week_number
    const grouped: Record<number, { setCount: number; byOffset: Record<number, number> }> = {};

    for (const inst of instances ?? []) {
      const sw = inst.set_week_number as number;
      if (!grouped[sw]) grouped[sw] = { setCount: 0, byOffset: {} };
      grouped[sw].setCount++;

      if (inst.harvested_week_number != null && inst.harvested_year != null) {
        const offset =
          (inst.harvested_year - inst.set_year) * 52 +
          inst.harvested_week_number -
          sw;
        if (offset >= 4 && offset <= 10) {
          grouped[sw].byOffset[offset] = (grouped[sw].byOffset[offset] ?? 0) + 1;
        }
      }
    }

    const result = Object.entries(grouped)
      .filter(([, d]) => d.setCount > 0)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([weekStr, d]) => {
        const setCount = d.setCount;
        const bo = d.byOffset;

        const counts = {
          week4:  bo[4]  ?? 0,
          week5:  bo[5]  ?? 0,
          week6:  bo[6]  ?? 0,
          week7:  bo[7]  ?? 0,
          week8:  bo[8]  ?? 0,
          week9:  bo[9]  ?? 0,
          week10: bo[10] ?? 0,
        };

        const pct = (n: number) =>
          setCount > 0 ? Math.round((n / setCount) * 1000) / 10 : 0;

        return {
          setWeekNumber: Number(weekStr),
          setCount,
          harvestedByOffset: counts,
          harvestedPercentByOffset: {
            week4Percent:  pct(counts.week4),
            week5Percent:  pct(counts.week5),
            week6Percent:  pct(counts.week6),
            week7Percent:  pct(counts.week7),
            week8Percent:  pct(counts.week8),
            week9Percent:  pct(counts.week9),
            week10Percent: pct(counts.week10),
          },
        };
      });

    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
