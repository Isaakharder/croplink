// Shared hourly-rollup computation and application, used by every write path
// into phase_climate_hourly / variety_climate_hourly / variety_climate_hourly_features:
// the manual batch-upload-and-commit flow, the automated Climate Agent
// ingestion route, and the offline backfill script. Before Round 10 this
// logic existed only inline inside climateImportBatches.ts's buildCommitPlan,
// which the automated agent route never called — the reason
// variety_climate_hourly stopped advancing on 2026-07-17 while raw
// climate_readings kept growing. Extracting it here means manual and
// automated ingestion literally cannot diverge again: there is exactly one
// implementation of "how do raw readings become an hourly row."
import { randomUUID } from 'crypto';
import { supabase } from './supabase';
import { fetchAllRows } from './paginatedFetch';
import { computeVarietyHourlyRow, computePhaseHourlyRow, localCalendarDateKey, type VarietyHourlyResult, type PhaseHourlyResult, type DeltaFlag } from './climateAveraging';
import { GREENHOUSE_TIME_ZONE, zonedTimeToUtc } from './ridderParser';
import { recomputeVarietyClimateFeatures } from './climateFeatureRecompute';

/**
 * Thrown when a phase lock/lease couldn't be acquired, OR when a write-time
 * lease re-check found the lease had been taken over since acquisition --
 * a different job is (or was) writing an overlapping range for the same
 * phase. Callers should treat this as retryable (re-queue, don't treat as a
 * genuine failure).
 */
export class RollupLockContentionError extends Error {
  constructor(public readonly phaseId: string | null, detail: string) {
    super(detail);
    this.name = 'RollupLockContentionError';
  }
}

async function acquirePhaseLocks(phaseIds: string[], jobId: string): Promise<string[]> {
  const acquired: string[] = [];
  // Sorted ascending so two jobs that both need locks for the same MULTIPLE
  // phases always request them in the same order -- prevents a classic
  // A-locks-1-then-2 / B-locks-2-then-1 deadlock.
  const sorted = [...new Set(phaseIds)].sort();
  for (const phaseId of sorted) {
    const { data, error } = await supabase.rpc('acquire_climate_rollup_phase_lock', { p_phase_id: phaseId, p_job_id: jobId });
    if (error) throw new Error(`Failed to acquire lock for phase ${phaseId}: ${error.message}`);
    if (!data) {
      // Couldn't get this one -- release whatever we DID acquire before
      // bailing, so a partial failure never leaves phases locked with
      // nothing running to eventually release them.
      await releasePhaseLocks(acquired, jobId);
      throw new RollupLockContentionError(phaseId, `Phase ${phaseId} lease is held by another in-progress rollup job -- retryable, not a genuine failure.`);
    }
    acquired.push(phaseId);
  }
  return acquired;
}

async function releasePhaseLocks(phaseIds: string[], jobId: string): Promise<void> {
  for (const phaseId of phaseIds) {
    const { error } = await supabase.rpc('release_climate_rollup_phase_lock', { p_phase_id: phaseId, p_job_id: jobId });
    if (error) console.error(`Failed to release lock for phase ${phaseId} (job ${jobId}):`, error.message);
  }
}

export interface ReadingLike {
  zone_label: string;
  measured_at: string;
  metric_name: string;
  value: number;
  unit?: string | null;
}

export interface ZoneTopologyRow { id: string; import_key: string; phase_id: string }

export interface ZoneTopology {
  zoneByImportKey: Map<string, ZoneTopologyRow>;
  varietyToZoneLabels: Map<string, string[]>;
}

