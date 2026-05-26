import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('seasons')
      .select('*')
      .order('year', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, year, plant_date, pull_out_date, is_active, organization_id } = req.body;
    if (year == null) {
      return res.status(400).json({ error: 'year is required' });
    }
    const { data, error } = await supabase
      .from('seasons')
      .insert({
        name: name ?? String(year),
        year,
        plant_date,
        pull_out_date,
        is_active: is_active ?? true,
        organization_id,
      })
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
      .from('seasons')
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

export default router;
