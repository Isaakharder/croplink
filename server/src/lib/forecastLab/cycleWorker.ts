// Worker-thread entry for a Forecast Lab cycle (see cycleJob.ts). Runs the
// whole cycle off the API's main thread and reports progress; the final
// status is written to the run row by runForecastLabCycle itself.
import { parentPort, workerData } from 'worker_threads';
import { randomUUID } from 'crypto';
import type { CycleWorkerData, WorkerMessage } from './cycleJob';

const post = (m: WorkerMessage) => parentPort?.postMessage(m);

async function main(data: CycleWorkerData): Promise<void> {
  // Imported here so a self-test proves the compiled module graph loads in a worker.
  const { runForecastLabCycle } = await import('./cycle');
  const { activeVarietiesForYear, loadSourceData, supabaseLabStore } = await import('./repository');
  const { createGrowlinkV2Client } = await import('../growlinkV2Client');
  const { runYieldWeekSync, runDeletionSync } = await import('../growlinkYieldSyncRunner');
  const { supabaseYieldWeekRepo } = await import('../growlinkYieldRepo');
  const { getConnectionRow } = await import('../../routes/growlinkConnection');
  if (data.selfTest) { post({ type: 'done', status: 'self-test' }); return; }

  const key = process.env.GROWLINK_CROPLINK_KEY;
  const baseUrl = process.env.GROWLINK_BASE_URL || (await getConnectionRow())?.base_url;
  const sync = key && baseUrl && !data.skipSync
    ? async () => {
        const deps = { client: createGrowlinkV2Client({ baseUrl, key }), repo: supabaseYieldWeekRepo, newId: randomUUID };
        return [await runYieldWeekSync(deps), await runDeletionSync(deps)].map((r) => ({ kind: r.kind, status: r.status, fetched: r.fetched, created: r.created, updated: r.updated, rejected: r.rejected, error: r.error }));
      }
    : undefined;
  const summary = await runForecastLabCycle({
    store: supabaseLabStore, varieties: activeVarietiesForYear, load: loadSourceData, now: () => new Date(), newId: randomUUID,
    codeVersion: process.env.RAILWAY_GIT_COMMIT_SHA ?? null, sync, runId: data.runId,
    onProgress: (progress) => post({ type: 'progress', progress }),
  }, data.year);
  post({ type: 'done', status: summary.status });
}

main(workerData as CycleWorkerData).catch((e) => {
  post({ type: 'fatal', error: e instanceof Error ? e.message : String(e) });
  process.exitCode = 1;
});
