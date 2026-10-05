// Forecast Lab API. Read endpoints are public like the rest of CropLink's
// read API (no secrets or key material are ever included); the cycle that
// issues snapshots and runs the GrowLink sync requires X-Internal-Ops-Key.
import { randomUUID } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { internalOpsAuth } from '../middleware/internalOpsAuth';
import { isoWeekIndex, fromIsoWeekIndex, isoWeekOfDate, greenhouseIsoWeek } from '../lib/isoWeek';
import { buildLabForecasts, LabForecast, LAB_MODELS } from '../lib/forecastLab/engine';
import { resolveActuals, scoreSnapshots, seasonStage, RECOMMENDATION_CRITERIA, ActualWeek } from '../lib/forecastLab/evaluation';
import { assembleView } from '../lib/forecastLab/view';
import { latestSurveyIndex } from '../lib/forecastLab/cycle';
import { startCycleJob, sweepStaleRuns, activeRun, RunStore, CycleWorkerData } from '../lib/forecastLab/cycleJob';
import { activeVarietiesForYear, loadSourceData, loadActualRows, supabaseLabStore, LabStore, LabRun, VarietyRecord } from '../lib/forecastLab/repository';

const CACHE_MS = 10 * 60 * 1000;
const currentCache = new Map<string, { at: number; value: LabForecast[] }>();
const codeVersion = () => process.env.RAILWAY_GIT_COMMIT_SHA ?? null;

function stageFor(variety: VarietyRecord, actuals: Map<number, ActualWeek>) {
  const harvested = [...actuals.values()].filter((a) => (a.kg ?? 0) > 0).map((a) => a.index);
  const first = harvested.length ? Math.min(...harvested) : null;
  let pull: number | null = null;
  if (variety.pull_out_date) { const w = isoWeekOfDate(new Date(`${variety.pull_out_date}T12:00:00Z`)); pull = isoWeekIndex(w.year, w.week); }
  return (index: number) => seasonStage(index, first, pull);
}

function describeRun(r: LabRun) {
  const hb = typeof r.summary?.heartbeatAt === 'string' ? (r.summary.heartbeatAt as string) : null;
  return {
    id: r.id, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at, codeVersion: r.code_version, error: r.error,
    heartbeatAt: hb, secondsSinceHeartbeat: hb ? Math.round((Date.now() - Date.parse(hb)) / 1000) : null,
    progress: r.summary?.progress ?? null, summary: r.status === 'running' ? null : r.summary,
  };
}

export interface ForecastLabRouterOptions {
  runStore?: RunStore;
  /** Starts the background job. Defaults to a worker-thread job. */
  startJob?: (data: CycleWorkerData) => void;
}