export async function loadZoneTopology(): Promise<ZoneTopology> {
  const { data: zones } = await supabase.from('zones').select('id, import_key, phase_id');
  const zoneByImportKey = new Map<string, ZoneTopologyRow>((zones ?? []).map((z) => [z.import_key as string, z as ZoneTopologyRow]));
  const { data: varietyZones } = await supabase.from('variety_zones').select('variety_id, zone_id');
  const zoneImportKeyById = new Map((zones ?? []).map((z) => [z.id, z.import_key as string]));
  const varietyToZoneLabels = new Map<string, string[]>();
  for (const vz of varietyZones ?? []) {
    const label = zoneImportKeyById.get(vz.zone_id);
    if (!label) continue;
    if (!varietyToZoneLabels.has(vz.variety_id)) varietyToZoneLabels.set(vz.variety_id, []);
    varietyToZoneLabels.get(vz.variety_id)!.push(label);
  }
  return { zoneByImportKey, varietyToZoneLabels };
}

/** Start of the greenhouse-local calendar day containing `isoTimestamp`, as a UTC ISO string. */
export function greenhouseDayStartUtc(isoTimestamp: string): string {
  const [y, m, d] = localCalendarDateKey(new Date(isoTimestamp), GREENHOUSE_TIME_ZONE).split('-').map(Number);
  return zonedTimeToUtc(y, m, d, 0, 0, 0, GREENHOUSE_TIME_ZONE).toISOString();
}

/**
 * The LAST hourly bucket of the greenhouse-local calendar day containing
 * `isoTimestamp` (i.e. one hour before the next local day starts), as a UTC
 * ISO string. Computed as "start of the next local calendar date, minus one
 * hour" via the real IANA timezone conversion (zonedTimeToUtc) for that
 * specific calendar date -- not naive +24h arithmetic -- so a DST-transition
 * day (23 or 25 hours) is still handled correctly, even though the current
 * backfill window doesn't cross one.
 */
export function greenhouseDayEndUtc(isoTimestamp: string): string {
  const [y, m, d] = localCalendarDateKey(new Date(isoTimestamp), GREENHOUSE_TIME_ZONE).split('-').map(Number);
  const nextDayStartLocal = new Date(Date.UTC(y, m - 1, d + 1)); // calendar-date arithmetic only, not a real instant
  const nextDayStartUtc = zonedTimeToUtc(
    nextDayStartLocal.getUTCFullYear(), nextDayStartLocal.getUTCMonth() + 1, nextDayStartLocal.getUTCDate(),
    0, 0, 0, GREENHOUSE_TIME_ZONE
  );
  return new Date(nextDayStartUtc.getTime() - 3600000).toISOString();
}

const VALUE_EPSILON = 0.0005;
export function sameValue(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < VALUE_EPSILON;
}

