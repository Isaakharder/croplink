-- Forecast Lab: immutable forecast snapshots for legacy + experimental models,
-- cycle runs, manual data-quality exclusions, and variety configuration
-- history (changes that affect kg scaling).
--
-- Depends on 20261004000000_iso_week_53.sql (iso_weeks_in_year).
-- No foreign key from snapshots/history to varieties on purpose: snapshots are
-- immutable, so a FK would block the existing variety-delete workflow.

create table forecast_lab_runs (
  id            uuid        primary key,
  kind          text        not null check (kind in ('cycle', 'manual')),
  status        text        not null check (status in ('running', 'succeeded', 'partial', 'failed')),
  started_at    timestamptz not null,
  finished_at   timestamptz,
  code_version  text,
  summary       jsonb       not null default '{}'::jsonb,
  error         text
);
create index forecast_lab_runs_started_idx on forecast_lab_runs (started_at desc);

create table forecast_lab_snapshots (
  id               bigserial   primary key,
  run_id           uuid        not null references forecast_lab_runs(id),
  kind             text        not null check (kind in ('live', 'hindcast')),
  variety_id       uuid        not null,
  model_id         text        not null check (model_id in ('legacy', 'open-fruit-d', 'interval-censored-recent')),
  model_version    text        not null,
  experimental     boolean     not null,
  as_of_year       integer     not null,
  as_of_week       integer     not null check (as_of_week >= 1 and as_of_week <= iso_weeks_in_year(as_of_year)),
  as_of_index      integer     not null,
  input_cutoff     timestamptz not null,
  issued_at        timestamptz not null default now(),
  code_version     text,
  target_year      integer     not null,
  target_week      integer     not null check (target_week >= 1 and target_week <= iso_weeks_in_year(target_year)),
  target_index     integer     not null,
  horizon          integer     not null check (horizon >= 1),
  forecast_kg      numeric,
  range_low_kg     numeric,
  range_high_kg    numeric,
  fruit_per_m2     numeric,
  afw_g            numeric,
  afw_source       text,
  afw_as_of_index  integer,
  area_m2          numeric     not null,
  total_stems      integer     not null,
  measured_stems   integer     not null,
  pull_out_date    date,
  harvest_window   numeric     not null,
  coverage         numeric,
  params           jsonb       not null,
  evidence         jsonb       not null,
  warnings         text[]      not null default '{}',
  constraint forecast_lab_snapshots_natural_key unique (variety_id, model_id, model_version, kind, as_of_index, target_index),
  constraint forecast_lab_snapshots_horizon check (target_index = as_of_index + horizon),
  constraint forecast_lab_snapshots_range check (range_low_kg is null or range_high_kg is null or range_low_kg <= range_high_kg)
);
create index forecast_lab_snapshots_target_idx on forecast_lab_snapshots (variety_id, target_index);
create index forecast_lab_snapshots_asof_idx on forecast_lab_snapshots (variety_id, model_id, kind, as_of_index);

-- Once issued, a forecast is never rewritten or removed.
create or replace function forecast_lab_snapshots_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'forecast_lab_snapshots is immutable (% rejected)', tg_op;
end
$$;

create trigger forecast_lab_snapshots_no_update_delete
  before update or delete on forecast_lab_snapshots
  for each row execute function forecast_lab_snapshots_immutable();
create trigger forecast_lab_snapshots_no_truncate
  before truncate on forecast_lab_snapshots
  for each statement execute function forecast_lab_snapshots_immutable();

-- Weeks deliberately excluded from scoring (e.g. a GrowLink entry under investigation).
create table forecast_lab_exclusions (
  id            uuid        primary key default gen_random_uuid(),
  variety_id    uuid        not null,
  target_year   integer     not null,
  target_week   integer     not null check (target_week >= 1 and target_week <= iso_weeks_in_year(target_year)),
  reason        text        not null check (length(trim(reason)) > 0),
  created_at    timestamptz not null default now(),
  created_by    text,
  unique (variety_id, target_year, target_week)
);

-- Configuration history (design: docs/design/variety-config-audit.md).
create table variety_config_history (
  id              uuid        primary key default gen_random_uuid(),
  variety_id      uuid        not null,
  field           text        not null check (field in (
                    'area_m2', 'plant_count', 'total_stem_count', 'is_active',
                    'plant_date', 'pull_out_date', 'case_kg', 'average_fruit_weight_grams')),
  old_value       jsonb,
  new_value       jsonb,
  effective_from  date        not null,
  changed_at      timestamptz not null default now(),
  changed_by      text,
  source          text        not null check (source in ('ui', 'api', 'import', 'migration', 'backfill')),
  note            text
);
create index variety_config_history_variety_idx on variety_config_history (variety_id, field, effective_from);

create or replace function varieties_config_audit()
returns trigger
language plpgsql
as $$
declare
  f text;
  o jsonb;
  n jsonb;
  eff date := coalesce(nullif(current_setting('croplink.effective_from', true), '')::date, now()::date);
  src text := coalesce(nullif(current_setting('croplink.change_source', true), ''), 'api');
begin
  foreach f in array array['area_m2', 'plant_count', 'total_stem_count', 'is_active', 'plant_date', 'pull_out_date', 'case_kg', 'average_fruit_weight_grams'] loop
    n := to_jsonb(new) -> f;
    o := case when tg_op = 'UPDATE' then to_jsonb(old) -> f else null end;
    if tg_op = 'INSERT' or o is distinct from n then
      insert into variety_config_history (variety_id, field, old_value, new_value, effective_from, source)
      values (new.id, f, o, n, eff, src);
    end if;
  end loop;
  return new;
end
$$;

create trigger varieties_config_audit_trg
  after insert or update on varieties
  for each row execute function varieties_config_audit();

-- Baseline: today's values. Earlier values were never recorded.
insert into variety_config_history (variety_id, field, old_value, new_value, effective_from, source, note)
select v.id, f.field, null, to_jsonb(v) -> f.field, v.created_at::date, 'backfill',
       'Baseline from current values at migration time; values before this are not recorded'
       || case when v.updated_at > v.created_at then ' (record last changed ' || to_char(v.updated_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC — previous values unknown)' else '' end
from varieties v
cross join (values ('area_m2'), ('plant_count'), ('total_stem_count'), ('is_active'), ('plant_date'), ('pull_out_date'), ('case_kg'), ('average_fruit_weight_grams')) as f(field);

alter table forecast_lab_runs enable row level security;
alter table forecast_lab_snapshots enable row level security;
alter table forecast_lab_exclusions enable row level security;
alter table variety_config_history enable row level security;
