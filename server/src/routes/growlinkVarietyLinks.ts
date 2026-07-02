import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

const LINK_STATUSES = ['linked', 'unlinked', 'conflict'];
const SELECT_WITH_VARIETY = '*, variety:varieties(id, name, is_active)';

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query;
    let query = supabase
      .from('growlink_variety_links')
      .select(SELECT_WITH_VARIETY)
      .order('created_at', { ascending: false });
    if (status) query = query.eq('link_status', status as string);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) { next(e); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { variety_id, growlink_variety_key, link_status, notes, organization_id } = req.body;
    if (!variety_id) return res.status(400).json({ error: 'variety_id is required' });
    if (!growlink_variety_key?.trim()) return res.status(400).json({ error: 'growlink_variety_key is required' });
    if (link_status !== undefined && !LINK_STATUSES.includes(link_status)) {
      return res.status(400).json({ error: `link_status must be one of ${LINK_STATUSES.join(', ')}` });
    }
    const { data, error } = await supabase
      .from('growlink_variety_links')
      .insert({
        variety_id,
        growlink_variety_key: growlink_variety_key.trim(),
        link_status: link_status ?? 'linked',
        notes: notes?.trim() || null,
        organization_id: organization_id ?? null,
      })
      .select(SELECT_WITH_VARIETY)
      .single();
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'This variety already has a GrowLink link, or that GrowLink key is already in use' });
      }
      throw new Error(error.message);
    }
    res.status(201).json(data);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { growlink_variety_key, link_status, notes } = req.body;
    if (link_status !== undefined && !LINK_STATUSES.includes(link_status)) {
      return res.status(400).json({ error: `link_status must be one of ${LINK_STATUSES.join(', ')}` });
    }
    const updates: Record<string, unknown> = {};
    if (growlink_variety_key !== undefined) {
      if (!growlink_variety_key?.trim()) return res.status(400).json({ error: 'growlink_variety_key cannot be empty' });
      updates.growlink_variety_key = growlink_variety_key.trim();
    }
    if (link_status !== undefined) updates.link_status = link_status;
    if (notes !== undefined) updates.notes = notes?.trim() || null;

    const { data, error } = await supabase
      .from('growlink_variety_links')
      .update(updates)
      .eq('id', req.params.id)
      .select(SELECT_WITH_VARIETY)
      .single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'That GrowLink key is already in use' });
      throw new Error(error.message);
    }
    if (!data) return res.status(404).json({ error: 'Variety link not found' });
    res.json(data);
  } catch (e) { next(e); }
});

router.patch('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { link_status } = req.body;
    if (!LINK_STATUSES.includes(link_status)) {
      return res.status(400).json({ error: `link_status must be one of ${LINK_STATUSES.join(', ')}` });
    }
    const { data, error } = await supabase
      .from('growlink_variety_links')
      .update({ link_status })
      .eq('id', req.params.id)
      .select(SELECT_WITH_VARIETY)
      .single();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Variety link not found' });
    res.json(data);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { error } = await supabase.from('growlink_variety_links').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.status(204).send();
  } catch (e) { next(e); }
});

export default router;
