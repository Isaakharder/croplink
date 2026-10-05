/**
 * Forecast Lab cycle as a background job: prompt 202, observable status,
 * heartbeats with progress, failure on worker crash/exit/timeout, recovery of
 * runs abandoned by a restart (stale heartbeat), no overwrite of finished
 * runs, and a real worker thread loading the cycle's module graph.
 *
 * Run with: npx tsx src/__tests__/forecast-lab-job.test.ts
 * (the compiled-worker check runs when server/dist exists: npm run build first)
 */
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import path from 'path';
import { AddressInfo } from 'net';
import { Worker } from 'worker_threads';
import { staleRuns, sweepStaleRuns, startCycleJob, createCycleWorker, JobWorker, WorkerMessage, RunStore, CycleWorkerData } from '../lib/forecastLab/cycleJob';
import { runForecastLabCycle, CycleProgress } from '../lib/forecastLab/cycle';
import type { LabRun, LabStore, SourceData, VarietyRecord } from '../lib/forecastLab/repository';

let pass = 0;
let fail = 0;
function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); fail++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In-memory run table with the same guards as the Supabase store (heartbeat/fail only while running). */
function memStore() {
  const runs = new Map<string, LabRun>();
  const store: RunStore & { runs: Map<string, LabRun> } = {
    runs,
    createRun: async (r) => { runs.set(r.id, { ...r, status: 'running', finished_at: null, summary: {}, error: null }); },
    getRun: async (id) => runs.get(id) ?? null,
    listRuns: async ({ status, limit }) => [...runs.values()].filter((r) => !status || r.status === status).sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit),
    heartbeat: async (id, summary) => { const r = runs.get(id); if (r && r.status === 'running') r.summary = summary; },
    failIfRunning: async (id, p) => { const r = runs.get(id); if (!r || r.status !== 'running') return false; Object.assign(r, p, { status: 'failed' }); return true; },
  };
  return store;
}
class FakeWorker extends EventEmitter implements JobWorker {
  terminated = false;
  async terminate() { this.terminated = true; return 0; }
  send(m: WorkerMessage) { this.emit('message', m); }
}
const prog = (p: Partial<CycleProgress>): CycleProgress => ({ phase: 'hindcast', variety: 'Mathieu', hindcastWeeksDone: 0, hindcastWeeksTotal: 16, varietiesDone: 0, varietiesTotal: 1, ...p });

