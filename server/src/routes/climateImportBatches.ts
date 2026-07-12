import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { createHash, randomUUID } from 'crypto';
import { supabase } from '../lib/supabase';
import { chunkArray } from '../lib/chunkArray';
import { fetchAllRows } from '../lib/fetchAllRows';
import { parseRidderBlockSummary, zonedTimeToUtc, GREENHOUSE_TIME_ZONE, type ZoneReading } from '../lib/ridderParser';
import { computeVarietyHourlyRow, computePhaseHourlyRow, localCalendarDateKey, type VarietyHourlyResult, type PhaseHourlyResult } from '../lib/climateAveraging';
import { canonicalizeStagedReadings, type StagedReadingLike, type StagedFileLike } from '../lib/climateDuplicates';
import { previewTimestampCorrection, applyTimestampCorrection } from '../lib/climateCorrections';
import { recomputeVarietyClimateFeatures } from '../lib/climateFeatureRecompute';

/** Start of the greenhouse-local calendar day containing `isoTimestamp`, as a UTC ISO string. */
function greenhouseDayStartUtc(isoTimestamp: string): string {
  const [y, m, d] = localCalendarDateKey(new Date(isoTimestamp), GREENHOUSE_TIME_ZONE).split('-').map(Number);
  return zonedTimeToUtc(y, m, d, 0, 0, 0, GREENHOUSE_TIME_ZONE).toISOString();
}

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 5000 } });

const CHUNK_SIZE = 500;
const VALUE_EPSILON = 0.0005;

function sameValue(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < VALUE_EPSILON;
}

