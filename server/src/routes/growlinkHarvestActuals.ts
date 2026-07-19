import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { getConnectionRow } from './growlinkConnection';

// Mostly read-only: these records are owned by GrowLink. The one exception
// is POST /sync below, which is the "future sync service" this table was
// always designed for — still never hand-edited otherwise.
const router = Router();

const SELECT_WITH_VARIETY = '*, variety:varieties(id, name)';
const HARVEST_ACTUALS_PATH = '/api/integrations/croplink/harvest-actuals';
const SYNC_TIMEOUT_MS = 20000;

interface RemoteHarvestActual {
  harvestId: string;
  varietyId: string;
  varietyName?: string;
  harvestDate: string | null;
  year: number;
  week: number;
  harvestKg: number | null;
  updatedAt?: string;
}

/**
 * Monday of the given ISO 8601 week — GrowLink's harvest-actuals payload
 * reports year+week but harvestDate is always null (confirmed live), while
 * growlink_harvest_actuals.harvest_date is not-null. Jan 4 always falls in
 * ISO week 1, which anchors the rest of the calculation.
 */
function isoWeekToMonday(year: number, week: number): string {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // Mon=1..Sun=7
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const target = new Date(week1Monday);
  target.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return target.toISOString().slice(0, 10);
}

interface ExistingHarvestActualRow {
  id: string;
  growlink_harvest_key: string;
  variety_id: string | null;
  kg: number | null;
  year: number;
  week_number: number;
  growlink_variety_key: string;
  source_payload: RemoteHarvestActual | null;
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
 * doesn't guarantee stable key order round-trip, so a naive
 * JSON.stringify(a) === JSON.stringify(b) would false-positive as "changed"
 * on nothing but key reordering.
 */
function isUnchanged(existing: ExistingHarvestActualRow, resolvedVarietyId: string | null, r: RemoteHarvestActual): boolean {
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

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, year, matched } = req.query;
    let query = supabase
      .from('growlink_harvest_actuals')
      .select(SELECT_WITH_VARIETY)
      .order('harvest_date', { ascending: false });
    if (varietyId) query = query.eq('variety_id', varietyId as string);
    if (year) query = query.eq('year', Number(year));
    if (matched === 'true') query = query.not('variety_id', 'is', null);
    if (matched === 'false') query = query.is('variety_id', null);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) { next(e); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('growlink_harvest_actuals')
      .select(SELECT_WITH_VARIETY)
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Harvest actual not found' });
    res.json(data);
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /sync — fetches GrowLink's harvest-actuals feed, resolves each
// record's variety via growlink_variety_links, and upserts into
// growlink_harvest_actuals keyed on growlink_harvest_key (GrowLink's
// harvestId). GrowLink's endpoint returns the full snapshot every call (no
// pagination or filtering observed), so every sync is a full fetch-and-diff.
// ─────────────────────────────────────────────────────────────────────────
router.post('/sync', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const connection = await getConnectionRow();
    if (!connection?.base_url || !connection?.secret_key) {
      return res.status(400).json({ error: 'GrowLink connection is not configured — set it up on the Connection tab first.' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
    let remoteRecords: RemoteHarvestActual[];
    try {
      const response = await fetch(`${connection.base_url}${HARVEST_ACTUALS_PATH}`, {
        headers: { 'X-Integration-Key': connection.secret_key },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return res.status(502).json({ error: `GrowLink responded with ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}` });
      }
      const json = await response.json();
      const parsed = Array.isArray(json) ? json : Array.isArray(json?.harvestActuals) ? json.harvestActuals : null;
      if (!parsed) return res.status(502).json({ error: 'Unexpected response shape from GrowLink harvest-actuals endpoint' });
      remoteRecords = parsed;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return res.status(504).json({ error: `Timed out after ${SYNC_TIMEOUT_MS / 1000}s contacting GrowLink` });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    // Only actively 'linked' rows resolve a variety_id — 'unlinked'/'conflict'
    // are the grower's explicit signal not to auto-resolve that key.
    const { data: links, error: linksError } = await supabase
      .from('growlink_variety_links')
      .select('variety_id, growlink_variety_key')
      .eq('link_status', 'linked');
    if (linksError) throw new Error(linksError.message);
    const varietyIdByGrowlinkKey = new Map((links ?? []).map((l) => [l.growlink_variety_key, l.variety_id]));

    // organization_id is null for every row in this app today, and a plain
    // unique index never treats two NULLs as a conflict — same caveat noted
    // on crop_integration_settings_org_name_uq — so (like elsewhere in this
    // codebase) this looks up existing rows explicitly by growlink_harvest_key
    // instead of relying on ON CONFLICT to find them. Selects the full row
    // (not just id) so isUnchanged() can diff against it below.
    const { data: existingRows, error: existingError } = await supabase
      .from('growlink_harvest_actuals')
      .select('id, growlink_harvest_key, variety_id, kg, year, week_number, growlink_variety_key, source_payload')
      .is('organization_id', null);
    if (existingError) throw new Error(existingError.message);
    const existingByKey = new Map((existingRows ?? []).map((r) => [r.growlink_harvest_key, r as ExistingHarvestActualRow]));

    const now = new Date().toISOString();
    const toInsert: Record<string, unknown>[] = [];
    const toUpdate: Record<string, unknown>[] = [];
    const matchedGrowlinkVarietyKeys = new Set<string>();
    let matchedCount = 0;
    let unmatchedCount = 0;
    let skippedCount = 0;
    let unchangedCount = 0;

    for (const r of remoteRecords) {
      if (!r.harvestId || !r.varietyId) { skippedCount++; continue; }

      const varietyId = varietyIdByGrowlinkKey.get(r.varietyId) ?? null;
      if (varietyId) { matchedCount++; matchedGrowlinkVarietyKeys.add(r.varietyId); }
      else unmatchedCount++;

      const existing = existingByKey.get(r.harvestId);
      if (existing && isUnchanged(existing, varietyId, r)) {
        // Identical to what's already stored — nothing to write, and
        // deliberately not touched (synced_at included), so an unchanged
        // record stays an honest no-op rather than a write that just moves
        // a timestamp.
        unchangedCount++;
        continue;
      }

      const row: Record<string, unknown> = {
        organization_id: null,
        growlink_harvest_key: r.harvestId,
        growlink_variety_key: r.varietyId,
        variety_id: varietyId,
        harvest_date: r.harvestDate ?? isoWeekToMonday(r.year, r.week),
        year: r.year,
        week_number: r.week,
        kg: r.harvestKg ?? null,
        source_payload: r,
        synced_at: now,
      };

      if (existing) toUpdate.push({ id: existing.id, ...row });
      else toInsert.push(row);
    }

    if (toInsert.length > 0) {
      const { error } = await supabase.from('growlink_harvest_actuals').insert(toInsert);
      if (error) throw new Error(error.message);
    }
    if (toUpdate.length > 0) {
      const { error } = await supabase.from('growlink_harvest_actuals').upsert(toUpdate);
      if (error) throw new Error(error.message);
    }
    if (matchedGrowlinkVarietyKeys.size > 0) {
      await supabase
        .from('growlink_variety_links')
        .update({ last_synced_at: now })
        .in('growlink_variety_key', Array.from(matchedGrowlinkVarietyKeys));
    }

    res.json({
      fetched: remoteRecords.length,
      created: toInsert.length,
      updated: toUpdate.length,
      unchanged: unchangedCount,
      matched: matchedCount,
      unmatched: unmatchedCount,
      skipped: skippedCount,
      syncedAt: now,
    });
  } catch (e) { next(e); }
});

export default router;
