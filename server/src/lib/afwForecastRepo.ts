// Data access for grower-entered AFW forecasts (afw_forecast_entries,
// append-only). Server-side only; degrades to "unavailable" until the
// migration is applied.
import { supabase } from './supabase';
import { fetchAllRows } from './paginatedFetch';
import { ManualAfwEntry, AfwChange } from './afwForecast';

interface Row { id: number; variety_id: string; iso_year: number; iso_week: number; action: 'set' | 'clear'; grams: number | string | null; entered_at: string }

const toEntry = (r: Row): ManualAfwEntry => ({
  id: Number(r.id), varietyId: r.variety_id, year: r.iso_year, week: r.iso_week, action: r.action, grams: r.grams == null ? null : Number(r.grams), enteredAt: r.entered_at,
});

export interface AfwForecastRepo {
  /** null when the table does not exist yet (migration pending). */
  list(varietyId: string): Promise<ManualAfwEntry[] | null>;
  /** Inserts one batch in a single statement (all rows or none). */
  insertBatch(varietyId: string, batchId: string, changes: AfwChange[]): Promise<ManualAfwEntry[]>;
}

export const supabaseAfwForecastRepo: AfwForecastRepo = {
  async list(varietyId) {
    try {
      const rows = await fetchAllRows<Row>(() =>
        supabase.from('afw_forecast_entries').select('id, variety_id, iso_year, iso_week, action, grams, entered_at').eq('variety_id', varietyId)
      );
      return rows.map(toEntry);
    } catch (e) {
      if (/does not exist|could not find the table/i.test(String((e as Error)?.message))) return null;
      throw e;
    }
  },
  async insertBatch(varietyId, batchId, changes) {
    const rows = changes.map((c) => ({ batch_id: batchId, variety_id: varietyId, iso_year: c.year, iso_week: c.week, action: c.grams == null ? 'clear' : 'set', grams: c.grams, entered_by: 'editor-passcode' }));
    const { data, error } = await supabase.from('afw_forecast_entries').insert(rows).select('id, variety_id, iso_year, iso_week, action, grams, entered_at');
    if (error) throw new Error(error.message);
    return ((data ?? []) as Row[]).map(toEntry);
  },
};
