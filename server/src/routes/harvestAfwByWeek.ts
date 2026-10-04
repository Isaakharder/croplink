import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { isoWeekIndex, isoWeekOfDate, isValidIsoWeek, weeksInIsoYear } from '../lib/isoWeek';

const router = Router();

/**
 * True when (year, week) is strictly after today's ISO year/week — i.e. a
 * week that hasn't happened yet, so it cannot have a real harvest
 * measurement. Compared as exact ISO-week indexes so W53 and year
 * boundaries order correctly.
 */
function isFutureWeek(year: number, week: number): boolean {
  const today = isoWeekOfDate(new Date());
  return isoWeekIndex(year, week) > isoWeekIndex(today.year, today.week);
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, year } = req.query;
    if (!varietyId || !year) {
      return res.status(400).json({ error: 'varietyId and year are required' });
    }
    const { data, error } = await supabase
      .from('harvest_afw_by_week')
      .select('*')
      .eq('variety_id', varietyId as string)
      .eq('year', Number(year))
      .order('week_number');
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

router.post('/upsert-many', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows array is required' });
    }

    // An 'override' (manual guess for a not-yet-harvested week) must never
    // clobber an already-recorded 'actual' (real measurement) for the same
    // week — the unique key alone doesn't protect this since either source
    // can legally occupy that row.
    const overrideRows = rows.filter((r) => r.source === 'override');
    const existingActualKeys = new Set<string>();
    if (overrideRows.length > 0) {
      const varietyIds = [...new Set(overrideRows.map((r) => r.variety_id))];
      const { data: existing, error: exErr } = await supabase
        .from('harvest_afw_by_week')
        .select('variety_id, year, week_number, source')
        .in('variety_id', varietyIds)
        .eq('source', 'actual');
      if (exErr) throw new Error(exErr.message);
      for (const row of existing ?? []) {
        existingActualKeys.add(`${row.variety_id}:${row.year}:${row.week_number}`);
      }
    }

    const skipped: { week_number: number; reason: string }[] = [];
    const rowsToUpsert = rows.filter((r) => {
      if (!isValidIsoWeek(r.year, r.week_number)) {
        skipped.push({ week_number: r.week_number, reason: `Week ${r.week_number} doesn't exist in ${r.year} (valid: 1–${Number.isInteger(r.year) ? weeksInIsoYear(r.year) : 52})` });
        return false;
      }
      // A real harvest measurement cannot exist for a week that hasn't
      // happened yet — reject outright rather than silently downgrading to
      // 'override', so a future-dated guess never gets stored with the
      // confidence of a real measurement (see the 2026-08-28 projection
      // audit: this is exactly how a season's AFW got batch-guessed on a
      // single day). The grower can still save it deliberately as an
      // override.
      if (r.source === 'actual' && isFutureWeek(r.year, r.week_number)) {
        skipped.push({ week_number: r.week_number, reason: `Week ${r.week_number} hasn't happened yet — can't save as an actual. Use Override instead.` });
        return false;
      }
      if (r.source !== 'override') return true;
      const key = `${r.variety_id}:${r.year}:${r.week_number}`;
      if (existingActualKeys.has(key)) {
        skipped.push({ week_number: r.week_number, reason: 'An actual already exists for that week' });
        return false;
      }
      return true;
    });

    const upsertRows = rowsToUpsert.map((r) => ({
      ...r,
      updated_at: new Date().toISOString(),
    }));

    let data: unknown[] = [];
    if (upsertRows.length > 0) {
      const { data: upserted, error } = await supabase
        .from('harvest_afw_by_week')
        .upsert(upsertRows, { onConflict: 'variety_id,year,week_number' })
        .select();
      if (error) throw new Error(error.message);
      data = upserted ?? [];
    }

    res.json({ data, skipped });
  } catch (e) {
    next(e);
  }
});

export default router;