function round(v: number | null, decimals: number): number | null {
  if (v == null) return null;
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

export interface PhaseHourlyRowOut {
  organization_id: null;
  phase_id: string;
  measured_at: string;
  radiation_cumulative_j_cm2: number | null;
  radiation_interval_delta_j_cm2: number | null;
  radiation_interval_minutes: number | null;
  radiation_quality_flag: DeltaFlag | null;
  drain_water_pct: number | null;
  source_zone_label: string | null;
  source_batch_id: string | null;
}

export interface VarietyHourlyRowOut {
  organization_id: null;
  variety_id: string;
  measured_at: string;
  air_temperature_avg_c: number | null; air_temperature_zone_count: number;
  relative_humidity_avg_pct: number | null; relative_humidity_zone_count: number;
  vpd_avg_kpa: number | null; vpd_zone_count: number;
  co2_avg_ppm: number | null; co2_zone_count: number;
  ec_avg: number | null; ec_zone_count: number;
  ph_avg: number | null; ph_zone_count: number;
  irrigation_cumulative_avg_ml: number | null; irrigation_zone_count: number;
  irrigation_interval_delta_ml: number | null; irrigation_interval_minutes: number | null;
  irrigation_quality_flag: DeltaFlag | null;
  expected_zone_count: number;
  phase_id: string | null;
  radiation_cumulative_j_cm2: number | null;
  radiation_interval_delta_j_cm2: number | null;
  quality_warnings: string[];
  source_batch_id: string | null;
  temporal_covered: boolean;
  zones_linked: number;
  zones_reporting: number;
  zone_participation_pct: number | null;
  zone_diagnostics: VarietyHourlyResult['zoneDiagnostics'];
}

export interface ExistingPhaseHourlyRow { phase_id: string; measured_at: string; radiation_cumulative_j_cm2: number | null }
export interface ExistingVarietyHourlyRow {
  variety_id: string; measured_at: string; irrigation_cumulative_avg_ml: number | null;
  radiation_cumulative_j_cm2?: number | null; radiation_interval_delta_j_cm2?: number | null;
}

/**
 * Pure computation (no DB access): given already-resolved readings, zone/
 * variety topology, and the existing rows needed to seed cumulative
 * (radiation/irrigation) carry-forward, computes every phase/variety hourly
 * row implied by `readings`. Does not decide how a disagreement with an
 * already-stored row should be handled -- that policy differs by caller (the
 * manual commit flow surfaces a conflict for human resolution; the automated
 * rollup and backfill upsert unconditionally, since for their own affected
 * range they ARE the deterministic source of truth, recomputed from the same
 * math every time).
 */
export function computePhaseAndVarietyHourlyRows(params: {
  readings: ReadingLike[];
  topology: ZoneTopology;
  existingPhaseHourly: ExistingPhaseHourlyRow[];
  existingVarietyHourly: ExistingVarietyHourlyRow[];
  sourceBatchId: string | null;
}): { phaseHourlyRows: PhaseHourlyRowOut[]; varietyHourlyRows: VarietyHourlyRowOut[] } {
  const { readings, topology, existingPhaseHourly, existingVarietyHourly, sourceBatchId } = params;
  const { zoneByImportKey, varietyToZoneLabels } = topology;

  const readingsByTimestamp = new Map<string, ReadingLike[]>();
  for (const r of readings) {
    if (!readingsByTimestamp.has(r.measured_at)) readingsByTimestamp.set(r.measured_at, []);
    readingsByTimestamp.get(r.measured_at)!.push(r);
  }
  const sortedTimestamps = Array.from(readingsByTimestamp.keys()).sort();

  // ── Phase hourly (radiation, drain) ──────────────────────────────────────
  const phaseHourlyRows: PhaseHourlyRowOut[] = [];
  const phasesTouched = new Set(
    Array.from(zoneByImportKey.values()).filter((z) => readings.some((r) => r.zone_label === z.import_key)).map((z) => z.phase_id)
  );

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
      // .find() picks whichever zone reported this metric -- correct as long
      // as radiation/drain are genuinely single-sensor-per-phase (verified
      // live: only one zone ever reports either metric, for every phase
      // checked). If a future greenhouse configuration ever adds a second
      // radiation sensor within one phase, .find() would silently keep only
      // the first and drop the rest without averaging them -- which is
      // exactly the "average cumulative counters before deltas" failure mode
      // this round was asked to rule out, so it's surfaced loudly here
      // rather than assumed away. Fixing it properly (per-zone delta/reset
      // tracking, then averaging the deltas) needs its own carry-forward
      // structure and a product decision about what a multi-sensor phase
      // reading even means -- bigger than this check, deliberately not done
      // speculatively for a configuration that doesn't exist today.
      const radiationCandidates = rowsAtTs.filter((r) => r.metric_name === 'radiation_sum_j_cm2' && zonesInPhase.includes(r.zone_label));
      const drainCandidates = rowsAtTs.filter((r) => r.metric_name === 'drain_water_pct' && zonesInPhase.includes(r.zone_label));
      if (radiationCandidates.length > 1) console.warn(`[climateRollupService] Multiple zones reported radiation_sum_j_cm2 for phase ${phaseId} @ ${ts} (${radiationCandidates.map((r) => r.zone_label).join(', ')}) -- only ${radiationCandidates[0].zone_label} is being used, the rest are silently dropped. This assumption needs revisiting.`);
      if (drainCandidates.length > 1) console.warn(`[climateRollupService] Multiple zones reported drain_water_pct for phase ${phaseId} @ ${ts} (${drainCandidates.map((r) => r.zone_label).join(', ')}) -- only ${drainCandidates[0].zone_label} is being used, the rest are silently dropped. This assumption needs revisiting.`);
      const radiationReading = radiationCandidates[0];
      const drainReading = drainCandidates[0];
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

      phaseHourlyRows.push({
        organization_id: null, phase_id: phaseId, measured_at: ts,
        radiation_cumulative_j_cm2: round(computed.radiationCumulativeJCm2, 2),
        radiation_interval_delta_j_cm2: round(computed.radiationIntervalDeltaJCm2, 2),
        radiation_interval_minutes: computed.radiationIntervalMinutes,
        radiation_quality_flag: computed.radiationQualityFlag,
        drain_water_pct: round(computed.drainWaterPct, 2),
        source_zone_label: computed.sourceZoneLabel,
        source_batch_id: sourceBatchId,
      });
    }
  }

  // ── Variety hourly (averages + irrigation delta) ─────────────────────────
  const varietyHourlyRows: VarietyHourlyRowOut[] = [];
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

  const existingPhaseHourlyMap = new Map(existingPhaseHourly.map((r) => [`${r.phase_id}|${r.measured_at}`, r]));

  for (const ts of sortedTimestamps) {
    const rowsAtTs = readingsByTimestamp.get(ts)!;
    for (const [varietyId, zoneLabels] of varietiesTouched) {
      const anyZoneHasDataThisHour = zoneLabels.some((zl) => rowsAtTs.some((r) => r.zone_label === zl));
      if (!anyZoneHasDataThisHour) continue;

      const zonesForPhase = zoneLabels.map((zl) => zoneByImportKey.get(zl)).filter((z): z is ZoneTopologyRow => !!z);
      const phaseId = zonesForPhase[0]?.phase_id ?? null;
      const existingPhaseForTs = phaseId ? existingPhaseHourlyMap.get(`${phaseId}|${ts}`) : undefined;
      const justComputedPhase = phaseId ? phaseHourlyRows.find((p) => p.phase_id === phaseId && p.measured_at === ts) : undefined;
      const phaseRadiation = justComputedPhase
        ? { cumulativeJCm2: justComputedPhase.radiation_cumulative_j_cm2, intervalDeltaJCm2: justComputedPhase.radiation_interval_delta_j_cm2 }
        : existingPhaseForTs
          ? { cumulativeJCm2: existingPhaseForTs.radiation_cumulative_j_cm2 ?? null, intervalDeltaJCm2: null }
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

      varietyHourlyRows.push({
        organization_id: null, variety_id: varietyId, measured_at: ts,
        air_temperature_avg_c: round(computed.airTemperatureAvgC, 2), air_temperature_zone_count: computed.airTemperatureZoneCount,
        relative_humidity_avg_pct: round(computed.relativeHumidityAvgPct, 2), relative_humidity_zone_count: computed.relativeHumidityZoneCount,
        vpd_avg_kpa: computed.vpdAvgKpa, vpd_zone_count: computed.vpdZoneCount,
        co2_avg_ppm: round(computed.co2AvgPpm, 2), co2_zone_count: computed.co2ZoneCount,
        ec_avg: round(computed.ecAvg, 3), ec_zone_count: computed.ecZoneCount,
        ph_avg: round(computed.phAvg, 3), ph_zone_count: computed.phZoneCount,
        irrigation_cumulative_avg_ml: round(computed.irrigationCumulativeAvgMl, 2), irrigation_zone_count: computed.irrigationZoneCount,
        irrigation_interval_delta_ml: round(computed.irrigationIntervalDeltaMl, 2), irrigation_interval_minutes: computed.irrigationIntervalMinutes,
        irrigation_quality_flag: computed.irrigationQualityFlag,
        expected_zone_count: computed.expectedZoneCount,
        phase_id: computed.phaseId,
        radiation_cumulative_j_cm2: round(computed.radiationCumulativeJCm2, 2),
        radiation_interval_delta_j_cm2: round(computed.radiationIntervalDeltaJCm2, 2),
        quality_warnings: computed.warnings,
        source_batch_id: sourceBatchId,
        temporal_covered: computed.temporalCovered,
        zones_linked: computed.zonesLinked,
        zones_reporting: computed.zonesReporting,
        zone_participation_pct: computed.zoneParticipationPct,
        zone_diagnostics: computed.zoneDiagnostics,
      });
    }
  }

  return { phaseHourlyRows, varietyHourlyRows };
}

