// One-shot entry point for the "croplink-rollup-cron" Railway service.
// Meant to run on a `*/5 * * * *` schedule (Railway skips a scheduled
// firing if the previous one hasn't exited yet, so this must always
// terminate promptly -- see internalOpsClient's request timeout and the
// explicit process.exit() calls below). Does one thing: calls
// POST /rollup-jobs/process on the main API service and reports the result.
import { callInternalOps } from './internalOpsClient';

interface RollupJobResult {
  jobId: string;
  status: 'completed' | 'failed' | 'requeued';
  error?: string;
}
interface ProcessResponse {
  claimed: number;
  results?: RollupJobResult[];
}

const LIMIT = Number(process.env.ROLLUP_CRON_LIMIT) || 25;
const REQUEST_TIMEOUT_MS = Number(process.env.ROLLUP_CRON_TIMEOUT_MS) || 90_000;

async function main(): Promise<number> {
  console.log(`[rollup-cron] POST /api/climate/rollup-jobs/process (limit=${LIMIT}, timeoutMs=${REQUEST_TIMEOUT_MS})`);
  const result = (await callInternalOps('/api/climate/rollup-jobs/process', { limit: LIMIT }, REQUEST_TIMEOUT_MS)) as ProcessResponse;

  const byStatus = { completed: 0, failed: 0, requeued: 0 };
  for (const r of result.results ?? []) byStatus[r.status]++;
  console.log(`[rollup-cron] claimed=${result.claimed} completed=${byStatus.completed} requeued=${byStatus.requeued} failed=${byStatus.failed}`);

  // Per-job failures are surfaced loudly here for the Railway log stream,
  // but a 2xx response from /process is still a successful cron run -- the
  // endpoint itself did its job (claimed what it could, recorded genuine
  // failures on the job row with last_error for operator visibility, and
  // requeued transient lock contention automatically). Exit code reflects
  // HTTP-level success only, per this cron's contract: 0 on 2xx, non-zero
  // only for timeout/network failure/non-2xx.
  for (const r of result.results ?? []) {
    if (r.status === 'failed') console.error(`[rollup-cron] job ${r.jobId} FAILED: ${r.error}`);
  }
  return 0;
}

// Sets process.exitCode and returns (rather than calling process.exit())
// so Node exits naturally once the event loop drains -- letting the fetch
// request's socket close cleanly first. Forcing process.exit() immediately
// after a fetch resolves has been observed to crash Node on Windows with a
// libuv assertion ("UV_HANDLE_CLOSING") while that socket is mid-teardown;
// this pattern avoids the race entirely rather than depending on which
// platform/Node version the race does or doesn't reproduce on.
main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    console.error(`[rollup-cron] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