export function createForecastLabRouter(store: LabStore = supabaseLabStore, opts: ForecastLabRouterOptions = {}): Router {
  const router = Router();
  const runStore = opts.runStore ?? (store as RunStore);
  const startJob = opts.startJob ?? ((data: CycleWorkerData) => { startCycleJob({ store: runStore, onFinished: () => currentCache.clear() }, data); });

  router.get('/view', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const year = Number(req.query.year);
      const varietyId = String(req.query.varietyId ?? '');
      const horizon = Math.min(4, Math.max(1, Number(req.query.horizon ?? 1) || 1));
      if (!Number.isInteger(year) || !varietyId) return res.status(400).json({ error: 'year and varietyId are required' });
      const variety = (await activeVarietiesForYear(year)).find((v) => v.id === varietyId);
      if (!variety) return res.status(404).json({ error: 'Active variety not found for that year' });

      const now = new Date();
      const src = await loadSourceData(variety, year);
      const actuals = resolveActuals(src.v2Actuals, src.v1Actuals, now);
      const asOfIndex = latestSurveyIndex(src.inputs.events, now);
      if (asOfIndex == null) return res.json({ variety: { id: variety.id, name: variety.name }, weeks: [], warnings: ['No survey data for this variety yet.'] });

      // A saved AFW forecast changes the stamp, so projections recompute immediately.
      const manualStamp = (src.inputs.manualAfw ?? []).reduce((m, e) => Math.max(m, e.id), 0);
      const stamp = [asOfIndex, src.inputs.events.length, src.inputs.afw.length, src.inputs.afw.map((a) => a.knownAt).sort().at(-1), src.lastV1Sync, variety.updated_at, manualStamp].join('|');
      const key = `${varietyId}|${stamp}`;
      let current = currentCache.get(key);
      if (!current || Date.now() - current.at > CACHE_MS) {
        current = { at: Date.now(), value: buildLabForecasts(src.inputs, fromIsoWeekIndex(asOfIndex), { now, afwKnownBy: now }) };
        currentCache.set(key, current);
      }
      const snapshotsEnabled = await store.available();
      const snapshots = snapshotsEnabled ? await store.listSnapshots([varietyId]) : [];
      const history = snapshotsEnabled ? await store.configHistory(varietyId) : [];

      const actualIdx = [...actuals.values()].filter((a) => (a.kg ?? 0) > 0).map((a) => a.index);
      const legacyIdx = [...src.inputs.legacyByIndex].filter(([, v]) => v.kg > 0).map(([i]) => i);
      const fromIndex = Math.min(...actualIdx, ...legacyIdx, asOfIndex);
      const weeks = assembleView({ asOfIndex, horizon, fromIndex, current: current.value, snapshots, actuals, legacyByIndex: src.inputs.legacyByIndex });

      const d = current.value.find((c) => c.modelId === 'open-fruit-d')!;
      const latestEntered = src.inputs.events.reduce((m, e) => (e.createdAt > m ? e.createdAt : m), '');
      const settledIdx = [...actuals.values()].filter((a) => a.settlement === 'settled' && a.kg != null).map((a) => a.index);
      const warnings: string[] = [];
      if (!src.growlinkVarietyKey) warnings.push('This variety is not linked to a GrowLink variety — no GrowLink AFW or actuals.');
      else if (!src.v2Available) warnings.push('GrowLink v2 yield detail is not available yet (migration or first sync pending) — AFW falls back to CropLink manual values and settlement uses the 10-day rule.');
      else if (!src.lastV2Sync) warnings.push('GrowLink v2 has never been synced.');
      else if (src.lastV2Sync.status !== 'succeeded') warnings.push(`Last GrowLink v2 sync ${src.lastV2Sync.status}.`);
      const futureWeeks = weeks.filter((w) => !w.past);
      const noLegacy = futureWeeks.filter((w) => !(w.legacyKg && w.legacyKg > 0));
      if (futureWeeks.length && noLegacy.length) {
        const lastLegacy = [...src.inputs.legacyByIndex].filter(([, x]) => x.kg > 0).map(([i]) => i).sort((a, b) => a - b).at(-1);
        warnings.push(`Legacy projection has no forecast for ${noLegacy.map((w) => `W${w.week}`).join(', ')}${lastLegacy != null ? ` (its last projected week is W${fromIsoWeekIndex(lastLegacy).week})` : ''} — the 0 shown there means "no legacy projection", not a prediction of zero.`);
      }
      if (!src.afwForecastsAvailable) warnings.push('AFW forecasts are not enabled yet (database migration pending).');
      if (snapshotsEnabled) {
        const liveTargets = new Set(snapshots.filter((x) => x.kind === 'live' && x.experimental).map((x) => x.target_index));
        const pastWithActual = weeks.filter((w) => w.past && w.actual?.kg != null);
        const unlocked = pastWithActual.filter((w) => !liveTargets.has(w.index));
        if (pastWithActual.length && unlocked.length === pastWithActual.length) warnings.push('No forecast issued at the time (locked live snapshot) exists for any past week yet — past-week comparisons are hindcasts reconstructed from data known then, not evidence of live accuracy.');
        else if (unlocked.length) warnings.push(`${unlocked.length} past week(s) have no locked live forecast; they show hindcasts only.`);
      }
      if (!snapshotsEnabled) warnings.push('Forecast snapshots are not enabled yet (database migration pending) — experimental forecasts below are computed live and are not locked or scored.');
      for (const w of new Set([...(d.warnings ?? [])].filter((x) => /^(afw|measurements|no-afw|forecast-old)/.test(x)))) warnings.push(w);
      const provisional = weeks.filter((w) => w.actual && w.actual.settlement === 'provisional').map((w) => w.label);
      if (provisional.length) warnings.push(`GrowLink weeks not settled yet (may still change): ${provisional.join(', ')}`);
      if (variety.updated_at) warnings.push(`Variety configuration (area/stems) last changed ${variety.updated_at.slice(0, 10)}; earlier values are not recorded${history.length ? '' : ' (configuration history not enabled yet)'}.`);

      res.json({
        experimental: true,
        variety: { id: variety.id, name: variety.name, areaM2: src.inputs.variety.areaM2, totalStems: src.inputs.variety.totalStems, plantCount: src.inputs.variety.plantCount, pullOutDate: src.inputs.variety.pullOutDate, configUpdatedAt: variety.updated_at },
        asOf: { index: asOfIndex, label: `W${fromIsoWeekIndex(asOfIndex).week} ${fromIsoWeekIndex(asOfIndex).year}` },
        horizon,
        models: Object.values(LAB_MODELS),
        current: current.value.map(({ targets: _t, ...meta }) => meta),
        freshness: {
          latestSurveyWeek: `W${fromIsoWeekIndex(asOfIndex).week}`,
          latestSurveyEnteredAt: latestEntered || null,
          lastGrowlinkV1Sync: src.lastV1Sync,
          lastGrowlinkV2Sync: src.lastV2Sync,
          latestActualWeek: actualIdx.length ? `W${fromIsoWeekIndex(Math.max(...actualIdx)).week}` : null,
          latestSettledWeek: settledIdx.length ? `W${fromIsoWeekIndex(Math.max(...settledIdx)).week}` : null,
          afw: d.afw ? { grams: d.afw.grams, source: d.afw.source, week: `W${fromIsoWeekIndex(d.afw.asOfIndex).week}`, ageWeeks: d.afw.ageWeeks } : null,
          snapshotsEnabled,
          growlinkV2Available: src.v2Available,
          afwForecastsAvailable: src.afwForecastsAvailable,
        },
        configHistory: history,
        warnings,
        weeks,
      });
    } catch (e) { next(e); }
  });

  router.get('/metrics', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const year = Number(req.query.year);
      if (!Number.isInteger(year)) return res.status(400).json({ error: 'year is required' });
      if (!(await store.available())) return res.json({ snapshotsEnabled: false, reports: [], criteria: RECOMMENDATION_CRITERIA });
      const varieties = await activeVarietiesForYear(year);
      const snapshots = await store.listSnapshots(varieties.map((v) => v.id));
      const exclusions = await store.listExclusions(varieties.map((v) => v.id));
      const now = new Date();
      const actualsByVariety = new Map<string, Map<number, ActualWeek>>();
      const stages = new Map<string, (i: number) => ReturnType<typeof seasonStage>>();
      for (const v of varieties) {
        const rows = await loadActualRows(v.id);
        const a = resolveActuals(rows.v2, rows.v1, now);
        actualsByVariety.set(v.id, a);
        stages.set(v.id, stageFor(v, a));
      }
      const reports = scoreSnapshots(snapshots, actualsByVariety, exclusions, (vid, i) => stages.get(vid)?.(i) ?? 'main');
      res.json({ snapshotsEnabled: true, varieties: varieties.map((v) => ({ id: v.id, name: v.name })), criteria: RECOMMENDATION_CRITERIA, reports });
    } catch (e) { next(e); }
  });

  // Starts a cycle as a background job and returns at once (202). Progress and
  // the final status are on GET /runs/:id; abandoned runs are marked failed.
  router.post('/cycle', internalOpsAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await store.available())) return res.status(503).json({ status: 'unavailable', error: 'Forecast Lab tables are not available.' });
      const year = Number(req.body?.year ?? greenhouseIsoWeek(new Date()).year);
      if (!Number.isInteger(year)) return res.status(400).json({ error: 'year must be an integer' });
      const running = await activeRun(runStore);
      if (running) return res.status(409).json({ error: 'A Forecast Lab cycle is already running.', runId: running.id, statusUrl: `/api/forecast-lab/runs/${running.id}` });
      const runId = randomUUID();
      await runStore.createRun({ id: runId, kind: 'cycle', started_at: new Date().toISOString(), code_version: codeVersion() });
      startJob({ runId, year, skipSync: req.body?.skipSync === true });
      res.status(202).json({ runId, status: 'running', year, statusUrl: `/api/forecast-lab/runs/${runId}` });
    } catch (e) { next(e); }
  });

  router.get('/runs', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await store.available())) return res.json({ runs: [] });
      await sweepStaleRuns(runStore);
      res.json({ runs: (await runStore.listRuns({ limit: 10 })).map(describeRun) });
    } catch (e) { next(e); }
  });

  router.get('/runs/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid run id' });
      await sweepStaleRuns(runStore);
      const run = await runStore.getRun(id);
      if (!run) return res.status(404).json({ error: 'run not found' });
      res.json(describeRun(run));
    } catch (e) { next(e); }
  });

  return router;
}