export interface RollupRangeResult {
  hoursWithReadings: number;
  phaseHourlyUpserted: number;
  varietyHourlyUpserted: number;
  featureHoursRecomputed: number;
}

/**
 * Idempotently (re)computes phase_climate_hourly, variety_climate_hourly, and
 * variety_climate_hourly_features from whatever is currently in
 * climate_readings, for the requested [startIso, endIso] plus enough
 * surrounding context to be ORDER-INDEPENDENT: the result for a given range
 * is the same regardless of what other jobs have or haven't run yet, what
 * order jobs run in, how many run concurrently, or how many times any of
 * them retry.
 *
 * How: carry-forward state (radiation/irrigation cumulative deltas, EC/pH
 * deltas) is seeded from RAW READINGS, never from another job's already-
 * written derived rows -- raw data is immutable and available immediately
 * after ingestion, unlike a sibling job's output, which may not exist yet
 * or may itself be mid-write. Concretely:
 *
 *   - Reads climate_readings from (greenhouse-local day start of startIso,
 *     minus 1 hour) through (the END of endIso's greenhouse-local day) --
 *     see the closure reasoning below for exactly why the forward padding
 *     has to reach the whole rest of the day, not a fixed +1 hour.
 *   - Runs computePhaseAndVarietyHourlyRows across that ENTIRE widened
 *     window in one call, with empty existingPhaseHourly/existingVarietyHourly
 *     -- its own internal same-call carry-forward loop (the mechanism
 *     already proven correct for single-pass continuous processing) then
 *     handles same-day/adjacent-hour logic correctly using only raw data.
 *   - Only UPSERTS rows from startIso through the end of that local day --
 *     the "core" range. Hours before startIso are computed purely as in-
 *     memory context to seed carry-forward correctly; they are NOT written
 *     here, since whichever job actually owns that earlier period will
 *     (whenever it runs, before or after this one) independently compute
 *     and write it the same way. This avoids every job redundantly
 *     rewriting the entire previous day while still being correct.
 *   - The forward write extension exists so that a LATE-ARRIVING reading,
 *     reprocessed via a new job for just its own hour, also corrects
 *     whichever LATER hour turns out to be the next one with a reading for
 *     that zone/metric -- which, given real gaps, is not reliably "the very
 *     next clock hour" (see below).
 *   - variety_climate_hourly_features gets the full computed set (core +
 *     context) passed in-memory as `contextRows`, so its own one-hour
 *     lookback for EC/pH deltas never depends on a DB round-trip that
 *     could hit not-yet-written data either.
 *
 * RECOMPUTATION CLOSURE -- why the forward padding is "rest of the local
 * day", not a fixed +1 clock hour:
 *
 * computeCumulativeDelta (radiation/irrigation) does NOT require its
 * `previous` argument to be exactly one hour earlier -- it only requires
 * the SAME greenhouse-local calendar day. The calling loop in
 * computePhaseAndVarietyHourlyRows only iterates timestamps that actually
 * HAVE a reading (`sortedTimestamps`, built from `readingsByTimestamp`'s
 * keys) -- a missing hour is simply never visited, so the running-
 * cumulative map (`phaseRunningCumulative` / `varietyRunningIrrigation`)
 * keeps whatever value it last saw and hands it to the NEXT hour that DOES
 * have a reading, however far away that is within the same day. Concretely:
 * a reading at 10:00 with nothing at 11:00 or 12:00 means 13:00's delta is
 * computed as value(13:00) - value(10:00) -- a change at 10:00 genuinely
 * reaches 13:00, not just "the next clock hour." A fixed +1 hour window
 * would silently fail to recompute 13:00 whenever a gap this size exists --
 * confirmed for real: the live dataset has 187 missing hours, the longest
 * single gap being 9 hours.
 *
 * computeHourlyFeatures's EC/pH deltas are the OPPOSITE: `adjacentHour`
 * requires the previous row to be EXACTLY 3,600,000ms (1 hour) earlier --
 * any gap, of any length, unconditionally breaks that chain (ecDelta/
 * phDelta become null, not "computed against whatever's earlier"). So EC/pH
 * never needs more than the existing 1-hour padding either direction.
 *
 * The forward closure is therefore bounded by the greenhouse-local-day
 * reset -- never beyond it, since a new day always starts
 * `first_reading_of_day` regardless of what came before, for BOTH
 * radiation/irrigation (explicit day check) and, in practice, EC/pH (a
 * cross-midnight gap of any length also breaks the exact-adjacency check).
 * Reading/writing through the end of the local day is therefore the tight,
 * provably-sufficient bound -- not a conservative guess, and not unbounded.
 * Traced per metric:
 *   - radiation (phase, single-sensor pass-through): bounded to the same
 *     greenhouse-local day (a new day always resets regardless of gap
 *     length) -- reaches the next ACTUAL reading, wherever in the day it is.
 *   - irrigation (variety, cross-zone-averaged cumulative): same rule.
 *   - drain: no delta/carry-forward at all (straight pass-through of the
 *     raw reading) -- zero cross-hour influence.
 *   - EC/pH deltas: exactly one hop forward, broken by ANY gap (including a
 *     sub-day one) -- this is also why the backward padding is
 *     `dayStart - 1 hour`, not just `dayStart`: the first hour of a new
 *     greenhouse-local day still needs the previous day's last hour as
 *     EC/pH delta context even though radiation/irrigation ignore it.
 *   - CO2, VPD, temperature, RH, zone-participation fields: pure per-hour
 *     averages, no carry-forward, zero cross-hour influence.
 * Proven against the real 55-day Mathieu dataset and synthetic gap/ordering/
 * concurrency scenarios in backfill-boundary.test.ts, climate-rollup-
 * service.test.ts, and rollup-order-independence.test.ts -- see those for
 * the executable proof, including gaps up to several hours, gaps crossing
 * midnight, and late insertions at the start/middle/end of a gap.
 * Reads don't filter by organization_id: mirrors the existing manual-commit
 * pipeline, where phase/variety hourly rows are always written with
 * organization_id=null regardless of which organization's readings fed them,
 * and zone/variety topology (import_key-based matching) is itself
 * organization-agnostic. Not a new behavior -- this preserves what the
 * pre-existing commit path already did.
 */
