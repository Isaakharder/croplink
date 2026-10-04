import { describe, it, expect } from 'vitest';
import type { GrowlinkHarvestActual, HarvestedEntry, HarvestProjectionVariety } from '../types';
import { resolveWeeklyActuals, sumActualKg, buildDashboardComparison } from './dashboardHarvest';

const V1 = 'variety-1';
const V2 = 'variety-2';
const VARIETIES = new Set([V1, V2]);

let n = 0;
function gl(overrides: Partial<GrowlinkHarvestActual> = {}): GrowlinkHarvestActual {
  n += 1;
  return {
    id: `gl-${n}`,
    organization_id: null,
    growlink_harvest_key: `gl-key-${n}`,
    growlink_variety_key: 'gl-variety',
    variety_id: V1,
    harvest_date: '2026-07-06',
    year: 2026,
    week_number: 28,
    kg: 1000,
    synced_at: '2026-09-26T00:00:00Z',
    created_at: '2026-09-26T00:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
    ...overrides,
  };
}

function manual(overrides: Partial<HarvestedEntry> = {}): HarvestedEntry {
  n += 1;
  return {
    id: `m-${n}`,
    organization_id: null,
    variety_id: V1,
    year: 2026,
    week_number: 28,
    kg: 400,
    harvest_date: '2026-07-06',
    created_at: '2026-09-26T00:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
    ...overrides,
  };
}

function projection(id: string, weeks: [number, number, number][]): HarvestProjectionVariety {
  return {
    id, name: id, color: null, area_m2: 1000, totalKg: weeks.reduce((s, w) => s + w[2], 0),
    weeks: weeks.map(([week, projectedFruitPerM2, projectedKg]) => ({ week, projectedFruitPerM2, projectedKg })),
  };
}

describe('resolveWeeklyActuals', () => {
  it('uses GrowLink and ignores manual when both exist for the same variety/week (no double count)', () => {
    const r = resolveWeeklyActuals([gl({ kg: 1000 })], [manual({ kg: 400 })], 2026, VARIETIES);
    expect(r).toEqual([{ varietyId: V1, week: 28, kg: 1000, source: 'growlink', rowCount: 1 }]);
    expect(sumActualKg(r)).toBe(1000);
  });

  it('ignores every manual row for a GrowLink-covered week, even several of them', () => {
    const r = resolveWeeklyActuals(
      [gl({ kg: 600 }), gl({ kg: 400 })],
      [manual({ kg: 50 }), manual({ kg: 75 })],
      2026, VARIETIES
    );
    expect(sumActualKg(r)).toBe(1000);
    expect(r.every((x) => x.source === 'growlink')).toBe(true);
  });

  it('falls back to manual only for weeks GrowLink does not cover', () => {
    const r = resolveWeeklyActuals(
      [gl({ week_number: 28, kg: 1000 })],
      [manual({ week_number: 28, kg: 400 }), manual({ week_number: 29, kg: 300 })],
      2026, VARIETIES
    );
    expect(r.map((x) => [x.week, x.kg, x.source])).toEqual([
      [28, 1000, 'growlink'],
      [29, 300, 'manual-fallback'],
    ]);
    expect(sumActualKg(r)).toBe(1300);
  });

  it('resolves per variety: GrowLink for one variety does not block manual for another in the same week', () => {
    const r = resolveWeeklyActuals(
      [gl({ variety_id: V1, kg: 1000 })],
      [manual({ variety_id: V1, kg: 400 }), manual({ variety_id: V2, kg: 250 })],
      2026, VARIETIES
    );
    expect(r.map((x) => [x.varietyId, x.kg, x.source])).toEqual([
      [V1, 1000, 'growlink'],
      [V2, 250, 'manual-fallback'],
    ]);
  });

  it('a GrowLink row with null kg still owns its week — no manual fallback, and kg stays unknown', () => {
    const r = resolveWeeklyActuals([gl({ kg: null })], [manual({ kg: 400 })], 2026, VARIETIES);
    expect(r).toEqual([{ varietyId: V1, week: 28, kg: null, source: 'growlink', rowCount: 1 }]);
    expect(sumActualKg(r)).toBeNull();
  });

  it('excludes unmatched GrowLink rows, other years, and varieties not on the dashboard', () => {
    const r = resolveWeeklyActuals(
      [gl({ variety_id: null }), gl({ year: 2025 }), gl({ variety_id: 'other' })],
      [manual({ year: 2025 }), manual({ variety_id: 'other' })],
      2026, VARIETIES
    );
    expect(r).toEqual([]);
  });

  it('an unmatched GrowLink row does not block manual fallback for that week', () => {
    const r = resolveWeeklyActuals([gl({ variety_id: null })], [manual({ kg: 400 })], 2026, VARIETIES);
    expect(r).toEqual([{ varietyId: V1, week: 28, kg: 400, source: 'manual-fallback', rowCount: 1 }]);
  });
});

