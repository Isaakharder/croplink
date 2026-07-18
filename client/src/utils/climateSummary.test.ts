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
