-- Grower-entered AFW FORECASTS (expected average fruit weight, grams) by
-- variety and ISO packing week, for the current week through pull-out.
--
-- Kept apart from harvest_afw_by_week (CropLink's actual/override series used
-- by the legacy projection) and from GrowLink's measured AFW: a forecast never
-- overwrites an actual or a settled value.
--
-- Append-only. Every Save inserts one row per changed week ('set' with grams,
-- or 'clear'); the current value of a week is its latest row. Rows are never
-- updated or deleted, so any forecast can be reproduced with exactly the AFW
-- forecasts that had been entered by its issue time (no look-ahead).
--
-- Depends on 20261004000000_iso_week_53.sql (iso_weeks_in_year).
-- No foreign key to varieties on purpose: rows are immutable, so a FK would
-- block the existing variety-delete workflow (same as forecast_lab_snapshots).

create table afw_forecast_entries (
  id          bigserial    primary key,
  batch_id    uuid         not null,
  variety_id  uuid         not null,
  iso_year    integer      not null,
  iso_week    integer      not null check (iso_week >= 1 and iso_week <= iso_weeks_in_year(iso_year)),
  action      text         not null check (action in ('set', 'clear')),
  grams       numeric(6,1) check (grams is null or (grams >= 20 and grams <= 1000)),
  entered_at  timestamptz  not null default now(),
  entered_by  text,
  note        text,
  constraint afw_forecast_entries_action_grams check ((action = 'set') = (grams is not null))
);
create index afw_forecast_entries_week_idx on afw_forecast_entries (variety_id, iso_year, iso_week, entered_at desc, id desc);

create or replace function afw_forecast_entries_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'afw_forecast_entries is append-only (% rejected)', tg_op;
end
$$;

create trigger afw_forecast_entries_no_update_delete
  before update or delete on afw_forecast_entries
  for each row execute function afw_forecast_entries_immutable();
create trigger afw_forecast_entries_no_truncate
  before truncate on afw_forecast_entries
  for each statement execute function afw_forecast_entries_immutable();

-- Server-only (the CropLink server uses the service role; the browser never
-- queries Supabase directly). RLS with no policies, and no table privilege
-- for the API roles — TRUNCATE/REFERENCES/TRIGGER are not governed by RLS.
alter table afw_forecast_entries enable row level security;
revoke all on table afw_forecast_entries from anon, authenticated, public;
revoke all on sequence afw_forecast_entries_id_seq from anon, authenticated, public;
grant select, insert on table afw_forecast_entries to service_role;
grant usage, select on sequence afw_forecast_entries_id_seq to service_role;
