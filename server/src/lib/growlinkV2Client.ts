// HTTP client for GrowLink's CropLink v2 integration endpoints. The key is
// read from the GROWLINK_CROPLINK_KEY Railway secret only — never from the
// database — and never appears in errors or logs (a short sha256
// fingerprint identifies which key was used).
import { V2ListPage, V2ManifestHeader, V2ManifestPage, V2Tombstone, V2YieldWeekItem, keyFingerprint } from './growlinkYieldSync';

export class GrowlinkV2Error extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface GrowlinkV2Client {
  keyFingerprint: string;
  yieldWeeksPage(cursor: string | null): Promise<V2ListPage<V2YieldWeekItem>>;
  deletionsPage(cursor: string | null): Promise<V2ListPage<V2Tombstone>>;
  createManifest(): Promise<V2ManifestHeader>;
  manifestPage(manifestId: string, cursor: string): Promise<V2ManifestPage>;
}

export function createGrowlinkV2Client(opts: { baseUrl: string; key: string; fetchImpl?: typeof fetch; timeoutMs?: number }): GrowlinkV2Client {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/api/integrations/croplink/v2`;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  async function call<T>(method: 'GET' | 'POST', path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { method, headers: { 'X-Integration-Key': opts.key }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timeout = e instanceof Error && e.name === 'TimeoutError';
      throw new GrowlinkV2Error(0, timeout ? `GrowLink ${method} ${path.split('?')[0]} timed out after ${timeoutMs}ms` : `GrowLink ${method} ${path.split('?')[0]} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new GrowlinkV2Error(res.status, `GrowLink ${method} ${path.split('?')[0]} returned ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GrowlinkV2Error(res.status, `GrowLink ${method} ${path.split('?')[0]} returned non-JSON`);
    }
  }
  const q = (cursor: string | null) => (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');

  return {
    keyFingerprint: keyFingerprint(opts.key),
    yieldWeeksPage: (cursor) => call('GET', `/yield-weeks${q(cursor)}`),
    deletionsPage: (cursor) => call('GET', `/yield-week-deletions${q(cursor)}`),
    createManifest: () => call('POST', '/yield-week-manifests'),
    manifestPage: (id, cursor) => call('GET', `/yield-week-manifests/${encodeURIComponent(id)}/ids?cursor=${encodeURIComponent(cursor)}`),
  };
}
