import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId } = req.query;
    let query = supabase.from('measurement_rows').select('*').order('sort_order').order('row_name');
    if (varietyId) query = query.eq('variety_id', varietyId as string);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organization_id, variety_id, row_name, sort_order } = req.body;
    if (!variety_id || !row_name) {
      return res.status(400).json({ error: 'variety_id and row_name are required' });
    }
    const { data, error } = await supabase
      .from('measurement_rows')
      .insert({ organization_id, variety_id, row_name, sort_order: sort_order ?? 0, is_active: true })
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
      .from('measurement_rows')
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

router.patch('/:id/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    const { data, error } = await supabase
      .from('measurement_rows')
      .update({ is_active, updated_at: new Date().toISOString() })
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
