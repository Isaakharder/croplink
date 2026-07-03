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
  avgBreakerToHarvestWeeks: number;
  harvestedWithinOneWeekPercent: number;
  sampleSize: number;
  currentWeekBreakerCount: number;
  currentWeekMeasuredStemCount: number;
  currentWeekBreakerFruitPerM2: number;
  nextWeekBreakerKgEstimate: number;
  missingAfwWarning: boolean;
}

export interface RipeningActualsRow {
  setWeekNumber: number;
  setCount: number;
  harvestedByOffset: {
    week4: number; week5: number; week6: number; week7: number;
    week8: number; week9: number; week10: number;
  };
  harvestedPercentByOffset: {
    week4Percent: number; week5Percent: number; week6Percent: number; week7Percent: number;
    week8Percent: number; week9Percent: number; week10Percent: number;
  };
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
