// Dashboard harvest actuals: source resolution + projected-vs-actual in kg.
//
// Actual kg has two possible sources:
//   - growlink_harvest_actuals (synced from GrowLink) — authoritative
//   - harvested_entries (hand-entered) — used ONLY for a variety/week that
//     has no GrowLink row at all
// The two are never summed for the same variety/week. A GrowLink row whose
// kg is null still claims its variety/week (GrowLink owns it, kg unknown) —
// it does not open the door to a manual fallback.
//
// Projected kg comes from GET /harvest-projections (fruit/m² × area × the
// harvest week's AFW, computed server-side) — the same figures the
// Projections page shows. Nothing here converts fruit/m² to kg itself, and
// fruit_instances are not a source of kg.
import type { GrowlinkHarvestActual, HarvestedEntry, HarvestProjectionVariety } from '../types';
import { compareProjectedToActualByWeek } from './growlinkComparison';

export type ActualSource = 'growlink' | 'manual-fallback';

export interface ResolvedWeeklyActual {
  varietyId: string;
  week: number;
  /** null only when GrowLink has row(s) for this variety/week but none carry kg. */
  kg: number | null;
  source: ActualSource;
  rowCount: number;
}

function key(varietyId: string, week: number): string {
  return `${varietyId}|${week}`;
}

export function resolveWeeklyActuals(
  growlinkActuals: GrowlinkHarvestActual[],
  manualEntries: HarvestedEntry[],
  year: number,
  varietyIds: Set<string>
): ResolvedWeeklyActual[] {
  const resolved = new Map<string, ResolvedWeeklyActual>();

  for (const a of growlinkActuals) {
    if (a.variety_id == null || a.year !== year || !varietyIds.has(a.variety_id)) continue;
    const k = key(a.variety_id, a.week_number);
    const r = resolved.get(k) ?? { varietyId: a.variety_id, week: a.week_number, kg: null, source: 'growlink' as const, rowCount: 0 };
    r.rowCount += 1;
    if (a.kg != null) r.kg = (r.kg ?? 0) + Number(a.kg);
    resolved.set(k, r);
  }

  const growlinkKeys = new Set(resolved.keys());
  for (const e of manualEntries) {
    if (e.year !== year || !varietyIds.has(e.variety_id)) continue;
    const k = key(e.variety_id, e.week_number);
    if (growlinkKeys.has(k)) continue; // GrowLink owns this variety/week — never add manual on top
    const r = resolved.get(k) ?? { varietyId: e.variety_id, week: e.week_number, kg: 0, source: 'manual-fallback' as const, rowCount: 0 };
    r.rowCount += 1;
    r.kg = (r.kg ?? 0) + Number(e.kg);
    resolved.set(k, r);
  }

  return [...resolved.values()].sort((a, b) => a.week - b.week || a.varietyId.localeCompare(b.varietyId));
}

/** Sum of resolved kg, or null when there is no actual kg at all (never a fabricated 0). */
export function sumActualKg(resolved: ResolvedWeeklyActual[]): number | null {
  const withKg = resolved.filter((r) => r.kg != null);
  if (withKg.length === 0) return null;
  return withKg.reduce((s, r) => s + (r.kg as number), 0);
}

export interface DashboardComparisonRow {
  week: number;
  projectedFruitPerM2: number;
  /** null when nothing is projected for this week. */
  projectedKg: number | null;
  /** Some variety has projected fruit this week but no AFW, so projectedKg is incomplete. */
  missingAfw: boolean;
  actualKg: number | null;
  sources: ActualSource[];
  /** null when either side is missing, projected kg is 0, or projected kg is incomplete (missing AFW). */
  varianceKg: number | null;
  variancePct: number | null;
}

export function buildDashboardComparison(
  projections: HarvestProjectionVariety[],
  resolved: ResolvedWeeklyActual[]
): DashboardComparisonRow[] {
  const projKg = new Map<number, number>();
  const projFruit = new Map<number, number>();
  const missingAfw = new Set<number>();
  for (const v of projections) {
    for (const w of v.weeks) {
      if (w.projectedFruitPerM2 <= 0 && w.projectedKg <= 0) continue;
      projFruit.set(w.week, (projFruit.get(w.week) ?? 0) + w.projectedFruitPerM2);
      projKg.set(w.week, (projKg.get(w.week) ?? 0) + w.projectedKg);
      if (w.projectedFruitPerM2 > 0 && w.projectedKg === 0) missingAfw.add(w.week);
    }
  }

  const actualKg = new Map<number, number>();
  const sources = new Map<number, Set<ActualSource>>();
  for (const r of resolved) {
    if (!sources.has(r.week)) sources.set(r.week, new Set());
    sources.get(r.week)!.add(r.source);
    if (r.kg != null) actualKg.set(r.week, (actualKg.get(r.week) ?? 0) + r.kg);
  }

  const compared = new Map(
    compareProjectedToActualByWeek(
      [...projKg].map(([week, projectedKg]) => ({ week, projectedKg })),
      actualKg
    ).map((r) => [r.week, r])
  );

  const weeks = [...new Set([...projFruit.keys(), ...sources.keys()])].sort((a, b) => a - b);
  return weeks.map((week) => {
    const c = compared.get(week);
    const incomplete = missingAfw.has(week);
    return {
      week,
      projectedFruitPerM2: projFruit.get(week) ?? 0,
      projectedKg: projFruit.has(week) ? (c?.projectedKg ?? 0) : null,
      missingAfw: incomplete,
      actualKg: c?.actualKg ?? null,
      sources: [...(sources.get(week) ?? [])],
      varianceKg: incomplete ? null : c?.differenceKg ?? null,
      variancePct: incomplete ? null : c?.differencePct ?? null,
    };
  });
}
