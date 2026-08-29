import { Router, Request, Response, NextFunction } from 'express';
import { internalOpsAuth } from '../middleware/internalOpsAuth';
import { runProjectionSnapshot } from '../lib/projectionSnapshotService';

const router = Router();

// POST /api/climate/snapshots/run — { year, runId? }. Safe authenticated
// trigger, not an in-process timer: this process does not schedule itself.
// A cron/scheduler (or a human operator) is expected to call this on a
// regular cadence (e.g. daily) — see the Round 10 report for the specific
// scheduling step this still needs. Pass `runId` to make a retry of the
// same logical snapshot idempotent instead of creating a second one.
router.post('/run', internalOpsAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const year = Number(req.body?.year);
    if (!year) return res.status(400).json({ error: 'year is required' });
    const runId = typeof req.body?.runId === 'string' ? req.body.runId : undefined;
    const result = await runProjectionSnapshot(year, runId);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
