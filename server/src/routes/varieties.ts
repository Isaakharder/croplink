import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { getOrCreateSeasonByYear } from '../services/seasons';

const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { seasonId, year } = req.query;
    let query = supabase.from('varieties').select('*').order('name');
    if (seasonId) {
      query = query.eq('season_id', seasonId as string);
    } else if (year) {
      const { data: seasons, error: seasonError } = await supabase
        .from('seasons')
        .select('id')
        .eq('year', Number(year))
        .order('created_at', { ascending: true });

      if (seasonError) throw new Error(seasonError.message);
      const seasonIds = (seasons ?? []).map(season => season.id);
      if (seasonIds.length === 0) {
        return res.json([]);
      }
      query = query.in('season_id', seasonIds);
    }
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
      organization_id, season_id, year, name, color, plant_date, pull_out_date, area_m2,
      plant_count, total_stem_count, average_fruit_weight_grams, is_active
    } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    let resolvedSeasonId = season_id;
    if (!resolvedSeasonId) {
      if (year == null) {
        return res.status(400).json({ error: 'season_id or year is required' });
      }
      const season = await getOrCreateSeasonByYear(Number(year), organization_id ?? null);
      resolvedSeasonId = season.id;
    }

    const { data, error } = await supabase
      .from('varieties')
      .insert({
        organization_id,
        season_id: resolvedSeasonId,
        name,
        color,
        plant_date,
        pull_out_date,
        area_m2,
        plant_count, total_stem_count, average_fruit_weight_grams,
        is_active: is_active ?? true
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
      .from('varieties')
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
      .from('varieties')
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
