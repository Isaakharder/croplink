import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, year } = req.query;
    if (!varietyId || !year) {
      return res.status(400).json({ error: 'varietyId and year are required' });
    }
    const { data, error } = await supabase
      .from('fruit_weight_by_week')
      .select('*')
      .eq('variety_id', varietyId as string)
      .eq('year', Number(year))
      .order('week_number');
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

router.post('/upsert-many', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows array is required' });
    }
    const upsertRows = rows.map((r) => ({
      ...r,
      updated_at: new Date().toISOString(),
    }));
    const { data, error } = await supabase
      .from('fruit_weight_by_week')
      .upsert(upsertRows, { onConflict: 'variety_id,year,week_number' })
      .select();
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

export default router;
