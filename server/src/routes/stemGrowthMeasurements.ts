import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

// GET /stem-growth-measurements?stemId=&year=&weekNumber=
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { stemId, year, weekNumber } = req.query;
    if (!stemId || !year || !weekNumber) {
      return res.status(400).json({ error: 'stemId, year, and weekNumber are required' });
    }
    const { data, error } = await supabase
      .from('stem_growth_measurements')
      .select('*')
      .eq('measurement_stem_id', stemId as string)
      .eq('year', Number(year))
      .eq('week_number', Number(weekNumber))
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json(data ?? null);
  } catch (e) {
    next(e);
  }
});

// POST /stem-growth-measurements/upsert
router.post('/upsert', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { stemId, seasonId, year, weekNumber, growthCm, notes, organization_id } = req.body;
    if (!stemId || !year || !weekNumber || growthCm == null) {
      return res.status(400).json({ error: 'stemId, year, weekNumber, and growthCm are required' });
    }
    if (weekNumber < 1 || weekNumber > 53) {
      return res.status(400).json({ error: 'weekNumber must be between 1 and 53' });
    }
    if (Number(growthCm) <= 0) {
      return res.status(400).json({ error: 'growthCm must be greater than 0' });
    }

    // Resolve measurement_row_id and variety_id from the stem
    const { data: stemData, error: stemError } = await supabase
      .from('measurement_stems')
      .select('id, measurement_row_id, measurement_rows(id, variety_id)')
      .eq('id', stemId as string)
      .single();
    if (stemError || !stemData) {
      return res.status(404).json({ error: 'Stem not found' });
    }
    const row = Array.isArray(stemData.measurement_rows)
      ? stemData.measurement_rows[0]
      : stemData.measurement_rows;
    if (!row) return res.status(404).json({ error: 'Row not found for stem' });

    const { data, error } = await supabase
      .from('stem_growth_measurements')
      .upsert(
        {
          measurement_stem_id: stemId,
          measurement_row_id: stemData.measurement_row_id,
          variety_id: (row as { variety_id: string }).variety_id,
          season_id: seasonId ?? null,
          year,
          week_number: weekNumber,
          growth_cm: Number(growthCm),
          notes: notes ?? null,
          organization_id: organization_id ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'measurement_stem_id,year,week_number' }
      )
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

export default router;
