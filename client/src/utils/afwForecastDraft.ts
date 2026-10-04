// Draft state for the AFW Forecast editor — pure. The draft maps each week
// label to the text in its input ('' = no manual forecast). The server is
// authoritative (it re-validates and resolves on save); these helpers give
// the same answers before saving so the grower sees what will happen.
import type { AfwForecastChange, AfwForecastEditorModel, AfwForecastWeek, AfwUsedSource } from '../types';

export const AFW_MIN_G = 20;
export const AFW_MAX_G = 1000;
export const AFW_TYPICAL_G: [number, number] = [60, 450];

export type AfwDraft = Record<string, string>;

const round1 = (g: number) => Math.round(g * 10) / 10;
const parse = (v: string | undefined): number | null => {
  const t = (v ?? '').trim();
  if (t === '') return null;
  const g = Number(t);
  return Number.isFinite(g) ? g : NaN;
};

export function initDraft(weeks: AfwForecastWeek[]): AfwDraft {
  return Object.fromEntries(weeks.map((w) => [w.label, w.manual ? String(w.manual.grams) : '']));
}

/** Per-week input errors (blocking) and notices (unusual but allowed). */
export function validateDraft(draft: AfwDraft, weeks: AfwForecastWeek[]): { errors: Record<string, string>; notices: Record<string, string> } {
  const errors: Record<string, string> = {};
  const notices: Record<string, string> = {};
  for (const w of weeks) {
    const g = parse(draft[w.label]);
    if (g == null) continue;
    if (Number.isNaN(g)) errors[w.label] = 'Enter a number of grams';
    else if (g < AFW_MIN_G || g > AFW_MAX_G) errors[w.label] = `Must be ${AFW_MIN_G}–${AFW_MAX_G} g`;
    else if (g < AFW_TYPICAL_G[0] || g > AFW_TYPICAL_G[1]) notices[w.label] = `Unusual (typical ${AFW_TYPICAL_G[0]}–${AFW_TYPICAL_G[1]} g)`;
  }
  return { errors, notices };
}

/** Weeks whose draft differs from what is saved (numbers compared after rounding to 0.1 g). */
export function changedWeeks(draft: AfwDraft, weeks: AfwForecastWeek[]): AfwForecastWeek[] {
  return weeks.filter((w) => {
    const g = parse(draft[w.label]);
    const saved = w.manual?.grams ?? null;
    if (g == null) return saved != null;
    if (Number.isNaN(g)) return true;
    return saved == null || round1(g) !== saved;
  });
}

export function isDirty(draft: AfwDraft, weeks: AfwForecastWeek[]): boolean {
  return changedWeeks(draft, weeks).length > 0;
}

/** Save payload: changed weeks only; an emptied week with a saved value becomes a clear. Call only when validateDraft has no errors. */
export function buildChanges(draft: AfwDraft, weeks: AfwForecastWeek[]): AfwForecastChange[] {
  return changedWeeks(draft, weeks).map((w) => {
    const g = parse(draft[w.label]);
    return { year: w.year, week: w.week, grams: g == null ? null : round1(g) };
  });
}

/**
 * Copy the value of week `fromLabel` into later weeks. 'empty' fills only
 * weeks without a value (keeps exact-week entries); 'all' overwrites them.
 */
export function fillForward(draft: AfwDraft, weeks: AfwForecastWeek[], fromLabel: string, mode: 'empty' | 'all' | 'next'): AfwDraft {
  const i = weeks.findIndex((w) => w.label === fromLabel);
  const v = (draft[fromLabel] ?? '').trim();
  if (i < 0 || v === '') return draft;
  const out = { ...draft };
  const later = mode === 'next' ? weeks.slice(i + 1, i + 2) : weeks.slice(i + 1);
  for (const w of later) if (mode !== 'empty' || (out[w.label] ?? '').trim() === '') out[w.label] = v;
  return out;
}

export interface PreviewAfw { grams: number; source: AfwUsedSource; fromWeek: string }

/**
 * AFW each week would use with the draft as it stands: this week's value →
 * the most recent EARLIER week's value → the baseline. Same order as the
 * server; a week never uses a later week's value.
 */
export function previewUsed(draft: AfwDraft, weeks: AfwForecastWeek[], baseline: AfwForecastEditorModel['baseline']): (PreviewAfw | null)[] {
  let carried: { grams: number; fromWeek: string } | null = null;
  return weeks.map((w) => {
    const g = parse(draft[w.label]);
    if (g != null && !Number.isNaN(g)) {
      carried = { grams: round1(g), fromWeek: w.label };
      return { grams: carried.grams, source: 'manual-exact' as const, fromWeek: w.label };
    }
    if (carried) return { grams: carried.grams, source: 'manual-carried' as const, fromWeek: carried.fromWeek };
    return baseline ? { grams: baseline.grams, source: baseline.source, fromWeek: baseline.fromWeek } : null;
  });
}

export const SOURCE_SHORT: Record<AfwUsedSource, string> = {
  'manual-exact': 'Manual (this week)',
  'manual-carried': 'Manual (carried)',
  'growlink-settled': 'GrowLink settled',
  'growlink-v2': 'GrowLink (not settled)',
  'croplink-manual': 'CropLink fallback',
};
