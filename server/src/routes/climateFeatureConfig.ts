import { Router, Request, Response } from 'express';
import { VPD_BANDS, VPD_BAND_CONFIG_VERSION, DEGREE_HOUR_BASE_TEMP_C, DEGREE_HOUR_UPPER_CAP_C, FEATURE_ENGINE_VERSION } from '../lib/climateFeatures';

const router = Router();

// GET / — the feature engine's config constants (climateFeatures.ts), so the
// client can render VPD band shading/labels and degree-hour base/cap from
// the same source of truth the server uses, instead of a hardcoded copy.
router.get('/', (_req: Request, res: Response) => {
  res.json({
    vpdBands: VPD_BANDS.map((b) => ({ key: b.key, label: b.label, minKpa: b.minKpa, maxKpa: b.maxKpa })),
    vpdBandConfigVersion: VPD_BAND_CONFIG_VERSION,
    degreeHourBaseTempC: DEGREE_HOUR_BASE_TEMP_C,
    degreeHourUpperCapC: DEGREE_HOUR_UPPER_CAP_C,
    featureEngineVersion: FEATURE_ENGINE_VERSION,
  });
});

export default router;
