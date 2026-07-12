import { Router, Request, Response, NextFunction } from 'express';
import { buildVarietyClimateDataset } from '../lib/climateExposureDataset';

const router = Router();

// GET /?varietyId=&year=&grain=instance|cohort
//
// Phase 2 dataset builder — deterministic aggregation only, no XGBoost.
// `modelStatus` is included explicitly so it's unambiguous nothing consumes
// this data yet.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, year } = req.query;
    const grain = (req.query.grain as string) || 'instance';
    if (!varietyId) return res.status(400).json({ error: 'varietyId is required' });
    if (!year) return res.status(400).json({ error: 'year is required' });
    if (grain !== 'instance' && grain !== 'cohort') return res.status(400).json({ error: 'grain must be "instance" or "cohort"' });

    const dataset = await buildVarietyClimateDataset(varietyId as string, Number(year));

    res.json({
      varietyId,
      setYear: Number(year),
      grain,
      modelStatus: 'not_used_by_any_model_yet',
      rows: grain === 'instance' ? dataset.instanceRows : dataset.cohortRows,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
