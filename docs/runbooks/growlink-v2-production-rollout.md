# GrowLink v2 / CropLink sync — production rollout runbook

Code state (2026-10-04): GrowLink `main` = `0a552a9`, CropLink `main` = `747eafa`, both deployed. Until the steps below are applied:
- GrowLink v2 endpoints refuse every existing key (403 for a valid key without the new scope).
- GrowLink key lookups fall back to the pre-scope columns.
- GrowLink does not write `last_write_source`.
- CropLink's `/api/growlink/yield-weeks/sync-internal` exists but needs `INTERNAL_OPS_KEY` and `GROWLINK_CROPLINK_KEY`, and is never called automatically.
- The experimental D/IC forecast is not on CropLink `main`.

**Progress (2026-10-04):** GrowLink 0140, 0141 and 0142 applied and verified in production; CropLink Test Connection passes (8 varieties). Everything from step 3 on is pending. **Every step requires approval.** Run each migration in the Supabase SQL editor of the named project. Preflight blocks are read-only (`begin transaction read only … rollback`).

## Order

| # | Where | Step | Gate |
|---|---|---|---|
| 1 | GrowLink DB | Preflight 0140 → apply `0140_rls_fix_integration_keys.sql` → verify | Preflight A clean |
| 2 | GrowLink DB | Preflight 0141 → apply `0141_croplink_v2_yield_detail.sql` → verify | Preflight B clean |
| 2b | GrowLink DB | Apply `0142_revoke_v2_tables_from_api_roles.sql` → verify | Step 2 verified |
| 3 | GrowLink Railway (server) | Set `YIELD_WRITE_SOURCE_TRACKING=enabled` → redeploy → verify one write | Step 2 verified |
| 4 | GrowLink admin | Issue a scoped CropLink key | Step 2 verified |
| 5 | CropLink DB | Preflight → apply `20261004000000_iso_week_53.sql` → verify (**before 2026-12-28**) | Preflight C clean |
| 6 | CropLink DB | Preflight → apply `20261005000000_growlink_yield_weeks.sql` → verify | Step 5 verified |
| 7 | CropLink Railway (server) | Set `GROWLINK_CROPLINK_KEY` (+ optional `GROWLINK_BASE_URL`) → redeploy | Steps 4 and 6 |
| 8 | CropLink | First sync (`mode: incremental`), review the run; reconciliation runs later | Separate approval |
| 9 | CropLink DB | Preflight → apply `20261006000000_forecast_lab.sql` (E) → verify | Step 5 verified |
| 10 | CropLink DB | Preflight → apply `20261007000000_afw_forecasts.sql` (E2) → verify | Step 5 verified |
| 11 | CropLink | Deploy `feature/forecast-lab` (Forecast Lab + AFW Forecast editor) → first cycle (F) → cron | Steps 8–10 verified |

Steps 5 and 6 don't depend on 1–4 and can run in either half. Step 7 must come after both 4 and 6.

---

## A. GrowLink 0140 — close anonymous access to `organization_integration_keys` — APPLIED 2026-10-04

The file was revised (`fd1b16c`) after the production preflight showed a different live state than 0072 implies: the four `to public` policies existed, but `anon`/`authenticated` held only `REFERENCES`/`TRIGGER`/`TRUNCATE`, and `organization_upload_keys` had RLS with no policies. The applied version drops the four policies, revokes **all** privileges from `anon`, `authenticated` and `PUBLIC` on **both** key tables, grants `service_role` exactly `SELECT/INSERT/UPDATE/DELETE`, and aborts unless that end state holds. The live pre-state and the exact rollback are in the file header/footer; the preflight and rollback below are kept as the original plan.

Preflight (read-only):

