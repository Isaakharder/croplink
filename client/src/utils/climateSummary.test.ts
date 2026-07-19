import { describe, it, expect } from 'vitest';
import type { VarietyClimateHourlyRow } from '../types';
import {
  buildClimateSummary,
  resolveSummaryWindow,
  splitByWindow,
  FRESHNESS_THRESHOLD_HOURS,
} from './climateSummary';

const VARIETY_ID = 'variety-1';
const MANUAL_BATCH_ID = 'manual-batch-1'; // stands in for a committed manual-CSV-import batch
const SYNOPTA_ORG_ID = 'synopta-org-1'; // stands in for the Synopta Agent's organization_id

let idCounter = 0;

function makeRow(measuredAtIso: string, tempC: number, overrides: Partial<VarietyClimateHourlyRow> = {}): VarietyClimateHourlyRow {
  idCounter += 1;
  return {
    id: `row-${idCounter}`,
    organization_id: null,
    variety_id: VARIETY_ID,
    measured_at: measuredAtIso,
    air_temperature_avg_c: tempC,
    air_temperature_zone_count: 4,
    relative_humidity_avg_pct: 70,
    relative_humidity_zone_count: 4,
    co2_avg_ppm: 500,
    co2_zone_count: 4,
    ec_avg: 2,
    ec_zone_count: 4,
    ph_avg: 5.8,
    ph_zone_count: 4,
    irrigation_cumulative_avg_ml: 100,
    irrigation_zone_count: 4,
    irrigation_interval_delta_ml: 10,
    irrigation_interval_minutes: 60,
    irrigation_quality_flag: 'ok',
    expected_zone_count: 4,
    phase_id: null,
    radiation_cumulative_j_cm2: 50,
    radiation_interval_delta_j_cm2: 10,
    quality_warnings: [],
    source_batch_id: null,
    ...overrides,
  };
}

