// GrowLink v2 yield-detail sync — pure planning and verification (no I/O).
//
// Invariants:
//  - Raw upstream values are kept verbatim (raw_payload + typed copies, upstream
//    ids and timestamps); derived values (AFW) are recomputed by versioned
//    functions here, never stored as if they were source data.
//  - Weeks are GrowLink PACKING weeks; nothing here maps them to CropLink
//    survey or biological harvest weeks.
//  - Nothing is ever hard-deleted. Tombstones mark rows 'deleted_upstream';
//    an id absent from a manifest is marked 'missing_upstream' only after two
//    consecutive manifests that were each verified complete (every page from
//    one manifest, contiguous, count and checksum match).
//  - Any data change to a row CropLink held as settled is recorded as a late
//    edit (revision with was_settled = true).
import { createHash } from 'crypto';
import { isValidIsoWeek } from './isoWeek';
import { RejectedRecord } from './growlinkHarvestSync';

export const SUPPORTED_MANIFEST_ALGORITHM = 'sha256:sorted-lowercase-ids-newline-joined';
/** A reconciliation that would newly flag more than this share of active rows as absent is aborted, not applied. */
export const MASS_ABSENCE_THRESHOLD = 0.1;
export const MAX_PAGES_PER_RUN = 1000;
export const AFW_DERIVATION_VERSION = 'afw-v1';

// ── Contract ───────────────────────────────────────────────────────────────

export interface V2DailyRow {
  breakdownId: string;
  packedDate: string | null;
  totalKg: number | null;
  averageFruitWeightG: number | null;
  sizeKg: Record<string, number>;
  updatedAt: string;
}

export interface V2YieldWeekItem {
  yieldEntryId: string;
  varietyId: string;
  varietyName: string;
  packingYear: number;
  packingWeek: number;
  packedDate: string | null;
  totalKg: number | null;
  averageFruitWeightG: number | null;
  totalCases: number | null;
  sizeKg: Record<string, number>;
  kgPerM2: number | null;
  daily: V2DailyRow[];
  dailyBreakdownComplete: boolean | null;
  lastWriteSource: string;
  /** The GrowLink variety record's own area_m2. */
  varietyAreaM2: number | null;
  varietyUpdatedAt: string | null;
  /** GrowLink's measured greenhouse-row footprint (its physical-area rule). */
  physicalAreaM2: number | null;
  physicalAreaRowCount: number;
  physicalAreaRowsMissingDimensions: number;
  createdAt: string;
  updatedAt: string;
  settlement: { status: 'settled' | 'provisional'; settledAt: string | null; reason: string };
}

export interface V2ListPage<T> {
  items: T[];
  nextCursor: string | null;
  resumeCursor: string | null;
  hasMore: boolean;
  serverTime: string;
}

export interface V2Tombstone {
  tombstoneId: string;
  yieldEntryId: string;
  varietyId: string | null;
  packingYear: number | null;
  packingWeek: number | null;
  deletedAt: string;
}

export interface V2ManifestHeader {
  manifestId: string;
  expectedCount: number;
  checksum: string;
  algorithm: string;
  createdAt: string;
  expiresAt: string;
}

export interface V2ManifestPage extends V2ManifestHeader {
  offset: number;
  ids: string[];
  nextCursor: string | null;
  hasMore: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isTs = (v: unknown) => typeof v === 'string' && !isNaN(Date.parse(v));
const isNonNegOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
const isKgMap = (v: unknown) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0);

