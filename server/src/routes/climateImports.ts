import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { climateImportAuth } from '../middleware/climateImportAuth';
import { chunkArray } from '../lib/chunkArray';
import { fetchAllRows } from '../lib/paginatedFetch';

const router = Router();

// Supported metric_name values the agent should normalise to before posting:
//   ec                    mS/cm
//   ph                    (dimensionless)
//   temperature_c         °C
//   relative_humidity_pct %
//   co2_ppm               ppm
//   drain_water_pct       %
//   feed_water_volume_ml  ml
//   radiation_sum_j_cm2   J/cm²

interface Reading {
  zone_label: string;
  measured_at: string;
  metric_name: string;
  value?: number | null;
  unit?: string | null;
  source_file?: string | null;
}

type RollupJobStatus = 'enqueued' | 'already_enqueued' | 'enqueue_failed' | 'not_needed';

/**
 * Ensures exactly one climate_rollup_jobs row exists for this import,
 * enqueueing one if it's missing. Called both on first creation and on a
 * duplicate-file retry, so a rollup job that failed to enqueue the first
 * time gets a real second chance -- the agent's own file-hash dedup means it
 * will never resend a file's raw content once climate_imports has a row for
 * it, so the duplicate branch is the only place a retry can ever land.
 */
async function ensureRollupJobEnqueued(orgId: string, importId: string, readings: Reading[]): Promise<RollupJobStatus> {
  const { data: existingJob } = await supabase
    .from('climate_rollup_jobs')
    .select('id')
    .eq('source_import_id', importId)
    .maybeSingle();
  if (existingJob) return 'already_enqueued';

  const timestamps = readings.map((r) => r.measured_at).sort();
  const { error } = await supabase.from('climate_rollup_jobs').insert({
    organization_id: orgId,
    source: 'agent_import',
    source_import_id: importId,
    range_start: timestamps[0],
    range_end: timestamps[timestamps.length - 1],
  });
  if (error) {
    console.error('Failed to enqueue climate_rollup_jobs row for import', importId, error.message);
    return 'enqueue_failed';
  }
  return 'enqueued';
}

// POST /api/v1/climate/imports
// Called by the external Climate Agent after it parses a Block Summary file.
// Body: { file_hash, filename, readings: [{ zone_label, measured_at, metric_name, value, unit?, source_file? }] }
// Returns:
//   201 { status: "created",   import_id, readings_stored, rollup_job_status }
//   200 { status: "duplicate", import_id, rollup_job_status }
// rollup_job_status is 'enqueue_failed' when readings were saved but the
// durable rollup job could not be created -- the import itself did NOT fail
// (raw data is safe), but its climate rollup is not yet scheduled. Retrying
// the same file (which the agent does automatically on any non-2xx or on
// its own schedule) self-heals this via the 'duplicate' branch above; an
// operator can also see it lagging via GET /rollup-jobs/status.
router.post('/', climateImportAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { file_hash, filename, readings } = req.body as {
      file_hash?: string;
      filename?: string;
      readings?: Reading[];
    };

    if (!file_hash || typeof file_hash !== 'string') {
      return res.status(400).json({ error: 'file_hash is required' });
    }
    if (!Array.isArray(readings) || readings.length === 0) {
      return res.status(400).json({ error: 'readings array is required and must not be empty' });
    }
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      if (!r.zone_label) {
        return res.status(400).json({ error: `readings[${i}]: zone_label is required` });
      }
      if (!r.measured_at) {
        return res.status(400).json({ error: `readings[${i}]: measured_at is required` });
      }
      if (!r.metric_name) {
        return res.status(400).json({ error: `readings[${i}]: metric_name is required` });
      }
    }

    const orgId = req.organization!.id;

    // Duplicate file check
    const { data: existing } = await supabase
      .from('climate_imports')
      .select('id')
      .eq('organization_id', orgId)
      .eq('file_hash', file_hash)
      .maybeSingle();

    if (existing) {
      // Self-healing retry: a prior attempt for this exact file may have
      // saved readings successfully but failed to enqueue its rollup job
      // (see the comment below on why that can happen). Simply returning
      // 'duplicate' here without checking would leave that import's rollup
      // permanently unscheduled -- the agent's own duplicate-file dedup
      // means it will never resend a file it thinks already succeeded, so
      // this is the only place that retry can ever get a second chance.
      const rollupStatus = await ensureRollupJobEnqueued(orgId, existing.id, readings);
      return res.status(200).json({ status: 'duplicate', import_id: existing.id, rollup_job_status: rollupStatus });
    }

    // Create the import record
    const { data: importRow, error: importError } = await supabase
      .from('climate_imports')
      .insert({
        organization_id: orgId,
        filename: filename ?? 'unknown',
        file_hash,
        readings_stored: 0,
      })
      .select('id')
      .single();

    if (importError || !importRow) {
      throw new Error(importError?.message ?? 'Failed to create climate_imports record');
    }

    // Insert readings — skip exact duplicates (same org + timestamp + zone + metric)
    const rows = readings.map(r => ({
      organization_id: orgId,
      import_id: importRow.id,
      zone_label: r.zone_label,
      measured_at: r.measured_at,
      metric_name: r.metric_name,
      value: r.value ?? null,
      unit: r.unit ?? null,
      source_file: r.source_file ?? null,
    }));

    let readingsStored = 0;
    for (const chunk of chunkArray(rows, 500)) {
      const { data, error } = await supabase
        .from('climate_readings')
        .upsert(chunk, {
          onConflict: 'organization_id,measured_at,zone_label,metric_name',
          ignoreDuplicates: true,
        })
        .select('id');
      if (error) throw new Error(error.message);
      readingsStored += (data ?? []).length;
    }

    // Patch the import row with the final count
    await supabase
      .from('climate_imports')
      .update({ readings_stored: readingsStored })
      .eq('id', importRow.id);

    // Durably enqueue the hourly rollup (phase/variety_climate_hourly +
    // features) for the range this import touched, rather than computing it
    // inline here (would add latency/timeout risk to the agent's response,
    // and a crash mid-computation would leave raw readings written with no
    // record that a rollup was ever attempted) or firing a non-durable
    // in-process promise (silently lost on restart, no retry, no
    // visibility). A separate worker (POST /api/climate/rollup-jobs/process)
    // claims and processes this job — see climateRollupJobs.ts.
    //
    // If this insert itself fails, the raw readings are still safely saved
    // (they're the durable record; that part of this request genuinely
    // succeeded) -- but the response must say so honestly rather than
    // reporting a plain 'created' as if the rollup was scheduled. Two
    // recovery paths exist for a failed enqueue: (1) the next call to
    // POST /rollup-jobs/process won't see this import at all since no job
    // row exists for it -- so it stays permanently unrolled-up unless (2)
    // the agent retries the same file later, which hits the 'duplicate'
    // branch above, which itself now checks for and re-enqueues a missing
    // job. Until either happens, the /rollup-jobs/status watermark-lag
    // check will eventually surface this import's data as stuck raw-only.
    const rollupJobStatus = readingsStored > 0
      ? await ensureRollupJobEnqueued(orgId, importRow.id, readings)
      : 'not_needed'; // nothing new was stored (every reading was an exact duplicate) -- no rollup work implied

    return res.status(201).json({
      status: 'created',
      import_id: importRow.id,
      readings_stored: readingsStored,
      rollup_job_status: rollupJobStatus,
    });
  } catch (e) {
    next(e);
  }
});

