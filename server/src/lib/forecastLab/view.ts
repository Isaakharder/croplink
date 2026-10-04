// Assembles the Forecast Lab page model — pure. For each week:
//  - past weeks (<= as-of): the forecast that was ISSUED `horizon` weeks
//    earlier, from immutable snapshots (live preferred over hindcast);
//  - future weeks: the current computation (so a just-saved AFW forecast shows
//    immediately). If a live snapshot for this as-of week was already locked
//    with the same result it is shown as locked; if inputs changed since the
//    lock, the locked value is shown alongside — it stays the one scored;
//  - the legacy forecast exactly as the legacy endpoint returns it today;
//  - the GrowLink packed actual with its settled/provisional state.
import { fromIsoWeekIndex } from '../isoWeek';
import { LabForecast, LabModelId, LAB_MODELS } from './engine';
import { ActualWeek, SnapshotRow } from './evaluation';

export interface ModelCell {
  kg: number | null;
  low: number | null;
  high: number | null;
  locked: boolean;
  kind: 'live' | 'hindcast' | 'current';
  issuedAt: string | null;
  asOfWeek: string;
  version: string;
  afwG: number | null;
  afwSource: string | null;
  afwWeek: string | null;
  harvestWindow: number;
  warnings: string[];
  diffKg: number | null;
  diffPct: number | null;
  /** Set when a locked live snapshot for this week differs from the current computation. */
  lockedKg: number | null;
  lockedIssuedAt: string | null;
}

export interface ViewWeek {
  index: number;
  year: number;
  week: number;
  label: string;
  past: boolean;
  legacyKg: number | null;
  actual: { kg: number | null; settlement: ActualWeek['settlement']; source: ActualWeek['source']; settlementSource: ActualWeek['settlementSource'] } | null;
  legacyDiffKg: number | null;
  legacyDiffPct: number | null;
  models: Partial<Record<LabModelId, ModelCell>>;
}

const closeTo = (a: number | null, b: number | null, tol = 0.5) => (a == null || b == null ? a === b : Math.abs(a - b) <= tol);
const wk = (i: number) => { const w = fromIsoWeekIndex(i); return `${w.year}-W${String(w.week).padStart(2, '0')}`; };
const diff = (f: number | null, a: ActualWeek | undefined) => (f == null || !a || a.kg == null ? { d: null, p: null } : { d: f - a.kg, p: a.kg > 0 ? ((f - a.kg) / a.kg) * 100 : null });

export function assembleView(args: {
  asOfIndex: number;
  horizon: number;
  fromIndex: number;
  current: LabForecast[];
  snapshots: SnapshotRow[];
  actuals: Map<number, ActualWeek>;
  legacyByIndex: Map<number, { kg: number }>;
}): ViewWeek[] {
  const { asOfIndex, horizon, fromIndex, current, snapshots, actuals, legacyByIndex } = args;
  const experimental = (Object.keys(LAB_MODELS) as LabModelId[]).filter((m) => LAB_MODELS[m].experimental);
  const toIndex = asOfIndex + Math.max(...current.map((c) => c.targets.length), 0);
  const weeks: ViewWeek[] = [];
  for (let i = fromIndex; i <= toIndex; i++) {
    const w = fromIsoWeekIndex(i);
    const a = actuals.get(i);
    const legacyKg = legacyByIndex.get(i)?.kg ?? null;
    const ld = diff(legacyKg, a);
    const row: ViewWeek = {
      index: i, year: w.year, week: w.week, label: wk(i), past: i <= asOfIndex, legacyKg,
      actual: a ? { kg: a.kg, settlement: a.settlement, source: a.source, settlementSource: a.settlementSource } : null,
      legacyDiffKg: ld.d, legacyDiffPct: ld.p, models: {},
    };
    for (const m of experimental) {
      let cell: ModelCell | null = null;
      if (i <= asOfIndex) {
        const pick = (kind: 'live' | 'hindcast') => snapshots.find((s) => s.model_id === m && s.kind === kind && s.target_index === i && s.horizon === horizon);
        const s = pick('live') ?? pick('hindcast');
        if (s) cell = fromSnapshot(s);
      } else {
        const s = snapshots.find((x) => x.model_id === m && x.kind === 'live' && x.as_of_index === asOfIndex && x.target_index === i);
        const fc = current.find((c) => c.modelId === m);
        const t = fc?.targets.find((x) => x.index === i);
        if (fc && t) {
          const locked = s ? fromSnapshot(s) : null;
          const same = locked && fc.version === locked.version && closeTo(locked.kg, t.kg) && closeTo(locked.afwG, t.afw?.grams ?? null);
          if (locked && same) cell = locked;
          else {
            cell = {
              kg: t.kg, low: t.low, high: t.high, locked: false, kind: 'current', issuedAt: null, asOfWeek: wk(fc.asOfIndex), version: fc.version,
              afwG: t.afw?.grams ?? null, afwSource: t.afw?.source ?? null, afwWeek: t.afw ? wk(t.afw.fromIndex) : null, harvestWindow: t.harvestWindow,
              warnings: [...fc.warnings, ...t.warnings, locked
                ? `changed-since-lock: inputs changed after this week's forecast was locked (${locked.kg == null ? 'no kg' : `${Math.round(locked.kg)} kg`} at ${locked.afwG ?? '?'} g, issued ${locked.issuedAt?.slice(0, 16).replace('T', ' ')} UTC); the locked value is the one scored`
                : 'not-locked: computed now; becomes a locked snapshot at the next lab cycle'],
              diffKg: null, diffPct: null, lockedKg: locked?.kg ?? null, lockedIssuedAt: locked?.issuedAt ?? null,
            };
          }
        } else if (s) cell = fromSnapshot(s);
      }
      if (cell) {
        const d = diff(cell.kg, a);
        cell.diffKg = d.d;
        cell.diffPct = d.p;
        row.models[m] = cell;
      }
    }
    weeks.push(row);
  }
  return weeks;
}

function fromSnapshot(s: SnapshotRow): ModelCell {
  const n = (v: unknown) => (v == null ? null : Number(v));
  return {
    kg: n(s.forecast_kg), low: n(s.range_low_kg), high: n(s.range_high_kg), locked: true, kind: s.kind, issuedAt: s.issued_at, asOfWeek: wk(s.as_of_index),
    version: s.model_version, afwG: n(s.afw_g), afwSource: s.afw_source, afwWeek: s.afw_as_of_index != null ? wk(s.afw_as_of_index) : null,
    harvestWindow: Number(s.harvest_window), warnings: s.warnings ?? [], diffKg: null, diffPct: null, lockedKg: null, lockedIssuedAt: null,
  };
}
