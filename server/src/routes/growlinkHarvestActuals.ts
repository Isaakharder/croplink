import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { getConnectionRow } from './growlinkConnection';
import { fetchAllRows } from '../lib/paginatedFetch';
import { ExistingHarvestActualRow, planHarvestActualsSync, writeWithRowFallback } from '../lib/growlinkHarvestSync';

// Mostly read-only: these records are owned by GrowLink. The one exception
// is POST /sync below, which is the "future sync service" this table was
// always designed for — still never hand-edited otherwise.
const router = Router();

const SELECT_WITH_VARIETY = '*, variety:varieties(id, name)';
const HARVEST_ACTUALS_PATH = '/api/integrations/croplink/harvest-actuals';
const SYNC_TIMEOUT_MS = 20000;

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
    let remoteRecords: unknown[];
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
    // Paginated defensively — currently well under the 1,000-row cap (126
    // rows total today), but this lookup existing outright unbounded is
    // exactly the pattern that caused silent truncation elsewhere in this
    // codebase, and here a miss doesn't just mis-display something: it
    // makes an already-synced record look new, producing a duplicate
    // insert (or an update never applied to the real existing row) once
    // this table grows past the cap.
    const existingRows = await fetchAllRows<ExistingHarvestActualRow>(() =>
      supabase
        .from('growlink_harvest_actuals')
        .select('id, growlink_harvest_key, variety_id, kg, year, week_number, growlink_variety_key, source_payload')
        .is('organization_id', null)
    );
    const existingByKey = new Map(existingRows.map((r) => [r.growlink_harvest_key, r]));

    const now = new Date().toISOString();
    // Validation happens per record: a malformed record (or a week that
    // doesn't exist in its ISO year) is reported, never allowed to fail the
    // whole sync.
    const plan = planHarvestActualsSync(remoteRecords, existingByKey, varietyIdByGrowlinkKey, now);

    const inserted = await writeWithRowFallback(plan.toInsert, async (rows) => {
      const { error } = await supabase.from('growlink_harvest_actuals').insert(rows);
      return error ? error.message : null;
    });
    const updated = await writeWithRowFallback(plan.toUpdate, async (rows) => {
      const { error } = await supabase.from('growlink_harvest_actuals').upsert(rows);
      return error ? error.message : null;
    });
    if (plan.matchedGrowlinkVarietyKeys.size > 0) {
      await supabase
        .from('growlink_variety_links')
        .update({ last_synced_at: now })
        .in('growlink_variety_key', Array.from(plan.matchedGrowlinkVarietyKeys));
    }

    const rejectedRecords = [...plan.rejected, ...inserted.failed, ...updated.failed];
    for (const r of rejectedRecords) {
      console.warn(`[growlink-sync] rejected ${r.stage} harvestId=${r.harvestId} year=${r.year} week=${r.week}: ${r.reason}`);
    }

    res.json({
      fetched: remoteRecords.length,
      created: inserted.written,
      updated: updated.written,
      unchanged: plan.unchangedCount,
      matched: plan.matchedCount,
      unmatched: plan.unmatchedCount,
      skipped: plan.rejected.length,
      failed: inserted.failed.length + updated.failed.length,
      rejectedRecords,
      syncedAt: now,
    });
  } catch (e) { next(e); }
});

export default router;
