import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

// GrowLink Connection settings — stores the base URL and integration key used
// to call GrowLink's API. The secret key is never returned by any route here
// and must never be logged.
const router = Router();

const INTEGRATION_NAME = 'growlink';
const VARIETIES_PATH = '/api/integrations/croplink/varieties';
const TEST_TIMEOUT_MS = 10000;

type ConnectionStatus = 'not_configured' | 'connected' | 'connection_failed';

export interface ConnectionRow {
  id: string;
  organization_id: string | null;
  integration_name: string;
  base_url: string | null;
  secret_key: string | null;
  status: ConnectionStatus;
  last_tested_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

type TestResult =
  | { ok: true; varietyCount: number; varieties: unknown[] }
  | { ok: false; error: string };

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function maskKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}${'•'.repeat(4)}${key.slice(-4)}`;
}

// Public shape returned to the client — never includes secret_key.
function toPublic(row: ConnectionRow | null) {
  if (!row) {
    return {
      base_url: null,
      has_key: false,
      masked_key: null,
      status: 'not_configured' as ConnectionStatus,
      last_tested_at: null,
      last_success_at: null,
      last_error: null,
    };
  }
  return {
    base_url: row.base_url,
    has_key: !!row.secret_key,
    masked_key: maskKey(row.secret_key),
    status: row.status,
    last_tested_at: row.last_tested_at,
    last_success_at: row.last_success_at,
    last_error: row.last_error,
  };
}

// Exported so growlinkHarvestActuals.ts's sync route can read the same
// saved base_url/secret_key without a second, divergent lookup.
export async function getConnectionRow(): Promise<ConnectionRow | null> {
  const { data, error } = await supabase
    .from('crop_integration_settings')
    .select('*')
    .is('organization_id', null)
    .eq('integration_name', INTEGRATION_NAME)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function testGrowlinkConnection(baseUrl: string, secretKey: string): Promise<TestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${VARIETIES_PATH}`, {
      method: 'GET',
      headers: { 'X-Integration-Key': secretKey },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, error: `GrowLink responded with ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}` };
    }
    const data = await response.json();
    const varieties = Array.isArray(data) ? data : Array.isArray(data?.varieties) ? data.varieties : null;
    if (!varieties) {
      return { ok: false, error: 'Unexpected response shape from GrowLink varieties endpoint' };
    }
    return { ok: true, varietyCount: varieties.length, varieties };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: `Timed out after ${TEST_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
  } finally {
    clearTimeout(timeout);
  }
}

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await getConnectionRow();
    res.json(toPublic(row));
  } catch (e) { next(e); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { base_url, secret_key } = req.body;
    if (!base_url?.trim()) return res.status(400).json({ error: 'GrowLink API URL is required' });

    const existing = await getConnectionRow();
    if (!existing?.secret_key && !secret_key?.trim()) {
      return res.status(400).json({ error: 'Integration key is required' });
    }

    const updates: Record<string, unknown> = {
      base_url: stripTrailingSlash(base_url.trim()),
      // Saved values haven't been verified against GrowLink yet — require a
      // fresh Test Connection before showing Connected/Connection Failed.
      status: 'not_configured',
      last_error: null,
    };
    if (secret_key?.trim()) updates.secret_key = secret_key.trim();

    let row: ConnectionRow;
    if (existing) {
      const { data, error } = await supabase
        .from('crop_integration_settings')
        .update(updates)
        .eq('id', existing.id)
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      row = data;
    } else {
      const { data, error } = await supabase
        .from('crop_integration_settings')
        .insert({ ...updates, organization_id: null, integration_name: INTEGRATION_NAME })
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      row = data;
    }
    res.json(toPublic(row));
  } catch (e) { next(e); }
});

router.post('/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await getConnectionRow();
    const baseUrlInput = typeof req.body?.base_url === 'string' ? req.body.base_url.trim() : '';
    const secretKeyInput = typeof req.body?.secret_key === 'string' ? req.body.secret_key.trim() : '';

    const baseUrl = stripTrailingSlash(baseUrlInput || existing?.base_url || '');
    const secretKey = secretKeyInput || existing?.secret_key || '';

    if (!baseUrl) return res.status(400).json({ error: 'GrowLink API URL is required' });
    if (!secretKey) return res.status(400).json({ error: 'Integration key is required' });

    const result = await testGrowlinkConnection(baseUrl, secretKey);

    // Only persist test results against an existing saved row — an ad-hoc
    // test of unsaved values shouldn't create a partial row (Save Connection
    // does that explicitly).
    if (existing) {
      const now = new Date().toISOString();
      await supabase
        .from('crop_integration_settings')
        .update({
          status: result.ok ? 'connected' : 'connection_failed',
          last_tested_at: now,
          last_success_at: result.ok ? now : existing.last_success_at,
          last_error: result.ok ? null : result.error,
        })
        .eq('id', existing.id);
    }

    res.json(result);
  } catch (e) { next(e); }
});

export default router;
