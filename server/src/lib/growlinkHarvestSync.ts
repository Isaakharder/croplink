// Pure planning + resilient writing for POST /api/growlink/harvest-actuals/sync.
//
// Each remote record is validated on its own (including that its week
// exists in its ISO year — W53 is valid in 2026, not in 2025), and a write
// failure for one record never discards the rest of the batch: a failed
// batch is retried row by row so only the offending rows are reported.
import { isValidIsoWeek, isoWeekMonday, weeksInIsoYear } from './isoWeek';

export interface RemoteHarvestActual {
  harvestId: string;
  varietyId: string;
  varietyName?: string;
  harvestDate: string | null;
  year: number;
  week: number;
  harvestKg: number | null;
  updatedAt?: string;
}

export interface ExistingHarvestActualRow {
  id: string;
  growlink_harvest_key: string;
  variety_id: string | null;
  kg: number | null;
  year: number;
  week_number: number;
  growlink_variety_key: string;
  source_payload: RemoteHarvestActual | null;
}

export interface RejectedRecord {
  harvestId: string | null;
  year: unknown;
  week: unknown;
  stage: 'validation' | 'write';
  reason: string;
}

const KG_EPSILON = 0.0005; // same tolerance used elsewhere in this app for numeric-column round-tripping noise

function numbersEqual(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < KG_EPSILON;
}

/**
 * True when a fresh sync of this record would write nothing new — every
 * field the grower actually sees or that downstream logic depends on is
 * identical to what's already stored: harvest kg, year/week, GrowLink
 * variety details (key + name), the locally-resolved CropLink variety, and
 * GrowLink's own updatedAt (a proxy for "the raw source payload changed").
 * Compared field-by-field rather than as an opaque JSON blob because jsonb
 * doesn't guarantee stable key order round-trip.
 */
export function isUnchanged(existing: ExistingHarvestActualRow, resolvedVarietyId: string | null, r: RemoteHarvestActual): boolean {
  const payload = existing.source_payload;
  return (
    existing.variety_id === resolvedVarietyId &&
    numbersEqual(existing.kg, r.harvestKg ?? null) &&
    existing.year === r.year &&
    existing.week_number === r.week &&
    existing.growlink_variety_key === r.varietyId &&
    (payload?.varietyName ?? null) === (r.varietyName ?? null) &&
    (payload?.harvestDate ?? null) === (r.harvestDate ?? null) &&
    (payload?.updatedAt ?? null) === (r.updatedAt ?? null)
  );
}

/** null when valid, otherwise a human-readable reason. */
export function validateRemoteHarvestActual(r: Partial<RemoteHarvestActual> | null | undefined): string | null {
  if (!r || typeof r !== 'object') return 'record is not an object';
  if (typeof r.harvestId !== 'string' || r.harvestId === '') return 'missing harvestId';
  if (typeof r.varietyId !== 'string' || r.varietyId === '') return 'missing varietyId';
  if (!Number.isInteger(r.year)) return `invalid year ${JSON.stringify(r.year)}`;
  if (!isValidIsoWeek(r.year, r.week)) {
    return `invalid ISO week ${JSON.stringify(r.week)} for ${r.year} (valid: 1–${weeksInIsoYear(r.year as number)})`;
  }
  if (r.harvestKg != null && !(typeof r.harvestKg === 'number' && Number.isFinite(r.harvestKg) && r.harvestKg >= 0)) {
    return `invalid harvestKg ${JSON.stringify(r.harvestKg)}`;
  }
  if (r.harvestDate != null && (typeof r.harvestDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.harvestDate) || isNaN(Date.parse(r.harvestDate)))) {
    return `invalid harvestDate ${JSON.stringify(r.harvestDate)}`;
  }
  return null;
}

export interface SyncPlan {
  toInsert: Record<string, unknown>[];
  toUpdate: Record<string, unknown>[];
  rejected: RejectedRecord[];
  matchedCount: number;
  unmatchedCount: number;
  unchangedCount: number;
  matchedGrowlinkVarietyKeys: Set<string>;
}

export function planHarvestActualsSync(
  remoteRecords: unknown[],
  existingByKey: Map<string, ExistingHarvestActualRow>,
  varietyIdByGrowlinkKey: Map<string, string>,
  now: string
): SyncPlan {
  const plan: SyncPlan = { toInsert: [], toUpdate: [], rejected: [], matchedCount: 0, unmatchedCount: 0, unchangedCount: 0, matchedGrowlinkVarietyKeys: new Set() };

  for (const raw of remoteRecords) {
    const reason = validateRemoteHarvestActual(raw as Partial<RemoteHarvestActual>);
    if (reason) {
      const r = (raw ?? {}) as Partial<RemoteHarvestActual>;
      plan.rejected.push({ harvestId: typeof r.harvestId === 'string' ? r.harvestId : null, year: r.year, week: r.week, stage: 'validation', reason });
      continue;
    }
    const r = raw as RemoteHarvestActual;

    // Only actively 'linked' rows resolve a variety_id (the caller passes only those).
    const varietyId = varietyIdByGrowlinkKey.get(r.varietyId) ?? null;
    if (varietyId) { plan.matchedCount++; plan.matchedGrowlinkVarietyKeys.add(r.varietyId); }
    else plan.unmatchedCount++;

    const existing = existingByKey.get(r.harvestId);
    if (existing && isUnchanged(existing, varietyId, r)) {
      // Deliberately not touched (synced_at included) — an unchanged record stays an honest no-op.
      plan.unchangedCount++;
      continue;
    }

    const row: Record<string, unknown> = {
      organization_id: null,
      growlink_harvest_key: r.harvestId,
      growlink_variety_key: r.varietyId,
      variety_id: varietyId,
      // GrowLink reports harvestDate as null (confirmed live) while the column is not-null.
      harvest_date: r.harvestDate ?? isoWeekMonday(r.year, r.week).toISOString().slice(0, 10),
      year: r.year,
      week_number: r.week,
      kg: r.harvestKg ?? null,
      source_payload: r,
      synced_at: now,
    };
    if (existing) plan.toUpdate.push({ id: existing.id, ...row });
    else plan.toInsert.push(row);
  }
  return plan;
}

/**
 * Writes `rows` as one batch; if the batch fails, retries each row alone
 * so a single bad row (e.g. one the database rejects) can't sink the rest.
 * `writeBatch` resolves to an error message or null.
 */
export async function writeWithRowFallback(
  rows: Record<string, unknown>[],
  writeBatch: (rows: Record<string, unknown>[]) => Promise<string | null>
): Promise<{ written: number; failed: RejectedRecord[] }> {
  if (rows.length === 0) return { written: 0, failed: [] };
  if ((await writeBatch(rows)) == null) return { written: rows.length, failed: [] };

  let written = 0;
  const failed: RejectedRecord[] = [];
  for (const row of rows) {
    const err = await writeBatch([row]);
    if (err == null) written++;
    else failed.push({ harvestId: (row.growlink_harvest_key as string) ?? null, year: row.year, week: row.week_number, stage: 'write', reason: err });
  }
  return { written, failed };
}
