import { Request, Response, NextFunction } from 'express';

export function climateAgentAuth(req: Request, res: Response, next: NextFunction) {
  const key = req.header('X-Climate-Agent-Key');
  if (!key || key !== process.env.CLIMATE_AGENT_API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing climate agent API key' });
  }
  next();
}
