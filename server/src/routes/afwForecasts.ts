// Grower AFW forecast editor API.
//   GET  /api/afw-forecasts?varietyId=…  → editable weeks (current week → pull-out)
//        with the saved forecast, the GrowLink actual (read-only) and the AFW
//        the experimental projections use for each week, with its source.
//   POST /api/afw-forecasts               → one Save: append-only rows, all or none.
//        Requires the editor passcode (X-AFW-Editor-Key, see middleware/afwEditorAuth).
// Forecasts never touch GrowLink actuals or CropLink's harvest_afw_by_week.
import { randomUUID } from 'crypto';
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { createAfwEditorAuth } from '../middleware/afwEditorAuth';
import { supabase } from '../lib/supabase';
import { fromIsoWeekIndex, isoWeekIndex } from '../lib/isoWeek';
import { harvestWindowFraction } from '../lib/cropWindow';
import {
  AFW_SOURCE_LABELS, editableWeeks, effectiveManualAfw, latestSettledGrowlinkAfw, resolveTargetAfw, validateAfwChanges, ManualAfwEntry,
} from '../lib/afwForecast';
import { AfwForecastRepo, supabaseAfwForecastRepo } from '../lib/afwForecastRepo';
import { selectAfw, AfwPoint } from '../lib/forecastLab/engine';
import { loadAfwPoints } from '../lib/forecastLab/repository';

interface VarietyRow { id: string; name: string; pull_out_date: string | null; is_active: boolean }

export interface AfwForecastDeps {
  repo: AfwForecastRepo;
  variety: (id: string) => Promise<VarietyRow | null>;
  afwPoints: (varietyId: string) => Promise<{ afw: AfwPoint[]; growlinkLinked: boolean; v2Available: boolean }>;
  now: () => Date;
  /** Guards writes. Defaults to the editor-passcode middleware. */
  writeAuth?: RequestHandler;
}

const label = (i: number) => { const w = fromIsoWeekIndex(i); return `${w.year}-W${String(w.week).padStart(2, '0')}`; };

/** Editor model — pure apart from its inputs. Exported for tests. */
export function buildEditorModel(args: { variety: VarietyRow; entries: ManualAfwEntry[]; afw: AfwPoint[]; now: Date; growlinkLinked: boolean; v2Available: boolean }) {
  const { variety, entries, afw, now } = args;
  const win = editableWeeks(now, variety.pull_out_date);
  const manual = effectiveManualAfw(entries, now);
  const fallback = selectAfw(afw, win.from, now).point;
  const settled = latestSettledGrowlinkAfw(afw.filter((p) => p.source === 'growlink-v2'), win.from, now);
  const weeks = [];
  for (let i = win.from; i <= win.to; i++) {
    const w = fromIsoWeekIndex(i);
    const m = manual.get(i) ?? null;
    // Shown only when one GrowLink entry covers the week (several entries would need kg weights to combine).
    const glAll = afw.filter((p) => p.source === 'growlink-v2' && p.index === i);
    const gl = glAll.length === 1 ? glAll[0] : null;
    const used = resolveTargetAfw(i, manual, settled, fallback);
    weeks.push({
      index: i, year: w.year, week: w.week, label: label(i), current: i === win.from,
      harvestWindow: harvestWindowFraction(i, variety.pull_out_date),
      manual: m ? { grams: m.grams, enteredAt: m.enteredAt, entryId: m.entryId } : null,
      growlinkActual: gl ? { grams: gl.grams, settled: gl.settled === true } : null,
      used: used ? { grams: used.grams, source: used.source, sourceLabel: AFW_SOURCE_LABELS[used.source], fromWeek: label(used.fromIndex) } : null,
    });
  }
  const latestEntryId = entries.reduce((mx, e) => Math.max(mx, e.id), 0);
  // What a week uses when no manual forecast reaches it (tiers 3–4) — lets the editor preview unsaved edits.
  const b = resolveTargetAfw(win.from, new Map(), settled, fallback);
  const baseline = b ? { grams: b.grams, source: b.source, sourceLabel: AFW_SOURCE_LABELS[b.source], fromWeek: label(b.fromIndex) } : null;
  const warnings: string[] = [];
  if (!win.pullOutKnown) warnings.push('No pull-out date set for this variety — showing the next 12 weeks. Set a pull-out date to edit through the end of the crop.');
  if (!args.growlinkLinked) warnings.push('Not linked to a GrowLink variety — weeks without a manual forecast fall back to CropLink AFW.');
  else if (!args.v2Available) warnings.push('GrowLink AFW detail is not available yet (sync pending) — weeks without a manual forecast fall back to CropLink AFW.');
  return {
    variety: { id: variety.id, name: variety.name, pullOutDate: variety.pull_out_date },
    window: { from: label(win.from), to: label(win.to), pullOutKnown: win.pullOutKnown },
    latestEntryId,
    baseline,
    weeks,
    history: [...entries].sort((a, b) => b.id - a.id).slice(0, 25).map((e) => ({ id: e.id, week: label(isoWeekIndex(e.year, e.week)), action: e.action, grams: e.grams, enteredAt: e.enteredAt })),
    warnings,
  };
}

