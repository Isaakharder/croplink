import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { stemId } = req.query;
    let query = supabase.from('plant_nodes').select('*').order('sort_order').order('node_number');
    if (stemId) query = query.eq('measurement_stem_id', stemId as string);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      organization_id, measurement_stem_id, node_number, sort_order,
      node_label, parent_node_id, side, is_side_shoot,
    } = req.body;
    if (!measurement_stem_id || node_number === undefined) {
      return res.status(400).json({ error: 'measurement_stem_id and node_number are required' });
    }
    const { data, error } = await supabase
      .from('plant_nodes')
      .insert({
        organization_id,
        measurement_stem_id,
        node_number,
        sort_order: sort_order ?? 0,
        is_active: true,
        node_label: node_label ?? null,
        parent_node_id: parent_node_id ?? null,
        side: side ?? null,
        is_side_shoot: is_side_shoot ?? false,
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
      .from('plant_nodes')
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
      .from('plant_nodes')
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
