// Internal-only GrowLink v2 sync endpoints (X-Internal-Ops-Key). Nothing here
// is reachable without the internal ops secret, and the GrowLink key is read
// only from the GROWLINK_CROPLINK_KEY environment secret.
import { randomUUID } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { internalOpsAuth } from '../middleware/internalOpsAuth';
import { createGrowlinkV2Client } from '../lib/growlinkV2Client';
import { runYieldWeekSync, runDeletionSync, runManifestReconciliation, YieldWeekRepo } from '../lib/growlinkYieldSyncRunner';
import { getConnectionRow } from './growlinkConnection';

export function createGrowlinkYieldWeeksRouter(repo: YieldWeekRepo, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Router {
  const router = Router();

  router.post('/sync-internal', internalOpsAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = env.GROWLINK_CROPLINK_KEY;
      if (!key) return res.status(503).json({ error: 'GROWLINK_CROPLINK_KEY is not configured on this server' });
      const baseUrl = env.GROWLINK_BASE_URL || (await getConnectionRow())?.base_url;
      if (!baseUrl) return res.status(503).json({ error: 'GrowLink base URL is not configured' });
      const mode = req.body?.mode ?? 'incremental';
      if (mode !== 'incremental' && mode !== 'reconcile') return res.status(400).json({ error: "mode must be 'incremental' or 'reconcile'" });

      const deps = { client: createGrowlinkV2Client({ baseUrl, key, fetchImpl }), repo, newId: randomUUID };
      const runs = mode === 'reconcile'
        ? [await runManifestReconciliation(deps)]
        : [await runYieldWeekSync(deps), await runDeletionSync(deps)];
      const ok = runs.every((r) => r.status === 'succeeded');
      res.status(ok ? 200 : 207).json({ runs });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
