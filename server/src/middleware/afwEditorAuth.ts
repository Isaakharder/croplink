import { Request, Response, NextFunction, RequestHandler } from 'express';
import { secretsMatch } from './internalOpsAuth';

// Gates grower writes to AFW forecasts. CropLink has no user accounts, so
// this is a shared editor passcode: AFW_EDITOR_KEY (a Railway secret on the
// server only — never bundled into the client) sent as X-AFW-Editor-Key.
// Separate from INTERNAL_OPS_KEY so the ops secret never reaches a browser.
//
// Fails closed (503) when the secret is not configured. Wrong or missing
// passcodes are counted per client IP; after MAX_FAILURES within WINDOW_MS
// that IP is refused (429) until the window ends, even with the right key.
// The passcode is never logged or stored.
export const AFW_EDITOR_HEADER = 'X-AFW-Editor-Key';
export const MAX_FAILURES = 10;
export const WINDOW_MS = 15 * 60 * 1000;

/** Client IP behind Railway's edge: the right-most X-Forwarded-For entry is the one the edge appended. */
export function clientIp(req: Request): string {
  const xff = req.header('X-Forwarded-For');
  const last = xff?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return last || req.socket?.remoteAddress || 'unknown';
}

export function createAfwEditorAuth(opts: { env?: NodeJS.ProcessEnv; now?: () => number } = {}): RequestHandler {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const failures = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const configured = env.AFW_EDITOR_KEY;
    if (!configured) return res.status(503).json({ error: 'AFW forecast editing is not enabled on this server (AFW_EDITOR_KEY is not configured).' });

    const ip = clientIp(req);
    const t = now();
    let f = failures.get(ip);
    if (f && f.resetAt <= t) { failures.delete(ip); f = undefined; }
    if (f && f.count >= MAX_FAILURES) {
      res.setHeader('Retry-After', String(Math.ceil((f.resetAt - t) / 1000)));
      return res.status(429).json({ error: 'Too many wrong passcodes. Try again later.' });
    }

    const key = req.header(AFW_EDITOR_HEADER);
    if (!key || !secretsMatch(key, configured)) {
      if (f) f.count++;
      else failures.set(ip, { count: 1, resetAt: t + WINDOW_MS });
      if (failures.size > 10_000) for (const [k, v] of failures) if (v.resetAt <= t) failures.delete(k);
      return res.status(401).json({ error: 'Editor passcode required or incorrect.', passcodeRequired: true });
    }
    next();
  };
}
