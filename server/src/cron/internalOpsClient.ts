// Shared HTTP client for the one-shot cron entry points in this directory
// (processRollup.ts, runSnapshot.ts). Each of those is meant to run as its
// own separate Railway cron service -- see server/src/cron/README.md -- and
// call back into the main CropLink API service's internal-ops-authenticated
// endpoints, never touch the database directly.
import dotenv from 'dotenv';
import path from 'path';
// Same two-location lookup index.ts/supabase.ts already use, so this also
// works for local testing without needing its own env-loading convention;
// on Railway these are no-ops since the platform injects env vars directly
// and neither .env file exists in the deployed container.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

/**
 * POSTs to one internal-ops route and returns the parsed JSON body.
 * Throws (never returns) on timeout, network failure, or a non-2xx
 * response -- callers should let that exception propagate to a top-level
 * catch that sets a non-zero exit code, per each cron service's contract
 * with Railway (exit 0 only after a genuine 2xx).
 *
 * The key is sent only as the X-Internal-Ops-Key header value, never
 * interpolated into the logged URL or any thrown error message -- errors
 * here quote response bodies/status codes, never request headers.
 */
export async function callInternalOps(routePath: string, body: unknown, timeoutMs = 90_000): Promise<unknown> {
  const baseUrl = process.env.CROPLINK_INTERNAL_BASE_URL;
  const key = process.env.INTERNAL_OPS_KEY;
  if (!baseUrl) throw new Error('CROPLINK_INTERNAL_BASE_URL is not set');
  if (!key) throw new Error('INTERNAL_OPS_KEY is not set');

  const url = `${baseUrl.replace(/\/+$/, '')}${routePath}`;

  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Ops-Key': key },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const isTimeout = e instanceof Error && e.name === 'TimeoutError';
    throw new Error(isTimeout
      ? `POST ${routePath} timed out after ${timeoutMs}ms`
      : `POST ${routePath} failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${routePath} returned ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`POST ${routePath} returned 2xx but a non-JSON body: ${text.slice(0, 500)}`);
  }
}
