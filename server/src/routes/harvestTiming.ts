import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

// GET /harvest-timing?varietyId=&year=
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, year } = req.query;
    if (!varietyId || !year) {
      return res.status(400).json({ error: 'varietyId and year are required' });
    }
    const { data, error } = await supabase
      .from('harvest_timing_profiles')
      .select('*')
      .eq('variety_id', varietyId as string)
      .eq('year', Number(year))
      .order('set_week_number');
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

// POST /harvest-timing/upsert-many
router.post('/upsert-many', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows array is required' });
    }

    // Validate
    for (const row of rows) {
      if (!row.variety_id || !row.year || row.set_week_number === undefined) {
        return res.status(400).json({ error: 'Each row needs variety_id, year, set_week_number' });
      }
      if (row.set_week_number < 1 || row.set_week_number > 52) {
        return res.status(400).json({ error: 'set_week_number must be 1–52' });
      }
    }

    const upsertRows = rows.map((r) => ({
      ...r,
      updated_at: new Date().toISOString(),
    }));

    const { data, error } = await supabase
      .from('harvest_timing_profiles')
      .upsert(upsertRows, { onConflict: 'variety_id,year,set_week_number' })
      .select();
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

export default router;