function hoursAgoIso(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

describe('resolveSummaryWindow', () => {
  it('returns null for zero rows — the exact condition under which the chart would also show nothing', () => {
    expect(resolveSummaryWindow([], new Date())).toBeNull();
  });

  it('anchors to the newest row, not to "now", and reports isLive=false when that row is stale', () => {
    const now = new Date('2026-07-18T20:00:00Z');
    // Freshest data is over a day old — simulates variety_climate_hourly not
    // having been rolled up since a manual batch commit two days ago, even
    // though the underlying data source (climate_readings) has newer rows.
    const rows = [makeRow('2026-07-17T11:00:00Z', 22)];
    const window = resolveSummaryWindow(rows, now);
    expect(window).not.toBeNull();
    expect(window!.windowEndIso).toBe('2026-07-17T11:00:00.000Z');
    expect(window!.windowStartIso).toBe('2026-07-16T11:00:00.000Z');
    expect(window!.isLive).toBe(false);
  });

  it('reports isLive=true when the newest row is within the freshness threshold of now', () => {
    const now = new Date('2026-07-18T20:00:00Z');
    const rows = [makeRow(hoursAgoIso(now, FRESHNESS_THRESHOLD_HOURS - 0.5), 22)];
    const window = resolveSummaryWindow(rows, now);
    expect(window!.isLive).toBe(true);
  });
});

describe('splitByWindow', () => {
  it('buckets rows into current vs. previous 24h relative to the resolved window, excluding anything outside both', () => {
    const now = new Date('2026-07-18T12:00:00Z');
    const rows = [
      makeRow(hoursAgoIso(now, 50), 10), // outside previous window entirely
      makeRow(hoursAgoIso(now, 30), 15), // previous 24h
      makeRow(hoursAgoIso(now, 10), 20), // current 24h
      makeRow(hoursAgoIso(now, 0), 25),  // current 24h (the anchor row itself)
    ];
    const window = resolveSummaryWindow(rows, now)!;
    const { currentRows, previousRows } = splitByWindow(rows, window);
    expect(currentRows.map((r) => r.air_temperature_avg_c)).toEqual([20, 25]);
    expect(previousRows.map((r) => r.air_temperature_avg_c)).toEqual([15]);
  });
});

describe('buildClimateSummary — source-agnostic aggregation', () => {
  it('includes readings from both a manual-import-provenance row set and an agent-import-provenance row set in the same averages', () => {
    // Regression guard for the reported bug: the summary must never filter by
    // source_batch_id, organization_id, or import recency — it aggregates
    // whatever variety_climate_hourly rows exist for the variety, exactly
    // like the full chart's query does.
    const now = new Date('2026-07-18T23:00:00Z');
    const manualRows: VarietyClimateHourlyRow[] = [];
    const agentRows: VarietyClimateHourlyRow[] = [];
    for (let h = 0; h < 12; h++) {
      manualRows.push(makeRow(hoursAgoIso(now, 23 - h), 20, { source_batch_id: MANUAL_BATCH_ID, organization_id: null }));
    }
    for (let h = 12; h < 24; h++) {
      agentRows.push(makeRow(hoursAgoIso(now, 23 - h), 30, { source_batch_id: null, organization_id: SYNOPTA_ORG_ID }));
    }
    const allRows = [...manualRows, ...agentRows];

    const window = resolveSummaryWindow(allRows, now)!;
    const { currentRows, previousRows } = splitByWindow(allRows, window);
    const summary = buildClimateSummary('Mathieu', 'air_temperature', currentRows, previousRows, {}, window.isLive);

    const tempStat = summary.metrics.find((m) => m.key === 'air_temperature')!;
    // All 24 hours (12 manual-provenance + 12 agent-provenance) must be
    // observed — if the summary silently dropped either source, this count
    // or the average below would betray it.
    expect(tempStat.hoursObserved).toBe(24);
    expect(tempStat.avg).toBeCloseTo(25, 5); // mean of twelve 20s and twelve 30s
    expect(tempStat.min?.value).toBe(20);
    expect(tempStat.max?.value).toBe(30);

    // Sanity: both provenances are actually present in what got aggregated,
    // not just the same source duplicated.
    const sourcesInCurrentWindow = new Set(currentRows.map((r) => r.source_batch_id ?? r.organization_id ?? 'unknown'));
    expect(sourcesInCurrentWindow).toEqual(new Set([MANUAL_BATCH_ID, SYNOPTA_ORG_ID]));
  });

  it('labels a stale (non-live) window without claiming the data is current', () => {
    const now = new Date('2026-07-19T00:00:00Z');
    const rows = [makeRow('2026-07-17T11:00:00Z', 24)];
    const window = resolveSummaryWindow(rows, now)!;
    const { currentRows, previousRows } = splitByWindow(rows, window);
    const summary = buildClimateSummary('Mathieu', 'air_temperature', currentRows, previousRows, {}, window.isLive);

    expect(window.isLive).toBe(false);
    expect(summary.overview).toContain('most recent 24 hours of available data');
    expect(summary.overview).not.toContain('currently');
  });
});

describe('Radiation — accumulated total, not a per-hour statistic', () => {
  // Reproduces the exact real-world shape that motivated this fix: a normal
  // climb through the day, a mid-day sensor counter reset (large negative
  // delta), then a small climb resuming right after — the bug this fixes
  // showed the tiny post-reset delta as "the" radiation figure.
  const now = new Date('2026-07-18T00:00:00Z');
  const deltas = [100, 200, 300, -580, 50, 20]; // reset is the -580 at hour index 3
  const rows = deltas.map((d, i) => makeRow(hoursAgoIso(now, 5 - i), 20, { radiation_interval_delta_j_cm2: d }));

  it('sums the non-negative deltas into accumulatedTotal — a reset does not reduce the 24h total', () => {
    const window = resolveSummaryWindow(rows, now)!;
    const { currentRows, previousRows } = splitByWindow(rows, window);
    const summary = buildClimateSummary('Mathieu', 'radiation_interval', currentRows, previousRows, {}, window.isLive);
    const rad = summary.metrics.find((m) => m.key === 'radiation_interval')!;

    // 100 + 200 + 300 + 50 + 20 = 670. The reset (-580) must NOT be
    // subtracted — a sensor artifact resetting the counter is not a real
    // 580 J/cm² loss of accumulated radiation.
    expect(rad.accumulatedTotal).toBe(670);
    expect(rad.excludedNegativeCount).toBe(1);
  });

  it('does not use the latest hourly delta as the main value', () => {
    const window = resolveSummaryWindow(rows, now)!;
    const { currentRows, previousRows } = splitByWindow(rows, window);
    const summary = buildClimateSummary('Mathieu', 'radiation_interval', currentRows, previousRows, {}, window.isLive);
    const rad = summary.metrics.find((m) => m.key === 'radiation_interval')!;

    // The latest hour's delta (20) is a real number in this dataset but must
    // never be what "the radiation total" resolves to.
    expect(rad.accumulatedTotal).not.toBe(20);
    expect(rad.isAccumulator).toBe(true);
  });

  it('compares the total against the previous 24h total, not an average', () => {
    const previousDeltas = [10, 10, 10, 10, 10, 10]; // previous 24h totals to 60
    // Hours 30..25 — comfortably inside (24h, 48h] ago, clear of the exact
    // 24h boundary (splitByWindow's current bucket is inclusive of it).
    const previousRowsRaw = previousDeltas.map((d, i) => makeRow(hoursAgoIso(now, 30 - i), 20, { radiation_interval_delta_j_cm2: d }));
    const allRows = [...previousRowsRaw, ...rows];

    const window = resolveSummaryWindow(allRows, now)!;
    const { currentRows, previousRows } = splitByWindow(allRows, window);
    const summary = buildClimateSummary('Mathieu', 'radiation_interval', currentRows, previousRows, {}, window.isLive);
    const rad = summary.metrics.find((m) => m.key === 'radiation_interval')!;

    expect(rad.accumulatedTotal).toBe(670);
    expect(rad.previousAccumulatedTotal).toBe(60);
    expect(rad.deltaAccumulatedFromPrevious).toBe(610);
  });
});

describe('pH — sentinel zero exclusion (defense-in-depth at the client layer)', () => {
  it('excludes an exact-zero pH reading from avg/min/max even if one reaches the client unfixed', () => {
    // Server-side aggregation now nulls these out before they're ever stored
    // (see climateAveraging.ts SENTINEL_ZERO_METRICS), but this proves the
    // client doesn't silently trust a raw 0 either, in case an unfixed
    // historical row or a future ingestion path ever produces one.
    const now = new Date('2026-07-18T00:00:00Z');
    const phValues = [5.0, 4.9, 0, 4.8, 0, 5.1];
    const rows = phValues.map((v, i) => makeRow(hoursAgoIso(now, 5 - i), 20, { ph_avg: v }));

    const window = resolveSummaryWindow(rows, now)!;
    const { currentRows, previousRows } = splitByWindow(rows, window);
    const summary = buildClimateSummary('Mathieu', 'ph', currentRows, previousRows, {}, window.isLive);
    const ph = summary.metrics.find((m) => m.key === 'ph')!;

    expect(ph.hoursObserved).toBe(4); // the two zero hours are excluded, not averaged as 0
    expect(ph.avg).toBeCloseTo((5.0 + 4.9 + 4.8 + 5.1) / 4, 5);
    expect(ph.min?.value).toBe(4.8); // never 0
    expect(ph.max?.value).toBe(5.1);
    expect(ph.excludedZeroCount).toBe(2);
  });

  it('shows the most recent VALID (non-zero) pH reading as current when the newest raw reading is zero', () => {
    const now = new Date('2026-07-18T00:00:00Z');
    // Newest hour (index 5, closest to `now`) is a sentinel zero.
    const phValues = [5.0, 4.9, 4.95, 4.85, 4.7, 0];
    const rows = phValues.map((v, i) => makeRow(hoursAgoIso(now, 5 - i), 20, { ph_avg: v }));

    const window = resolveSummaryWindow(rows, now)!;
    const { currentRows, previousRows } = splitByWindow(rows, window);
    const summary = buildClimateSummary('Mathieu', 'ph', currentRows, previousRows, {}, window.isLive);
    const ph = summary.metrics.find((m) => m.key === 'ph')!;

    expect(ph.current?.value).toBe(4.7); // the last VALID reading, not 0
  });

  it('reports no current value (never 0) when every pH reading in the window is a sentinel zero', () => {
    const now = new Date('2026-07-18T00:00:00Z');
    const rows = [0, 0, 0].map((v, i) => makeRow(hoursAgoIso(now, 2 - i), 20, { ph_avg: v }));

    const window = resolveSummaryWindow(rows, now)!;
    const { currentRows, previousRows } = splitByWindow(rows, window);
    const summary = buildClimateSummary('Mathieu', 'ph', currentRows, previousRows, {}, window.isLive);
    const ph = summary.metrics.find((m) => m.key === 'ph')!;

    expect(ph.hoursObserved).toBe(0);
    expect(ph.current).toBeNull();
    expect(ph.avg).toBeNull();
    // This is the state the UI renders as "No valid reading" rather than "0.00".
  });
});