interface ReadingAgg {
  zones: Set<string>;
  earliest: string | null;
  latest: string | null;
}

// GET /api/v1/climate/imports
// Feeds the Climate page's "Synopta Agent Imports" tab. This is a browser-facing
// read endpoint — unlike the POST above it does NOT require climateImportAuth,
// since the browser has no session/API key to present (this app has no
// user/session auth system). Organization isolation is instead enforced at the
// query level: every climate_imports/climate_readings lookup is always filtered
// to exactly one resolved organization_id, so results can never blend across
// organizations even without a bearer key gating the request itself.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let organizationId = typeof req.query.organization_id === 'string' ? req.query.organization_id : undefined;

    if (!organizationId) {
      const { data: orgs, error: orgsError } = await supabase
        .from('organizations')
        .select('id')
        .eq('is_active', true);
      if (orgsError) throw new Error(orgsError.message);

      if (!orgs || orgs.length === 0) {
        return res.status(200).json({ organization_id: null, imports: [] });
      }
      if (orgs.length > 1) {
        return res.status(400).json({ error: 'organization_id is required when multiple organizations exist' });
      }
      organizationId = orgs[0].id;
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const { data: imports, error: importsError } = await supabase
      .from('climate_imports')
      .select('id, filename, file_hash, readings_stored, created_at')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (importsError) throw new Error(importsError.message);

    const importIds = (imports ?? []).map(imp => imp.id);
    const aggByImport = new Map<string, ReadingAgg>();

    if (importIds.length > 0) {
      // Paginated — measured live before fixing (not assumed): the default
      // request (limit=50 imports) sums to ~5,700 real climate_readings
      // rows against a 1,000-row cap, so this was silently showing
      // zones/earliest/latest for only the first ~7-8 of 50 imports on
      // every default-limit request, not just an edge case at limit=200.
      // Scope (organization_id + the bounded importIds list from the
      // .limit()-ed climate_imports query above) is unchanged — this is
      // NOT a full 146,806-row climate_readings scan, only ever as many
      // rows as the already-bounded import selection above produced.
      // Chunked by 100 import IDs first (URL-length safety, same reason
      // chunkArray exists elsewhere) with each chunk paginated in turn.
      const readings = (
        await Promise.all(
          chunkArray(importIds, 100).map((ids) =>
            fetchAllRows<{ import_id: string; zone_label: string; measured_at: string }>(() =>
              supabase
                .from('climate_readings')
                .select('import_id, zone_label, measured_at')
                .eq('organization_id', organizationId)
                .in('import_id', ids)
            )
          )
        )
      ).flat();

      for (const r of readings) {
        let agg = aggByImport.get(r.import_id);
        if (!agg) {
          agg = { zones: new Set(), earliest: null, latest: null };
          aggByImport.set(r.import_id, agg);
        }
        agg.zones.add(r.zone_label);
        if (!agg.earliest || r.measured_at < agg.earliest) agg.earliest = r.measured_at;
        if (!agg.latest || r.measured_at > agg.latest) agg.latest = r.measured_at;
      }
    }

    const result = (imports ?? []).map(imp => {
      const agg = aggByImport.get(imp.id);
      return {
        import_id: imp.id,
        created_at: imp.created_at,
        filename: imp.filename,
        file_hash: imp.file_hash,
        readings_stored: imp.readings_stored,
        zones: agg ? Array.from(agg.zones).sort() : [],
        earliest_measured_at: agg?.earliest ?? null,
        latest_measured_at: agg?.latest ?? null,
        source: 'Synopta Agent',
      };
    });

    return res.status(200).json({ organization_id: organizationId, imports: result });
  } catch (e) {
    next(e);
  }
});

export default router;
