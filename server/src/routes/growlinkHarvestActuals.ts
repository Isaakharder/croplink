import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

// Read-only: these records are owned by GrowLink and are only ever written
// by the future sync service / "Sync Now" action, never edited by hand.
const router = Router();

const SELECT_WITH_VARIETY = '*, variety:varieties(id, name)';

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, year, matched } = req.query;
    let query = supabase
      .from('growlink_harvest_actuals')
      .select(SELECT_WITH_VARIETY)
      .order('harvest_date', { ascending: false });
    if (varietyId) query = query.eq('variety_id', varietyId as string);
    if (year) query = query.eq('year', Number(year));
    if (matched === 'true') query = query.not('variety_id', 'is', null);
    if (matched === 'false') query = query.is('variety_id', null);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) { next(e); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('growlink_harvest_actuals')
      .select(SELECT_WITH_VARIETY)
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Harvest actual not found' });
    res.json(data);
  } catch (e) { next(e); }
});

export default router;
