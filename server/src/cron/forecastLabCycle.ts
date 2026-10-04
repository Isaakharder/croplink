// One-shot entry point for a "croplink-forecast-lab-cron" Railway service.
// Calls POST /api/forecast-lab/cycle on the main API (internal-ops auth): sync
// GrowLink v2 (when GROWLINK_CROPLINK_KEY is set on the API), lock new live
// forecasts, backfill labelled hindcasts once. Re-running is safe: snapshots
// are insert-only and keyed, so a repeat inserts nothing.
import { callInternalOps } from './internalOpsClient';

const TIMEOUT_MS = Number(process.env.FORECAST_LAB_CRON_TIMEOUT_MS) || 600_000;

async function main(): Promise<number> {
  console.log(`[forecast-lab-cron] POST /api/forecast-lab/cycle (timeoutMs=${TIMEOUT_MS})`);
  const result = (await callInternalOps('/api/forecast-lab/cycle', {}, TIMEOUT_MS)) as { status: string; runId: string | null; varieties: { name: string; asOf: string | null; liveInserted: number; hindcastInserted: number; error?: string }[] };
  console.log(`[forecast-lab-cron] run=${result.runId} status=${result.status}`);
  for (const v of result.varieties ?? []) console.log(`[forecast-lab-cron] ${v.name}: asOf=${v.asOf} live+${v.liveInserted} hindcast+${v.hindcastInserted}${v.error ? ` ERROR ${v.error}` : ''}`);
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    console.error(`[forecast-lab-cron] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