export interface RollupReadWindow {
  /** greenhouse-local day start of startIso, minus 1 hour -- see rollupClimateReadingRange's doc comment for why exactly this padding. */
  readStart: string;
  /** max(end of endIso's greenhouse-local day, endIso + 1 hour) -- see rollupClimateReadingRange's doc comment for why BOTH bounds are independently necessary, not just the larger-looking one. */
  readEnd: string;
}

/**
 * Pure, unit-testable window-math extracted from rollupClimateReadingRange:
 * given the requested [startIso, endIso], computes how far to widen the raw-
 * reading READ window so carry-forward context is self-sufficient from raw
 * data alone. Exported separately from the DB-touching orchestration around
 * it specifically so this math can be tested without a live database.
 *
 * readEnd is the LATER of two independently-necessary bounds, not just
 * "the rest of the day": end-of-local-day closes radiation/irrigation's
 * gap-spanning reach (bounded by the day reset, however many hours away);
 * endIso+1h closes EC/pH's exactly-one-hour adjacency, which is NOT bounded
 * by the day reset (it crosses local midnight whenever there's no gap,
 * since it only checks clock-hour adjacency, not calendar day). These
 * coincide in most cases, but diverge at the exact edge case where endIso
 * IS the last hour of its own local day -- there, end-of-day equals endIso
 * itself (zero extension), which would silently drop the +1h EC/pH needs.
 */