/** null when the item matches the v2 contract, otherwise the first violation. */
export function validateYieldWeekItem(raw: unknown): string | null {
  const r = raw as Partial<V2YieldWeekItem> | null;
  if (!r || typeof r !== 'object') return 'item is not an object';
  if (typeof r.yieldEntryId !== 'string' || !UUID_RE.test(r.yieldEntryId)) return 'invalid yieldEntryId';
  if (typeof r.varietyId !== 'string' || !UUID_RE.test(r.varietyId)) return 'invalid varietyId';
  if (!isValidIsoWeek(r.packingYear, r.packingWeek)) return `invalid packing week ${JSON.stringify(r.packingWeek)} for ${JSON.stringify(r.packingYear)}`;
  if (r.packedDate !== null && !(typeof r.packedDate === 'string' && DATE_RE.test(r.packedDate))) return 'invalid packedDate';
  for (const f of ['totalKg', 'averageFruitWeightG', 'totalCases', 'varietyAreaM2', 'physicalAreaM2'] as const) {
    if (!isNonNegOrNull(r[f])) return `invalid ${f}`;
  }
  if (r.averageFruitWeightG != null && r.averageFruitWeightG > 2000) return 'averageFruitWeightG implausible (> 2000 g)';
  if (!(r.kgPerM2 === null || (typeof r.kgPerM2 === 'number' && Number.isFinite(r.kgPerM2)))) return 'invalid kgPerM2';
  if (!Number.isInteger(r.physicalAreaRowCount) || (r.physicalAreaRowCount as number) < 0) return 'invalid physicalAreaRowCount';
  if (!Number.isInteger(r.physicalAreaRowsMissingDimensions) || (r.physicalAreaRowsMissingDimensions as number) < 0 || (r.physicalAreaRowsMissingDimensions as number) > (r.physicalAreaRowCount as number)) return 'invalid physicalAreaRowsMissingDimensions';
  if (!isKgMap(r.sizeKg)) return 'invalid sizeKg';
  if (!Array.isArray(r.daily)) return 'daily must be an array';
  for (const d of r.daily) {
    if (!d || typeof d.breakdownId !== 'string') return 'daily row missing breakdownId';
    if (d.packedDate !== null && !(typeof d.packedDate === 'string' && DATE_RE.test(d.packedDate))) return 'invalid daily packedDate';
    if (!isNonNegOrNull(d.totalKg) || !isNonNegOrNull(d.averageFruitWeightG)) return 'invalid daily kg/AFW';
    if (!isKgMap(d.sizeKg) || !isTs(d.updatedAt)) return 'invalid daily row';
  }
  if (!(r.dailyBreakdownComplete === null || typeof r.dailyBreakdownComplete === 'boolean')) return 'invalid dailyBreakdownComplete';
  if (typeof r.lastWriteSource !== 'string') return 'invalid lastWriteSource';
  if (!isTs(r.createdAt) || !isTs(r.updatedAt)) return 'invalid createdAt/updatedAt';
  if (r.varietyUpdatedAt !== null && !isTs(r.varietyUpdatedAt)) return 'invalid varietyUpdatedAt';
  const s = r.settlement;
  if (!s || (s.status !== 'settled' && s.status !== 'provisional')) return 'invalid settlement.status';
  if (s.settledAt !== null && !isTs(s.settledAt)) return 'invalid settlement.settledAt';
  if (s.status === 'settled' && s.settledAt === null) return 'settled without settledAt';
  return null;
}

// ── Canonical payload hash (data fields only — settlement is not data) ────

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}
const DATA_FIELDS = [
  'varietyId', 'varietyName', 'packingYear', 'packingWeek', 'packedDate', 'totalKg', 'averageFruitWeightG', 'totalCases',
  'sizeKg', 'kgPerM2', 'daily', 'dailyBreakdownComplete', 'lastWriteSource', 'varietyAreaM2', 'varietyUpdatedAt',
  'physicalAreaM2', 'physicalAreaRowCount', 'physicalAreaRowsMissingDimensions', 'createdAt', 'updatedAt',
] as const;
export function payloadSha256(item: V2YieldWeekItem): string {
  const data = Object.fromEntries(DATA_FIELDS.map((f) => [f, item[f]]));
  return createHash('sha256').update(JSON.stringify(canonical(data))).digest('hex');
}
function changedFields(prev: V2YieldWeekItem | null, next: V2YieldWeekItem): string[] {
  if (!prev) return [...DATA_FIELDS];
  return DATA_FIELDS.filter((f) => JSON.stringify(canonical(prev[f])) !== JSON.stringify(canonical(next[f])));
}

