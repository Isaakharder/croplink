import { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'crypto';

/**
 * Constant-time secret comparison. A plain `===`/`!==` on the raw strings
 * (what climateAgentAuth.ts still does, pre-dating this round -- not
 * changed here since it's out of this task's scope, but noted as an
 * existing weakness with the same shape) short-circuits on the first
 * differing byte, so response latency leaks how many leading characters of
 * a guess were correct. Hashing both sides to a fixed-length digest first
 * sidesteps timingSafeEqual's requirement that both buffers be the same
 * length (comparing raw strings of different lengths would throw), and the
 * hash step itself doesn't reintroduce a timing leak -- sha256 is constant-
 * time per input length, and both inputs are hashed the same way regardless
 * of whether they match.
 */
function secretsMatch(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

// Gates internal/ops endpoints that aren't tied to any one organization's API
// key: the rollup-job worker trigger, rollup/coverage diagnostics, and the
// forecast-snapshot trigger. Deliberately separate from climateAgentAuth /
// climateImportAuth (organization- or agent-scoped) -- these endpoints act
// across all organizations and shouldn't be reachable with an org's own key.
// A cron/scheduler (or a human operator) calls these with this shared secret.
//
// Not "security by obscurity": the route paths themselves (/rollup-jobs/*,
// /snapshots/*) are unauthenticated to discover (Express doesn't hide route
// existence -- a request with no/wrong key still gets a 401, not a 404 that
// would suggest hiding the path is load-bearing), but every request is
// rejected without a valid, constant-time-compared shared secret. Security
// here rests entirely on the secret's strength and how it's stored/rotated
// (an operational concern -- generate a long random value, keep it out of
// source control, rotate if ever exposed), not on the endpoint being hard
// to guess.
export function internalOpsAuth(req: Request, res: Response, next: NextFunction) {
  const key = req.header('X-Internal-Ops-Key');
  const configured = process.env.INTERNAL_OPS_KEY;
  if (!configured) {
    return res.status(503).json({ error: 'INTERNAL_OPS_KEY is not configured on this server' });
  }
  if (!key || !secretsMatch(key, configured)) {
    return res.status(401).json({ error: 'Invalid or missing internal ops key' });
  }
  next();
}