export function computeRollupReadWindow(startIso: string, endIso: string): RollupReadWindow {
  const dayEndMs = new Date(greenhouseDayEndUtc(endIso)).getTime();
  const plusOneHourMs = new Date(endIso).getTime() + 3600000;
  return {
    readStart: new Date(new Date(greenhouseDayStartUtc(startIso)).getTime() - 3600000).toISOString(),
    readEnd: new Date(Math.max(dayEndMs, plusOneHourMs)).toISOString(),
  };
}

/**
 * Pure, unit-testable core/context partition: given the full set of rows
 * computed across a widened window and the job's own originally-requested
 * `startIso`, splits out which rows this job actually owns and writes
 * ("core": measured_at >= startIso, which includes the rest-of-day forward
 * extension baked into readEnd) versus which were computed only to seed
 * carry-forward and must NOT be written here.
 */
export function partitionCoreRows<T extends { measured_at: string }>(rows: T[], startIso: string): { core: T[]; context: T[] } {
  // Epoch-ms comparison, not raw string comparison: `startIso` and a row's
  // `measured_at` aren't guaranteed to share the same timestamp string
  // format (e.g. with vs. without milliseconds) even when they represent
  // the same instant -- exactly the bug class this whole preflight has been
  // hunting down elsewhere (Supabase's "+00:00" vs. Date#toISOString()'s
  // ".000Z"). Comparing as real instants sidesteps it entirely.
  const startMs = new Date(startIso).getTime();
  const core: T[] = [];
  const context: T[] = [];
  for (const r of rows) (new Date(r.measured_at).getTime() >= startMs ? core : context).push(r);
  return { core, context };
}

