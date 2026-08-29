import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { internalOpsAuth } from '../middleware/internalOpsAuth';
import { rollupClimateReadingRange, RollupLockContentionError, loadZoneTopology } from '../lib/climateRollupService';
import { fetchAllRows } from '../lib/paginatedFetch';

const router = Router();

interface RollupJobRow {
  id: string;
  organization_id: string | null;
  source: string;
  source_import_id: string | null;
  source_batch_id: string | null;
  range_start: string;
  range_end: string;
  status: string;
  attempt_count: number;
}

// POST /api/climate/rollup-jobs/process — claims and processes up to `limit`
// pending jobs. Meant to be called by an external scheduler (cron / hosting
// platform's scheduled-task feature) on a short interval, e.g. every 1-5
// minutes -- this process does NOT run its own timer (see the module doc in
// climateRollupService.ts for why an in-process fire-and-forget/interval
// approach was deliberately avoided). Safe to call concurrently: job
// claiming uses `FOR UPDATE SKIP LOCKED` (claim_climate_rollup_jobs), so two
// overlapping invocations never process the same job twice.
router.post('/process', internalOpsAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Number(req.body?.limit) || 5, 25);

    const { data: claimed, error: claimError } = await supabase.rpc('claim_climate_rollup_jobs', { p_limit: limit });
    if (claimError) throw new Error(claimError.message);

    const jobs = (claimed ?? []) as RollupJobRow[];
    const results: { jobId: string; status: 'completed' | 'failed' | 'requeued'; error?: string; summary?: unknown }[] = [];

    for (const job of jobs) {
      try {
        const summary = await rollupClimateReadingRange(job.range_start, job.range_end, job.id);
        await supabase.from('climate_rollup_jobs').update({
          status: 'completed', completed_at: new Date().toISOString(), last_error: null,
        }).eq('id', job.id);
        results.push({ jobId: job.id, status: 'completed', summary });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof RollupLockContentionError) {
          // Expected and transient -- another job is currently writing an
          // overlapping range for the same phase. Back to 'pending' (not
          // 'failed') so the next /process call retries it automatically;
          // claim_climate_rollup_jobs only ever claims 'pending' jobs, so a
          // 'failed' status here would silently stall until an operator
          // intervened, for something that needs no intervention at all.
          await supabase.from('climate_rollup_jobs').update({
            status: 'pending', last_error: message,
          }).eq('id', job.id);
          results.push({ jobId: job.id, status: 'requeued', error: message });
          continue;
        }
        await supabase.from('climate_rollup_jobs').update({
          status: 'failed', last_error: message,
        }).eq('id', job.id);
        results.push({ jobId: job.id, status: 'failed', error: message });
      }
    }

    res.json({ claimed: jobs.length, results });
  } catch (e) {
    next(e);
  }
});

