import { describe, it, expect } from 'vitest';
import type { AfwForecastWeek, AfwForecastEditorModel } from '../types';
import { initDraft, validateDraft, changedWeeks, isDirty, buildChanges, fillForward, previewUsed } from './afwForecastDraft';

// 2026-W51 … 2027-W02: crosses ISO week 53 and the year boundary.
const labels: [number, number][] = [[2026, 51], [2026, 52], [2026, 53], [2027, 1], [2027, 2]];
const week = (y: number, w: number, manual: number | null = null): AfwForecastWeek => ({
  index: 0, year: y, week: w, label: `${y}-W${String(w).padStart(2, '0')}`, current: false, harvestWindow: 1,
  manual: manual == null ? null : { grams: manual, enteredAt: '2026-12-01T00:00:00Z', entryId: 1 }, growlinkActual: null, used: null,
});
const weeks = labels.map(([y, w]) => week(y, w, y === 2026 && w === 52 ? 200 : null));
const baseline: AfwForecastEditorModel['baseline'] = { grams: 192, source: 'growlink-settled', sourceLabel: 'GrowLink settled actual', fromWeek: '2026-W38' };

describe('AFW forecast draft', () => {
  it('starts from saved values and is clean', () => {
    const d = initDraft(weeks);
    expect(d['2026-W52']).toBe('200');
    expect(d['2026-W53']).toBe('');
    expect(isDirty(d, weeks)).toBe(false);
  });

  it('exact-week values win; later weeks carry the most recent earlier value across W53 into the next year', () => {
    const d = { ...initDraft(weeks), '2027-W01': '185' };
    const p = previewUsed(d, weeks, baseline);
    expect(p.map((x) => [x?.source, x?.grams, x?.fromWeek])).toEqual([
      ['growlink-settled', 192, '2026-W38'],
      ['manual-exact', 200, '2026-W52'],
      ['manual-carried', 200, '2026-W52'],
      ['manual-exact', 185, '2027-W01'],
      ['manual-carried', 185, '2027-W01'],
    ]);
  });

  it('never applies a later week\'s value to an earlier week', () => {
    const d = { ...initDraft(weeks), '2026-W52': '', '2027-W02': '250' };
    const p = previewUsed(d, weeks, baseline);
    expect(p.slice(0, 4).every((x) => x?.source === 'growlink-settled')).toBe(true);
    expect(p[4]?.source).toBe('manual-exact');
  });

  it('fill-forward: empty-only keeps exact entries, all overwrites, next copies one week', () => {
    const d = { ...initDraft(weeks), '2027-W01': '185' };
    expect(fillForward(d, weeks, '2026-W52', 'empty')).toMatchObject({ '2026-W53': '200', '2027-W01': '185', '2027-W02': '200' });
    expect(fillForward(d, weeks, '2026-W52', 'all')).toMatchObject({ '2026-W53': '200', '2027-W01': '200', '2027-W02': '200' });
    expect(fillForward(d, weeks, '2026-W52', 'next')).toMatchObject({ '2026-W53': '200', '2027-W01': '185', '2027-W02': '' });
    expect(fillForward(d, weeks, '2026-W51', 'all')).toBe(d); // nothing to copy from an empty week
  });

  it('validates input and flags unusual values without blocking', () => {
    const d = { ...initDraft(weeks), '2026-W51': 'abc', '2026-W53': '5', '2027-W01': '500', '2027-W02': '210' };
    const v = validateDraft(d, weeks);
    expect(v.errors).toEqual({ '2026-W51': 'Enter a number of grams', '2026-W53': 'Must be 20–1000 g' });
    expect(Object.keys(v.notices)).toEqual(['2027-W01']);
  });

  it('builds a save with changed weeks only; clearing a saved week sends a clear; rounding to 0.1 g', () => {
    const d = { ...initDraft(weeks), '2026-W52': '', '2026-W53': '210.04', '2027-W01': ' ' };
    expect(isDirty(d, weeks)).toBe(true);
    expect(changedWeeks(d, weeks).map((w) => w.label)).toEqual(['2026-W52', '2026-W53']);
    expect(buildChanges(d, weeks)).toEqual([{ year: 2026, week: 52, grams: null }, { year: 2026, week: 53, grams: 210 }]);
    expect(isDirty({ ...initDraft(weeks), '2026-W52': '200.0' }, weeks)).toBe(false);
  });
});