export const supabaseAfwForecastDeps: AfwForecastDeps = {
  repo: supabaseAfwForecastRepo,
  async variety(id) {
    const { data, error } = await supabase.from('varieties').select('id, name, pull_out_date, is_active').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as VarietyRow | null) ?? null;
  },
  afwPoints: loadAfwPoints,
  now: () => new Date(),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAfwForecastsRouter(deps: AfwForecastDeps = supabaseAfwForecastDeps): Router {
  const router = Router();

  async function model(varietyId: string, res: Response) {
    const variety = await deps.variety(varietyId);
    if (!variety) { res.status(404).json({ error: 'Variety not found' }); return null; }
    const [entries, pts] = await Promise.all([deps.repo.list(varietyId), deps.afwPoints(varietyId)]);
    if (entries == null) { res.status(503).json({ error: 'AFW forecasts are not enabled yet (database migration pending).', available: false }); return null; }
    return buildEditorModel({ variety, entries, afw: pts.afw, now: deps.now(), growlinkLinked: pts.growlinkLinked, v2Available: pts.v2Available });
  }

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const varietyId = String(req.query.varietyId ?? '');
      if (!UUID.test(varietyId)) return res.status(400).json({ error: 'varietyId is required' });
      const m = await model(varietyId, res);
      if (!m) return;
      res.json({ available: true, ...m });
    } catch (e) { next(e); }
  });

  router.post('/', deps.writeAuth ?? createAfwEditorAuth(), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const varietyId = String(req.body?.varietyId ?? '');
      if (!UUID.test(varietyId)) return res.status(400).json({ error: 'varietyId is required' });
      const variety = await deps.variety(varietyId);
      if (!variety) return res.status(404).json({ error: 'Variety not found' });
      const entries = await deps.repo.list(varietyId);
      if (entries == null) return res.status(503).json({ error: 'AFW forecasts are not enabled yet (database migration pending).' });
      // Optimistic concurrency: the editor must have seen the latest saved state.
      const latest = entries.reduce((mx, e) => Math.max(mx, e.id), 0);
      if (Number(req.body?.expectedLatestEntryId ?? -1) !== latest) {
        return res.status(409).json({ error: 'AFW forecasts were changed since you loaded them. Reload, then re-apply your edits.' });
      }
      const now = deps.now();
      const v = validateAfwChanges(req.body?.changes, { now, pullOutDate: variety.pull_out_date, current: effectiveManualAfw(entries, now) });
      if (v.errors.length) return res.status(422).json({ error: 'Nothing was saved — fix these weeks and save again.', errors: v.errors });
      const saved = v.accepted.length ? await deps.repo.insertBatch(varietyId, randomUUID(), v.accepted) : [];
      const m = await model(varietyId, res);
      if (!m) return;
      res.json({ available: true, saved: saved.length, notices: v.notices, ...m });
    } catch (e) { next(e); }
  });

  return router;
}

