import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, year } = req.query;
    let query = supabase
      .from('harvested_entries')
      .select('*')
      .order('week_number');
    if (varietyId) query = query.eq('variety_id', varietyId as string);
    if (year) query = query.eq('year', Number(year));
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organization_id, variety_id, year, week_number, kg, cases, case_weight_kg, harvest_date, notes } = req.body;
    if (!variety_id || !year || !week_number || kg === undefined) {
      return res.status(400).json({ error: 'variety_id, year, week_number, and kg are required' });
    }
    if (week_number < 1 || week_number > 52) {
      return res.status(400).json({ error: 'week_number must be 1–52' });
    }
    if (kg < 0) {
      return res.status(400).json({ error: 'kg cannot be negative' });
    }
    const { data, error } = await supabase
      .from('harvested_entries')
      .insert({ organization_id, variety_id, year, week_number, kg, cases, case_weight_kg, harvest_date, notes })
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json(data);
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    delete updates.id;
    updates.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('harvested_entries')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('harvested_entries')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
