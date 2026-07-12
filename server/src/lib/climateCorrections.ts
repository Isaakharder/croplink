// Manual correction of an already-committed source file's canonical hour —
// used when a parser/timestamp-resolution bug is discovered after commit
// (see ridderParser.ts resolveTimestamp: the filename hour is authoritative;
// System Time is validation-only). Moving a file's readings to a different
// hour can change the cumulative (irrigation/radiation) delta of the hour it
// left, the hour it now occupies, and the hour immediately after — because
// each of those deltas is computed against the *previous* cumulative value.
import { supabase } from './supabase';
import { fetchAllRows } from './fetchAllRows';
import { zonedTimeToUtc, GREENHOUSE_TIME_ZONE } from './ridderParser';
import { computeVarietyHourlyRow, computePhaseHourlyRow, localCalendarDateKey } from './climateAveraging';
import { recomputeVarietyClimateFeatures } from './climateFeatureRecompute';

interface ReadingLike { zone_label: string; metric_name: string; value: number; unit: string | null }

function localHourParts(iso: string): { year: number; month: number; day: number; hour: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: GREENHOUSE_TIME_ZONE, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: parts.hour === '24' ? 0 : Number(parts.hour) };
}

/** Every whole hour from `startIso` to `endIso` inclusive, ascending. */
function hourRange(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  let t = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  while (t <= end) {
    out.push(new Date(t).toISOString());
    t += 3600000;
  }
  return out;
}

async function loadZoneTopology() {
  const { data: zones } = await supabase.from('zones').select('id, import_key, phase_id');
  const zoneByImportKey = new Map((zones ?? []).map((z) => [z.import_key, z]));
  const { data: varietyZones } = await supabase.from('variety_zones').select('variety_id, zone_id');
  const zoneImportKeyById = new Map((zones ?? []).map((z) => [z.id, z.import_key]));
  const varietyToZoneLabels = new Map<string, string[]>();
  for (const vz of varietyZones ?? []) {
    const label = zoneImportKeyById.get(vz.zone_id);
    if (!label) continue;
    if (!varietyToZoneLabels.has(vz.variety_id)) varietyToZoneLabels.set(vz.variety_id, []);
    varietyToZoneLabels.get(vz.variety_id)!.push(label);
  }
  return { zoneByImportKey, varietyToZoneLabels };
}

export interface CorrectionConflict { zoneLabel: string; metricName: string; existingValue: number; movedValue: number }

export interface TimestampCorrectionPreview {
  filename: string;
  importId: string;
  fileHash: string;
  oldMeasuredAtUtc: string;
  newMeasuredAtUtc: string;
  alreadyCorrect: boolean;
  movedReadingCount: number;
  recomputeTimestamps: string[];
  conflictsAtTarget: CorrectionConflict[];
  canApply: boolean;
}

async function computeCorrectionPlan(filename: string) {
  const { data: imp } = await supabase.from('climate_imports').select('*').eq('filename', filename).maybeSingle();
  if (!imp) throw new Error(`No climate_imports row found for filename "${filename}".`);
  if (!imp.filename_timestamp) throw new Error(`"${filename}" has no filename_timestamp on record — cannot derive a corrected hour.`);

  const { year, month, day, hour } = localHourParts(imp.filename_timestamp);
  const newMeasuredAtUtc = zonedTimeToUtc(year, month, day, hour, 0, 0, GREENHOUSE_TIME_ZONE);
  const oldMeasuredAtUtc = new Date(imp.measured_at);
  const alreadyCorrect = newMeasuredAtUtc.getTime() === oldMeasuredAtUtc.getTime();

  const movedReadings = alreadyCorrect
    ? []
    : await fetchAllRows<ReadingLike & { id: string }>((from, to) =>
        supabase.from('climate_readings').select('id, zone_label, metric_name, value, unit')
          .eq('source_file', filename).eq('measured_at', oldMeasuredAtUtc.toISOString()).range(from, to)
      );

  const conflictsAtTarget: CorrectionConflict[] = [];
  if (!alreadyCorrect && movedReadings.length > 0) {
    const existingAtTarget = await fetchAllRows<{ zone_label: string; metric_name: string; value: number }>((from, to) =>
      supabase.from('climate_readings').select('zone_label, metric_name, value')
        .eq('measured_at', newMeasuredAtUtc.toISOString()).range(from, to)
    );
    const existingByKey = new Map(existingAtTarget.map((r) => [`${r.zone_label}|${r.metric_name}`, r.value]));
    for (const r of movedReadings) {
      const existingValue = existingByKey.get(`${r.zone_label}|${r.metric_name}`);
      if (existingValue !== undefined) {
        conflictsAtTarget.push({ zoneLabel: r.zone_label, metricName: r.metric_name, existingValue, movedValue: r.value });
      }
    }
  }

  const recomputeTimestamps = alreadyCorrect
    ? []
    : hourRange(
        new Date(Math.min(oldMeasuredAtUtc.getTime(), newMeasuredAtUtc.getTime())).toISOString(),
        new Date(Math.max(oldMeasuredAtUtc.getTime(), newMeasuredAtUtc.getTime())).toISOString(),
      );
  // Extend one hour past the later endpoint — its cumulative delta depends on
  // the (now corrected) cumulative value at that later endpoint — but only if
  // it's still the same greenhouse-local calendar day (a new day always
  // resets the delta regardless of what came before).
  if (recomputeTimestamps.length > 0) {
    const lastTs = recomputeTimestamps[recomputeTimestamps.length - 1];
    const nextTs = new Date(new Date(lastTs).getTime() + 3600000).toISOString();
    if (localCalendarDateKey(new Date(nextTs), GREENHOUSE_TIME_ZONE) === localCalendarDateKey(new Date(lastTs), GREENHOUSE_TIME_ZONE)) {
      recomputeTimestamps.push(nextTs);
    }
  }

  return { imp, oldMeasuredAtUtc, newMeasuredAtUtc, alreadyCorrect, movedReadings, conflictsAtTarget, recomputeTimestamps };
}

