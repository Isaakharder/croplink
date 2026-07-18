// Deterministic "Past 24 Hours Climate Summary" engine.
//
// Every number and sentence produced here is computed directly from the
// VarietyClimateHourlyRow rows already returned by GET /variety-hourly —
// nothing in this file calls an AI/LLM or invents a claim that can't be
// traced back to a specific calculation below. If a later feature adds an
// AI-generated interpretation layer on top of this summary, it must be
// rendered in a visually distinct section, never merged into the sentences
// this module produces.
import type { VarietyClimateHourlyRow } from '../types';

export type SummaryMetricKey = 'air_temperature' | 'relative_humidity' | 'co2' | 'ec' | 'ph' | 'radiation_interval';

export interface SummaryMetricDef {
  key: SummaryMetricKey;
  label: string;
  shortLabel: string;
  unit: string;
  field: keyof VarietyClimateHourlyRow;
  supportsTarget: boolean;
  digits: number;
  /**
   * True only for radiation_interval_delta_j_cm2: a negative value there is a
   * sensor/counter reset artifact, not a real reading (see the identical
   * exclusion in VarietyClimateHourlyAggregatedRow.radiationIntervalTotalJCm2
   * and the red-flagged bars in ClimateAnalysisTab). Averaging or reporting a
   * "largest fall" that includes a reset would describe a sensor glitch as if
   * it were a real environmental swing, so those hours are excluded from
   * every stat below — same rule the rest of the app already applies to this
   * metric, just applied here too.
   */
  excludeNegative?: boolean;
}

// Only metrics with a natural "average/min/max/current" reading are summarized
// here — irrigation is an interval total, not a level, so it doesn't fit this
// shape and stays on the full chart. Radiation has no configurable target
// (there's no existing grower-setpoint concept for it in this app).
export const SUMMARY_METRICS: SummaryMetricDef[] = [
  { key: 'air_temperature', label: 'Air Temperature', shortLabel: 'Temperature', unit: '°C', field: 'air_temperature_avg_c', supportsTarget: true, digits: 1 },
  { key: 'relative_humidity', label: 'Relative Humidity', shortLabel: 'Humidity', unit: '%', field: 'relative_humidity_avg_pct', supportsTarget: true, digits: 0 },
  { key: 'co2', label: 'CO₂', shortLabel: 'CO₂', unit: 'ppm', field: 'co2_avg_ppm', supportsTarget: true, digits: 0 },
  { key: 'ec', label: 'EC', shortLabel: 'EC', unit: 'mS/cm', field: 'ec_avg', supportsTarget: true, digits: 2 },
  { key: 'ph', label: 'pH', shortLabel: 'pH', unit: '', field: 'ph_avg', supportsTarget: true, digits: 2 },
  { key: 'radiation_interval', label: 'Radiation', shortLabel: 'Radiation', unit: ' J/cm²', field: 'radiation_interval_delta_j_cm2', supportsTarget: false, digits: 1, excludeNegative: true },
];

// The four metrics the compact 24h timeline shows, per the spec — "where
// available" is handled by the component (a sparkline with zero points just
// isn't rendered).
export const TIMELINE_METRIC_KEYS: SummaryMetricKey[] = ['air_temperature', 'relative_humidity', 'co2', 'radiation_interval'];

export interface TargetRange { min: number | null; max: number | null }
export type TargetConfig = Partial<Record<SummaryMetricKey, TargetRange>>;

// Grower-configured target ranges. No backend concept of this exists yet
// elsewhere in the app, so this is stored locally rather than inventing a
// server table this feature doesn't otherwise need — it's per-browser, not
// per-organization, and that's an intentional scope limit, not an oversight.
const TARGET_STORAGE_KEY = 'croplink.climateSummaryTargets.v1';

export function loadTargetConfig(): TargetConfig {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(TARGET_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TargetConfig) : {};
  } catch {
    return {};
  }
}

export function saveTargetConfig(config: TargetConfig): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(TARGET_STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* best-effort — a private-browsing quota error shouldn't break the page */
  }
}

export interface ExtremePoint { value: number; at: string }
export interface SwingPoint { delta: number; fromAt: string; toAt: string; fromValue: number; toValue: number }

