// Supabase-backed YieldWeekRepo for the GrowLink v2 sync. Server-side only:
// these tables are never exposed through CropLink's public API.
import { supabase } from './supabase';
import { fetchAllRows } from './paginatedFetch';
import { chunkArray } from './chunkArray';
import { StoredYieldWeek } from './growlinkYieldSync';
import { YieldWeekRepo } from './growlinkYieldSyncRunner';

export const supabaseYieldWeekRepo: YieldWeekRepo = {
  async getCursor(endpoint) {
    const { data, error } = await supabase.from('growlink_sync_state').select('cursor').eq('endpoint', endpoint).maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.cursor as { resumeCursor?: string } | null)?.resumeCursor ?? null;
  },
  async setCursor(endpoint, cursor, keyFingerprint) {
    const { error } = await supabase.from('growlink_sync_state')
      .upsert({ endpoint, cursor: { resumeCursor: cursor }, key_fingerprint: keyFingerprint, updated_at: new Date().toISOString() }, { onConflict: 'endpoint' });
    if (error) throw new Error(error.message);
  },
  async getByIds(ids) {
    const out: StoredYieldWeek[] = [];
    for (const chunk of chunkArray([...new Set(ids)], 100)) {
      const { data, error } = await supabase.from('growlink_yield_weeks').select('*').in('growlink_yield_entry_id', chunk);
      if (error) throw new Error(error.message);
      out.push(...((data ?? []) as StoredYieldWeek[]));
    }
    return out;
  },
  async getAllForReconciliation() {
    return fetchAllRows<StoredYieldWeek>(() => supabase.from('growlink_yield_weeks').select('*'));
  },
  async writeRows(rows, mode) {
    const { error } = mode === 'insert'
      ? await supabase.from('growlink_yield_weeks').insert(rows)
      : await supabase.from('growlink_yield_weeks').upsert(rows, { onConflict: 'growlink_yield_entry_id' });
    return error ? error.message : null;
  },
  async insertRevisions(revisions) {
    for (const chunk of chunkArray(revisions, 200)) {
      const { error } = await supabase.from('growlink_yield_week_revisions').insert(chunk);
      if (error) throw new Error(error.message);
    }
  },
  async saveRun(run) {
    const { error } = await supabase.from('growlink_sync_runs').upsert(run, { onConflict: 'id' });
    if (error) throw new Error(error.message);
  },
};
