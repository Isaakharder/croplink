import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phaseId } = req.query;
    let query = supabase
      .from('zones')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (phaseId) query = query.eq('phase_id', phaseId as string);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) { next(e); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phase_id, name, import_key, sort_order, organization_id } = req.body;
    if (!phase_id) return res.status(400).json({ error: 'phase_id is required' });
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!import_key?.trim()) return res.status(400).json({ error: 'import_key is required' });
    const { data, error } = await supabase
      .from('zones')
      .insert({
        phase_id,
        name: name.trim(),
        import_key: import_key.trim(),
        sort_order: sort_order ?? 0,
        organization_id: organization_id ?? null,
      })
      .select()
      .single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'import_key is already used by another zone' });
      throw new Error(error.message);
    }
    res.status(201).json(data);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, import_key, sort_order } = req.body;
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name.trim();
    if (import_key !== undefined) updates.import_key = import_key.trim();
    if (sort_order !== undefined) updates.sort_order = sort_order;
    const { data, error } = await supabase
      .from('zones')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'import_key is already used by another zone' });
      throw new Error(error.message);
    }
    if (!data) return res.status(404).json({ error: 'Zone not found' });
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { error } = await supabase.from('zones').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.status(204).send();
  } catch (e) { next(e); }
});

export default router;