describe('sumActualKg', () => {
  it('returns null (not 0) when there are no actuals', () => {
    expect(sumActualKg([])).toBeNull();
  });

  it('returns a real 0 when actual rows exist and total 0 kg', () => {
    expect(sumActualKg(resolveWeeklyActuals([gl({ kg: 0 })], [], 2026, VARIETIES))).toBe(0);
  });
});

describe('buildDashboardComparison', () => {
  it('compares kg to kg and includes weeks with only a projection or only an actual', () => {
    const rows = buildDashboardComparison(
      [projection(V1, [[28, 0.3, 800], [29, 2.4, 6000]])],
      resolveWeeklyActuals([gl({ week_number: 17, kg: 500 }), gl({ week_number: 28, kg: 1000 })], [], 2026, VARIETIES)
    );
    expect(rows).toEqual([
      { week: 17, projectedFruitPerM2: 0, projectedKg: null, missingAfw: false, actualKg: 500, sources: ['growlink'], varianceKg: null, variancePct: null },
      { week: 28, projectedFruitPerM2: 0.3, projectedKg: 800, missingAfw: false, actualKg: 1000, sources: ['growlink'], varianceKg: 200, variancePct: 25 },
      { week: 29, projectedFruitPerM2: 2.4, projectedKg: 6000, missingAfw: false, actualKg: null, sources: [], varianceKg: null, variancePct: null },
    ]);
  });

  it('does not double count a week that has both GrowLink and manual rows', () => {
    const rows = buildDashboardComparison(
      [projection(V1, [[28, 0.3, 800]])],
      resolveWeeklyActuals([gl({ kg: 1000 })], [manual({ kg: 400 })], 2026, VARIETIES)
    );
    expect(rows[0].actualKg).toBe(1000);
    expect(rows[0].sources).toEqual(['growlink']);
  });

  it('sums across varieties and reports mixed provenance for the week', () => {
    const rows = buildDashboardComparison(
      [projection(V1, [[28, 0.3, 800]]), projection(V2, [[28, 0.2, 200]])],
      resolveWeeklyActuals([gl({ variety_id: V1, kg: 1000 })], [manual({ variety_id: V2, kg: 250 })], 2026, VARIETIES)
    );
    expect(rows[0].projectedKg).toBe(1000);
    expect(rows[0].actualKg).toBe(1250);
    expect(rows[0].sources.sort()).toEqual(['growlink', 'manual-fallback']);
    expect(rows[0].varianceKg).toBe(250);
  });

  it('keeps a projected-fruit week with no AFW, flags it, and withholds variance', () => {
    const rows = buildDashboardComparison(
      [projection(V1, [[30, 7.3, 0]])],
      resolveWeeklyActuals([gl({ week_number: 30, kg: 900 })], [], 2026, VARIETIES)
    );
    expect(rows).toEqual([
      { week: 30, projectedFruitPerM2: 7.3, projectedKg: 0, missingAfw: true, actualKg: 900, sources: ['growlink'], varianceKg: null, variancePct: null },
    ]);
  });
});
