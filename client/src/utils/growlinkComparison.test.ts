import { describe, it, expect } from 'vitest';
import type { GrowlinkHarvestActual } from '../types';
import { buildWeeklyComparison, formatDifferenceLabel } from './growlinkComparison';

let idCounter = 0;
function makeActual(overrides: Partial<GrowlinkHarvestActual> = {}): GrowlinkHarvestActual {
  idCounter += 1;
  return {
    id: `actual-${idCounter}`,
    organization_id: null,
    growlink_harvest_key: `key-${idCounter}`,
    growlink_variety_key: 'gl-variety-1',
    variety_id: 'variety-1',
    harvest_date: '2026-06-01',
    year: 2026,
    week_number: 22,
    kg: 100,
    cases: null,
    case_weight_kg: null,
    synced_at: '2026-07-18T00:00:00Z',
    created_at: '2026-07-18T00:00:00Z',
    updated_at: '2026-07-18T00:00:00Z',
    ...overrides,
  };
}

describe('buildWeeklyComparison', () => {
  it('computes differenceKg and differencePct with the exact specified formulas', () => {
    const rows = buildWeeklyComparison(
      [{ week: 22, projectedKg: 80 }],
      [makeActual({ week_number: 22, kg: 100 })]
    );
    expect(rows).toEqual([{ week: 22, projectedKg: 80, actualKg: 100, differenceKg: 20, differencePct: 25 }]);
  });

  it('handles projected kg of zero safely — neither differenceKg nor differencePct is computed (both null, shown as "—"), never a divide-by-zero artifact or a misleading "100% variance"', () => {
    const rows = buildWeeklyComparison(
      [{ week: 22, projectedKg: 0 }],
      [makeActual({ week_number: 22, kg: 50 })]
    );
    expect(rows[0].projectedKg).toBe(0);
    expect(rows[0].actualKg).toBe(50);
    expect(rows[0].differenceKg).toBeNull();
    expect(rows[0].differencePct).toBeNull();
  });

  it('distinguishes "no matched actual yet" (null) from a real zero-kg actual', () => {
    const rows = buildWeeklyComparison([{ week: 22, projectedKg: 80 }], []);
    expect(rows[0].actualKg).toBeNull();
    expect(rows[0].differenceKg).toBeNull();
    expect(rows[0].differencePct).toBeNull();
  });

  it('excludes unmatched GrowLink records (variety_id null) even if the caller forgot to pre-filter — a hard invariant, not just a caller convention', () => {
    const rows = buildWeeklyComparison(
      [{ week: 22, projectedKg: 80 }],
      [
        makeActual({ week_number: 22, kg: 40, variety_id: 'variety-1' }),
        makeActual({ week_number: 22, kg: 999, variety_id: null }), // unmatched — must never contribute
      ]
    );
    expect(rows[0].actualKg).toBe(40);
  });

  it('sums multiple matched records in the same week', () => {
    const rows = buildWeeklyComparison(
      [{ week: 22, projectedKg: 80 }],
      [makeActual({ week_number: 22, kg: 40 }), makeActual({ week_number: 22, kg: 25 })]
    );
    expect(rows[0].actualKg).toBe(65);
  });

  it('skips weeks with neither a projection nor an actual', () => {
    const rows = buildWeeklyComparison(
      [{ week: 22, projectedKg: 0 }, { week: 23, projectedKg: 40 }],
      []
    );
    expect(rows.map((r) => r.week)).toEqual([23]);
  });

  it('includes a week with only an actual and no projection — the week stays visible (union of projected/actual weeks) but no difference is calculated against a nonexistent projection', () => {
    const rows = buildWeeklyComparison([], [makeActual({ week_number: 30, kg: 15 })]);
    expect(rows).toEqual([{ week: 30, projectedKg: 0, actualKg: 15, differenceKg: null, differencePct: null }]);
  });

  it('treats a null kg on a matched record as no contribution, not zero-that-counts', () => {
    const rows = buildWeeklyComparison(
      [{ week: 22, projectedKg: 80 }],
      [makeActual({ week_number: 22, kg: null })]
    );
    // No valid kg contributed at all -> falls back to the "no actual" case.
    expect(rows[0].actualKg).toBeNull();
  });
});

describe('formatDifferenceLabel', () => {
  it('"X% over" with an up arrow when actual exceeds projected', () => {
    expect(formatDifferenceLabel({ differenceKg: 20, differencePct: 25 })).toEqual({ text: '25.0% over', arrow: '▲' });
  });

  it('"X% under" with a down arrow when actual is below projected', () => {
    expect(formatDifferenceLabel({ differenceKg: -20, differencePct: -8.7 })).toEqual({ text: '8.7% under', arrow: '▼' });
  });

  it('"On target" with no arrow when actual exactly matches projected', () => {
    expect(formatDifferenceLabel({ differenceKg: 0, differencePct: 0 })).toEqual({ text: 'On target', arrow: '' });
  });

  it('shows "—" (never a number) when projected kg was zero, even though a real difference exists', () => {
    expect(formatDifferenceLabel({ differenceKg: 50, differencePct: null })).toEqual({ text: '—', arrow: '' });
  });

  it('shows "—" when there is no matched actual for the week at all', () => {
    expect(formatDifferenceLabel({ differenceKg: null, differencePct: null })).toEqual({ text: '—', arrow: '' });
  });
});