// Values are rounded to their destination column's precision BEFORE storage
// and BEFORE conflict comparison — otherwise a freshly-computed average
// (kept at higher internal precision) never exactly equals the same value
// after it's round-tripped through a numeric(_,2)/numeric(_,3) column, and
// every re-import of genuinely identical data would falsely show as a conflict.
function round(v: number | null, decimals: number): number | null {
  if (v == null) return null;
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

// ─────────────────────────────────────────────────────────────────────────
// POST / — upload N files, parse + stage them (no permanent writes yet)
// ─────────────────────────────────────────────────────────────────────────
router.post('/', upload.array('files'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'At least one file is required (field name "files")' });
    }

    const organizationId: string | null = null; // no user/session auth in this app yet — matches existing climate tables' unscoped pattern

    const { data: batch, error: batchErr } = await supabase
      .from('climate_import_batches')
      .insert({ organization_id: organizationId, file_count: files.length, status: 'pending' })
      .select('id')
      .single();
    if (batchErr || !batch) throw new Error(batchErr?.message ?? 'Failed to create import batch');
    const batchId = batch.id as string;

    // Parse everything first (CPU-bound, no DB) so duplicate-hash lookups can be a single query.
    const parsedFiles = files.map((f) => {
      const content = f.buffer.toString('utf-8');
      const fileHash = createHash('sha256').update(f.buffer).digest('hex');
      const parsed = parseRidderBlockSummary(f.originalname, content);
      return { file: f, fileHash, parsed, content };
    });

    const allHashes = Array.from(new Set(parsedFiles.map((p) => p.fileHash)));
    const { data: existingImports } = await supabase
      .from('climate_imports')
      .select('id, file_hash, readings_stored, measured_at')
      .in('file_hash', allHashes);
    // A prior climate_imports row with readings_stored = 0 means this exact
    // file was staged before but never actually wrote any permanent readings
    // (e.g. it lost every same-batch duplicate conflict) — that's a repair
    // candidate, not a true duplicate; its data can still be recovered.
    const existingImportByHash = new Map((existingImports ?? []).map((r) => [r.file_hash as string, r]));

    const seenInBatch = new Set<string>();
    const stagedFileRows: Record<string, unknown>[] = [];
    const stagedFileMeta: { fileHash: string; filename: string; index: number }[] = [];

    for (let i = 0; i < parsedFiles.length; i++) {
      const { file, fileHash, parsed, content } = parsedFiles[i];
      let status: 'parsed' | 'duplicate' | 'error' | 'repair' = 'parsed';
      let errorMessage: string | null = null;
      const existingImport = existingImportByHash.get(fileHash);

      if (seenInBatch.has(fileHash)) {
        status = 'duplicate';
      } else if (parsed.errors.length > 0) {
        status = 'error';
        errorMessage = parsed.errors.join('; ');
      } else if (existingImport) {
        status = existingImport.readings_stored === 0 ? 'repair' : 'duplicate';
      }
      seenInBatch.add(fileHash);

      stagedFileRows.push({
        batch_id: batchId,
        organization_id: organizationId,
        filename: file.originalname,
        file_hash: fileHash,
        status,
        error_message: errorMessage,
        filename_timestamp: parsed.timestamp.filenameTimestampUtc?.toISOString() ?? null,
        week_number: parsed.timestamp.weekNumber,
        system_date_raw: parsed.timestamp.systemDateRaw,
        system_time_raw: parsed.timestamp.systemTimeRaw,
        resolved_measured_at: (status === 'parsed' || status === 'repair') ? parsed.timestamp.measuredAtUtc.toISOString() : null,
        timestamp_conflict: parsed.timestamp.conflict,
        timestamp_warning: parsed.timestamp.warning,
        hour_difference_minutes: parsed.timestamp.hourDifferenceMinutes,
        hour_conflict: parsed.timestamp.hourConflict,
        hour_warning: parsed.timestamp.hourWarning,
        raw_content: content,
        existing_import_id: status === 'repair' ? existingImport!.id : null,
        existing_measured_at: status === 'repair' ? existingImport!.measured_at : null,
        zone_count: parsed.zoneLabels.length,
      });
      stagedFileMeta.push({ fileHash, filename: file.originalname, index: i });
    }

    const { data: insertedFiles, error: filesErr } = await supabase
      .from('climate_import_staged_files')
      .insert(stagedFileRows)
      .select('id, filename, file_hash, status');
    if (filesErr) throw new Error(filesErr.message);

    // Stage readings for files that parsed cleanly, including repair candidates
    // (a prior import of the same file that never actually stored readings).
    const stagedReadingRows: Record<string, unknown>[] = [];
    for (const inserted of insertedFiles ?? []) {
      if (inserted.status !== 'parsed' && inserted.status !== 'repair') continue;
      const match = parsedFiles.find((p) => p.fileHash === inserted.file_hash && p.file.originalname === inserted.filename);
      if (!match) continue;
      const measuredAtIso = match.parsed.timestamp.measuredAtUtc.toISOString();
      const allReadings: (ZoneReading & { }) [] = [...match.parsed.zoneReadings, ...match.parsed.phaseLevelReadings];
      for (const r of allReadings) {
        stagedReadingRows.push({
          staged_file_id: inserted.id,
          batch_id: batchId,
          organization_id: organizationId,
          zone_label: r.zoneLabel,
          measured_at: measuredAtIso,
          metric_name: r.metricName,
          value: r.value,
          unit: r.unit,
        });
      }
    }

    for (const chunk of chunkArray(stagedReadingRows, CHUNK_SIZE)) {
      const { error } = await supabase.from('climate_import_staged_readings').insert(chunk);
      if (error) throw new Error(error.message);
    }

    await supabase.from('climate_import_batches').update({ file_count: files.length }).eq('id', batchId);

    const preview = await buildPreview(batchId);
    res.status(201).json({ batchId, ...preview });
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:batchId/preview — recompute the preview summary for a pending batch
// ─────────────────────────────────────────────────────────────────────────
router.get('/:batchId/preview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const batchId = req.params.batchId as string;
    const preview = await buildPreview(batchId);
    res.json({ batchId, ...preview });
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET / — import batch history
// ─────────────────────────────────────────────────────────────────────────
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('climate_import_batches')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:batchId — cancel a pending batch (cascade deletes staged rows only)
// ─────────────────────────────────────────────────────────────────────────
router.delete('/:batchId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data: batch } = await supabase.from('climate_import_batches').select('status').eq('id', req.params.batchId).maybeSingle();
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    if (batch.status === 'committed') return res.status(400).json({ error: 'Cannot cancel a committed batch' });
    const { error } = await supabase
      .from('climate_import_batches')
      .update({ status: 'cancelled' })
      .eq('id', req.params.batchId);
    if (error) throw new Error(error.message);
    // Staged files/readings cascade-delete with the batch row itself; leaving the
    // batch row (status='cancelled') as a lightweight history breadcrumb instead
    // of hard-deleting it, but its staged data is no longer needed.
    await supabase.from('climate_import_staged_files').delete().eq('batch_id', req.params.batchId);
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:batchId/confirm — dry-run conflict check, or (with resolutions) commit
// ─────────────────────────────────────────────────────────────────────────
router.post('/:batchId/confirm', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const batchId = req.params.batchId as string;
    // 'skip' | 'overwrite' for reading/variety_hourly conflicts; a stagedFileId
    // string (which candidate wins) for batch_duplicate conflicts.
    const resolutions: Record<string, string> = req.body?.resolutions ?? {};

    const { data: batch } = await supabase.from('climate_import_batches').select('*').eq('id', batchId).maybeSingle();
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    if (batch.status === 'committed') return res.status(400).json({ error: 'Batch already committed' });

    const plan = await buildCommitPlan(batchId, resolutions);

    const unresolvedConflicts = plan.conflicts.filter((c) => !resolutions[c.conflictId]);
    if (unresolvedConflicts.length > 0) {
      return res.status(200).json({ status: 'conflicts', conflicts: plan.conflicts, summary: plan.summary });
    }

    // Apply resolutions: drop 'skip' rows, keep 'overwrite' + non-conflicting new rows.
    const skippedIds = new Set(
      plan.conflicts.filter((c) => resolutions[c.conflictId] === 'skip').map((c) => c.conflictId)
    );
    const finalReadings = plan.readingRows.filter((r) => !skippedIds.has(r.conflictId ?? ''));
    const finalVarietyHourly = plan.varietyHourlyRows.filter((r) => !skippedIds.has(r.conflictId ?? ''));
    const finalPhaseHourly = plan.phaseHourlyRows;

    const { error: rpcError } = await supabase.rpc('commit_climate_import_batch', {
      p_batch_id: batchId,
      p_imports: plan.importRows,
      p_readings: finalReadings.map(({ conflictId, ...rest }) => rest),
      p_phase_hourly: finalPhaseHourly.map(({ conflictId, ...rest }) => rest),
      p_variety_hourly: finalVarietyHourly.map(({ conflictId, ...rest }) => rest),
    });

    if (rpcError) {
      await supabase.from('climate_import_batches').update({ status: 'failed', error_message: rpcError.message }).eq('id', batchId);
      return res.status(500).json({ error: rpcError.message, status: 'failed' });
    }

    // Repair files (a filename/hash that already had a climate_imports row
    // from a prior attempt that stored zero readings) reused that existing
    // row's id as their import_id above — commit_climate_import_batch's
    // `ON CONFLICT ... DO NOTHING` left the row's own fields untouched, so
    // update it here and leave an audit trail of the repair.
    for (const ru of plan.repairUpdates) {
      await supabase.from('climate_imports').update({
        measured_at: ru.correctedMeasuredAt,
        readings_stored: ru.readingsStored,
        raw_content: ru.rawContent,
        hour_difference_minutes: ru.hourDifferenceMinutes,
        hour_conflict: false,
        hour_warning: ru.hourWarning,
      }).eq('id', ru.importId);

      await supabase.from('climate_import_corrections').insert({
        organization_id: null,
        correction_type: 'repair_import',
        source_filename: ru.filename,
        source_file_hash: ru.fileHash,
        old_measured_at: ru.previousWrongMeasuredAt,
        new_measured_at: ru.correctedMeasuredAt,
        affected_reading_count: ru.readingsStored,
        notes: 'Re-uploaded after the timestamp-resolution fix; this file previously lost a same-batch duplicate conflict and stored zero readings.',
      });
    }

    // Staging is ephemeral — safe to remove now that permanent tables have the data.
    await supabase.from('climate_import_staged_files').delete().eq('batch_id', batchId);

    // Best-effort: derive Phase 1 climate features for the hours just
    // committed. Never fails the import — a bug here shouldn't block data
    // ingestion, and hours can always be backfilled via the recompute route.
    try {
      await recomputeVarietyClimateFeatures(
        finalVarietyHourly.map((r) => ({ varietyId: r.variety_id as string, measuredAt: r.measured_at as string }))
      );
    } catch (featureError) {
      console.error('Failed to recompute variety_climate_hourly_features after batch commit:', featureError);
    }

    res.json({
      status: 'committed',
      readingsCommitted: finalReadings.length,
      readingsSkippedAsDuplicate: plan.summary.skippedIdenticalCount,
      varietyHourlyCommitted: finalVarietyHourly.length,
      phaseHourlyCommitted: finalPhaseHourly.length,
      repairedFiles: plan.repairUpdates.map((r) => r.filename),
    });
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /corrections/preview — dry-run: what would correcting this already-
// committed file's canonical hour to its filename-authoritative hour do?
// ─────────────────────────────────────────────────────────────────────────
router.post('/corrections/preview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filename = req.body?.filename as string | undefined;
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    const preview = await previewTimestampCorrection(filename);
    res.json(preview);
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /corrections/apply — perform the correction (refuses if the preview
// found a conflicting permanent reading already at the target hour).
// ─────────────────────────────────────────────────────────────────────────
router.post('/corrections/apply', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filename = req.body?.filename as string | undefined;
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    const result = await applyTimestampCorrection(filename);
    res.json({ status: 'corrected', ...result });
  } catch (e) {
    next(e);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════

async function buildPreview(batchId: string) {
  const files = await fetchAllRows((from, to) =>
    supabase.from('climate_import_staged_files').select('*').eq('batch_id', batchId).range(from, to)
  );

  const parsedFiles = files.filter((f) => f.status === 'parsed' || f.status === 'repair');
  const repairFiles = files.filter((f) => f.status === 'repair');
  const duplicateFiles = files.filter((f) => f.status === 'duplicate');
  const errorFiles = files.filter((f) => f.status === 'error');

  const timestamps = parsedFiles.map((f) => f.resolved_measured_at as string).filter(Boolean).sort();
  const uniqueTimestamps = Array.from(new Set(timestamps));

  // Duplicate timestamps: more than one file resolving to the same hour.
  const timestampCounts = new Map<string, number>();
  for (const t of timestamps) timestampCounts.set(t, (timestampCounts.get(t) ?? 0) + 1);
  const duplicateTimestamps = Array.from(timestampCounts.entries()).filter(([, c]) => c > 1).map(([t]) => t);

  // Missing hours: gaps between consecutive unique timestamps > 1 hour.
  let missingHours = 0;
  for (let i = 1; i < uniqueTimestamps.length; i++) {
    const gapMs = new Date(uniqueTimestamps[i]).getTime() - new Date(uniqueTimestamps[i - 1]).getTime();
    const gapHours = Math.round(gapMs / 3600000);
    if (gapHours > 1) missingHours += gapHours - 1;
  }

  const timestampWarnings = parsedFiles
    .filter((f) => f.timestamp_conflict)
    .map((f) => ({ filename: f.filename, warning: f.timestamp_warning }));

  // Hour-discrepancy warnings: System Time's hour vs. the (authoritative)
  // filename hour. 1-hour staleness is non-blocking; anything larger needs
  // an explicit confirmation before import (hasUnresolvedHourConflicts).
  const hourWarnings = parsedFiles
    .filter((f) => f.hour_warning)
    .map((f) => ({ filename: f.filename, warning: f.hour_warning as string, hourConflict: !!f.hour_conflict, hourDifferenceMinutes: f.hour_difference_minutes as number | null }));
  const hasUnresolvedHourConflicts = parsedFiles.some((f) => f.hour_conflict);

  // Repair candidates: this exact file was staged before but never actually
  // wrote permanent readings (it lost every same-batch conflict) — its data
  // can still be recovered, now under the corrected filename-authoritative hour.
  const repairDetails = repairFiles.map((f) => ({
    filename: f.filename,
    previousWrongMeasuredAt: f.existing_measured_at as string | null,
    correctedMeasuredAt: f.resolved_measured_at as string | null,
  }));

  // Full staged readings — paginated (a real batch easily exceeds PostgREST's
  // default 1000-row cap) — used both for detected zones/metrics and for the
  // same-batch duplicate-reading analysis below.
  const stagedReadings = await fetchAllRows<StagedReadingLike>((from, to) =>
    supabase.from('climate_import_staged_readings').select('*').eq('batch_id', batchId).range(from, to)
  );
  const detectedZones = Array.from(new Set(stagedReadings.map((r) => r.zone_label))).sort();
  const detectedMetrics = Array.from(new Set(stagedReadings.map((r) => r.metric_name))).sort();

  // Same-batch duplicate analysis — surfaced here, BEFORE Confirm Import, not
  // just discovered when the commit is attempted.
  const fileByIdForDupes = new Map<string, StagedFileLike>(
    files.map((f) => [f.id, { id: f.id, filename: f.filename, filename_timestamp: f.filename_timestamp }])
  );
  const { groups: duplicateGroups } = canonicalizeStagedReadings(stagedReadings, fileByIdForDupes);

  const groupsByTimestamp = new Map<string, typeof duplicateGroups>();
  for (const g of duplicateGroups) {
    if (!groupsByTimestamp.has(g.measuredAt)) groupsByTimestamp.set(g.measuredAt, []);
    groupsByTimestamp.get(g.measuredAt)!.push(g);
  }
  const duplicateTimestampDetails = Array.from(groupsByTimestamp.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([measuredAt, groups]) => {
      const filesInvolved = Array.from(new Set(groups.flatMap((g) => g.candidates.map((c) => c.filename))));
      const conflicting = groups.filter((g) => g.isConflict);
      return {
        measuredAt,
        files: filesInvolved,
        identicalReadingCount: groups.length - conflicting.length,
        conflictingReadingCount: conflicting.length,
        conflictingMetricsZones: conflicting.map((g) => ({ zoneLabel: g.zoneLabel, metricName: g.metricName, candidates: g.candidates })),
      };
    });
  const identicalDuplicateTimestampCount = duplicateTimestampDetails.filter((d) => d.conflictingReadingCount === 0).length;
  const conflictingDuplicateTimestampCount = duplicateTimestampDetails.filter((d) => d.conflictingReadingCount > 0).length;

  const { data: zones } = await supabase.from('zones').select('id, name, import_key, phase_id');
  const zoneByImportKey = new Map((zones ?? []).map((z) => [z.import_key, z]));
  const unmatchedZones = detectedZones.filter((z) => !zoneByImportKey.has(z));

  const { data: varietyZones } = await supabase
    .from('variety_zones')
    .select('variety_id, zone_id, varieties(name), zones(name, import_key)');
  type VZRow = { variety_id: string; zone_id: string; varieties: { name: string } | { name: string }[] | null; zones: { name: string; import_key: string } | { name: string; import_key: string }[] | null };
  const varietyMap = new Map<string, { varietyName: string; zoneLabels: string[] }>();
  for (const vz of (varietyZones ?? []) as VZRow[]) {
    const varietyName = (Array.isArray(vz.varieties) ? vz.varieties[0]?.name : vz.varieties?.name) ?? 'Unknown';
    const zoneInfo = Array.isArray(vz.zones) ? vz.zones[0] : vz.zones;
    if (!zoneInfo) continue;
    if (!varietyMap.has(vz.variety_id)) varietyMap.set(vz.variety_id, { varietyName, zoneLabels: [] });
    varietyMap.get(vz.variety_id)!.zoneLabels.push(zoneInfo.import_key);
  }
  const varietyMappings = Array.from(varietyMap.values());
  const linkedZoneKeys = new Set(varietyMappings.flatMap((v) => v.zoneLabels));
  const zonesWithoutVariety = detectedZones.filter((z) => zoneByImportKey.has(z) && !linkedZoneKeys.has(z));
  const varietiesInBatch = varietyMappings.filter((v) => v.zoneLabels.some((z) => detectedZones.includes(z)));

  const phasesInvolved = new Set(
    detectedZones.map((z) => zoneByImportKey.get(z)?.phase_id).filter(Boolean)
  );

  return {
    filesParsed: parsedFiles.length,
    filesFailed: errorFiles.length,
    filesDuplicate: duplicateFiles.length,
    filesRepair: repairFiles.length,
    repairDetails,
    files: files.map((f) => ({
      filename: f.filename,
      status: f.status,
      errorMessage: f.error_message,
      resolvedMeasuredAt: f.resolved_measured_at,
      weekNumber: f.week_number,
      timestampConflict: f.timestamp_conflict,
      timestampWarning: f.timestamp_warning,
      hourConflict: f.hour_conflict,
      hourWarning: f.hour_warning,
      hourDifferenceMinutes: f.hour_difference_minutes,
      zoneCount: f.zone_count,
    })),
    timestampRange: uniqueTimestamps.length > 0 ? { start: uniqueTimestamps[0], end: uniqueTimestamps[uniqueTimestamps.length - 1] } : null,
    uniqueTimestampCount: uniqueTimestamps.length,
    duplicateTimestamps,
    identicalDuplicateTimestampCount,
    conflictingDuplicateTimestampCount,
    duplicateTimestampDetails,
    hasUnresolvedDuplicateConflicts: conflictingDuplicateTimestampCount > 0,
    missingHours,
    timestampWarnings,
    hourWarnings,
    hasUnresolvedHourConflicts,
    detectedZones,
    detectedMetrics,
    unmatchedZones,
    varietyMappings,
    zonesWithoutVariety,
    // Unique (variety,timestamp)/(phase,timestamp) pair counts are unaffected
    // by same-batch duplicate readings — dedup only changes which underlying
    // zone reading is used per pair, never the set of pairs itself.
    expectedVarietyHourRows: varietiesInBatch.length * uniqueTimestamps.length,
    expectedPhaseHourRows: phasesInvolved.size * uniqueTimestamps.length,
  };
}

interface ConflictRow { conflictId?: string; [key: string]: unknown }

interface Conflict {
  conflictId: string;
  kind: 'reading' | 'variety_hourly' | 'batch_duplicate' | 'hour_discrepancy';
  description: string;
  existingValue: unknown;
  newValue: unknown;
  /** batch_duplicate only: the candidate files/values to choose between. Resolution = chosen stagedFileId. */
  candidates?: { stagedFileId: string; filename: string; value: number }[];
}

async function buildCommitPlan(batchId: string, resolutions: Record<string, string> = {}) {
  const files = await fetchAllRows((from, to) =>
    supabase.from('climate_import_staged_files').select('*').eq('batch_id', batchId).in('status', ['parsed', 'repair']).range(from, to)
  );

  // Files with a >1-hour System-Time-vs-filename discrepancy must not
  // auto-import — the resolver already used the filename hour, but this
  // needs an explicit human confirmation ('confirm_filename_hour') before
  // proceeding, the same way an unresolved batch_duplicate does.
  const unresolvedHourConflicts = files.filter((f) => f.hour_conflict && resolutions[`hour:${f.filename}`] !== 'confirm_filename_hour');
  if (unresolvedHourConflicts.length > 0) {
    return {
      importRows: [], readingRows: [], phaseHourlyRows: [], varietyHourlyRows: [],
      conflicts: unresolvedHourConflicts.map((f): Conflict => ({
        conflictId: `hour:${f.filename}`,
        kind: 'hour_discrepancy',
        description: `${f.filename}: ${f.hour_warning}`,
        existingValue: null,
        newValue: null,
      })),
      summary: {
        totalReadings: 0, newReadings: 0, newVarietyHourly: 0, newPhaseHourly: 0,
        conflictCount: unresolvedHourConflicts.length, skippedIdenticalCount: 0,
      },
      repairUpdates: [],
    };
  }

  const rawReadings = await fetchAllRows<StagedReadingLike>((from, to) =>
    supabase.from('climate_import_staged_readings').select('*').eq('batch_id', batchId).range(from, to)
  );

  const fileMetaById = new Map<string, StagedFileLike>(
    files.map((f) => [f.id, { id: f.id, filename: f.filename, filename_timestamp: f.filename_timestamp }])
  );

  // Same-batch duplicates (multiple staged files resolving to the same zone
  // + metric + timestamp) MUST be collapsed to exactly one canonical row per
  // destination key before anything downstream uses `readings` — Postgres's
  // ON CONFLICT DO UPDATE cannot affect the same target row twice in one
  // statement, and picking an arbitrary duplicate for averaging would be
  // non-deterministic. Identical-valued duplicates collapse silently;
  // genuinely conflicting ones become a `batch_duplicate` conflict that must
  // be explicitly resolved (never chosen arbitrarily) before we proceed.
  const { canonicalReadings, groups: duplicateGroups, skippedIdenticalCount } = canonicalizeStagedReadings(
    rawReadings, fileMetaById, resolutions
  );

  const unresolvedBatchDuplicates = duplicateGroups.filter((g) => g.isConflict && !resolutions[g.conflictId]);
  if (unresolvedBatchDuplicates.length > 0) {
    return {
      importRows: [], readingRows: [], phaseHourlyRows: [], varietyHourlyRows: [],
      conflicts: unresolvedBatchDuplicates.map((g): Conflict => ({
        conflictId: g.conflictId,
        kind: 'batch_duplicate',
        description: `${g.zoneLabel} / ${g.metricName} @ ${g.measuredAt} — ${g.candidates.length} files disagree`,
        existingValue: null,
        newValue: null,
        candidates: g.candidates,
      })),
      summary: {
        totalReadings: rawReadings.length, newReadings: 0, newVarietyHourly: 0, newPhaseHourly: 0,
        conflictCount: unresolvedBatchDuplicates.length, skippedIdenticalCount: 0,
      },
      repairUpdates: [],
    };
  }

  const readings = canonicalReadings;

  const measuredAts = Array.from(new Set(readings.map((r) => r.measured_at as string)));
  const minTs = measuredAts.sort()[0];
  const maxTs = measuredAts.sort()[measuredAts.length - 1];

  const { data: zones } = await supabase.from('zones').select('id, name, import_key, phase_id');
  const zoneByImportKey = new Map((zones ?? []).map((z) => [z.import_key, z]));

  const { data: varietyZones } = await supabase.from('variety_zones').select('variety_id, zone_id');
  const { data: zoneRows } = await supabase.from('zones').select('id, import_key');
  const zoneImportKeyById = new Map((zoneRows ?? []).map((z) => [z.id, z.import_key]));
  const varietyToZoneLabels = new Map<string, string[]>();
  for (const vz of varietyZones ?? []) {
    const label = zoneImportKeyById.get(vz.zone_id);
    if (!label) continue;
    if (!varietyToZoneLabels.has(vz.variety_id)) varietyToZoneLabels.set(vz.variety_id, []);
    varietyToZoneLabels.get(vz.variety_id)!.push(label);
  }

  // Existing permanent data in the batch's timestamp range, for conflict
  // detection. Paginated — a large batch's date range can easily hold more
  // than PostgREST's default 1000-row cap worth of existing readings.
  const existingReadings = minTs
    ? await fetchAllRows((from, to) =>
        supabase.from('climate_readings').select('zone_label, metric_name, measured_at, value').gte('measured_at', minTs).lte('measured_at', maxTs).range(from, to)
      )
    : [];
  const existingReadingMap = new Map(existingReadings.map((r) => [`${r.zone_label}|${r.metric_name}|${r.measured_at}`, r.value as number]));

  // Widened lower bound: the previous same-greenhouse-day cumulative reading
  // needed to seed irrigation/radiation deltas may fall BEFORE this batch's
  // own minTs (e.g. it was committed in an earlier batch), so this can't be
  // scoped to [minTs, maxTs] or the very first hour(s) of a new batch would
  // wrongly look "first_reading_of_day" even when a same-day prior row exists.
  const dayStart = minTs ? greenhouseDayStartUtc(minTs) : null;

  const existingVarietyHourly = dayStart
    ? await fetchAllRows((from, to) =>
        supabase.from('variety_climate_hourly').select('*').gte('measured_at', dayStart).lte('measured_at', maxTs).range(from, to)
      )
    : [];
  const existingVarietyHourlyMap = new Map(existingVarietyHourly.map((r) => [`${r.variety_id}|${r.measured_at}`, r]));

  const existingPhaseHourly = dayStart
    ? await fetchAllRows((from, to) =>
        supabase.from('phase_climate_hourly').select('*').gte('measured_at', dayStart).lte('measured_at', maxTs).range(from, to)
      )
    : [];
  const existingPhaseHourlyMap = new Map(existingPhaseHourly.map((r) => [`${r.phase_id}|${r.measured_at}`, r]));

  const conflicts: Conflict[] = [];
  const readingRows: ConflictRow[] = [];

  // File ledger rows (one per staged file being permanently recorded). IDs are
  // generated here (not left to the DB default) so climate_readings rows can
  // reference the correct import_id before the ledger rows actually exist —
  // both are inserted together, atomically, inside the same RPC call.
  //
  // Repair files (status='repair') already have a climate_imports row from
  // their original — failed — import attempt (readings_stored was 0). Reuse
  // that row's id as the import_id instead of inserting a second row, which
  // would violate the (organization_id, file_hash) uniqueness constraint;
  // the existing row is updated separately after the RPC succeeds.
  const importIdByStagedFileId = new Map(
    files.map((f) => [f.id, f.status === 'repair' ? (f.existing_import_id as string) : randomUUID()])
  );
  const importRows = files
    .filter((f) => f.status !== 'repair')
    .map((f) => ({
      id: importIdByStagedFileId.get(f.id),
      organization_id: f.organization_id,
      filename: f.filename,
      file_hash: f.file_hash,
      readings_stored: readings.filter((r) => r.staged_file_id === f.id).length,
      batch_id: batchId,
      measured_at: f.resolved_measured_at,
      filename_timestamp: f.filename_timestamp,
      week_number: f.week_number,
      timestamp_conflict: f.timestamp_conflict,
      timestamp_warning: f.timestamp_warning,
      hour_difference_minutes: f.hour_difference_minutes,
      hour_conflict: f.hour_conflict,
      hour_warning: f.hour_warning,
      raw_content: f.raw_content,
    }));

  const repairUpdates = files
    .filter((f) => f.status === 'repair')
    .map((f) => ({
      importId: f.existing_import_id as string,
      filename: f.filename,
      fileHash: f.file_hash,
      previousWrongMeasuredAt: f.existing_measured_at as string,
      correctedMeasuredAt: f.resolved_measured_at as string,
      readingsStored: readings.filter((r) => r.staged_file_id === f.id).length,
      rawContent: f.raw_content as string | null,
      hourDifferenceMinutes: f.hour_difference_minutes as number | null,
      hourWarning: f.hour_warning as string | null,
    }));

  const fileById = new Map(files.map((f) => [f.id, f]));

  for (const r of readings) {
    const key = `${r.zone_label}|${r.metric_name}|${r.measured_at}`;
    const existingValue = existingReadingMap.get(key);
    const file = fileById.get(r.staged_file_id);
    if (existingValue !== undefined) {
      if (sameValue(existingValue, r.value)) continue; // identical — skip silently, nothing to write
      const conflictId = `reading:${key}`;
      conflicts.push({
        conflictId, kind: 'reading',
        description: `${r.zone_label} / ${r.metric_name} @ ${r.measured_at}`,
        existingValue, newValue: r.value,
      });
      readingRows.push({
        conflictId, organization_id: r.organization_id, import_id: importIdByStagedFileId.get(r.staged_file_id) ?? null,
        zone_label: r.zone_label, measured_at: r.measured_at, metric_name: r.metric_name, value: r.value, unit: r.unit, source_file: file?.filename ?? null,
      });
      continue;
    }
    readingRows.push({
      organization_id: r.organization_id, import_id: importIdByStagedFileId.get(r.staged_file_id) ?? null,
      zone_label: r.zone_label, measured_at: r.measured_at, metric_name: r.metric_name, value: r.value, unit: r.unit, source_file: file?.filename ?? null,
    });
  }

  // ── Phase hourly (radiation, drain) ──────────────────────────────────────
  const phaseHourlyRows: ConflictRow[] = [];
  const readingsByTimestamp = new Map<string, typeof readings>();
  for (const r of readings) {
    if (!readingsByTimestamp.has(r.measured_at)) readingsByTimestamp.set(r.measured_at, []);
    readingsByTimestamp.get(r.measured_at)!.push(r);
  }

  const phasesTouched = new Set(
    Array.from(zoneByImportKey.values()).filter((z) => readings.some((r) => r.zone_label === z.import_key)).map((z) => z.phase_id)
  );

  // Track running cumulative per phase across this batch's chronological timestamps.
  const sortedTimestamps = Array.from(readingsByTimestamp.keys()).sort();
  const phaseRunningCumulative = new Map<string, { value: number; measuredAt: Date }>();
  for (const phaseId of phasesTouched) {
    const existingForPhase = existingPhaseHourly
      .filter((p) => p.phase_id === phaseId && new Date(p.measured_at) < new Date(sortedTimestamps[0] ?? 0))
      .sort((a, b) => new Date(b.measured_at).getTime() - new Date(a.measured_at).getTime())[0];
    if (existingForPhase?.radiation_cumulative_j_cm2 != null) {
      phaseRunningCumulative.set(phaseId, { value: existingForPhase.radiation_cumulative_j_cm2, measuredAt: new Date(existingForPhase.measured_at) });
    }
  }

  for (const ts of sortedTimestamps) {
    const rowsAtTs = readingsByTimestamp.get(ts)!;
    for (const phaseId of phasesTouched) {
      const zonesInPhase = Array.from(zoneByImportKey.values()).filter((z) => z.phase_id === phaseId).map((z) => z.import_key);
      const radiationReading = rowsAtTs.find((r) => r.metric_name === 'radiation_sum_j_cm2' && zonesInPhase.includes(r.zone_label));
      const drainReading = rowsAtTs.find((r) => r.metric_name === 'drain_water_pct' && zonesInPhase.includes(r.zone_label));
      if (!radiationReading && !drainReading) continue;

      const previous = phaseRunningCumulative.get(phaseId) ?? null;
      const computed: PhaseHourlyResult = computePhaseHourlyRow({
        measuredAt: new Date(ts),
        radiationValue: radiationReading?.value ?? null,
        drainValue: drainReading?.value ?? null,
        sourceZoneLabel: radiationReading?.zone_label ?? drainReading?.zone_label ?? null,
        previousRadiationCumulative: previous,
        timeZone: GREENHOUSE_TIME_ZONE,
      });
      if (computed.radiationCumulativeJCm2 != null) {
        phaseRunningCumulative.set(phaseId, { value: computed.radiationCumulativeJCm2, measuredAt: new Date(ts) });
      }

      const key = `${phaseId}|${ts}`;
      const existing = existingPhaseHourlyMap.get(key);
      const radiationCumulative = round(computed.radiationCumulativeJCm2, 2);
      const row = {
        organization_id: null, phase_id: phaseId, measured_at: ts,
        radiation_cumulative_j_cm2: radiationCumulative,
        radiation_interval_delta_j_cm2: round(computed.radiationIntervalDeltaJCm2, 2),
        radiation_interval_minutes: computed.radiationIntervalMinutes,
        radiation_quality_flag: computed.radiationQualityFlag,
        drain_water_pct: round(computed.drainWaterPct, 2),
        source_zone_label: computed.sourceZoneLabel,
        source_batch_id: batchId,
      };
      // Phase-hourly conflicts are folded into the reading-level conflict set
      // only when the underlying cumulative value actually differs.
      if (existing && !sameValue(existing.radiation_cumulative_j_cm2, radiationCumulative)) {
        conflicts.push({
          conflictId: `phase:${key}`, kind: 'reading',
          description: `Phase radiation @ ${ts}`,
          existingValue: existing.radiation_cumulative_j_cm2, newValue: radiationCumulative,
        });
        phaseHourlyRows.push({ conflictId: `phase:${key}`, ...row });
      } else {
        phaseHourlyRows.push(row);
      }
    }
  }

  // ── Variety hourly (averages + irrigation delta) ─────────────────────────
  const varietyHourlyRows: ConflictRow[] = [];
  const varietiesTouched = Array.from(varietyToZoneLabels.entries()).filter(([, zoneLabels]) =>
    zoneLabels.some((zl) => readings.some((r) => r.zone_label === zl))
  );

  const varietyRunningIrrigation = new Map<string, { value: number; measuredAt: Date }>();
  for (const [varietyId] of varietiesTouched) {
    const existingForVariety = existingVarietyHourly
      .filter((v) => v.variety_id === varietyId && new Date(v.measured_at) < new Date(sortedTimestamps[0] ?? 0))
      .sort((a, b) => new Date(b.measured_at).getTime() - new Date(a.measured_at).getTime())[0];
    if (existingForVariety?.irrigation_cumulative_avg_ml != null) {
      varietyRunningIrrigation.set(varietyId, { value: existingForVariety.irrigation_cumulative_avg_ml, measuredAt: new Date(existingForVariety.measured_at) });
    }
  }

  for (const ts of sortedTimestamps) {
    const rowsAtTs = readingsByTimestamp.get(ts)!;
    for (const [varietyId, zoneLabels] of varietiesTouched) {
      const anyZoneHasDataThisHour = zoneLabels.some((zl) => rowsAtTs.some((r) => r.zone_label === zl));
      if (!anyZoneHasDataThisHour) continue;

      const zonesForPhase = zoneLabels.map((zl) => zoneByImportKey.get(zl)).filter(Boolean);
      const phaseId = zonesForPhase[0]?.phase_id ?? null;
      const existingPhaseForTs = phaseId ? existingPhaseHourlyMap.get(`${phaseId}|${ts}`) : undefined;
      const justComputedPhase = phaseId ? phaseHourlyRows.find((p) => p.phase_id === phaseId && p.measured_at === ts) : undefined;
      const phaseRadiation = justComputedPhase
        ? { cumulativeJCm2: justComputedPhase.radiation_cumulative_j_cm2 as number | null, intervalDeltaJCm2: justComputedPhase.radiation_interval_delta_j_cm2 as number | null }
        : existingPhaseForTs
          ? { cumulativeJCm2: existingPhaseForTs.radiation_cumulative_j_cm2, intervalDeltaJCm2: existingPhaseForTs.radiation_interval_delta_j_cm2 }
          : null;

      const previousIrrigation = varietyRunningIrrigation.get(varietyId) ?? null;
      const computed: VarietyHourlyResult = computeVarietyHourlyRow({
        measuredAt: new Date(ts),
        linkedZoneLabels: zoneLabels,
        readings: rowsAtTs.map((r) => ({ zoneLabel: r.zone_label, metricName: r.metric_name, value: r.value, unit: r.unit ?? '' })),
        previousIrrigationCumulative: previousIrrigation,
        phaseId,
        phaseRadiation,
        timeZone: GREENHOUSE_TIME_ZONE,
      });
      if (computed.irrigationCumulativeAvgMl != null) {
        varietyRunningIrrigation.set(varietyId, { value: computed.irrigationCumulativeAvgMl, measuredAt: new Date(ts) });
      }

      const key = `${varietyId}|${ts}`;
      const existing = existingVarietyHourlyMap.get(key);
      const row = {
        organization_id: null, variety_id: varietyId, measured_at: ts,
        air_temperature_avg_c: round(computed.airTemperatureAvgC, 2), air_temperature_zone_count: computed.airTemperatureZoneCount,
        relative_humidity_avg_pct: round(computed.relativeHumidityAvgPct, 2), relative_humidity_zone_count: computed.relativeHumidityZoneCount,
        co2_avg_ppm: round(computed.co2AvgPpm, 2), co2_zone_count: computed.co2ZoneCount,
        ec_avg: round(computed.ecAvg, 3), ec_zone_count: computed.ecZoneCount,
        ph_avg: round(computed.phAvg, 3), ph_zone_count: computed.phZoneCount,
        irrigation_cumulative_avg_ml: round(computed.irrigationCumulativeAvgMl, 2), irrigation_zone_count: computed.irrigationZoneCount,
        irrigation_interval_delta_ml: round(computed.irrigationIntervalDeltaMl, 2), irrigation_interval_minutes: computed.irrigationIntervalMinutes,
        irrigation_quality_flag: computed.irrigationQualityFlag,
        expected_zone_count: computed.expectedZoneCount,
        phase_id: computed.phaseId, radiation_cumulative_j_cm2: round(computed.radiationCumulativeJCm2, 2), radiation_interval_delta_j_cm2: round(computed.radiationIntervalDeltaJCm2, 2),
        quality_warnings: computed.warnings,
        source_batch_id: batchId,
      };

      if (existing) {
        const differs =
          !sameValue(existing.air_temperature_avg_c, row.air_temperature_avg_c) ||
          !sameValue(existing.relative_humidity_avg_pct, row.relative_humidity_avg_pct) ||
          !sameValue(existing.co2_avg_ppm, row.co2_avg_ppm) ||
          !sameValue(existing.ec_avg, row.ec_avg) ||
          !sameValue(existing.ph_avg, row.ph_avg) ||
          !sameValue(existing.irrigation_cumulative_avg_ml, row.irrigation_cumulative_avg_ml);
        if (differs) {
          conflicts.push({
            conflictId: `variety:${key}`, kind: 'variety_hourly',
            description: `Variety average @ ${ts}`,
            existingValue: existing, newValue: row,
          });
          varietyHourlyRows.push({ conflictId: `variety:${key}`, ...row });
          continue;
        }
        continue; // identical — nothing to do
      }
      varietyHourlyRows.push(row);
    }
  }

  return {
    importRows,
    readingRows,
    phaseHourlyRows,
    varietyHourlyRows,
    conflicts,
    summary: {
      totalReadings: readings.length,
      newReadings: readingRows.filter((r) => !r.conflictId).length,
      newVarietyHourly: varietyHourlyRows.filter((r) => !r.conflictId).length,
      newPhaseHourly: phaseHourlyRows.filter((r) => !r.conflictId).length,
      conflictCount: conflicts.length,
      skippedIdenticalCount,
    },
    repairUpdates,
  };
}

export default router;
