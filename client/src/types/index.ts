export interface Season {
  id: string;
  organization_id?: string | null;
  name: string;
  year: number;
  plant_date?: string | null;
  pull_out_date?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Variety {
  id: string;
  organization_id?: string | null;
  season_id: string;
  name: string;
  color?: string | null;
  plant_date?: string | null;
  pull_out_date?: string | null;
  area_m2?: number | null;
  plant_count?: number | null;
  total_stem_count?: number | null;
  average_fruit_weight_grams?: number | null;
  case_kg?: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MeasurementRow {
  id: string;
  organization_id?: string | null;
  variety_id: string;
  row_name: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MeasurementStem {
  id: string;
  organization_id?: string | null;
  measurement_row_id: string;
  stem_name: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PlantNode {
  id: string;
  organization_id?: string | null;
  measurement_stem_id: string;
  node_number: number;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  node_label?: string | null;
  parent_node_id?: string | null;
  side?: 'left' | 'right' | null;
  is_side_shoot: boolean;
}

export type NodeStatus =
  | 'Aborted'
  | 'Pruned'
  | 'Flower'
  | 'SetFruit'
  | 'MatureGreen'
  | 'BreakerFruit'
  | 'Harvested';

export type LegacyNodeStatus = 'GolfBall' | 'Harvestable' | 'Missing' | 'Empty';
export type HistoricalNodeStatus = NodeStatus | LegacyNodeStatus;

export interface WeeklyNodeStatus {
  id: string;
  organization_id?: string | null;
  plant_node_id: string;
  season_id?: string | null;
  year: number;
  week_number: number;
  status: HistoricalNodeStatus;
  notes?: string | null;
  recorded_at: string;
  created_at: string;
  updated_at: string;
}

export interface HarvestTimingProfile {
  id: string;
  organization_id?: string | null;
  variety_id: string;
  year: number;
  set_week_number: number;
  avg_fruit_set: number;
  week1_percent: number;
  week2_percent: number;
  week3_percent: number;
  week4_percent: number;
  week5_percent: number;
  week6_percent: number;
  week7_percent: number;
  week8_percent: number;
  week9_percent: number;
  week10_percent: number;
  created_at: string;
  updated_at: string;
}

export interface FruitWeightByWeek {
  id: string;
  organization_id?: string | null;
  variety_id: string;
  year: number;
  week_number: number;
  weight_grams: number;
  created_at: string;
  updated_at: string;
}

export interface HarvestedEntry {
  id: string;
  organization_id?: string | null;
  variety_id: string;
  year: number;
  week_number: number;
  kg: number;
  cases?: number | null;
  case_weight_kg?: number | null;
  harvest_date: string;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectionWeek {
  week: number;
  projected_fruit_per_m2: number;
}

export interface ProjectionResult {
  weeks: ProjectionWeek[];
  total_projected: number;
  peak_week: number;
  peak_projected: number;
}

export interface MeasurementSummaryRecord {
  rowId: string;
  rowName: string;
  stemId: string;
  stemName: string;
  nodeId: string;
  nodeNumber: number;
  status: HistoricalNodeStatus | 'Not Recorded';
  recentlyHarvested: boolean;
  isActive: boolean;
}

export interface FruitSetByWeekEntry {
  weekNumber: number;
  setFruitCount: number;
  measuredStemCount: number;
  fruitSetPerM2: number;
}

export interface MobileRowCard {
  id: string;
  row_name: string;
  variety_id: string;
  sort_order: number;
  stem_count: number;
  last_updated: string;
}

export interface BreakerLearningResult {
  varietyId: string;
  year: number;
  currentWeek: number;
  nextWeek: number;
  avgBreakerToHarvestWeeks: number;
  harvestedWithinOneWeekPercent: number;
  sampleSize: number;
  varietyTotalStemCount: number;
  varietyAreaM2: number;
  currentWeekBreakerCount: number;
  currentWeekMeasuredStemCount: number;
  currentWeekBreakerFruitPerM2: number;
  nextWeekAfw: number;
  nextWeekBreakerKgEstimate: number;
  nextWeekBreakerKgEstimateRaw: number;
  minSampleSizeForAdjustment: number;
  adjustmentSuppressed: boolean;
  missingAfwWarning: boolean;
  currentWeekHarvestedCount: number;
  currentWeekHarvestedFruitPerM2: number;
  currentWeekAfw: number;
  currentWeekHarvestedKgEstimate: number;
  missingHarvestedAfwWarning: boolean;
}

export interface RipeningActualsOffsetCell {
  offset: number;
  hasOccurred: boolean;
  harvestedCount: number;
  harvestedPercent: number;
  harvestedSampleStems: string[];
  /** Fractional — a probabilistic forecast, not a confirmed count. */
  breakerExpectedCount: number;
  breakerExpectedPercent: number;
  breakerSampleStems: string[];
}

export interface RipeningActualsInstanceDetail {
  id: string;
  row: string;
  stem: string;
  node: number | null;
  setWeek: number;
  setDate: string | null;
  status: string;
  firstBreakerWeek: number | null;
  breakerDate: string | null;
  latestStatus: string | null;
  latestStatusWeek: number | null;
  actualHarvestWeek: number | null;
  originalExpectedHarvestWeek: number | null;
  currentExpectedHarvestWeek: number | null;
  rolledForward: boolean;
  needsReview: boolean;
  needsReviewReason: string | null;
}

export interface RipeningActualsRow {
  setWeekNumber: number;
  setCount: number;
  harvestedCount: number;
  harvestedPercent: number;
  abortedCount: number;
  prunedCount: number;
  /** status='set', never entered BreakerFruit (still SetFruit/MatureGreen). */
  otherOutstandingCount: number;
  /** status='set' with breaker history, but latest recorded status no longer confirms BreakerFruit — a data-quality flag, not a forecast input. */
  unreconciledCount: number;
  outsideWindowHarvestedCount: number;
  /** Actual current BreakerFruit count — integer, not a forecast. */
  breakerCount: number;
  breakerPercent: number;
  breakerEarlierExpectedCount: number;
  breakerLaterExpectedCount: number;
  breakerRolledForwardCount: number;
  offsets: RipeningActualsOffsetCell[];
  instances: RipeningActualsInstanceDetail[];
}

export interface RipeningActualsSummary {
  totalSetInstances: number;
  totalCompleted: number;
  totalOutstanding: number;
  totalAborted: number;
  totalPruned: number;
  totalCurrentBreakers: number;
  totalUnreconciled: number;
  totalBreakerRolledForward: number;
  sampleSize: number;
  avgWeeksToHarvest: number | null;
  medianWeeksToHarvest: number | null;
  modeWeeksToHarvest: number | null;
  cumulativePercentByOffset: Record<string, number>;
}

export interface BreakerForecastMeta {
  method: 'learned' | 'fallback';
  sampleSize: number;
  minSampleSize: number;
  profilePercent: {
    same: number;
    plus1: number;
    plus2: number;
    plus3: number;
    later: number;
  };
}

export interface RipeningActualsResult {
  rows: RipeningActualsRow[];
  summary: RipeningActualsSummary;
  breakerForecast: BreakerForecastMeta;
  currentWeek: number | null;
}

export interface HarvestProjectionWeek {
  week: number;
  projectedFruitPerM2: number;
  projectedKg: number;
}

export interface HarvestProjectionVariety {
  id: string;
  name: string;
  color: string | null;
  area_m2: number;
  totalKg: number;
  weeks: HarvestProjectionWeek[];
}

export interface HarvestProjectionWeeklyTotal {
  week: number;
  totalKg: number;
  byColor: Record<string, number>;
  byVariety: Record<string, number>;
}

export interface HarvestProjectionsResult {
  varieties: HarvestProjectionVariety[];
  weeklyTotals: HarvestProjectionWeeklyTotal[];
  varietyTotals: { id: string; name: string; color: string | null; totalKg: number }[];
  colorTotals: Record<string, number>;
}

export interface StemGrowthMeasurement {
  id: string;
  organization_id?: string | null;
  variety_id: string;
  season_id?: string | null;
  year: number;
  week_number: number;
  measurement_row_id: string;
  measurement_stem_id: string;
  growth_cm: number;
  top_node_number?: number | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Phase {
  id: string;
  organization_id?: string | null;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Zone {
  id: string;
  organization_id?: string | null;
  phase_id: string;
  name: string;
  import_key: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface VarietyZone {
  id: string;
  organization_id?: string | null;
  variety_id: string;
  zone_id: string;
  created_at: string;
}

export interface Block {
  id: string;
  organization_id?: string | null;
  name: string;
  climate_agent_block_key: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface BlockClimateSummary {
  id: string;
  organization_id?: string | null;
  block_id: string;
  measured_at: string;
  air_temperature_c?: number | null;
  relative_humidity_pct?: number | null;
  heating_setpoint_c?: number | null;
  created_at: string;
  updated_at: string;
}

// ── Variety-level hourly climate pipeline (manual CSV upload) ──────────────

export interface ClimateImportBatch {
  id: string;
  organization_id: string | null;
  status: 'pending' | 'committed' | 'failed' | 'cancelled';
  file_count: number;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
  error_message: string | null;
}

export interface SynoptaAgentImport {
  import_id: string;
  created_at: string;
  filename: string;
  file_hash: string;
  readings_stored: number;
  zones: string[];
  earliest_measured_at: string | null;
  latest_measured_at: string | null;
  source: 'Synopta Agent';
}

export interface ClimateImportStagedFileSummary {
  filename: string;
  status: 'parsed' | 'duplicate' | 'error' | 'repair';
  errorMessage: string | null;
  resolvedMeasuredAt: string | null;
  weekNumber: number | null;
  timestampConflict: boolean;
  timestampWarning: string | null;
  /** True only for a >1 hour System-Time-vs-filename discrepancy — needs explicit confirmation before import. */
  hourConflict: boolean;
  hourWarning: string | null;
  hourDifferenceMinutes: number | null;
  zoneCount: number;
}

export interface ClimateHourWarning {
  filename: string;
  warning: string;
  hourConflict: boolean;
  hourDifferenceMinutes: number | null;
}

export interface ClimateRepairDetail {
  filename: string;
  previousWrongMeasuredAt: string | null;
  correctedMeasuredAt: string | null;
}

export interface ClimateImportVarietyMapping {
  varietyName: string;
  zoneLabels: string[];
}

export interface ClimateDuplicateCandidate {
  stagedFileId: string;
  filename: string;
  value: number;
}

export interface ClimateDuplicateTimestampDetail {
  measuredAt: string;
  files: string[];
  identicalReadingCount: number;
  conflictingReadingCount: number;
  conflictingMetricsZones: { zoneLabel: string; metricName: string; candidates: ClimateDuplicateCandidate[] }[];
}

export interface ClimateImportPreview {
  batchId: string;
  filesParsed: number;
  filesFailed: number;
  filesDuplicate: number;
  filesRepair: number;
  repairDetails: ClimateRepairDetail[];
  files: ClimateImportStagedFileSummary[];
  timestampRange: { start: string; end: string } | null;
  uniqueTimestampCount: number;
  duplicateTimestamps: string[];
  identicalDuplicateTimestampCount: number;
  conflictingDuplicateTimestampCount: number;
  duplicateTimestampDetails: ClimateDuplicateTimestampDetail[];
  hasUnresolvedDuplicateConflicts: boolean;
  missingHours: number;
  timestampWarnings: { filename: string; warning: string | null }[];
  hourWarnings: ClimateHourWarning[];
  hasUnresolvedHourConflicts: boolean;
  detectedZones: string[];
  detectedMetrics: string[];
  unmatchedZones: string[];
  varietyMappings: ClimateImportVarietyMapping[];
  zonesWithoutVariety: string[];
  expectedVarietyHourRows: number;
  expectedPhaseHourRows: number;
}

export interface ClimateImportConflict {
  conflictId: string;
  kind: 'reading' | 'variety_hourly' | 'batch_duplicate' | 'hour_discrepancy';
  description: string;
  existingValue: unknown;
  newValue: unknown;
  candidates?: ClimateDuplicateCandidate[];
}

export interface ClimateImportConfirmResult {
  status: 'conflicts' | 'committed' | 'failed';
  conflicts?: ClimateImportConflict[];
  summary?: { totalReadings: number; newReadings: number; newVarietyHourly: number; newPhaseHourly: number; conflictCount: number; skippedIdenticalCount?: number };
  readingsCommitted?: number;
  readingsSkippedAsDuplicate?: number;
  varietyHourlyCommitted?: number;
  phaseHourlyCommitted?: number;
  repairedFiles?: string[];
  error?: string;
}

export interface ClimateTimestampCorrectionPreview {
  filename: string;
  importId: string;
  fileHash: string;
  oldMeasuredAtUtc: string;
  newMeasuredAtUtc: string;
  alreadyCorrect: boolean;
  movedReadingCount: number;
  recomputeTimestamps: string[];
  conflictsAtTarget: { zoneLabel: string; metricName: string; existingValue: number; movedValue: number }[];
  canApply: boolean;
}

export interface ClimateTimestampCorrectionResult {
  status: 'corrected';
  correctionId: string;
  movedReadingCount: number;
  recomputedTimestamps: string[];
}

export interface VarietyClimateHourlyRow {
  id: string;
  organization_id: string | null;
  variety_id: string;
  measured_at: string;
  air_temperature_avg_c: number | null;
  air_temperature_zone_count: number;
  relative_humidity_avg_pct: number | null;
  relative_humidity_zone_count: number;
  co2_avg_ppm: number | null;
  co2_zone_count: number;
  ec_avg: number | null;
  ec_zone_count: number;
  ph_avg: number | null;
  ph_zone_count: number;
  irrigation_cumulative_avg_ml: number | null;
  irrigation_zone_count: number;
  irrigation_interval_delta_ml: number | null;
  irrigation_interval_minutes: number | null;
  irrigation_quality_flag: 'ok' | 'first_reading_of_day' | 'negative_reset' | null;
  expected_zone_count: number;
  phase_id: string | null;
  /** Raw sensor running-total reading for this hour, not a value we compute. Can drop mid-day on a sensor/counter reset — see radiation_interval_delta_j_cm2 for the true per-hour delta. */
  radiation_cumulative_j_cm2: number | null;
  radiation_interval_delta_j_cm2: number | null;
  quality_warnings: string[];
  source_batch_id: string | null;
}

export interface VarietyClimateHourlyAggregatedRow {
  bucket: string;
  hourCount: number;
  airTemperatureAvgC: number | null;
  relativeHumidityAvgPct: number | null;
  co2AvgPpm: number | null;
  ecAvg: number | null;
  phAvg: number | null;
  irrigationIntervalTotalMl: number | null;
  irrigationCumulativeEndOfPeriodMl: number | null;
  /** The actual accumulated radiation for this bucket (sum of interval deltas, negative resets excluded). Use this for totals/charts/model inputs. */
  radiationIntervalTotalJCm2: number | null;
  /**
   * The raw sensor's own cumulative counter reading at the last hour of this
   * bucket — NOT a true accumulated total for the period. The counter can
   * reset mid-day (confirmed against real data), so this can read lower than
   * the period's actual accumulated radiation, or lower than an earlier hour
   * in the same bucket. Use radiationIntervalTotalJCm2 for anything that
   * needs "how much radiation accumulated during this period."
   */
  radiationCumulativeEndOfPeriodJCm2: number | null;
}

export type ClimateGranularity = 'hourly' | 'daily' | 'weekly';

export interface VarietyClimateHourlyResult {
  granularity: ClimateGranularity;
  rows: VarietyClimateHourlyRow[] | VarietyClimateHourlyAggregatedRow[];
  note?: string;
}

// ── Climate feature engine (Phase 1 + Phase 2) ──────────────────────────────
// Everything below mirrors server response shapes from climateFeatures.ts /
// varietyClimateFeatures.ts / climateExposureDataset.ts exactly — the client
// only visualizes these, it never recomputes them.

export type VpdBandKey = 'very_low' | 'low' | 'target' | 'elevated' | 'high';

export interface VpdBandDefinition {
  key: VpdBandKey;
  label: string;
  minKpa: number | null;
  maxKpa: number | null;
}

export interface ClimateFeatureConfig {
  vpdBands: VpdBandDefinition[];
  vpdBandConfigVersion: string;
  degreeHourBaseTempC: number;
  degreeHourUpperCapC: number;
  featureEngineVersion: string;
}

/** One row of variety_climate_hourly_features — the hourly granularity of GET /variety-features. */
export interface VarietyClimateHourlyFeatureRow {
  id: string;
  organization_id: string | null;
  variety_id: string;
  measured_at: string;
  degree_hours: number | null;
  vpd_kpa: number | null;
  vpd_band: VpdBandKey | null;
  is_daylight: boolean;
  ec_delta: number | null;
  ph_delta: number | null;
  co2_avg_ppm: number | null;
  radiation_interval_delta_j_cm2: number | null;
  irrigation_interval_delta_ml: number | null;
  irrigation_interval_minutes: number | null;
  source_variety_hourly_id: string | null;
  degree_hour_base_temp_c: number;
  degree_hour_upper_cap_c: number;
  vpd_band_config_version: string;
  feature_engine_version: string;
  created_at: string;
  updated_at: string;
}

/**
 * The shared exposure-window aggregate (aggregateExposureWindow on the
 * server) — used identically for a daily/weekly bucket, an ad-hoc /exposure
 * range, and each of a fruit instance's/cohort's four lifecycle windows.
 * coveragePct/hoursObserved/hoursExpected are what make a low-coverage
 * result visually distinguishable from a trustworthy one — always check
 * coveragePct before treating the other numbers at face value.
 */
export interface ExposureWindowFeatures {
  hoursObserved: number;
  hoursExpected: number;
  coveragePct: number | null;
  accumulatedDegreeHours: number | null;
  accumulatedRadiationJCm2: number | null;
  tempAvgC: number | null;
  tempMinC: number | null;
  tempMaxC: number | null;
  vpdAvgKpa: number | null;
  vpdMinKpa: number | null;
  vpdMaxKpa: number | null;
  vpdBandHours: Record<VpdBandKey, number>;
  co2AvgPpm: number | null;
  co2AvgDaylightPpm: number | null;
  co2AvgNightPpm: number | null;
  radiationWeightedCo2Ppm: number | null;
  irrigationTotalMl: number | null;
  irrigationEventCount: number;
  irrigationAvgIntervalMinutes: number | null;
  ecAvg: number | null;
  ecMin: number | null;
  ecMax: number | null;
  ecStdDev: number | null;
  phAvg: number | null;
  phMin: number | null;
  phMax: number | null;
  phStdDev: number | null;
}

/** One daily/weekly bucket of GET /variety-features — a full ExposureWindowFeatures plus bucket context. */
export interface VarietyClimateFeatureBucketRow extends ExposureWindowFeatures {
  bucket: string;
  hourCount: number;
  airTemperatureAvgC: number | null;
  relativeHumidityAvgPct: number | null;
}

export interface VarietyClimateFeatureResult {
  granularity: ClimateGranularity;
  rows: VarietyClimateHourlyFeatureRow[] | VarietyClimateFeatureBucketRow[];
  note?: string;
}

/** GET /variety-features/exposure response — one ExposureWindowFeatures for an arbitrary [start, end) range. */
export interface VarietyClimateExposureResult extends ExposureWindowFeatures {
  varietyId: string;
  start: string;
  end: string;
}

export type FruitInstanceStatus = 'set' | 'harvested' | 'aborted' | 'pruned';

/** One fruit_instances row joined to climate exposure across its four lifecycle windows (instance grain of the training dataset). */
export interface FruitInstanceClimateRow {
  fruitInstanceId: string;
  varietyId: string;
  plantNodeId: string;
  setYear: number;
  setWeekNumber: number;
  setDate: string;
  breakerYear: number | null;
  breakerWeekNumber: number | null;
  breakerDate: string | null;
  harvestedYear: number | null;
  harvestedWeekNumber: number | null;
  harvestedDate: string | null;
  status: FruitInstanceStatus;
  weeksToBreaker: number | null;
  weeksBreakerToHarvest: number | null;
  weeksSetToHarvest: number | null;
  setToCurrent: ExposureWindowFeatures | null;
  setToBreaker: ExposureWindowFeatures | null;
  breakerToHarvest: ExposureWindowFeatures | null;
  setToHarvest: ExposureWindowFeatures | null;
}

/** Set-week cohort grain of the training dataset — instance-level climate exposure averaged across the cohort. */
export interface SetWeekCohortClimateRow {
  varietyId: string;
  setYear: number;
  setWeekNumber: number;
  instanceCount: number;
  harvestedCount: number;
  abortedCount: number;
  prunedCount: number;
  openCount: number;
  avgWeeksToBreaker: number | null;
  avgWeeksBreakerToHarvest: number | null;
  avgWeeksSetToHarvest: number | null;
  setToCurrent: ExposureWindowFeatures | null;
  setToBreaker: ExposureWindowFeatures | null;
  breakerToHarvest: ExposureWindowFeatures | null;
  setToHarvest: ExposureWindowFeatures | null;
}

export type ClimateTrainingDatasetGrain = 'instance' | 'cohort';

export interface ClimateTrainingDatasetResult {
  varietyId: string;
  setYear: number;
  grain: ClimateTrainingDatasetGrain;
  /** Always 'not_used_by_any_model_yet' today — nothing consumes this data for prediction. */
  modelStatus: string;
  rows: FruitInstanceClimateRow[] | SetWeekCohortClimateRow[];
}

export type ExposureWindowKey = 'setToCurrent' | 'setToBreaker' | 'breakerToHarvest' | 'setToHarvest';

export type GrowlinkConnectionStatus = 'not_configured' | 'connected' | 'connection_failed';

export interface GrowlinkConnection {
  base_url: string | null;
  has_key: boolean;
  masked_key: string | null;
  status: GrowlinkConnectionStatus;
  last_tested_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}

export type GrowlinkConnectionTestResult =
  | { ok: true; varietyCount: number; varieties: unknown[] }
  | { ok: false; error: string };

export type GrowlinkLinkStatus = 'linked' | 'unlinked' | 'conflict';

export interface GrowlinkVarietyLink {
  id: string;
  organization_id?: string | null;
  variety_id: string;
  growlink_variety_key: string;
  link_status: GrowlinkLinkStatus;
  notes?: string | null;
  last_synced_at?: string | null;
  created_at: string;
  updated_at: string;
  variety?: { id: string; name: string; is_active: boolean } | null;
}

export interface GrowlinkHarvestActual {
  id: string;
  organization_id?: string | null;
  growlink_harvest_key: string;
  growlink_variety_key: string;
  variety_id?: string | null;
  harvest_date: string;
  year: number;
  week_number: number;
  kg?: number | null;
  cases?: number | null;
  case_weight_kg?: number | null;
  source_payload?: unknown | null;
  synced_at: string;
  created_at: string;
  updated_at: string;
  variety?: { id: string; name: string } | null;
}

export interface MeasurementSummaryResponse {
  summary: {
    totalMeasuredRows: number;
    totalMeasuredStems: number;
    totalNodesRecorded: number;
    statusCounts: Record<NodeStatus, number> & Partial<Record<LegacyNodeStatus, number>>;
    measuredStemCount: number;
    varietyAreaM2: number;
    varietyTotalStemCount: number;
    perM2ByStatus: Record<NodeStatus, number>;
  };
  records: MeasurementSummaryRecord[];
}
