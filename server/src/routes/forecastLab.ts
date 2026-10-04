// Forecast Lab API. Read endpoints are public like the rest of CropLink's
// read API (no secrets or key material are ever included); the cycle that
// issues snapshots and runs the GrowLink sync requires X-Internal-Ops-Key.
import { randomUUID } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { internalOpsAuth } from '../middleware/internalOpsAuth';
import { isoWeekIndex, fromIsoWeekIndex, isoWeekOfDate } from '../lib/isoWeek';
import { buildLabForecasts, LabForecast, LAB_MODELS } from '../lib/forecastLab/engine';
import { resolveActuals, scoreSnapshots, seasonStage, RECOMMENDATION_CRITERIA, ActualWeek } from '../lib/forecastLab/evaluation';
import { assembleView } from '../lib/forecastLab/view';
import { runForecastLabCycle, latestSurveyIndex } from '../lib/forecastLab/cycle';
import { activeVarietiesForYear, loadSourceData, loadActualRows, supabaseLabStore, LabStore, VarietyRecord } from '../lib/forecastLab/repository';
import { createGrowlinkV2Client } from '../lib/growlinkV2Client';
import { runYieldWeekSync, runDeletionSync } from '../lib/growlinkYieldSyncRunner';
import { supabaseYieldWeekRepo } from '../lib/growlinkYieldRepo';
import { getConnectionRow } from './growlinkConnection';

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

export function createForecastLabRouter(store: LabStore = supabaseLabStore): Router {
  const router = Router();

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
      if (!src.afwForecastsAvailable) warnings.push('AFW forecasts are not enabled yet (database migration pending).');
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

  router.post('/cycle', internalOpsAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const year = Number(req.body?.year ?? isoWeekOfDate(new Date()).year);
      const key = process.env.GROWLINK_CROPLINK_KEY;
      const baseUrl = process.env.GROWLINK_BASE_URL || (await getConnectionRow())?.base_url;
      const sync = key && baseUrl && req.body?.skipSync !== true
        ? async () => {
            const deps = { client: createGrowlinkV2Client({ baseUrl, key }), repo: supabaseYieldWeekRepo, newId: randomUUID };
            return [await runYieldWeekSync(deps), await runDeletionSync(deps)].map((r) => ({ kind: r.kind, status: r.status, fetched: r.fetched, created: r.created, updated: r.updated, rejected: r.rejected, error: r.error }));
          }
        : undefined;
      const summary = await runForecastLabCycle({
        store, varieties: activeVarietiesForYear, load: loadSourceData, now: () => new Date(), newId: randomUUID, codeVersion: codeVersion(), sync,
      }, year);
      currentCache.clear();
      res.status(summary.status === 'succeeded' ? 200 : summary.status === 'unavailable' ? 503 : 207).json(summary);
    } catch (e) { next(e); }
  });

  return router;
}
