import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rowId } = req.query;
    let query = supabase.from('measurement_stems').select('*').order('sort_order').order('stem_name');
    if (rowId) query = query.eq('measurement_row_id', rowId as string);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organization_id, measurement_row_id, stem_name, sort_order } = req.body;
    if (!measurement_row_id || !stem_name) {
      return res.status(400).json({ error: 'measurement_row_id and stem_name are required' });
    }
    const { data, error } = await supabase
      .from('measurement_stems')
      .insert({ organization_id, measurement_row_id, stem_name, sort_order: sort_order ?? 0, is_active: true })
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
      .from('measurement_stems')
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
      .from('measurement_stems')
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
