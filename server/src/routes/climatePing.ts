import { Router, Request, Response } from 'express';
import { climateImportAuth } from '../middleware/climateImportAuth';

const router = Router();

// GET /api/v1/climate/ping
// Connection-test endpoint for the Climate Agent — verifies the API key without
// creating any climate_imports or climate_readings rows.
router.get('/', climateImportAuth, (req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    service: 'CropLink',
    organization_id: req.organization!.id,
    organization_name: req.organization!.name,
  });
});

export default router;
