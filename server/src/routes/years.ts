import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { getOrCreateSeasonByYear } from '../services/seasons';

const router = Router();

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('seasons')
      .select('*')
      .order('year', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    const years = new Map<number, (typeof data)[number]>();
    for (const season of data ?? []) {
      if (!years.has(season.year)) {
        years.set(season.year, season);
      }
    }

    res.json(Array.from(years.values()));
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { year, organization_id } = req.body;
    if (year == null) {
      return res.status(400).json({ error: 'year is required' });
    }

    const season = await getOrCreateSeasonByYear(Number(year), organization_id ?? null);
    res.status(201).json(season);
  } catch (e) {
    next(e);
  }
});

export default router;