export async function previewTimestampCorrection(filename: string): Promise<TimestampCorrectionPreview> {
  const plan = await computeCorrectionPlan(filename);
  return {
    filename,
    importId: plan.imp.id,
    fileHash: plan.imp.file_hash,
    oldMeasuredAtUtc: plan.oldMeasuredAtUtc.toISOString(),
    newMeasuredAtUtc: plan.newMeasuredAtUtc.toISOString(),
    alreadyCorrect: plan.alreadyCorrect,
    movedReadingCount: plan.movedReadings.length,
    recomputeTimestamps: plan.recomputeTimestamps,
    conflictsAtTarget: plan.conflictsAtTarget,
    canApply: !plan.alreadyCorrect && plan.conflictsAtTarget.length === 0 && plan.movedReadings.length > 0,
  };
}

export async function applyTimestampCorrection(filename: string): Promise<{ correctionId: string; movedReadingCount: number; recomputedTimestamps: string[] }> {
  const plan = await computeCorrectionPlan(filename);
  if (plan.alreadyCorrect) throw new Error(`"${filename}" is already stored under its filename-authoritative hour — nothing to correct.`);
  if (plan.movedReadings.length === 0) throw new Error(`No committed climate_readings found for "${filename}" at ${plan.oldMeasuredAtUtc.toISOString()} — nothing to move.`);
  if (plan.conflictsAtTarget.length > 0) {
    throw new Error(
      `Refusing to correct "${filename}": ${plan.conflictsAtTarget.length} reading(s) already exist at the target hour ` +
      `(${plan.conflictsAtTarget.map((c) => `${c.zoneLabel}/${c.metricName}: existing=${c.existingValue} vs moved=${c.movedValue}`).join('; ')}).`
    );
  }

  const { zoneByImportKey, varietyToZoneLabels } = await loadZoneTopology();
  const oldIso = plan.oldMeasuredAtUtc.toISOString();
  const newIso = plan.newMeasuredAtUtc.toISOString();
  const movedByKey = new Map(plan.movedReadings.map((r) => [`${r.zone_label}|${r.metric_name}`, r]));

  const phaseHourlyRows: Record<string, unknown>[] = [];
  const varietyHourlyRows: Record<string, unknown>[] = [];
  const phaseCarry = new Map<string, { value: number; measuredAt: Date }>();
  const varietyCarry = new Map<string, { value: number; measuredAt: Date }>();

  const firstTs = plan.recomputeTimestamps[0];
  const allPhaseIds = Array.from(new Set(Array.from(zoneByImportKey.values()).map((z) => z.phase_id)));
  for (const phaseId of allPhaseIds) {
    const { data } = await supabase.from('phase_climate_hourly').select('measured_at, radiation_cumulative_j_cm2')
      .eq('phase_id', phaseId).lt('measured_at', firstTs).order('measured_at', { ascending: false }).limit(1);
    const row = data?.[0];
    if (row?.radiation_cumulative_j_cm2 != null) phaseCarry.set(phaseId, { value: row.radiation_cumulative_j_cm2, measuredAt: new Date(row.measured_at) });
  }
  const allVarietyIds = Array.from(varietyToZoneLabels.keys());
  for (const varietyId of allVarietyIds) {
    const { data } = await supabase.from('variety_climate_hourly').select('measured_at, irrigation_cumulative_avg_ml')
      .eq('variety_id', varietyId).lt('measured_at', firstTs).order('measured_at', { ascending: false }).limit(1);
    const row = data?.[0];
    if (row?.irrigation_cumulative_avg_ml != null) varietyCarry.set(varietyId, { value: row.irrigation_cumulative_avg_ml, measuredAt: new Date(row.measured_at) });
  }

  for (const ts of plan.recomputeTimestamps) {
    // Real readings present at this hour right now, MINUS anything belonging
    // to the file being moved away from oldIso, PLUS (at newIso) the moved
    // readings re-tagged to their corrected hour.
    const realAtTs = await fetchAllRows<ReadingLike & { source_file: string | null }>((from, to) =>
      supabase.from('climate_readings').select('zone_label, metric_name, value, unit, source_file').eq('measured_at', ts).range(from, to)
    );
    const readingsAtTs: ReadingLike[] = ts === oldIso
      ? realAtTs.filter((r) => r.source_file !== filename)
      : ts === newIso
        ? [...realAtTs, ...plan.movedReadings]
        : realAtTs;

    for (const [phaseId, zoneList] of Object.entries(
      Array.from(zoneByImportKey.values()).reduce<Record<string, string[]>>((acc, z) => {
        (acc[z.phase_id] ??= []).push(z.import_key);
        return acc;
      }, {})
    )) {
      const radiationReading = readingsAtTs.find((r) => r.metric_name === 'radiation_sum_j_cm2' && zoneList.includes(r.zone_label));
      const drainReading = readingsAtTs.find((r) => r.metric_name === 'drain_water_pct' && zoneList.includes(r.zone_label));
      if (!radiationReading && !drainReading) continue; // matches buildCommitPlan's guard — don't create empty phase rows for untouched phases
      const previous = phaseCarry.get(phaseId) ?? null;
      const computed = computePhaseHourlyRow({
        measuredAt: new Date(ts),
        radiationValue: radiationReading?.value ?? null,
        drainValue: drainReading?.value ?? null,
        sourceZoneLabel: radiationReading?.zone_label ?? drainReading?.zone_label ?? null,
        previousRadiationCumulative: previous,
        timeZone: GREENHOUSE_TIME_ZONE,
      });
      if (computed.radiationCumulativeJCm2 != null) phaseCarry.set(phaseId, { value: computed.radiationCumulativeJCm2, measuredAt: new Date(ts) });
      phaseHourlyRows.push({
        organization_id: null, phase_id: phaseId, measured_at: ts,
        radiation_cumulative_j_cm2: computed.radiationCumulativeJCm2,
        radiation_interval_delta_j_cm2: computed.radiationIntervalDeltaJCm2,
        radiation_interval_minutes: computed.radiationIntervalMinutes,
        radiation_quality_flag: computed.radiationQualityFlag,
        drain_water_pct: computed.drainWaterPct,
        source_zone_label: computed.sourceZoneLabel,
        source_batch_id: null,
      });
    }

    for (const [varietyId, zoneLabels] of varietyToZoneLabels) {
      const anyZoneHasData = zoneLabels.some((zl) => readingsAtTs.some((r) => r.zone_label === zl));
      if (!anyZoneHasData) continue;
      const zonesForVariety = zoneLabels.map((zl) => zoneByImportKey.get(zl)).filter(Boolean) as { phase_id: string }[];
      const phaseId = zonesForVariety[0]?.phase_id ?? null;
      const justComputedPhase = phaseId ? phaseHourlyRows.find((p) => p.phase_id === phaseId && p.measured_at === ts) : undefined;
      const phaseRadiation = justComputedPhase
        ? { cumulativeJCm2: justComputedPhase.radiation_cumulative_j_cm2 as number | null, intervalDeltaJCm2: justComputedPhase.radiation_interval_delta_j_cm2 as number | null }
        : null;
      const previousIrrigation = varietyCarry.get(varietyId) ?? null;
      const computed = computeVarietyHourlyRow({
        measuredAt: new Date(ts),
        linkedZoneLabels: zoneLabels,
        readings: readingsAtTs.map((r) => ({ zoneLabel: r.zone_label, metricName: r.metric_name, value: r.value, unit: r.unit ?? '' })),
        previousIrrigationCumulative: previousIrrigation,
        phaseId,
        phaseRadiation,
        timeZone: GREENHOUSE_TIME_ZONE,
      });
      if (computed.irrigationCumulativeAvgMl != null) varietyCarry.set(varietyId, { value: computed.irrigationCumulativeAvgMl, measuredAt: new Date(ts) });
      varietyHourlyRows.push({
        organization_id: null, variety_id: varietyId, measured_at: ts,
        air_temperature_avg_c: computed.airTemperatureAvgC, air_temperature_zone_count: computed.airTemperatureZoneCount,
        relative_humidity_avg_pct: computed.relativeHumidityAvgPct, relative_humidity_zone_count: computed.relativeHumidityZoneCount,
        co2_avg_ppm: computed.co2AvgPpm, co2_zone_count: computed.co2ZoneCount,
        ec_avg: computed.ecAvg, ec_zone_count: computed.ecZoneCount,
        ph_avg: computed.phAvg, ph_zone_count: computed.phZoneCount,
        irrigation_cumulative_avg_ml: computed.irrigationCumulativeAvgMl, irrigation_zone_count: computed.irrigationZoneCount,
        irrigation_interval_delta_ml: computed.irrigationIntervalDeltaMl, irrigation_interval_minutes: computed.irrigationIntervalMinutes,
        irrigation_quality_flag: computed.irrigationQualityFlag,
        expected_zone_count: computed.expectedZoneCount,
        phase_id: computed.phaseId, radiation_cumulative_j_cm2: computed.radiationCumulativeJCm2, radiation_interval_delta_j_cm2: computed.radiationIntervalDeltaJCm2,
        quality_warnings: computed.warnings,
        source_batch_id: null,
      });
    }
  }

  const { data: correctionId, error: rpcError } = await supabase.rpc('correct_climate_reading_timestamp', {
    p_source_filename: filename,
    p_old_measured_at: oldIso,
    p_new_measured_at: newIso,
    p_import_id: plan.imp.id,
    p_import_updates: {
      measured_at: newIso,
      hour_difference_minutes: 0,
      hour_conflict: false,
      hour_warning: null,
      readings_stored: plan.movedReadings.length,
    },
    p_phase_hourly: phaseHourlyRows,
    p_variety_hourly: varietyHourlyRows,
    p_correction_audit: {
      organization_id: null,
      correction_type: 'timestamp_relabel',
      source_filename: filename,
      source_file_hash: plan.imp.file_hash,
      old_measured_at: oldIso,
      new_measured_at: newIso,
      affected_reading_count: plan.movedReadings.length,
      affected_variety_hourly_ids: [],
      affected_phase_hourly_ids: [],
      notes: `Filename hour is authoritative; System Time-derived hour (${new Date(oldIso).toISOString()}) was stale relative to the filename (${new Date(newIso).toISOString()}).`,
    },
  });
  if (rpcError) throw new Error(rpcError.message);

  const [{ data: varietyIdsData }, { data: phaseIdsData }] = await Promise.all([
    supabase.from('variety_climate_hourly').select('id').in('measured_at', plan.recomputeTimestamps),
    supabase.from('phase_climate_hourly').select('id').in('measured_at', plan.recomputeTimestamps),
  ]);
  await supabase.rpc('set_climate_correction_affected_ids', {
    p_correction_id: correctionId,
    p_variety_hourly_ids: (varietyIdsData ?? []).map((r) => r.id),
    p_phase_hourly_ids: (phaseIdsData ?? []).map((r) => r.id),
  });

  // Best-effort: re-derive Phase 1 climate features for every hour whose
  // variety_climate_hourly row was just recomputed. Never fails the
  // correction — a bug here shouldn't block fixing bad timestamps.
  try {
    await recomputeVarietyClimateFeatures(
      varietyHourlyRows.map((r) => ({ varietyId: r.variety_id as string, measuredAt: r.measured_at as string }))
    );
  } catch (featureError) {
    console.error('Failed to recompute variety_climate_hourly_features after timestamp correction:', featureError);
  }

  return { correctionId: correctionId as string, movedReadingCount: plan.movedReadings.length, recomputedTimestamps: plan.recomputeTimestamps };
}
