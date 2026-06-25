import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { supabase } from '../lib/supabase';

export interface OrgContext {
  id: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      organization?: OrgContext;
    }
  }
}

export async function climateImportAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = auth.slice(7);
  const hash = createHash('sha256').update(token).digest('hex');

  const { data: org, error } = await supabase
    .from('organizations')
    .select('id, name')
    .eq('api_key_hash', hash)
    .eq('is_active', true)
    .maybeSingle();

  if (error || !org) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.organization = org;
  next();
}