(async () => {
  console.log('staleness');
  {
    const now = new Date('2026-10-05T12:00:00Z');
    const r = (id: string, status: LabRun['status'], started: string, hb?: string): LabRun => ({ id, kind: 'cycle', status, started_at: started, finished_at: null, code_version: null, summary: hb ? { heartbeatAt: hb } : {}, error: null });
    const runs = [
      r('fresh', 'running', '2026-10-05T11:00:00Z', '2026-10-05T11:59:00Z'),
      r('stale-hb', 'running', '2026-10-05T11:00:00Z', '2026-10-05T11:50:00Z'),
      r('never-beat', 'running', '2026-10-05T11:30:00Z'),
      r('done', 'succeeded', '2026-10-05T09:00:00Z', '2026-10-05T09:10:00Z'),
    ];
    assert('stale = running with no heartbeat for > 3 min (or none since start); finished runs never stale', staleRuns(runs, now).map((x) => x.id), ['stale-hb', 'never-beat']);
    const store = memStore();
    for (const x of runs) store.runs.set(x.id, x);
    const changed = await sweepStaleRuns(store, now);
    assert('sweep marks only the abandoned runs failed', [[...changed].sort(), store.runs.get('fresh')!.status, store.runs.get('done')!.status], [['never-beat', 'stale-hb'], 'running', 'succeeded']);
    assert('…with an explanation and keeps the last progress', [store.runs.get('stale-hb')!.error!.startsWith('abandoned: no heartbeat since 2026-10-05T11:50:00Z'), (store.runs.get('stale-hb')!.summary as Record<string, unknown>).heartbeatAt], [true, '2026-10-05T11:50:00Z']);
    assert('sweeping again changes nothing', await sweepStaleRuns(store, now), []);
  }

  console.log('job: heartbeat, progress, done');
  {
    const store = memStore();
    await store.createRun({ id: 'r1', kind: 'cycle', started_at: new Date().toISOString(), code_version: null });
    const w = new FakeWorker();
    const outcomes: unknown[] = [];
    startCycleJob({ store, createWorker: () => w, heartbeatMs: 15, onFinished: (o) => outcomes.push(o) }, { runId: 'r1', year: 2026, skipSync: true });
    assert('a heartbeat is written as soon as the job starts', typeof (store.runs.get('r1')!.summary as Record<string, unknown>).heartbeatAt, 'string');
    w.send({ type: 'progress', progress: prog({ hindcastWeeksDone: 5 }) });
    await sleep(40);
    assert('heartbeats carry the worker\'s latest progress', ((store.runs.get('r1')!.summary as Record<string, unknown>).progress as CycleProgress).hindcastWeeksDone, 5);
    store.runs.get('r1')!.status = 'succeeded'; // what runForecastLabCycle's finishRun does inside the worker
    store.runs.get('r1')!.summary = { final: true };
    w.send({ type: 'done', status: 'succeeded' });
    await sleep(40);
    w.emit('exit', 0);
    await sleep(5);
    assert('done: worker stopped, outcome reported, finished run never overwritten by a late heartbeat or exit', [w.terminated, outcomes, store.runs.get('r1')!.status, store.runs.get('r1')!.summary], [true, [{ runId: 'r1', status: 'succeeded' }], 'succeeded', { final: true }]);
  }

  console.log('job: worker failure and timeout');
  {
    const store = memStore();
    await store.createRun({ id: 'r2', kind: 'cycle', started_at: new Date().toISOString(), code_version: null });
    const w = new FakeWorker();
    startCycleJob({ store, createWorker: () => w, heartbeatMs: 1000 }, { runId: 'r2', year: 2026, skipSync: true });
    w.send({ type: 'progress', progress: prog({ hindcastWeeksDone: 3 }) });
    w.send({ type: 'fatal', error: 'out of memory' });
    w.emit('exit', 1);
    await sleep(10);
    const r2 = store.runs.get('r2')!;
    assert('worker exits before finishing → run failed at once with the reason and last progress', [r2.status, r2.error!.startsWith('worker exited (code 1) before finishing: out of memory'), ((r2.summary as Record<string, unknown>).progress as CycleProgress).hindcastWeeksDone], ['failed', true, 3]);

    await store.createRun({ id: 'r3', kind: 'cycle', started_at: new Date().toISOString(), code_version: null });
    const w3 = new FakeWorker();
    startCycleJob({ store, createWorker: () => w3, heartbeatMs: 1000, maxRuntimeMs: 30 }, { runId: 'r3', year: 2026, skipSync: true });
    await sleep(60);
    assert('exceeds the maximum runtime → worker terminated, run failed (timed out)', [w3.terminated, store.runs.get('r3')!.status, store.runs.get('r3')!.error!.startsWith('timed out')], [true, 'failed', true]);
  }

  console.log('cycle: uses the pre-created run and reports progress');
  {
    const created: string[] = [];
    const finished: { id: string; status: string }[] = [];
    const store = {
      available: async () => true, createRun: async (r: { id: string }) => { created.push(r.id); }, finishRun: async (id: string, p: { status: string }) => { finished.push({ id, status: p.status }); },
      insertSnapshots: async () => 0, snapshotAsOfIndexes: async () => new Set<string>(), listSnapshots: async () => [], listExclusions: async () => [], configHistory: async () => [],
    } as unknown as LabStore;
    const phases: string[] = [];
    await runForecastLabCycle({
      store, varieties: async () => [{ id: 'v1', name: 'Mathieu' } as VarietyRecord], load: async () => ({ inputs: { events: [] } } as unknown as SourceData),
      now: () => new Date('2026-10-05T12:00:00Z'), newId: () => 'unused', codeVersion: null, runId: 'pre-created', onProgress: (p) => phases.push(p.phase),
    }, 2026);
    assert('no second run row; final status written to the pre-created run', [created, finished], [[], [{ id: 'pre-created', status: 'succeeded' }]]);
    assert('progress reported through to done', [phases[0], phases.at(-1)], ['live', 'done']);
  }

  console.log('API: POST /cycle starts the job and returns at once; status is observable');
  {
    process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy';
    process.env.INTERNAL_OPS_KEY = 'ops-key-for-tests-only';
    const express = (await import('express')).default;
    const { createForecastLabRouter } = await import('../routes/forecastLab');
    const runStore = memStore();
    const started: CycleWorkerData[] = [];
    const labStore = { available: async () => true } as unknown as LabStore;
    const app = express();
    app.use(express.json());
    app.use('/api/forecast-lab', createForecastLabRouter(labStore, { runStore, startJob: (d) => { started.push(d); } }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/forecast-lab`;
    const start = (key = 'ops-key-for-tests-only') => fetch(`${base}/cycle`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Ops-Key': key }, body: JSON.stringify({ year: 2026, skipSync: true }) });
    try {
      assert('without the ops key → 401, nothing started', [(await start('wrong')).status, started.length], [401, 0]);
      const t0 = Date.now();
      const r = await start();
      const body = (await r.json()) as { runId: string; status: string; statusUrl: string };
      assert('202 within a second, with the run id and status URL; job started for that run', [r.status, Date.now() - t0 < 1000, body.status, body.statusUrl === `/api/forecast-lab/runs/${body.runId}`, started.map((d) => d.runId)], [202, true, 'running', true, [body.runId]]);
      const again = await start();
      assert('a second start while one is running → 409 pointing at the running run', [again.status, ((await again.json()) as { runId: string }).runId], [409, body.runId]);
      await runStore.heartbeat(body.runId, { heartbeatAt: new Date().toISOString(), progress: prog({ hindcastWeeksDone: 7 }) });
      const st = (await (await fetch(`${base}/runs/${body.runId}`)).json()) as { status: string; progress: CycleProgress; secondsSinceHeartbeat: number };
      assert('GET /runs/:id shows running, progress and heartbeat age', [st.status, st.progress.hindcastWeeksDone, st.secondsSinceHeartbeat <= 1], ['running', 7, true]);
      runStore.runs.get(body.runId)!.summary = { heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() }; // process died 10 min ago
      const st2 = (await (await fetch(`${base}/runs/${body.runId}`)).json()) as { status: string; error: string };
      assert('heartbeat stopped (restart/crash) → the status read marks it failed (abandoned)', [st2.status, st2.error.startsWith('abandoned')], ['failed', true]);
      assert('…and a new cycle can start', (await start()).status, 202);
      const list = (await (await fetch(`${base}/runs`)).json()) as { runs: { status: string }[] };
      assert('GET /runs lists recent runs, newest first', list.runs.map((x) => x.status), ['running', 'failed']);
    } finally { server.close(); }
  }

  console.log('real worker thread loads the cycle module graph');
  {
    const selfTest = (w: Worker | JobWorker) => new Promise<string>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 30_000);
      w.on('message', (m: WorkerMessage) => { if (m.type === 'done') { clearTimeout(t); resolve(m.status); } if (m.type === 'fatal') { clearTimeout(t); resolve(`fatal: ${m.error}`); } });
      w.on('error', (e: Error) => { clearTimeout(t); resolve(`error: ${e.message}`); });
    });
    const tsWorker = createCycleWorker({ runId: 'self-test', year: 2026, skipSync: true, selfTest: true });
    assert('under tsx (.ts worker)', await selfTest(tsWorker), 'self-test');
    await tsWorker.terminate();
    const compiled = path.resolve(__dirname, '../../dist/lib/forecastLab/cycleWorker.js');
    if (existsSync(compiled)) {
      const jsWorker = new Worker(compiled, { workerData: { runId: 'self-test', year: 2026, skipSync: true, selfTest: true }, execArgv: [] });
      assert('compiled build (dist/…/cycleWorker.js, plain node)', await selfTest(jsWorker), 'self-test');
      await jsWorker.terminate();
    } else console.log('  (dist not built — compiled-worker check skipped)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