export interface MetricSummaryStat {
  key: SummaryMetricKey;
  label: string;
  shortLabel: string;
  unit: string;
  digits: number;
  hoursObserved: number;
  /** Hours excluded from every stat above because they're a sensor-reset artifact (radiation only — see SummaryMetricDef.excludeNegative). */
  excludedNegativeCount: number;
  avg: number | null;
  min: ExtremePoint | null;
  max: ExtremePoint | null;
  current: ExtremePoint | null;
  largestRise: SwingPoint | null;
  largestFall: SwingPoint | null;
  target: TargetRange | null;
  hoursAboveTarget: number;
  hoursBelowTarget: number;
  longestBreachRunHours: number;
  longestBreachRunStart: string | null;
  longestBreachRunEnd: string | null;
  previousAvg: number | null;
  previousHoursObserved: number;
  deltaFromPrevious: number | null;
}

export const EXPECTED_WINDOW_HOURS = 24;

// Same threshold ClimatePage already uses for its "no Synopta data in the
// last N hours" staleness warning (SYNOPTA_STALE_WARNING_HOURS) — reused here
// so "is this genuinely current" means the same thing in both places.
export const FRESHNESS_THRESHOLD_HOURS = 2;

export interface SummaryWindow {
  windowStartIso: string;
  windowEndIso: string;
  previousStartIso: string;
  /** True when the newest available measurement is within FRESHNESS_THRESHOLD_HOURS of `now` — i.e. this genuinely is "the past 24 hours," not stale historical data being presented as if it were current. */
  isLive: boolean;
}

/**
 * Determines the summary's window from whatever data is actually available,
 * instead of assuming "now" has data. `rows` must be the SAME unbounded
 * variety_climate_hourly rows the full chart's query would return for this
 * variety (no date filter) — that's what guarantees the summary's "is there
 * any data at all" answer can never diverge from the chart's: this returns
 * null only when `rows` is empty, exactly the condition under which the
 * chart would also show nothing.
 */
export function resolveSummaryWindow(rows: VarietyClimateHourlyRow[], now: Date): SummaryWindow | null {
  if (rows.length === 0) return null;
  let latestMs = -Infinity;
  for (const r of rows) {
    const t = new Date(r.measured_at).getTime();
    if (t > latestMs) latestMs = t;
  }
  const windowStart = new Date(latestMs - EXPECTED_WINDOW_HOURS * 3_600_000);
  const previousStart = new Date(latestMs - 2 * EXPECTED_WINDOW_HOURS * 3_600_000);
  return {
    windowStartIso: windowStart.toISOString(),
    windowEndIso: new Date(latestMs).toISOString(),
    previousStartIso: previousStart.toISOString(),
    isLive: now.getTime() - latestMs <= FRESHNESS_THRESHOLD_HOURS * 3_600_000,
  };
}

/** Splits rows into the window's current/previous 24h buckets — both ends bounded, so a row can't land in "current" just because it's newer than windowEnd. */
export function splitByWindow(
  rows: VarietyClimateHourlyRow[],
  window: SummaryWindow
): { currentRows: VarietyClimateHourlyRow[]; previousRows: VarietyClimateHourlyRow[] } {
  const startMs = new Date(window.windowStartIso).getTime();
  const endMs = new Date(window.windowEndIso).getTime();
  const prevStartMs = new Date(window.previousStartIso).getTime();
  const currentRows: VarietyClimateHourlyRow[] = [];
  const previousRows: VarietyClimateHourlyRow[] = [];
  for (const r of rows) {
    const t = new Date(r.measured_at).getTime();
    if (t >= startMs && t <= endMs) currentRows.push(r);
    else if (t >= prevStartMs && t < startMs) previousRows.push(r);
  }
  const byTime = (a: VarietyClimateHourlyRow, b: VarietyClimateHourlyRow) => new Date(a.measured_at).getTime() - new Date(b.measured_at).getTime();
  currentRows.sort(byTime);
  previousRows.sort(byTime);
  return { currentRows, previousRows };
}

/**
 * A raw value, or null if it's missing or (for excludeNegative metrics) a
 * sensor-reset artifact. Exported so the compact timeline sparkline can apply
 * the same exclusion as the stat tiles — a reset artifact dominating a
 * "glance at a glance" chart's scale would defeat the point of it just as
 * much as reporting it as a real average/min/max would.
 */
export function readValue(row: VarietyClimateHourlyRow, def: SummaryMetricDef): number | null {
  const v = row[def.field] as number | null;
  if (v == null) return null;
  if (def.excludeNegative && v < 0) return null;
  return v;
}