/**
 * `jobId` identifies this call for phase-lock ownership/tracing (defaults to
 * a fresh id for ad-hoc callers). Pass the real climate_rollup_jobs.id from
 * the worker so a stuck lock can be traced back to its job record.
 */
export async function rollupClimateReadingRange(startIso: string, endIso: string, jobId: string = randomUUID()): Promise<RollupRangeResult> {
  const { readStart, readEnd } = computeRollupReadWindow(startIso, endIso);

  const readings = await fetchAllRows<ReadingLike>(() =>
    supabase.from('climate_readings').select('zone_label, measured_at, metric_name, value, unit').gte('measured_at', readStart).lte('measured_at', readEnd)
  );

  if (readings.length === 0) {
    return { hoursWithReadings: 0, phaseHourlyUpserted: 0, varietyHourlyUpserted: 0, featureHoursRecomputed: 0 };
  }

  const topology = await loadZoneTopology();

  // Empty existing-row lookback is deliberate: correctness now comes
  // entirely from `readings` spanning the widened window, computed in one
  // call so computePhaseAndVarietyHourlyRows's own internal carry-forward
  // loop handles it -- not from another job's already-written output.
  const { phaseHourlyRows: allPhaseRows, varietyHourlyRows: allVarietyRows } = computePhaseAndVarietyHourlyRows({
    readings, topology, existingPhaseHourly: [], existingVarietyHourly: [], sourceBatchId: null,
  });

  // "Core" = what this job actually owns and writes: its own requested
  // range plus the +1 hour forward extension. Everything before startIso
  // was computed only to seed carry-forward correctly and is deliberately
  // NOT written here.
  const { core: corePhaseRows } = partitionCoreRows(allPhaseRows, startIso);
  const { core: coreVarietyRows } = partitionCoreRows(allVarietyRows, startIso);

  // Concurrency protection (Phase 4): serialize the WRITE step for any
  // phase this job is about to touch, so two jobs with overlapping ranges
  // can never interleave their writes for the same phase. Determined from
  // what was actually computed (not the full static topology), so unrelated
  // phases with no data this range stay fully parallel. FOR UPDATE SKIP
  // LOCKED (in claim_climate_rollup_jobs) already prevents two workers from
  // claiming the same JOB row -- this is the separate, narrower protection
  // for two DIFFERENT jobs whose time ranges overlap.
  const affectedPhaseIds = new Set<string>();
  for (const r of corePhaseRows) affectedPhaseIds.add(r.phase_id);
  for (const r of coreVarietyRows) if (r.phase_id) affectedPhaseIds.add(r.phase_id);

  const lockedPhaseIds = await acquirePhaseLocks(Array.from(affectedPhaseIds), jobId);
  try {
    // Renew right before writing: the compute step above (fetch + pure
    // computation) has no natural checkpoint to interleave a mid-flight
    // heartbeat with -- real jobs measure well under a second per day of
    // data, so there's nothing to checkpoint DURING. This renewal exists
    // for the case that actually matters: a job whose fetch/compute phase
    // took unusually long (a slow query, a much wider range than a normal
    // day) gets a FRESH lease window for the write itself, rather than
    // writing against whatever fraction of the original lease happens to
    // remain. A renewal failure here (lease already taken over) is
    // equivalent to losing the race outright -- treated the same as a
    // write-time lease loss below.
    for (const phaseId of lockedPhaseIds) {
      const { data: renewed, error: renewError } = await supabase.rpc('renew_climate_rollup_phase_lock', { p_phase_id: phaseId, p_job_id: jobId });
      if (renewError) throw new Error(`Failed to renew lease for phase ${phaseId}: ${renewError.message}`);
      if (!renewed) throw new RollupLockContentionError(phaseId, `Phase ${phaseId} lease was taken over before renewal -- retryable, not a genuine failure.`);
    }

    // rollup_write_locked re-verifies (atomically, via FOR UPDATE) that this
    // job still holds a non-expired lease for every phase it's about to
    // write, THEN performs both upserts in the same transaction. If the
    // lease was taken over in the meantime, the whole call raises and rolls
    // back -- this is what actually stops a former owner from writing after
    // losing its lease, not just the earlier acquire step (acquiring only
    // stops a NEW owner from double-acquiring; it says nothing about an OLD
    // owner still mid-write).
    if (corePhaseRows.length > 0 || coreVarietyRows.length > 0) {
      const { error } = await supabase.rpc('rollup_write_locked', {
        p_job_id: jobId,
        p_phase_ids: Array.from(affectedPhaseIds),
        p_phase_hourly: corePhaseRows,
        p_variety_hourly: coreVarietyRows,
      });
      if (error) {
        if (error.message?.includes('LEASE_LOST')) throw new RollupLockContentionError(null, error.message);
        throw new Error(`rollup_write_locked failed: ${error.message}`);
      }
    }
    if (coreVarietyRows.length > 0) {
      // contextRows = the FULL widened set (core + pre-startIso context),
      // in memory -- so the features step's own one-hour lookback never
      // depends on a DB row that might not exist yet either. Features are
      // deliberately NOT inside the lease-checked transaction above: they're
      // a pure, deterministic function of the now-safely-written variety-
      // hourly data, so even a just-expired owner computing them afterward
      // produces the same correct result a new owner would -- redundant at
      // worst, never wrong, and idempotent upserts make redundant harmless.
      await recomputeVarietyClimateFeatures(
        coreVarietyRows.map((r) => ({ varietyId: r.variety_id, measuredAt: r.measured_at })),
        allVarietyRows
      );
    }
  } finally {
    await releasePhaseLocks(lockedPhaseIds, jobId);
  }

  const startMs = new Date(startIso).getTime();
  return {
    hoursWithReadings: new Set(readings.filter((r) => new Date(r.measured_at).getTime() >= startMs).map((r) => r.measured_at)).size,
    phaseHourlyUpserted: corePhaseRows.length,
    varietyHourlyUpserted: coreVarietyRows.length,
    featureHoursRecomputed: coreVarietyRows.length,
  };
}
