// Runs a Forecast Lab cycle as a background job with an observable status.
//
// The cycle is CPU-bound (bootstrap ranges, EM fits; minutes per variety), so
// it runs in a worker thread: the API keeps answering — including run-status
// reads — while it works. The HTTP request only creates the run row and
// starts the job; it returns 202 at once, so no proxy timeout can cut it off.
//
// Liveness: while the worker is alive the main thread writes a heartbeat
// (with the worker's latest progress) into the run's summary every
// HEARTBEAT_MS. A run whose heartbeat is older than STALE_AFTER_MS — the
// process restarted, crashed or was redeployed mid-run — is marked failed by
// sweepStaleRuns (on every status read, every new cycle and periodically).
// A worker that errors, exits early or exceeds MAX_RUNTIME_MS is marked
// failed immediately. Snapshots already inserted are kept (insert-only), so
// re-running the cycle resumes where it stopped.
import path from 'path';
import { Worker } from 'worker_threads';
import type { LabRun, LabStore } from './repository';
import type { CycleProgress } from './cycle';

export const HEARTBEAT_MS = 20_000;
export const STALE_AFTER_MS = 3 * 60_000;
export const MAX_RUNTIME_MS = 90 * 60_000;

export type RunStore = Required<Pick<LabStore, 'getRun' | 'listRuns' | 'heartbeat' | 'failIfRunning' | 'createRun'>>;

export interface CycleWorkerData { runId: string; year: number; skipSync: boolean; selfTest?: boolean }
export type WorkerMessage = { type: 'progress'; progress: CycleProgress } | { type: 'done'; status: string } | { type: 'fatal'; error: string };

/** The parts of worker_threads.Worker the job uses (a fake in tests). */
export interface JobWorker {
  on(event: 'message', cb: (m: WorkerMessage) => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  on(event: 'exit', cb: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export function createCycleWorker(data: CycleWorkerData): JobWorker {
  // Same extension as this module: .js in the build, .ts under tsx (the worker inherits the parent's execArgv, i.e. the tsx loader).
  const file = path.join(__dirname, `cycleWorker${path.extname(__filename)}`);
  return new Worker(file, { workerData: data }) as unknown as JobWorker;
}

export interface JobOptions {
  store: RunStore;
  createWorker?: (data: CycleWorkerData) => JobWorker;
  now?: () => Date;
  heartbeatMs?: number;
  maxRuntimeMs?: number;
  onFinished?: (outcome: { runId: string; status: string; error?: string }) => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Starts the job and returns at once. Never throws for job failures — they are recorded on the run. */
export function startCycleJob(opts: JobOptions, data: CycleWorkerData): { stop: () => Promise<void> } {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().getTime();
  let progress: CycleProgress | null = null;
  let finished = false;
  let workerError: string | null = null;

  const worker = (opts.createWorker ?? createCycleWorker)(data);

  const beat = () => {
    if (finished) return;
    opts.store.heartbeat(data.runId, { heartbeatAt: now().toISOString(), progress, job: 'worker-thread' }).catch(() => { /* next beat retries; staleness covers a lasting outage */ });
  };
  beat();
  const hb = setInterval(beat, opts.heartbeatMs ?? HEARTBEAT_MS);
  hb.unref?.();

  const fail = async (error: string) => {
    if (finished) return;
    finished = true;
    clearInterval(hb);
    clearTimeout(timer);
    try { await opts.store.failIfRunning(data.runId, { finished_at: now().toISOString(), summary: { heartbeatAt: now().toISOString(), progress, job: 'worker-thread' }, error }); } catch { /* the stale sweep will mark it */ }
    opts.onFinished?.({ runId: data.runId, status: 'failed', error });
  };

  const maxMs = opts.maxRuntimeMs ?? MAX_RUNTIME_MS;
  const timer = setTimeout(() => {
    void fail(`timed out: still running after ${Math.round(maxMs / 60_000)} min — worker stopped; snapshots already inserted are kept, re-run to resume`);
    void worker.terminate();
  }, maxMs);
  timer.unref?.();

  worker.on('message', (m: WorkerMessage) => {
    if (m.type === 'progress') progress = m.progress;
    else if (m.type === 'fatal') workerError = m.error;
    else if (m.type === 'done') {
      // The worker recorded the final status itself (finishRun).
      finished = true;
      clearInterval(hb);
      clearTimeout(timer);
      opts.onFinished?.({ runId: data.runId, status: m.status });
      void worker.terminate();
    }
  });
  worker.on('error', (e: Error) => { workerError = errText(e); });
  worker.on('exit', (code: number) => {
    if (!finished) void fail(`worker exited (code ${code}) before finishing${workerError ? `: ${workerError}` : ''}; snapshots already inserted are kept, re-run to resume`);
  });

  return { stop: async () => { await fail('stopped'); await worker.terminate(); } };
}

/** Runs marked running whose last heartbeat (or start, if none) is older than staleAfterMs. Pure. */
export function staleRuns(runs: LabRun[], now: Date, staleAfterMs = STALE_AFTER_MS): LabRun[] {
  return runs.filter((r) => {
    if (r.status !== 'running') return false;
    const hb = typeof r.summary?.heartbeatAt === 'string' ? Date.parse(r.summary.heartbeatAt as string) : NaN;
    const last = Number.isFinite(hb) ? hb : Date.parse(r.started_at);
    return now.getTime() - last > staleAfterMs;
  });
}

/** Marks abandoned runs failed (process restart, crash, redeploy). Returns the ids it changed. */
export async function sweepStaleRuns(store: RunStore, now: Date = new Date(), staleAfterMs = STALE_AFTER_MS): Promise<string[]> {
  const running = await store.listRuns({ status: 'running', limit: 50 });
  const changed: string[] = [];
  for (const r of staleRuns(running, now, staleAfterMs)) {
    const last = (r.summary?.heartbeatAt as string | undefined) ?? r.started_at;
    const ok = await store.failIfRunning(r.id, {
      finished_at: now.toISOString(),
      summary: { ...(r.summary ?? {}), abandonedAt: now.toISOString() },
      error: `abandoned: no heartbeat since ${last} (server restart, crash, redeploy or timeout); snapshots already inserted are kept, re-run the cycle to resume`,
    });
    if (ok) changed.push(r.id);
  }
  return changed;
}

/** A run that is genuinely in progress (running with a fresh heartbeat), if any. */
export async function activeRun(store: RunStore, now: Date = new Date(), staleAfterMs = STALE_AFTER_MS): Promise<LabRun | null> {
  await sweepStaleRuns(store, now, staleAfterMs);
  const running = await store.listRuns({ status: 'running', limit: 5 });
  return running[0] ?? null;
}
