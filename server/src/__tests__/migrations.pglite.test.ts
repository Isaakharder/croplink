/**
 * Applies the W53 migration and the GrowLink yield-weeks migration verbatim in
 * an in-process Postgres (PGlite — WASM, no server, no network, no
 * credentials) on top of stand-ins for the tables they alter.
 *
 * Run with: npx tsx src/__tests__/migrations.pglite.test.ts
 */
import { readFileSync } from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';

let pass = 0;
let fail = 0;
function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); fail++; }
}
async function rejects(label: string, p: Promise<unknown>) {
  try { await p; assert(label, 'accepted', 'rejected'); } catch { assert(label, 'rejected', 'rejected'); }
}
const migration = (f: string) => readFileSync(path.resolve(__dirname, '../../../supabase/migrations', f), 'utf8');

(async () => {
  const db = new PGlite();
  // Original 1–52 week checks, as created by 001_initial_schema / later migrations.
  await db.exec(`
    create table weekly_node_statuses (id serial primary key, year integer not null, week_number integer not null check (week_number >= 1 and week_number <= 52));
    create table fruit_weight_by_week (id serial primary key, year integer not null, week_number integer not null check (week_number >= 1 and week_number <= 52));
    create table harvest_timing_profiles (id serial primary key, year integer not null, set_week_number integer not null check (set_week_number >= 1 and set_week_number <= 52));
    create table harvested_entries (id serial primary key, year integer not null, week_number integer not null check (week_number >= 1 and week_number <= 52));
    create table harvest_afw_by_week (id serial primary key, year integer not null, week_number integer not null check (week_number >= 1 and week_number <= 52));
    create table growlink_harvest_actuals (id serial primary key, year integer not null, week_number integer not null check (week_number >= 1 and week_number <= 52));
  `);

  console.log('20261004000000_iso_week_53.sql');
  await db.exec(migration('20261004000000_iso_week_53.sql'));
  const fn = async (y: number) => (await db.query<{ n: number }>('select iso_weeks_in_year($1) n', [y])).rows[0].n;
  assert('iso_weeks_in_year: 2026 → 53, 2025 → 52, 2020 → 53', [await fn(2026), await fn(2025), await fn(2020)], [53, 52, 53]);
  for (const [table, col] of [['weekly_node_statuses', 'week_number'], ['fruit_weight_by_week', 'week_number'], ['harvest_timing_profiles', 'set_week_number'], ['harvested_entries', 'week_number'], ['harvest_afw_by_week', 'week_number'], ['growlink_harvest_actuals', 'week_number']]) {
    await db.query(`insert into ${table} (year, ${col}) values (2026, 53)`);
    assert(`${table}: 2026-W53 accepted`, true, true);
    await rejects(`${table}: 2025-W53 rejected`, db.query(`insert into ${table} (year, ${col}) values (2025, 53)`));
    await rejects(`${table}: W0 rejected`, db.query(`insert into ${table} (year, ${col}) values (2026, 0)`));
  }
  const old = await db.query(`select count(*)::int n from pg_constraint where contype = 'c' and pg_get_constraintdef(oid) ~ 'week_number <= 52'`);
  assert('no "<= 52" checks remain', (old.rows[0] as { n: number }).n, 0);

  console.log('20261005000000_growlink_yield_weeks.sql');
  await db.exec(migration('20261005000000_growlink_yield_weeks.sql'));
  const base = (over: Record<string, unknown> = {}) => {
    const r: Record<string, unknown> = {
      growlink_yield_entry_id: '00000000-0000-4000-8000-000000000001', growlink_variety_id: '00000000-0000-4000-8000-000000000002',
      packing_year: 2026, packing_week: 53, upstream_created_at: '2026-12-28T10:00:00Z', upstream_updated_at_raw: '2026-12-29T10:00:00.123456+00:00',
      upstream_updated_at: '2026-12-29T10:00:00Z', settlement_status: 'provisional', raw_payload: '{}', payload_sha256: 'abc',
      first_seen_run_id: '00000000-0000-4000-8000-000000000003', last_seen_run_id: '00000000-0000-4000-8000-000000000003', ...over,
    };
    const cols = Object.keys(r);
    return db.query(`insert into growlink_yield_weeks (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(r));
  };
  await base();
  assert('2026 packing W53 stored, defaults applied', (await db.query<{ s: string; d: unknown }>(`select upstream_status s, daily d from growlink_yield_weeks`)).rows[0], { s: 'active', d: [] });
  await rejects('duplicate upstream id rejected', base());
  await rejects('2025 packing W53 rejected', base({ growlink_yield_entry_id: '00000000-0000-4000-8000-000000000009', packing_year: 2025 }));
  await rejects('unknown settlement status rejected', base({ growlink_yield_entry_id: '00000000-0000-4000-8000-00000000000a', settlement_status: 'final' }));
  await rejects('unknown upstream status rejected', base({ growlink_yield_entry_id: '00000000-0000-4000-8000-00000000000b', upstream_status: 'gone' }));
  await rejects('raw payload is required', base({ growlink_yield_entry_id: '00000000-0000-4000-8000-00000000000c', raw_payload: null }));
  await db.query(`insert into growlink_yield_week_revisions (growlink_yield_entry_id, sync_run_id, change_kind, was_settled) values ($1, $2, 'update', true)`, ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003']);
  await rejects('unknown revision kind rejected', db.query(`insert into growlink_yield_week_revisions (growlink_yield_entry_id, sync_run_id, change_kind, was_settled) values ($1, $2, 'purged', false)`, ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003']));
  await rejects('sync state only for known endpoints', db.query(`insert into growlink_sync_state (endpoint, cursor) values ('everything', '{}')`));
  const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class where relname like 'growlink_%' and relkind = 'r' and relname <> 'growlink_harvest_actuals' order by relname`);
  assert('row-level security on every new table', rls.rows.map((r) => [r.relname, r.relrowsecurity]), [['growlink_sync_runs', true], ['growlink_sync_state', true], ['growlink_yield_week_revisions', true], ['growlink_yield_weeks', true]]);
  const cols = await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'growlink_yield_weeks' and (column_name like '%week%' or column_name like '%year%') order by 1`);
  assert('only packing weeks are stored (no harvest-week columns)', cols.rows.map((r) => r.column_name), ['packing_week', 'packing_year']);
  const secretCols = await db.query<{ n: number }>(`select count(*)::int n from information_schema.columns where table_name like 'growlink_sync_%' and column_name ~ '(secret|key)$' and column_name <> 'key_fingerprint'`);
  assert('no secret/key columns besides the fingerprint', secretCols.rows[0].n, 0);

  console.log('20261006000000_forecast_lab.sql');
  await db.exec(`create table varieties (id uuid primary key default gen_random_uuid(), name text, area_m2 numeric, plant_count integer, total_stem_count integer,
    average_fruit_weight_grams numeric, is_active boolean not null default true, plant_date date, pull_out_date date, case_kg numeric,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    insert into varieties (id, name, area_m2, plant_count, total_stem_count, pull_out_date, created_at, updated_at)
    values ('00000000-0000-4000-8000-0000000000aa', 'Mathieu', 11627, 40068, 80136, '2026-12-31', '2026-05-25', '2026-09-19 21:36:18+00');`);
  await db.exec(migration('20261006000000_forecast_lab.sql'));
  const baseline = await db.query<{ field: string; source: string; note: string }>(`select field, source, note from variety_config_history order by field`);
  assert('baseline config history: 8 fields per variety, marked backfill', [baseline.rows.length, baseline.rows.every((r) => r.source === 'backfill')], [8, true]);
  assert('baseline notes that earlier values are unknown (incl. the 2026-09-19 change)', baseline.rows[0].note.includes('2026-09-19'), true);
  await db.exec(`update varieties set area_m2 = 11787, name = 'Mathieu B' where id = '00000000-0000-4000-8000-0000000000aa'`);
  const ch = await db.query<{ field: string; old_value: number; new_value: number; source: string }>(`select field, old_value, new_value, source from variety_config_history where source <> 'backfill'`);
  assert('a scaling change is recorded (non-scaling fields are not)', ch.rows.map((r) => [r.field, Number(r.old_value), Number(r.new_value), r.source]), [['area_m2', 11627, 11787, 'api']]);
  await db.exec(`insert into forecast_lab_runs (id, kind, status, started_at) values ('00000000-0000-4000-8000-0000000000b1', 'cycle', 'running', now())`);
  const snap = (over: Record<string, unknown> = {}) => {
    const r: Record<string, unknown> = { run_id: '00000000-0000-4000-8000-0000000000b1', kind: 'live', variety_id: '00000000-0000-4000-8000-0000000000aa', model_id: 'open-fruit-d',
      model_version: 'open-fruit-d/1.0.0', experimental: true, as_of_year: 2026, as_of_week: 52, as_of_index: 2964, input_cutoff: '2026-12-29T00:00:00Z',
      target_year: 2026, target_week: 53, target_index: 2965, horizon: 1, forecast_kg: 1234.5, range_low_kg: 1000, range_high_kg: 1500, area_m2: 11627,
      total_stems: 80136, measured_stems: 56, harvest_window: 0.5714, params: '{}', evidence: '{}', ...over };
    const cols = Object.keys(r);
    return db.query(`insert into forecast_lab_snapshots (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) on conflict on constraint forecast_lab_snapshots_natural_key do nothing returning id`, Object.values(r));
  };
  assert('W53 target snapshot stored', (await snap()).rows.length, 1);
  assert('same forecast issued again → ignored, not rewritten', (await snap({ forecast_kg: 9999 })).rows.length, 0);
  assert('stored value is the original', Number((await db.query<{ k: string }>(`select forecast_kg k from forecast_lab_snapshots`)).rows[0].k), 1234.5);
  await rejects('UPDATE of a snapshot rejected', db.query(`update forecast_lab_snapshots set forecast_kg = 1`));
  await rejects('DELETE of a snapshot rejected', db.query(`delete from forecast_lab_snapshots`));
  await rejects('TRUNCATE of snapshots rejected', db.query(`truncate forecast_lab_snapshots`));
  await rejects('target must equal as-of + horizon', snap({ target_index: 2970 }));
  await rejects('range low above high rejected', snap({ as_of_index: 2963, target_index: 2964, target_week: 52, as_of_week: 51, range_low_kg: 2000 }));
  await rejects('unknown model id rejected', snap({ model_id: 'magic', as_of_index: 2960, target_index: 2961, as_of_week: 48, target_week: 49 }));
  await rejects('2025-W53 target rejected', snap({ target_year: 2025, as_of_index: 2959, target_index: 2960, as_of_week: 47, target_week: 53 }));
  const rls2 = await db.query<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class where relname in ('forecast_lab_runs','forecast_lab_snapshots','forecast_lab_exclusions','variety_config_history') order by relname`);
  assert('row-level security on all Forecast Lab tables', rls2.rows.every((r) => r.relrowsecurity) && rls2.rows.length === 4, true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
