// One-shot entry point for a "croplink-forecast-lab-cron" Railway service.
// Starts a cycle with POST /api/forecast-lab/cycle (internal-ops auth), which
// returns 202 with a run id at once — the cycle runs as a background job on
// the API — then polls GET /api/forecast-lab/runs/:id until it finishes.
// Exit 0 only for succeeded/partial; failed, abandoned or still running at
// the deadline exits 1. A 409 (a cycle is already running) is not an error:
// this run follows that one instead. Re-running is safe: snapshots are
// insert-only and keyed.
import { callInternalOps } from './internalOpsClient';

const TIMEOUT_MS = Number(process.env.FORECAST_LAB_CRON_TIMEOUT_MS) || 95 * 60_000;
const POLL_MS = Number(process.env.FORECAST_LAB_CRON_POLL_MS) || 30_000;

interface RunStatus { id: string; status: string; error: string | null; heartbeatAt: string | null; progress: Record<string, unknown> | null; summary: { varieties?: { name: string; asOf: string | null; liveInserted: number; hindcastInserted: number; error?: string }[] } | null }

async function getRun(id: string): Promise<RunStatus> {
  const base = (process.env.CROPLINK_INTERNAL_BASE_URL ?? '').replace(/\/+$/, '');
  const res = await fetch(`${base}/api/forecast-lab/runs/${id}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`GET /api/forecast-lab/runs/${id} returned ${res.status}`);
  return (await res.json()) as RunStatus;
}

async function main(): Promise<number> {
  console.log('[forecast-lab-cron] POST /api/forecast-lab/cycle');
  let runId: string;
  try {
    runId = ((await callInternalOps('/api/forecast-lab/cycle', {}, 60_000)) as { runId: string }).runId;
  } catch (e) {
    const m = /returned 409: (.*)$/s.exec(e instanceof Error ? e.message : '');
    if (!m) throw e;
    runId = (JSON.parse(m[1]) as { runId: string }).runId;
    console.log(`[forecast-lab-cron] a cycle is already running (${runId}); following it`);
  }
  console.log(`[forecast-lab-cron] run=${runId} started; polling every ${POLL_MS / 1000}s`);
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let run: RunStatus;
    try { run = await getRun(runId); } catch (e) { console.log(`[forecast-lab-cron] status read failed (${e instanceof Error ? e.message : e}); retrying`); if (Date.now() > deadline) return 1; continue; }
    if (run.status === 'running') {
      console.log(`[forecast-lab-cron] running: ${JSON.stringify(run.progress)} (heartbeat ${run.heartbeatAt})`);
      if (Date.now() > deadline) { console.error('[forecast-lab-cron] still running at the deadline'); return 1; }
      continue;
    }
    console.log(`[forecast-lab-cron] run=${runId} status=${run.status}${run.error ? ` error=${run.error}` : ''}`);
    for (const v of run.summary?.varieties ?? []) console.log(`[forecast-lab-cron] ${v.name}: asOf=${v.asOf} live+${v.liveInserted} hindcast+${v.hindcastInserted}${v.error ? ` ERROR ${v.error}` : ''}`);
    return run.status === 'succeeded' || run.status === 'partial' ? 0 : 1;
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    console.error(`[forecast-lab-cron] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
