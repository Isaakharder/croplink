import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase.from('variety_zones').select('*');
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) { next(e); }
});

// Assigns (or re-assigns) a variety to a zone.
// The UNIQUE index on zone_id means the upsert replaces any existing assignment for that zone.
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { variety_id, zone_id, organization_id } = req.body;
    if (!variety_id) return res.status(400).json({ error: 'variety_id is required' });
    if (!zone_id) return res.status(400).json({ error: 'zone_id is required' });
    const { data, error } = await supabase
      .from('variety_zones')
      .upsert(
        { variety_id, zone_id, organization_id: organization_id ?? null },
        { onConflict: 'zone_id' }
      )
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.status(201).json(data);
  } catch (e) { next(e); }
});

// Removes the variety assignment for a zone
router.delete('/:zoneId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { error } = await supabase
      .from('variety_zones')
      .delete()
      .eq('zone_id', req.params.zoneId);
    if (error) throw new Error(error.message);
    res.status(204).send();
  } catch (e) { next(e); }
});

export default router;