// GET /api/climate/rollup-jobs/status — internal diagnostics: raw-vs-derived
// watermarks and lag, pending/failed job counts, and current 7-day coverage
// by variety. Not org-scoped -- this is a whole-system operational view for
// staff/ops, not something exposed to a specific organization's own data.
router.get('/status', internalOpsAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [latestReading, latestPhaseHourly, latestVarietyHourly, latestFeature] = await Promise.all([
      supabase.from('climate_readings').select('measured_at').order('measured_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('phase_climate_hourly').select('measured_at').order('measured_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('variety_climate_hourly').select('measured_at').order('measured_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('variety_climate_hourly_features').select('measured_at').order('measured_at', { ascending: false }).limit(1).maybeSingle(),
    ]);

    const latestRawTs = latestReading.data?.measured_at ?? null;
    const latestVarietyHourlyTs = latestVarietyHourly.data?.measured_at ?? null;
    const lagHours = latestRawTs && latestVarietyHourlyTs
      ? Math.round((new Date(latestRawTs).getTime() - new Date(latestVarietyHourlyTs).getTime()) / 3600000)
      : null;

    const [{ count: pendingCount }, { count: failedCount }, { count: runningCount }] = await Promise.all([
      supabase.from('climate_rollup_jobs').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('climate_rollup_jobs').select('*', { count: 'exact', head: true }).eq('status', 'failed'),
      supabase.from('climate_rollup_jobs').select('*', { count: 'exact', head: true }).eq('status', 'running'),
    ]);

    const { data: recentFailures } = await supabase
      .from('climate_rollup_jobs')
      .select('id, source, range_start, range_end, attempt_count, last_error, updated_at')
      .eq('status', 'failed')
      .order('updated_at', { ascending: false })
      .limit(10);

    // 7-day coverage by variety, split into three tiers that should
    // reconcile after a healthy backfill (Round 10 preflight, Phase 6):
    //   raw:      does climate_readings have >=1 reading from a linked zone
    //             this hour at all? The ceiling everything else is bounded by.
    //   derived:  does variety_climate_hourly have a row (temporal_covered)?
    //             Can only be lower than raw if the rollup hasn't processed
    //             that hour yet -- the exact gap this round's redesign closes.
    //   feature:  does variety_climate_hourly_features have a row? This is
    //             what the Projections page's Climate Context card actually
    //             reads, so it's reported under the same name as before
    //             (`hoursObserved`/`coveragePct`) for backward compatibility.
    // A gap between derived and feature coverage that ISN'T raw/derived's own
    // gap points at a features-recompute problem specifically, not a rollup
    // problem -- worth being able to tell apart.
    const { data: varieties } = await supabase.from('varieties').select('id, name');
    const { varietyToZoneLabels } = await loadZoneTopology();
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
    const hoursExpected = 168;

    // Expected clock hours in the window -- the correct denominator (Round
    // 10 preflight finding: row-existence alone overstates coverage when
    // some expected hours have no row of any kind, not just partial zone
    // participation within a row that does exist).
    const expectedHourSet = new Set<number>();
    for (let t = sevenDaysAgo.getTime(); t < now.getTime(); t += 3600000) expectedHourSet.add(t);

    const coverageByVariety: {
      varietyId: string; varietyName: string;
      hoursExpected: number;
      rawHoursCovered: number; rawCoveragePct: number;
      derivedHoursCovered: number; derivedCoveragePct: number;
      hoursObserved: number; coveragePct: number; // feature tier, kept under its original name for backward compatibility
    }[] = [];
    for (const v of varieties ?? []) {
      const zoneLabels = varietyToZoneLabels.get(v.id) ?? [];
      let rawHoursCovered = 0;
      if (zoneLabels.length > 0) {
        const rawRows = await fetchAllRows<{ measured_at: string }>(() =>
          supabase.from('climate_readings').select('measured_at').in('zone_label', zoneLabels).gte('measured_at', sevenDaysAgo.toISOString()).lt('measured_at', now.toISOString())
        );
        const rawHourSet = new Set(rawRows.map((r) => new Date(r.measured_at).getTime()));
        rawHoursCovered = Array.from(rawHourSet).filter((ms) => expectedHourSet.has(ms)).length;
      }

      const { count: derivedCount } = await supabase
        .from('variety_climate_hourly')
        .select('*', { count: 'exact', head: true })
        .eq('variety_id', v.id)
        .eq('temporal_covered', true)
        .gte('measured_at', sevenDaysAgo.toISOString())
        .lt('measured_at', now.toISOString());

      const { count: featureCount } = await supabase
        .from('variety_climate_hourly_features')
        .select('*', { count: 'exact', head: true })
        .eq('variety_id', v.id)
        .gte('measured_at', sevenDaysAgo.toISOString())
        .lt('measured_at', now.toISOString());

      const derivedHoursCovered = derivedCount ?? 0;
      const hoursObserved = featureCount ?? 0;
      coverageByVariety.push({
        varietyId: v.id, varietyName: v.name, hoursExpected,
        rawHoursCovered, rawCoveragePct: Math.round((rawHoursCovered / hoursExpected) * 10000) / 100,
        derivedHoursCovered, derivedCoveragePct: Math.round((derivedHoursCovered / hoursExpected) * 10000) / 100,
        hoursObserved, coveragePct: Math.round((hoursObserved / hoursExpected) * 10000) / 100,
      });
    }

    // Zone mapping missing: a variety with zero linked zones can never get
    // any climate data, however healthy the rest of the pipeline is.
    const { data: varietyZoneLinks } = await supabase.from('variety_zones').select('variety_id');
    const linkedVarietyIds = new Set((varietyZoneLinks ?? []).map((r) => r.variety_id));
    const unmappedVarieties = (varieties ?? []).filter((v) => !linkedVarietyIds.has(v.id)).map((v) => v.name);

    // Radiation-reset anomaly: a 'negative_reset' flag is the EXPECTED shape
    // of one daily counter reset per phase -- more resets than days elapsed
    // in the window means something is resetting more often than once a
    // day, which is the "implausible negative delta beyond a recognised
    // reset" case Phase 5 asked to catch (the flag itself doesn't distinguish
    // "expected daily reset" from "the counter is flapping").
    const { data: phases } = await supabase.from('phases').select('id, name');
    const radiationResetAnomalies: { phaseId: string; phaseName: string; resetCount: number; daysInWindow: number }[] = [];
    for (const p of phases ?? []) {
      const { count: resetCount } = await supabase
        .from('phase_climate_hourly')
        .select('*', { count: 'exact', head: true })
        .eq('phase_id', p.id)
        .eq('radiation_quality_flag', 'negative_reset')
        .gte('measured_at', sevenDaysAgo.toISOString())
        .lt('measured_at', now.toISOString());
      const daysInWindow = 7;
      if ((resetCount ?? 0) > daysInWindow) {
        radiationResetAnomalies.push({ phaseId: p.id, phaseName: p.name, resetCount: resetCount ?? 0, daysInWindow });
      }
    }

    const RAW_STALE_HOURS = 3; // agent posts roughly hourly; 3 missed cycles is a real gap, not noise
    const ROLLUP_LAG_HOURS = 6; // worker is meant to run every few minutes; hours of lag means it isn't running
    const LOW_COVERAGE_PCT = 80;

    const rawStaleHours = latestRawTs ? Math.round((now.getTime() - new Date(latestRawTs).getTime()) / 3600000) : null;
    const lowCoverageVarieties = coverageByVariety.filter((v) => v.coveragePct < LOW_COVERAGE_PCT);

    const alerts: string[] = [];
    if (rawStaleHours != null && rawStaleHours > RAW_STALE_HOURS) alerts.push(`Raw readings are ${rawStaleHours}h stale (expected within ${RAW_STALE_HOURS}h) — the Climate Agent may have stopped posting.`);
    if (lagHours != null && lagHours > ROLLUP_LAG_HOURS) alerts.push(`Derived variety_climate_hourly is ${lagHours}h behind raw readings — the rollup worker may not be running.`);
    if ((failedCount ?? 0) > 0) alerts.push(`${failedCount} rollup job(s) in 'failed' status — see jobs.recentFailures.`);
    for (const v of lowCoverageVarieties) alerts.push(`${v.varietyName}: ${v.coveragePct}% 7-day climate coverage (below ${LOW_COVERAGE_PCT}%).`);
    for (const name of unmappedVarieties) alerts.push(`${name}: no zones linked in variety_zones — can never receive climate data.`);
    for (const a of radiationResetAnomalies) alerts.push(`${a.phaseName}: ${a.resetCount} radiation counter resets in the last ${a.daysInWindow} days (expected ~1/day) — check for a flapping/misconfigured sensor.`);
    // Raw-vs-derived gap specifically (distinct from the raw-staleness and
    // rollup-lag watermark alerts above, which look at the single latest
    // timestamp): a variety whose raw coverage is healthy but whose derived
    // coverage lags well behind it points at the rollup not keeping up for
    // THAT variety specifically, not a raw-ingestion problem.
    for (const v of coverageByVariety) {
      if (v.rawCoveragePct >= LOW_COVERAGE_PCT && v.derivedCoveragePct < v.rawCoveragePct - 10) {
        alerts.push(`${v.varietyName}: raw coverage ${v.rawCoveragePct}% but derived coverage only ${v.derivedCoveragePct}% — the rollup is behind for this variety specifically.`);
      }
    }

    res.json({
      watermarks: {
        latestRawReadingAt: latestRawTs,
        latestPhaseHourlyAt: latestPhaseHourly.data?.measured_at ?? null,
        latestVarietyHourlyAt: latestVarietyHourlyTs,
        latestFeatureAt: latestFeature.data?.measured_at ?? null,
        rawToVarietyHourlyLagHours: lagHours,
        rawReadingStaleHours: rawStaleHours,
      },
      jobs: {
        pending: pendingCount ?? 0,
        running: runningCount ?? 0,
        failed: failedCount ?? 0,
        recentFailures: recentFailures ?? [],
      },
      sevenDayCoverageByVariety: coverageByVariety,
      unmappedVarieties,
      radiationResetAnomalies,
      alerts,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
