import { Request, Response, NextFunction, RequestHandler } from 'express';

// Per-IP rate limit for grower saves (AFW forecasts). CropLink has no user
// accounts, so this only bounds how fast one client can append rows; every
// accepted save is still validated and stored append-only.
export const SAVE_LIMIT = 30;
export const SAVE_WINDOW_MS = 15 * 60 * 1000;

/** Client IP behind Railway's edge: the right-most X-Forwarded-For entry is the one the edge appended. */
export function clientIp(req: Request): string {
  const xff = req.header('X-Forwarded-For');
  const last = xff?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return last || req.socket?.remoteAddress || 'unknown';
}

export function createSaveRateLimit(opts: { limit?: number; windowMs?: number; now?: () => number } = {}): RequestHandler {
  const limit = opts.limit ?? SAVE_LIMIT;
  const windowMs = opts.windowMs ?? SAVE_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = clientIp(req);
    const t = now();
    let h = hits.get(ip);
    if (!h || h.resetAt <= t) { h = { count: 0, resetAt: t + windowMs }; hits.set(ip, h); }
    if (h.count >= limit) {
      res.setHeader('Retry-After', String(Math.ceil((h.resetAt - t) / 1000)));
      return res.status(429).json({ error: 'Too many saves from this connection. Try again in a few minutes.' });
    }
    h.count++;
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    next();
  };
}
