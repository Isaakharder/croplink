import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

interface StemRecord {
  id: string;
  is_active: boolean;
  updated_at: string;
}

interface RowWithStems {
  id: string;
  row_name: string;
  variety_id: string;
  sort_order: number;
  updated_at: string;
  measurement_stems: StemRecord[] | null;
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId } = req.query;
    if (!varietyId) return res.status(400).json({ error: 'varietyId is required' });

    const { data, error } = await supabase
      .from('measurement_rows')
      .select('id, row_name, variety_id, sort_order, updated_at, measurement_stems(id, is_active, updated_at)')
      .eq('variety_id', varietyId as string)
      .eq('is_active', true)
      .order('sort_order')
      .order('row_name');

    if (error) throw new Error(error.message);

    const rows = (data as unknown as RowWithStems[]).map(row => {
      const stems = Array.isArray(row.measurement_stems) ? row.measurement_stems : [];
      const activeStems = stems.filter(s => s.is_active);
      const lastUpdated = activeStems.reduce<string>(
        (max, s) => (s.updated_at > max ? s.updated_at : max),
        row.updated_at,
      );
      return {
        id: row.id,
        row_name: row.row_name,
        variety_id: row.variety_id,
        sort_order: row.sort_order,
        stem_count: activeStems.length,
        last_updated: lastUpdated,
      };
    });

    res.json(rows);
  } catch (e) {
    next(e);
  }
});

export default router;