export function keyFingerprint(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex').slice(0, 16);
}

// ── Stored row shape ───────────────────────────────────────────────────────

export type UpstreamStatus = 'active' | 'deleted_upstream' | 'missing_upstream';

export interface StoredYieldWeek {
  growlink_yield_entry_id: string;
  growlink_variety_id: string;
  growlink_variety_name: string | null;
  packing_year: number;
  packing_week: number;
  packed_date: string | null;
  total_kg: number | null;
  average_fruit_weight_g: number | null;
  total_cases: number | null;
  size_kg: Record<string, number>;
  kg_per_m2: number | null;
  daily: V2DailyRow[];
  daily_breakdown_complete: boolean | null;
  last_write_source: string | null;
  variety_area_m2: number | null;
  variety_updated_at: string | null;
  physical_area_m2: number | null;
  physical_area_row_count: number;
  physical_area_rows_missing_dimensions: number;
  upstream_created_at: string;
  upstream_updated_at_raw: string;
  upstream_updated_at: string;
  settlement_status: 'settled' | 'provisional';
  settled_at: string | null;
  settlement_reason: string | null;
  upstream_status: UpstreamStatus;
  upstream_status_changed_at: string | null;
  missing_candidate_run_id: string | null;
  raw_payload: V2YieldWeekItem;
  payload_sha256: string;
  api_version: string;
  first_seen_run_id: string;
  last_seen_run_id: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface Revision {
  growlink_yield_entry_id: string;
  sync_run_id: string;
  change_kind: 'update' | 'deleted_upstream' | 'missing_upstream' | 'restored';
  was_settled: boolean;
  changed_fields: string[];
  previous_payload: V2YieldWeekItem | null;
  current_payload: V2YieldWeekItem | null;
  detected_at: string;
}

export function toStoredRow(item: V2YieldWeekItem, runId: string, now: string, existing?: StoredYieldWeek): StoredYieldWeek {
  return {
    growlink_yield_entry_id: item.yieldEntryId.toLowerCase(),
    growlink_variety_id: item.varietyId.toLowerCase(),
    growlink_variety_name: item.varietyName || null,
    packing_year: item.packingYear,
    packing_week: item.packingWeek,
    packed_date: item.packedDate,
    total_kg: item.totalKg,
    average_fruit_weight_g: item.averageFruitWeightG,
    total_cases: item.totalCases,
    size_kg: item.sizeKg,
    kg_per_m2: item.kgPerM2,
    daily: item.daily,
    daily_breakdown_complete: item.dailyBreakdownComplete,
    last_write_source: item.lastWriteSource,
    variety_area_m2: item.varietyAreaM2,
    variety_updated_at: item.varietyUpdatedAt,
    physical_area_m2: item.physicalAreaM2,
    physical_area_row_count: item.physicalAreaRowCount,
    physical_area_rows_missing_dimensions: item.physicalAreaRowsMissingDimensions,
    upstream_created_at: item.createdAt,
    upstream_updated_at_raw: item.updatedAt,
    upstream_updated_at: new Date(item.updatedAt).toISOString(),
    settlement_status: item.settlement.status,
    settled_at: item.settlement.settledAt,
    settlement_reason: item.settlement.reason,
    upstream_status: 'active',
    upstream_status_changed_at: existing && existing.upstream_status !== 'active' ? now : existing?.upstream_status_changed_at ?? null,
    missing_candidate_run_id: null, // seen upstream → not missing
    raw_payload: item,
    payload_sha256: payloadSha256(item),
    api_version: 'v2',
    first_seen_run_id: existing?.first_seen_run_id ?? runId,
    last_seen_run_id: runId,
    first_seen_at: existing?.first_seen_at ?? now,
    last_seen_at: now,
  };
}

// ── Page collection ────────────────────────────────────────────────────────

export class SyncAbort extends Error {}

/**
 * Walks every page from `startCursor`. Throws (so nothing is committed and
 * the watermark does not move) on a malformed envelope, a stalled cursor, or
 * too many pages. A row edited mid-walk can legitimately appear twice; the
 * later (newer) copy wins.
 */
export async function collectPages<T extends { yieldEntryId?: string; tombstoneId?: string }>(
  fetchPage: (cursor: string | null) => Promise<V2ListPage<T>>,
  startCursor: string | null,
  idOf: (item: T) => string
): Promise<{ items: T[]; pages: number; resumeCursor: string | null }> {
  const byId = new Map<string, T>();
  let cursor = startCursor;
  let resume = startCursor;
  let pages = 0;
  for (;;) {
    const page = await fetchPage(cursor);
    pages++;
    if (!page || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean') throw new SyncAbort('malformed page envelope');
    if (page.hasMore !== (page.nextCursor != null)) throw new SyncAbort('hasMore and nextCursor disagree');
    if (page.hasMore && page.nextCursor === cursor) throw new SyncAbort('cursor did not advance');
    if (pages > MAX_PAGES_PER_RUN) throw new SyncAbort(`more than ${MAX_PAGES_PER_RUN} pages`);
    for (const item of page.items) {
      const id = idOf(item);
      byId.delete(id); // re-insert so iteration order reflects the latest copy
      byId.set(id, item);
    }
    if (page.resumeCursor) resume = page.resumeCursor;
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  return { items: [...byId.values()], pages, resumeCursor: resume };
}

// ── Upsert planning (late edits, settlement, restores) ─────────────────────

export interface UpsertPlan {
  inserts: StoredYieldWeek[];
  updates: StoredYieldWeek[];
  revisions: Revision[];
  rejected: RejectedRecord[];
  counts: { created: number; updated: number; settlementOnly: number; unchanged: number; lateEdits: number; restored: number };
}

export function planYieldWeekUpserts(rawItems: unknown[], existingById: Map<string, StoredYieldWeek>, runId: string, now: string): UpsertPlan {
  const plan: UpsertPlan = { inserts: [], updates: [], revisions: [], rejected: [], counts: { created: 0, updated: 0, settlementOnly: 0, unchanged: 0, lateEdits: 0, restored: 0 } };
  for (const raw of rawItems) {
    const reason = validateYieldWeekItem(raw);
    if (reason) {
      const r = (raw ?? {}) as Partial<V2YieldWeekItem>;
      plan.rejected.push({ harvestId: typeof r.yieldEntryId === 'string' ? r.yieldEntryId : null, year: r.packingYear, week: r.packingWeek, stage: 'validation', reason });
      continue;
    }
    const item = raw as V2YieldWeekItem;
    const existing = existingById.get(item.yieldEntryId.toLowerCase());
    const row = toStoredRow(item, runId, now, existing);
    if (!existing) { plan.inserts.push(row); plan.counts.created++; continue; }

    const restored = existing.upstream_status !== 'active';
    if (restored) {
      plan.counts.restored++;
      plan.revisions.push({ growlink_yield_entry_id: row.growlink_yield_entry_id, sync_run_id: runId, change_kind: 'restored', was_settled: existing.settlement_status === 'settled', changed_fields: [], previous_payload: existing.raw_payload, current_payload: item, detected_at: now });
    }
    if (existing.payload_sha256 !== row.payload_sha256) {
      const wasSettled = existing.settlement_status === 'settled';
      if (wasSettled) plan.counts.lateEdits++;
      plan.revisions.push({ growlink_yield_entry_id: row.growlink_yield_entry_id, sync_run_id: runId, change_kind: 'update', was_settled: wasSettled, changed_fields: changedFields(existing.raw_payload, item), previous_payload: existing.raw_payload, current_payload: item, detected_at: now });
      plan.updates.push(row);
      plan.counts.updated++;
    } else if (restored || existing.settlement_status !== row.settlement_status || existing.settled_at !== row.settled_at || existing.missing_candidate_run_id) {
      plan.updates.push(row);
      plan.counts.settlementOnly++;
    } else {
      plan.counts.unchanged++;
    }
  }
  return plan;
}

// ── Tombstones ─────────────────────────────────────────────────────────────

export function planTombstones(tombstones: V2Tombstone[], existingById: Map<string, StoredYieldWeek>, runId: string, now: string) {
  const updates: StoredYieldWeek[] = [];
  const revisions: Revision[] = [];
  let unknown = 0;
  for (const t of tombstones) {
    const existing = existingById.get(t.yieldEntryId.toLowerCase());
    if (!existing) { unknown++; continue; }
    if (existing.upstream_status === 'deleted_upstream') continue;
    updates.push({ ...existing, upstream_status: 'deleted_upstream', upstream_status_changed_at: now, missing_candidate_run_id: null, last_seen_run_id: runId });
    revisions.push({ growlink_yield_entry_id: existing.growlink_yield_entry_id, sync_run_id: runId, change_kind: 'deleted_upstream', was_settled: existing.settlement_status === 'settled', changed_fields: [], previous_payload: existing.raw_payload, current_payload: null, detected_at: now });
  }
  return { updates, revisions, unknown };
}

// ── Manifest verification ──────────────────────────────────────────────────

export class ManifestVerificationError extends Error {}

export function manifestChecksum(ids: string[]): string {
  return createHash('sha256').update(ids.map((i) => i.toLowerCase()).sort().join('\n')).digest('hex');
}

/** Proves every page belongs to one complete manifest. Throws otherwise. */
export function verifyManifest(header: V2ManifestHeader, pages: V2ManifestPage[]): { ids: Set<string>; createdAt: string } {
  if (header.algorithm !== SUPPORTED_MANIFEST_ALGORITHM) throw new ManifestVerificationError(`unsupported checksum algorithm ${header.algorithm}`);
  if (pages.length === 0) throw new ManifestVerificationError('no pages');
  let offset = 0;
  const ids: string[] = [];
  pages.forEach((p, i) => {
    if (p.manifestId !== header.manifestId) throw new ManifestVerificationError(`page ${i} belongs to manifest ${p.manifestId}`);
    if (p.checksum !== header.checksum || p.expectedCount !== header.expectedCount || p.algorithm !== header.algorithm || p.createdAt !== header.createdAt) {
      throw new ManifestVerificationError(`page ${i} header differs from the manifest`);
    }
    if (p.offset !== offset) throw new ManifestVerificationError(`page ${i} starts at ${p.offset}, expected ${offset}`);
    const last = i === pages.length - 1;
    if (last ? p.hasMore || p.nextCursor !== null : !p.hasMore) throw new ManifestVerificationError(`page ${i} continuation flags are inconsistent`);
    ids.push(...p.ids.map((x) => x.toLowerCase()));
    offset += p.ids.length;
  });
  if (ids.length !== header.expectedCount) throw new ManifestVerificationError(`received ${ids.length} ids, expected ${header.expectedCount}`);
  const set = new Set(ids);
  if (set.size !== ids.length) throw new ManifestVerificationError('duplicate ids');
  if (manifestChecksum(ids) !== header.checksum) throw new ManifestVerificationError('checksum mismatch');
  return { ids: set, createdAt: header.createdAt };
}

// ── Missing reconciliation (two consecutive verified manifests) ─────────────

export interface MissingPlan {
  aborted: boolean;
  reason: string | null;
  updates: StoredYieldWeek[];
  revisions: Revision[];
  counts: { considered: number; absent: number; newCandidates: number; markedMissing: number; restored: number; clearedCandidates: number };
}

export function planMissingReconciliation(
  rows: StoredYieldWeek[],
  manifest: { ids: Set<string>; createdAt: string },
  runId: string,
  now: string,
  threshold = MASS_ABSENCE_THRESHOLD
): MissingPlan {
  const plan: MissingPlan = { aborted: false, reason: null, updates: [], revisions: [], counts: { considered: 0, absent: 0, newCandidates: 0, markedMissing: 0, restored: 0, clearedCandidates: 0 } };
  // Rows created upstream after the manifest snapshot can't be in it; tombstoned rows are already resolved.
  const considered = rows.filter((r) => r.upstream_status !== 'deleted_upstream' && Date.parse(r.upstream_created_at) < Date.parse(manifest.createdAt));
  plan.counts.considered = considered.length;
  const active = considered.filter((r) => r.upstream_status === 'active');
  const absent = active.filter((r) => !manifest.ids.has(r.growlink_yield_entry_id));
  plan.counts.absent = absent.length;
  if (absent.length > 0 && absent.length > threshold * active.length) {
    plan.aborted = true;
    plan.reason = `${absent.length} of ${active.length} active rows absent (> ${threshold * 100}%) — not applied`;
    return plan;
  }
  for (const r of absent) {
    if (r.missing_candidate_run_id) {
      plan.updates.push({ ...r, upstream_status: 'missing_upstream', upstream_status_changed_at: now });
      plan.revisions.push({ growlink_yield_entry_id: r.growlink_yield_entry_id, sync_run_id: runId, change_kind: 'missing_upstream', was_settled: r.settlement_status === 'settled', changed_fields: [], previous_payload: r.raw_payload, current_payload: null, detected_at: now });
      plan.counts.markedMissing++;
    } else {
      plan.updates.push({ ...r, missing_candidate_run_id: runId });
      plan.counts.newCandidates++;
    }
  }
  for (const r of considered) {
    if (!manifest.ids.has(r.growlink_yield_entry_id)) continue;
    if (r.upstream_status === 'missing_upstream') {
      plan.updates.push({ ...r, upstream_status: 'active', upstream_status_changed_at: now, missing_candidate_run_id: null });
      plan.revisions.push({ growlink_yield_entry_id: r.growlink_yield_entry_id, sync_run_id: runId, change_kind: 'restored', was_settled: r.settlement_status === 'settled', changed_fields: [], previous_payload: r.raw_payload, current_payload: r.raw_payload, detected_at: now });
      plan.counts.restored++;
    } else if (r.missing_candidate_run_id) {
      plan.updates.push({ ...r, missing_candidate_run_id: null });
      plan.counts.clearedCandidates++;
    }
  }
  return plan;
}

// ── Derived values ─────────────────────────────────────────────────────────

export interface DerivedAfw {
  afwG: number | null;
  method: 'daily-fruit-weighted' | 'entry-level' | 'unavailable';
  version: typeof AFW_DERIVATION_VERSION;
}

/**
 * Weekly AFW from raw values. AFW is grams per fruit, so daily rows combine
 * as total grams over total fruit (Σkg / Σ(kg/AFW)) — the same rule GrowLink
 * uses when appending kg. Daily rows are preferred when the breakdown is
 * known complete and covers the weekly total; otherwise the entry-level AFW.
 */
export function deriveWeeklyAfw(item: Pick<V2YieldWeekItem, 'totalKg' | 'averageFruitWeightG' | 'daily' | 'dailyBreakdownComplete'>): DerivedAfw {
  const days = item.daily.filter((d) => (d.totalKg ?? 0) > 0 && (d.averageFruitWeightG ?? 0) > 0);
  const dayKg = days.reduce((s, d) => s + (d.totalKg as number), 0);
  if (item.dailyBreakdownComplete === true && days.length > 0 && item.totalKg != null && item.totalKg > 0 && Math.abs(dayKg - item.totalKg) <= 0.01 * item.totalKg) {
    const fruit = days.reduce((s, d) => s + ((d.totalKg as number) * 1000) / (d.averageFruitWeightG as number), 0);
    return { afwG: (dayKg * 1000) / fruit, method: 'daily-fruit-weighted', version: AFW_DERIVATION_VERSION };
  }
  if (item.averageFruitWeightG != null && item.averageFruitWeightG > 0) return { afwG: item.averageFruitWeightG, method: 'entry-level', version: AFW_DERIVATION_VERSION };
  return { afwG: null, method: 'unavailable', version: AFW_DERIVATION_VERSION };
}
