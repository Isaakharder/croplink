// One Forecast Lab cycle: (optionally) sync GrowLink, then issue immutable
// snapshots — a LIVE forecast as of the latest survey week, and (once)
// clearly-labelled HINDCASTS for earlier weeks reconstructed from data known
// at each of those weeks. Scoring is computed on read from stored snapshots,
// so nothing here ever rewrites an issued forecast or promotes a model.
import { StatusEvent } from '../harvestForecast';
import { isoWeekIndex, fromIsoWeekIndex, isoWeekOfDate } from '../isoWeek';
import { buildLabForecasts, LAB_MODELS } from './engine';
import { toSnapshotRows } from './evaluation';
import type { LabStore, SourceData, VarietyRecord } from './repository';

/** Hindcasts are backfilled at most this many weeks before the live as-of week. */
export const HINDCAST_WINDOW_WEEKS = 16;
/** …and not before this many weeks after tracking starts (no history to learn from). */
export const HINDCAST_MIN_HISTORY_WEEKS = 8;

/** Latest survey week (ISO index) not after the current ISO week, using only statuses entered by `now`. */
export function latestSurveyIndex(events: StatusEvent[], now: Date): number | null {
  const nowW = isoWeekOfDate(now);
  const nowIdx = isoWeekIndex(nowW.year, nowW.week);
  let best: number | null = null;
  for (const e of events) {
    const i = isoWeekIndex(e.year, e.week);
    if (i <= nowIdx && Date.parse(e.createdAt) <= now.getTime() && (best == null || i > best)) best = i;
  }
  return best;
}

export interface CycleDeps {
  store: LabStore;
  varieties: (year: number) => Promise<VarietyRecord[]>;
  load: (variety: VarietyRecord, year: number) => Promise<SourceData>;
  now: () => Date;
  newId: () => string;
  codeVersion: string | null;
  sync?: () => Promise<unknown>;
  draws?: number;
}

export interface CycleSummary {
  runId: string | null;
  status: 'succeeded' | 'partial' | 'failed' | 'unavailable';
  sync: unknown;
  varieties: { varietyId: string; name: string; asOf: string | null; liveInserted: number; hindcastInserted: number; hindcastWeeks: number; skipped?: string; error?: string }[];
}

export async function runForecastLabCycle(deps: CycleDeps, year: number): Promise<CycleSummary> {
  if (!(await deps.store.available())) return { runId: null, status: 'unavailable', sync: null, varieties: [] };
  const runId = deps.newId();
  const startedAt = deps.now().toISOString();
  await deps.store.createRun({ id: runId, kind: 'cycle', started_at: startedAt, code_version: deps.codeVersion });
  const summary: CycleSummary = { runId, status: 'succeeded', sync: null, varieties: [] };
  try {
    if (deps.sync) {
      try { summary.sync = await deps.sync(); } catch (e) { summary.sync = { error: e instanceof Error ? e.message : String(e) }; summary.status = 'partial'; }
    }
    for (const v of await deps.varieties(year)) {
      const entry: CycleSummary['varieties'][number] = { varietyId: v.id, name: v.name, asOf: null, liveInserted: 0, hindcastInserted: 0, hindcastWeeks: 0 };
      summary.varieties.push(entry);
      try {
        const src = await deps.load(v, year);
        const now = deps.now();
        const asOfIndex = latestSurveyIndex(src.inputs.events, now);
        if (asOfIndex == null) { entry.skipped = 'no survey data'; continue; }
        const asOf = fromIsoWeekIndex(asOfIndex);
        entry.asOf = `${asOf.year}-W${asOf.week}`;
        const issuedAt = now.toISOString();
        // Live: AFW forecasts entered up to the issue time apply. Hindcasts
        // (below) keep the default — only what was entered by their cutoff.
        const live = buildLabForecasts(src.inputs, asOf, { now, draws: deps.draws, afwKnownBy: now });
        entry.liveInserted = await deps.store.insertSnapshots(live.flatMap((fc) => toSnapshotRows(fc, { runId, kind: 'live', varietyId: v.id, issuedAt, codeVersion: deps.codeVersion })));

        const have = await deps.store.snapshotAsOfIndexes(v.id, 'hindcast');
        const firstSurvey = Math.min(...src.inputs.events.map((e) => isoWeekIndex(e.year, e.week)));
        const from = Math.max(firstSurvey + HINDCAST_MIN_HISTORY_WEEKS, asOfIndex - HINDCAST_WINDOW_WEEKS);
        const versions = Object.values(LAB_MODELS).map((m) => m.version);
        for (let t = from; t < asOfIndex; t++) {
          if (versions.every((ver) => have.has(`${ver}:${t}`))) continue;
          const fcs = buildLabForecasts(src.inputs, fromIsoWeekIndex(t), { now, draws: deps.draws });
          entry.hindcastInserted += await deps.store.insertSnapshots(fcs.flatMap((fc) => toSnapshotRows(fc, { runId, kind: 'hindcast', varietyId: v.id, issuedAt, codeVersion: deps.codeVersion })));
          entry.hindcastWeeks++;
        }
      } catch (e) {
        entry.error = e instanceof Error ? e.message : String(e);
        summary.status = 'partial';
      }
    }
    if (summary.varieties.length && summary.varieties.every((v) => v.error)) summary.status = 'failed';
    await deps.store.finishRun(runId, { status: summary.status, finished_at: deps.now().toISOString(), summary, error: null });
    return summary;
  } catch (e) {
    summary.status = 'failed';
    await deps.store.finishRun(runId, { status: 'failed', finished_at: deps.now().toISOString(), summary, error: e instanceof Error ? e.message : String(e) });
    return summary;
  }
}