```sql
begin transaction read only;
-- A1 current policies (expect the four 0072 policies, roles {public})
select policyname, roles, cmd, qual, with_check from pg_policies
 where schemaname = 'public' and tablename in ('organization_integration_keys', 'organization_upload_keys') order by tablename, policyname;
-- A2 privileges actually held (if anon has SELECT/INSERT here, the exposure is live)
select grantee, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and table_name in ('organization_integration_keys', 'organization_upload_keys')
   and grantee in ('anon', 'authenticated', 'service_role') order by table_name, grantee, privilege_type;
-- A3 audit: every key that exists (look for keys nobody issued through the admin page)
select id, organization_id, integration_name, label, status, created_at, last_used_at
  from public.organization_integration_keys order by created_at;
-- A4 row-level security flag
select relname, relrowsecurity from pg_class where oid in ('public.organization_integration_keys'::regclass);
rollback;
```

Go/no-go:
- A3 must contain only keys you recognise. Any unknown key should be revoked (`status = 'revoked'`) right after 0140.
- `organization_upload_keys` in A1/A2 is reported for review only (it grants *write* access for agent uploads). If it shows the same `public` policies, it needs the same fix as a separate migration.

Apply: run `0140_rls_fix_integration_keys.sql` as-is. It has its own `begin/commit` and aborts unless the end state is correct.

Verify: rerun A1/A2. Expect no policies on `organization_integration_keys`, and no anon/authenticated grants. Then in CropLink → GrowLink → **Test Connection** must still succeed (the server uses the service role).

Rollback (restores the 0072 state, **including the vulnerability**; use only if the server cannot read keys):

```sql
begin;
grant select, insert, update, delete on table public.organization_integration_keys to anon, authenticated;
create policy organization_integration_keys_select on public.organization_integration_keys for select to public using (true);
create policy organization_integration_keys_insert on public.organization_integration_keys for insert to public with check (true);
create policy organization_integration_keys_update on public.organization_integration_keys for update to public using (true) with check (true);
create policy organization_integration_keys_delete on public.organization_integration_keys for delete to public using (true);
commit;
```

## A2. GrowLink 0142 — revoke API-role privileges on the 0141 tables — APPLIED 2026-10-04

0141's three new tables received the project's default grants (`anon`/`authenticated`: `REFERENCES`, `TRIGGER`, `TRUNCATE` — 18 rows in the verification). RLS does not govern those. `0142_revoke_v2_tables_from_api_roles.sql` (`b4060c2`) revokes all privileges from `anon`, `authenticated` and `PUBLIC`, keeps `service_role` `SELECT/INSERT/UPDATE/DELETE` plus the revisions sequence, and aborts unless that end state holds. Verified: no API-role privileges on the three tables or the key tables, `service_role` 12/12, `yield_entries` 226 rows unchanged.

Rollback: `begin; grant references, trigger, truncate on table public.integration_deletions, public.integration_manifests, public.yield_entry_revisions to anon, authenticated; commit;`

## B. GrowLink 0141 — CropLink v2 schema — APPLIED 2026-10-04

Affected:

| Change | Objects |
|---|---|
| New columns | `organization_integration_keys.scopes text[] not null default '{harvest-actuals:read}'` (+ check `organization_integration_keys_scopes_check`); `yield_entries.last_write_source text not null default 'unknown'` (+ check `yield_entries_last_write_source_check`) |
| New index | `yield_entries_org_updated_id_idx (organization_id, updated_at, id)` |
| New functions | `iso_week_end_local`, `yield_week_is_settled`, `yield_entry_tracked`, `yield_entries_audit`, `yield_entry_daily_breakdown_audit` |
| New tables (RLS on, no policies) | `integration_deletions`, `integration_manifests`, `yield_entry_revisions` |
| New triggers | `yield_entries_audit_trg` (after update/delete on `yield_entries`), `yield_entry_daily_breakdown_audit_trg` (after insert/update/delete on `yield_entry_daily_breakdown`, also bumps the parent's `updated_at`) |

Behaviour changes after apply:
- Every edit to a yield entry or its daily rows writes one audit row.
- Every delete writes a tombstone.
- A daily-row change now moves its parent entry's `updated_at`.
- Existing keys get `harvest-actuals:read`, the same access they have today.

Preflight (read-only):

```sql
begin transaction read only;
-- B1 name collisions — expect 0 rows
select 'table' kind, c.relname name from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('integration_deletions', 'integration_manifests', 'yield_entry_revisions', 'yield_entries_org_updated_id_idx')
union all
select 'function', p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('iso_week_end_local', 'yield_week_is_settled', 'yield_entry_tracked', 'yield_entries_audit', 'yield_entry_daily_breakdown_audit')
union all
select 'column', table_name || '.' || column_name from information_schema.columns
 where table_schema = 'public' and ((table_name = 'organization_integration_keys' and column_name = 'scopes') or (table_name = 'yield_entries' and column_name = 'last_write_source'))
union all
select 'constraint', conname from pg_constraint where conname in ('organization_integration_keys_scopes_check', 'yield_entries_last_write_source_check');
-- B2 existing non-internal triggers on the two yield tables (review for interaction; expect none)
select tgrelid::regclass, tgname, pg_get_triggerdef(oid) from pg_trigger
 where not tgisinternal and tgrelid in ('public.yield_entries'::regclass, 'public.yield_entry_daily_breakdown'::regclass);
-- B3 sizes (index build and trigger volume)
select (select count(*) from public.yield_entries) yield_entries, (select count(*) from public.yield_entry_daily_breakdown) daily_rows,
       (select count(*) from public.organization_integration_keys) keys;
-- B4 timezone data present for the settlement rule — expect 2026-10-05 04:00:00+00
select ((date '2026-09-28' + 7)::timestamp at time zone 'America/Toronto') as w40_end_utc;
rollback;
```

Go/no-go: B1 returns 0 rows; B2 shows nothing unexpected; B4 returns `2026-10-05 04:00:00+00`.

Apply: run `0141_croplink_v2_yield_detail.sql` inside `begin; … commit;` (the file itself is not wrapped).

Verify:

```sql
select column_name from information_schema.columns where table_schema = 'public' and table_name = 'organization_integration_keys' and column_name = 'scopes';
select scopes, count(*) from public.organization_integration_keys group by scopes;   -- all {harvest-actuals:read}
select count(*) from public.yield_entries where last_write_source <> 'unknown';         -- 0 until step 3
select tgname from pg_trigger where tgname in ('yield_entries_audit_trg', 'yield_entry_daily_breakdown_audit_trg');
```

Then **Test Connection** in CropLink again (v1 now reads `scopes`).

Rollback (first unset `YIELD_WRITE_SOURCE_TRACKING` on GrowLink and wait for the redeploy, otherwise yield writes fail once the column is gone; export `yield_entry_revisions` / `integration_deletions` first if they hold anything you want to keep):

```sql
begin;
drop trigger if exists yield_entry_daily_breakdown_audit_trg on public.yield_entry_daily_breakdown;
drop trigger if exists yield_entries_audit_trg on public.yield_entries;
drop function if exists public.yield_entry_daily_breakdown_audit();
drop function if exists public.yield_entries_audit();
drop function if exists public.yield_entry_tracked(public.yield_entries);
drop table if exists public.yield_entry_revisions;
drop table if exists public.integration_manifests;
drop table if exists public.integration_deletions;
drop function if exists public.yield_week_is_settled(integer, integer, timestamptz, timestamptz);
drop function if exists public.iso_week_end_local(integer, integer, text);
drop index if exists public.yield_entries_org_updated_id_idx;
alter table public.yield_entries drop constraint if exists yield_entries_last_write_source_check;
alter table public.yield_entries drop column if exists last_write_source;
alter table public.organization_integration_keys drop constraint if exists organization_integration_keys_scopes_check;
alter table public.organization_integration_keys drop column if exists scopes;
commit;
```

The deployed GrowLink code keeps working after this rollback (it falls back to the pre-scope columns).

## C. CropLink `20261004000000_iso_week_53.sql`

Affected: six week CHECK constraints are replaced, on `weekly_node_statuses`, `fruit_weight_by_week`, `harvest_timing_profiles` (`set_week_number`), `harvested_entries`, `harvest_afw_by_week` and `growlink_harvest_actuals`. Each gets a `<table>_iso_week_check` against the new immutable function `iso_weeks_in_year(year)`.

Preflight (read-only):

```sql
begin transaction read only;
-- C1 all six tables exist (expect 6 non-null)
select to_regclass('public.weekly_node_statuses'), to_regclass('public.fruit_weight_by_week'), to_regclass('public.harvest_timing_profiles'),
       to_regclass('public.harvested_entries'), to_regclass('public.harvest_afw_by_week'), to_regclass('public.growlink_harvest_actuals');
-- C2 the checks that will be dropped (expect exactly 6, each "<= 52")
select conrelid::regclass, conname, pg_get_constraintdef(oid) from pg_constraint
 where contype = 'c' and pg_get_constraintdef(oid) ~ 'week_number <= 52'
   and conrelid in ('public.weekly_node_statuses'::regclass, 'public.fruit_weight_by_week'::regclass, 'public.harvest_timing_profiles'::regclass,
                    'public.harvested_entries'::regclass, 'public.harvest_afw_by_week'::regclass, 'public.growlink_harvest_actuals'::regclass)
 order by 1;
-- C3 name collisions — expect 0 rows
select conname from pg_constraint where conname like '%\_iso\_week\_check'
union all select proname from pg_proc where proname = 'iso_weeks_in_year';
-- C4 existing rows that would violate the new checks — expect all 0
select 'weekly_node_statuses' t, count(*) from public.weekly_node_statuses where week_number < 1 or week_number > extract(week from make_date(year, 12, 28))
union all select 'fruit_weight_by_week', count(*) from public.fruit_weight_by_week where week_number < 1 or week_number > extract(week from make_date(year, 12, 28))
union all select 'harvest_timing_profiles', count(*) from public.harvest_timing_profiles where set_week_number < 1 or set_week_number > extract(week from make_date(year, 12, 28))
union all select 'harvested_entries', count(*) from public.harvested_entries where week_number < 1 or week_number > extract(week from make_date(year, 12, 28))
union all select 'harvest_afw_by_week', count(*) from public.harvest_afw_by_week where week_number < 1 or week_number > extract(week from make_date(year, 12, 28))
union all select 'growlink_harvest_actuals', count(*) from public.growlink_harvest_actuals where week_number < 1 or week_number > extract(week from make_date(year, 12, 28));
rollback;
```

Apply: run the file inside `begin; … commit;`.

Verify: rerun C2 (expect 0 rows), and `select iso_weeks_in_year(2026), iso_weeks_in_year(2025);` gives `53, 52`.

Rollback (only valid while no W53 row exists; must run *after* rolling back 20261005, which depends on the function):

```sql
begin;
do $$ begin
  if (select count(*) from public.weekly_node_statuses where week_number = 53) + (select count(*) from public.fruit_weight_by_week where week_number = 53)
   + (select count(*) from public.harvest_timing_profiles where set_week_number = 53) + (select count(*) from public.harvested_entries where week_number = 53)
   + (select count(*) from public.harvest_afw_by_week where week_number = 53) + (select count(*) from public.growlink_harvest_actuals where week_number = 53) > 0 then
    raise exception 'W53 rows exist; the 1-52 checks cannot be restored';
  end if;
end $$;
alter table public.weekly_node_statuses     drop constraint weekly_node_statuses_iso_week_check,     add constraint weekly_node_statuses_week_number_check     check (week_number >= 1 and week_number <= 52);
alter table public.fruit_weight_by_week     drop constraint fruit_weight_by_week_iso_week_check,     add constraint fruit_weight_by_week_week_number_check     check (week_number >= 1 and week_number <= 52);
alter table public.harvest_timing_profiles  drop constraint harvest_timing_profiles_iso_week_check,  add constraint harvest_timing_profiles_set_week_number_check check (set_week_number >= 1 and set_week_number <= 52);
alter table public.harvested_entries        drop constraint harvested_entries_iso_week_check,        add constraint harvested_entries_week_number_check        check (week_number >= 1 and week_number <= 52);
alter table public.harvest_afw_by_week      drop constraint harvest_afw_by_week_iso_week_check,      add constraint harvest_afw_by_week_week_number_check      check (week_number >= 1 and week_number <= 52);
alter table public.growlink_harvest_actuals drop constraint growlink_harvest_actuals_iso_week_check, add constraint growlink_harvest_actuals_week_number_check check (week_number >= 1 and week_number <= 52);
drop function public.iso_weeks_in_year(integer);
commit;
```

## D. CropLink `20261005000000_growlink_yield_weeks.sql`

Affected: four new tables (`growlink_yield_weeks`, `growlink_yield_week_revisions`, `growlink_sync_runs`, `growlink_sync_state`), RLS on and no policies. All privileges are revoked from `anon`, `authenticated` and `PUBLIC` (new tables pick up default grants, and RLS does not cover `TRUNCATE`). No existing table changes.

Preflight: `select to_regclass('public.growlink_yield_weeks'), to_regclass('public.growlink_yield_week_revisions'), to_regclass('public.growlink_sync_runs'), to_regclass('public.growlink_sync_state'), to_regprocedure('public.iso_weeks_in_year(integer)');`. Expect four nulls and a non-null function (from step 5).

Apply: run the file inside `begin; … commit;`.

Verify: rerun the preflight; expect four non-null tables. Then the API-role check (expect 0 rows):

```sql
select t, r, p from unnest(array['growlink_yield_weeks','growlink_yield_week_revisions','growlink_sync_runs','growlink_sync_state']) t,
  unnest(array['anon','authenticated']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
 where has_table_privilege(r, 'public.' || t, p);
```

Rollback (export first if a sync has run): `begin; drop table public.growlink_yield_week_revisions, public.growlink_sync_runs, public.growlink_sync_state, public.growlink_yield_weeks; commit;`

## Railway variables

| Service | Variable | Value | When |
|---|---|---|---|
| GrowLink server | `YIELD_WRITE_SOURCE_TRACKING` | `enabled` | After 0141 is verified (step 3). Unset before any 0141 rollback. |
| CropLink server | `GROWLINK_CROPLINK_KEY` | raw key from step 4 (secret; never commit or store in a DB) | Step 7 |
| CropLink server | `GROWLINK_BASE_URL` | `https://growlinkserver-production.up.railway.app` (optional; otherwise read from the saved connection) | Step 7 |
| CropLink server | `INTERNAL_OPS_KEY` | already required by the rollup/snapshot crons; confirm it is set | Step 7 |

## Scoped key (step 4)

GrowLink admin, after 0141: `POST /api/admin/integration-keys` with
`{"organizationId": "<First Light Greenhouses org id>", "label": "CropLink v2 yield detail", "integrationName": "croplink", "scopes": ["harvest-actuals:read", "yield-detail:read"]}`.

The raw key is returned once. Paste it straight into CropLink's Railway `GROWLINK_CROPLINK_KEY`. GrowLink stores only its SHA-256 hash; CropLink sync runs record only a 16-character fingerprint.

The existing v1 key (still stored in CropLink's `crop_integration_settings.secret_key`) keeps `harvest-actuals:read` only. Moving it to an environment secret and clearing that column is a follow-up.

Before step 4 the admin route returns 400 for a request with scopes. That's expected.

## E. CropLink `20261006000000_forecast_lab.sql` (Forecast Lab)

Affected: four new tables (`forecast_lab_runs`, `forecast_lab_snapshots`, `forecast_lab_exclusions`, `variety_config_history`), RLS on and no policies, all privileges revoked from `anon`, `authenticated` and `PUBLIC`. Two new functions: `forecast_lab_snapshots_immutable`, `varieties_config_audit`. Triggers:
- `forecast_lab_snapshots_no_update_delete` and `forecast_lab_snapshots_no_truncate` (snapshots can never be changed).
- `varieties_config_audit_trg`: after insert/update on `varieties`, records changes to scaling fields.

The migration also backfills one baseline history row per variety per field. Depends on step 5 (`iso_weeks_in_year`).

Preflight (read-only):

```sql
begin transaction read only;
-- E1 expect four nulls and a non-null function
select to_regclass('public.forecast_lab_runs'), to_regclass('public.forecast_lab_snapshots'), to_regclass('public.forecast_lab_exclusions'),
       to_regclass('public.variety_config_history'), to_regprocedure('public.iso_weeks_in_year(integer)');
-- E2 the varieties columns the audit trigger reads (expect 8 rows)
select column_name from information_schema.columns where table_schema = 'public' and table_name = 'varieties'
   and column_name in ('area_m2', 'plant_count', 'total_stem_count', 'is_active', 'plant_date', 'pull_out_date', 'case_kg', 'average_fruit_weight_grams');
-- E3 existing triggers on varieties (review; expect only the updated_at trigger, if any)
select tgname, pg_get_triggerdef(oid) from pg_trigger where not tgisinternal and tgrelid = 'public.varieties'::regclass;
-- E4 baseline rows the backfill will write
select count(*) * 8 as baseline_rows from public.varieties;
rollback;
```

Apply inside `begin; … commit;`. Verify: E1 returns four non-null tables, `select count(*) from variety_config_history` equals E4, and the API-role check from D (with these four table names) returns 0 rows.

Rollback (snapshots are immutable by trigger, but dropping the table is allowed; export first if any cycle has run):

```sql
begin;
drop trigger if exists varieties_config_audit_trg on public.varieties;
drop function if exists public.varieties_config_audit();
drop table if exists public.forecast_lab_snapshots;
drop function if exists public.forecast_lab_snapshots_immutable();
drop table if exists public.forecast_lab_exclusions, public.forecast_lab_runs, public.variety_config_history;
commit;
```

## E2. CropLink `20261007000000_afw_forecasts.sql` (grower AFW forecasts)

Affected: one new append-only table `afw_forecast_entries` (variety, ISO year/week, `set` with grams 20–1000 or `clear`, `entered_at`), RLS on and no policies, all privileges revoked from `anon`, `authenticated` and `PUBLIC`; `service_role` gets `SELECT, INSERT` and the id sequence. One new function `afw_forecast_entries_immutable` with triggers rejecting UPDATE, DELETE and TRUNCATE. No existing table changes: `harvest_afw_by_week` (legacy AFW) and GrowLink data are untouched. Depends on step 5 (`iso_weeks_in_year`).

Preflight (read-only):

```sql
begin transaction read only;
select to_regclass('public.afw_forecast_entries') as must_be_null,
       to_regprocedure('public.afw_forecast_entries_immutable()') as must_be_null_too,
       to_regprocedure('public.iso_weeks_in_year(integer)') as must_be_set;
rollback;
```

Apply inside `begin; … commit;`. Verify: the table exists with `relrowsecurity = true`, 0 policies, 0 rows; the API-role check from D (with `afw_forecast_entries`) returns 0 rows; `has_table_privilege('service_role', 'public.afw_forecast_entries', 'INSERT')` is true.

Rollback (export first if growers have entered forecasts): `begin; drop table public.afw_forecast_entries; drop function public.afw_forecast_entries_immutable(); commit;`

Until E2 is applied the editor shows "AFW forecasts are not enabled yet" and the Lab runs exactly as before.

## F. Forecast Lab cycle (after E and step 7)

- First run, by hand: `POST /api/forecast-lab/cycle` with `X-Internal-Ops-Key`. It syncs GrowLink v2 if `GROWLINK_CROPLINK_KEY` is set, locks live forecasts, and backfills labelled hindcasts once. Re-running is safe: snapshots are insert-only and keyed.
- Railway cron service `croplink-forecast-lab-cron`, same repo as the existing cron services: start command `npm run cron:forecast-lab`, variables `CROPLINK_INTERNAL_BASE_URL` and `INTERNAL_OPS_KEY` (as for the rollup cron). Suggested schedule `30 10 * * *` (daily 10:30 UTC). Weekly settlement is picked up automatically, because scoring is computed from settled weeks when the page is read.