function extractPoints(rows: VarietyClimateHourlyRow[], def: SummaryMetricDef): { at: string; value: number }[] {
  return rows
    .map((r) => ({ at: r.measured_at, value: readValue(r, def) }))
    .filter((p): p is { at: string; value: number } => p.value != null);
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function targetStatus(value: number, target: TargetRange): 'above' | 'below' | 'in' {
  if (target.max != null && value > target.max) return 'above';
  if (target.min != null && value < target.min) return 'below';
  return 'in';
}

export function computeMetricSummary(
  def: SummaryMetricDef,
  currentRows: VarietyClimateHourlyRow[],
  previousRows: VarietyClimateHourlyRow[],
  target: TargetRange | null
): MetricSummaryStat {
  const points = extractPoints(currentRows, def);
  const excludedNegativeCount = def.excludeNegative
    ? currentRows.filter((r) => (r[def.field] as number | null) != null && (r[def.field] as number) < 0).length
    : 0;

  let min: ExtremePoint | null = null;
  let max: ExtremePoint | null = null;
  for (const p of points) {
    if (!min || p.value < min.value) min = p;
    if (!max || p.value > max.value) max = p;
  }
  const current = points.length > 0 ? points[points.length - 1] : null;

  // Rise/fall are only measured between chronologically ADJACENT hourly rows
  // that both have a value — a data gap must never be counted as a "swing,"
  // since that would attribute a change to time that was never observed.
  // (readValue() also excludes sensor-reset artifacts for radiation, same as extractPoints above.)
  let largestRise: SwingPoint | null = null;
  let largestFall: SwingPoint | null = null;
  for (let i = 1; i < currentRows.length; i++) {
    const prevVal = readValue(currentRows[i - 1], def);
    const curVal = readValue(currentRows[i], def);
    if (prevVal == null || curVal == null) continue;
    const delta = curVal - prevVal;
    if (delta > 0 && (!largestRise || delta > largestRise.delta)) {
      largestRise = { delta, fromAt: currentRows[i - 1].measured_at, toAt: currentRows[i].measured_at, fromValue: prevVal, toValue: curVal };
    }
    if (delta < 0 && (!largestFall || delta < largestFall.delta)) {
      largestFall = { delta, fromAt: currentRows[i - 1].measured_at, toAt: currentRows[i].measured_at, fromValue: prevVal, toValue: curVal };
    }
  }

  let hoursAboveTarget = 0;
  let hoursBelowTarget = 0;
  let currentRun = 0;
  let currentRunStart: string | null = null;
  let longestBreachRunHours = 0;
  let longestBreachRunStart: string | null = null;
  let longestBreachRunEnd: string | null = null;
  const hasTarget = !!target && (target.min != null || target.max != null);
  if (hasTarget) {
    for (const p of points) {
      const status = targetStatus(p.value, target as TargetRange);
      if (status === 'above') hoursAboveTarget++;
      if (status === 'below') hoursBelowTarget++;
      if (status !== 'in') {
        if (currentRun === 0) currentRunStart = p.at;
        currentRun++;
        if (currentRun > longestBreachRunHours) {
          longestBreachRunHours = currentRun;
          longestBreachRunStart = currentRunStart;
          longestBreachRunEnd = p.at;
        }
      } else {
        currentRun = 0;
        currentRunStart = null;
      }
    }
  }

  const previousValues = extractPoints(previousRows, def).map((p) => p.value);
  const previousAvg = mean(previousValues);
  const avg = mean(points.map((p) => p.value));

  return {
    key: def.key,
    label: def.label,
    shortLabel: def.shortLabel,
    unit: def.unit,
    digits: def.digits,
    hoursObserved: points.length,
    excludedNegativeCount,
    avg,
    min,
    max,
    current,
    largestRise,
    largestFall,
    target: hasTarget ? (target as TargetRange) : null,
    hoursAboveTarget,
    hoursBelowTarget,
    longestBreachRunHours,
    longestBreachRunStart,
    longestBreachRunEnd,
    previousAvg,
    previousHoursObserved: previousValues.length,
    deltaFromPrevious: avg != null && previousAvg != null ? avg - previousAvg : null,
  };
}

export interface ClimateSummaryResult {
  metrics: MetricSummaryStat[];
  hoursObservedTotal: number;
  hoursExpectedTotal: number;
  missingHourCount: number;
  /** Deterministic 1–2 sentence overview — see buildOverviewSentence. Never AI-generated. */
  overview: string;
  /** Deterministic notable-event strings; empty when nothing in the data warrants flagging. */
  notableEvents: string[];
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function buildOverviewSentence(varietyName: string, headline: MetricSummaryStat, notableEventCount: number, isLive: boolean): string {
  if (headline.hoursObserved === 0 || headline.avg == null || headline.min == null || headline.max == null || headline.current == null) {
    const periodPhrase = isLive ? 'in the past 24 hours' : 'in this period';
    return `No ${headline.label.toLowerCase()} data has been recorded for ${varietyName} ${periodPhrase}.`;
  }
  const avgStr = headline.avg.toFixed(headline.digits);
  const minStr = headline.min.value.toFixed(headline.digits);
  const maxStr = headline.max.value.toFixed(headline.digits);
  const curStr = headline.current.value.toFixed(headline.digits);
  // "currently" only makes sense when the window actually ends at (near) now —
  // for a stale/historical window that word would misrepresent old data as live.
  const currentLabel = isLive ? 'currently' : 'most recently';
  const periodPhrase = isLive ? 'the past 24 hours' : 'the most recent 24 hours of available data';

  let sentence1 = `${headline.label} averaged ${avgStr}${headline.unit} over ${periodPhrase} (${minStr}–${maxStr}${headline.unit}), ${currentLabel} ${curStr}${headline.unit}`;
  if (headline.deltaFromPrevious != null) {
    const absDelta = Math.abs(headline.deltaFromPrevious).toFixed(headline.digits);
    const direction = headline.deltaFromPrevious >= 0 ? 'higher' : 'lower';
    sentence1 += ` — ${absDelta}${headline.unit} ${direction} than the prior 24-hour period`;
  }
  sentence1 += '.';

  const sentence2 = notableEventCount > 0
    ? `${notableEventCount} notable event${notableEventCount === 1 ? '' : 's'} detected in this period — see below.`
    : 'No target breaches or data gaps were detected in this period.';

  return `${sentence1} ${sentence2}`;
}

/**
 * Builds the full deterministic summary for one variety's 24h window.
 * `currentRows`/`previousRows` must already be split via splitByWindow (or
 * equivalent) at that window's boundaries. `isLive` — from
 * resolveSummaryWindow — controls whether the overview/no-data text says
 * "the past 24 hours" (window genuinely ends near now) or describes a
 * historical window instead, so stale data is never narrated as current.
 */
export function buildClimateSummary(
  varietyName: string,
  headlineKey: SummaryMetricKey,
  currentRows: VarietyClimateHourlyRow[],
  previousRows: VarietyClimateHourlyRow[],
  targets: TargetConfig,
  isLive: boolean
): ClimateSummaryResult {
  const metrics = SUMMARY_METRICS.map((def) => computeMetricSummary(def, currentRows, previousRows, targets[def.key] ?? null));
  const missingHourCount = Math.max(0, EXPECTED_WINDOW_HOURS - currentRows.length);

  const notableEvents: string[] = [];
  if (missingHourCount > 0) {
    notableEvents.push(`${missingHourCount} of the ${EXPECTED_WINDOW_HOURS} hours in this period have no climate data recorded.`);
  }
  for (const m of metrics) {
    if (m.longestBreachRunHours >= 3 && m.longestBreachRunStart && m.longestBreachRunEnd) {
      notableEvents.push(
        `${m.label} stayed outside its configured target for ${m.longestBreachRunHours} consecutive hours, from ${formatTime(m.longestBreachRunStart)} to ${formatTime(m.longestBreachRunEnd)}.`
      );
    }
  }
  const negativeResetCount = currentRows.filter((r) => r.irrigation_quality_flag === 'negative_reset').length;
  if (negativeResetCount > 0) {
    notableEvents.push(`Irrigation readings showed a sensor counter reset in ${negativeResetCount} hour${negativeResetCount === 1 ? '' : 's'} of this period.`);
  }
  for (const m of metrics) {
    if (m.excludedNegativeCount > 0) {
      notableEvents.push(
        `${m.excludedNegativeCount} ${m.label.toLowerCase()} reading${m.excludedNegativeCount === 1 ? '' : 's'} reflected a sensor counter reset and ${m.excludedNegativeCount === 1 ? 'was' : 'were'} excluded from the stats above (see the full chart for the raw values).`
      );
    }
  }

  const headline = metrics.find((m) => m.key === headlineKey) ?? metrics[0];
  const overview = buildOverviewSentence(varietyName, headline, notableEvents.length, isLive);

  return {
    metrics,
    hoursObservedTotal: currentRows.length,
    hoursExpectedTotal: EXPECTED_WINDOW_HOURS,
    missingHourCount,
    overview,
    notableEvents,
  };
}

