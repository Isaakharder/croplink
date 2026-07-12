-- Variety-level hourly climate pipeline (manual CSV upload + future Climate Agent).
--
-- Layers:
--   1. climate_imports              — permanent per-file ledger (existing table, extended)
--   2. climate_readings             — permanent normalized per-zone/metric readings (existing table, untouched)
--   3. phase_climate_hourly         — new: phase-level Radiation / Drain Water %
--   4. variety_climate_hourly       — new: variety-level hourly averages + irrigation deltas
--
-- Staging (pre-commit, safe to delete without touching permanent history):
--   climate_import_batches
--   climate_import_staged_files
--   climate_import_staged_readings
--
-- variety_zones is reused unchanged (one variety per zone — kept as-is per decision).

-- ============================================================
-- STAGING
-- ============================================================

create table climate_import_batches (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        null,
  status           text        not null default 'pending' check (status in ('pending', 'committed', 'failed', 'cancelled')),
  file_count       integer     not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  committed_at     timestamptz,
  error_message    text
);

create index climate_import_batches_org_created_idx on climate_import_batches (organization_id, created_at desc);

create trigger update_climate_import_batches_updated_at
  before update on climate_import_batches for each row execute function update_updated_at_column();

-- One row per uploaded file, pending review. Deleting a batch cascades here.
create table climate_import_staged_files (
  id                    uuid        primary key default gen_random_uuid(),
  batch_id              uuid        not null references climate_import_batches(id) on delete cascade,
  organization_id       uuid        null,
  filename              text        not null,
  file_hash             text        not null,
  status                text        not null default 'parsed' check (status in ('parsed', 'duplicate', 'error')),
  error_message         text,
  filename_timestamp    timestamptz,
  week_number           integer,
  system_date_raw       text,
  system_time_raw       text,
  resolved_measured_at  timestamptz,
  timestamp_conflict    boolean     not null default false,
  timestamp_warning     text,
  zone_count            integer     not null default 0,
  created_at            timestamptz not null default now()
);

create index climate_import_staged_files_batch_idx on climate_import_staged_files (batch_id);
create index climate_import_staged_files_org_hash_idx on climate_import_staged_files (organization_id, file_hash);

-- Raw per-zone/metric values parsed from staged files, before commit.
create table climate_import_staged_readings (
  id               uuid          primary key default gen_random_uuid(),
  staged_file_id   uuid          not null references climate_import_staged_files(id) on delete cascade,
  batch_id         uuid          not null references climate_import_batches(id) on delete cascade,
  organization_id  uuid          null,
  zone_label       text          not null,
  measured_at      timestamptz   not null,
  metric_name      text          not null,
  value            numeric(12,4),
  unit             text,
  created_at       timestamptz   not null default now()
);

create index climate_import_staged_readings_batch_idx on climate_import_staged_readings (batch_id);
create index climate_import_staged_readings_file_idx on climate_import_staged_readings (staged_file_id);

-- ============================================================
-- EXTEND PERMANENT LEDGER (climate_imports)
-- ============================================================

alter table climate_imports
  add column if not exists batch_id           uuid references climate_import_batches(id),
  add column if not exists measured_at        timestamptz,
  add column if not exists filename_timestamp timestamptz,
  add column if not exists week_number        integer,
  add column if not exists timestamp_conflict boolean not null default false,
  add column if not exists timestamp_warning  text;

create index if not exists climate_imports_batch_idx on climate_imports (batch_id);

-- ============================================================
-- LAYER 3: PHASE-LEVEL HOURLY (Radiation, Drain Water %)
-- ============================================================

create table phase_climate_hourly (
  id                              uuid        primary key default gen_random_uuid(),
  organization_id                 uuid        null,
  phase_id                        uuid        not null references phases(id) on delete cascade,
  measured_at                     timestamptz not null,

  radiation_cumulative_j_cm2      numeric(10,2),
  radiation_interval_delta_j_cm2  numeric(10,2),
  radiation_interval_minutes      integer,
  radiation_quality_flag         text,

  drain_water_pct                 numeric(5,2),

  source_zone_label               text,
  source_batch_id                 uuid references climate_import_batches(id),

  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);

create unique index phase_climate_hourly_phase_measured_at_uq on phase_climate_hourly (phase_id, measured_at);
create index phase_climate_hourly_org_measured_idx on phase_climate_hourly (organization_id, measured_at);

create trigger update_phase_climate_hourly_updated_at
  before update on phase_climate_hourly for each row execute function update_updated_at_column();

-- ============================================================
-- LAYER 4: VARIETY-LEVEL HOURLY AVERAGES
-- ============================================================

create table variety_climate_hourly (
  id                              uuid        primary key default gen_random_uuid(),
  organization_id                 uuid        null,
  variety_id                      uuid        not null references varieties(id) on delete cascade,
  measured_at                     timestamptz not null,

  air_temperature_avg_c           numeric(6,2),
  air_temperature_zone_count      integer     not null default 0,

  relative_humidity_avg_pct       numeric(6,2),
  relative_humidity_zone_count    integer     not null default 0,

  co2_avg_ppm                     numeric(8,2),
  co2_zone_count                  integer     not null default 0,

  ec_avg                          numeric(6,3),
  ec_zone_count                   integer     not null default 0,

  ph_avg                          numeric(6,3),
  ph_zone_count                   integer     not null default 0,

  irrigation_cumulative_avg_ml    numeric(10,2),
  irrigation_zone_count           integer     not null default 0,
  irrigation_interval_delta_ml    numeric(10,2),
  irrigation_interval_minutes     integer,
  irrigation_quality_flag         text,

  expected_zone_count             integer     not null default 0,

  -- Phase passthrough (not a zone average — see phase_climate_hourly)
  phase_id                        uuid references phases(id),
  radiation_cumulative_j_cm2      numeric(10,2),
  radiation_interval_delta_j_cm2  numeric(10,2),

  quality_warnings                text[]      not null default '{}',
  source_batch_id                 uuid references climate_import_batches(id),

  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);

create unique index variety_climate_hourly_variety_measured_at_uq on variety_climate_hourly (variety_id, measured_at);
create index variety_climate_hourly_org_measured_idx on variety_climate_hourly (organization_id, measured_at);

create trigger update_variety_climate_hourly_updated_at
  before update on variety_climate_hourly for each row execute function update_updated_at_column();

-- ============================================================
-- ATOMIC COMMIT RPC
-- ============================================================
-- Node computes every row (averages, deltas, conflict resolution) ahead of
-- time and passes the final, already-decided row sets in. This function is
-- purely the transactional boundary for the permanent writes — if anything
-- inside raises, Postgres rolls back the whole function call, so the batch
-- either fully commits or is left exactly as it was.
--
-- p_imports:        climate_imports rows to insert (one per non-duplicate staged file)
-- p_readings:       climate_readings rows to upsert (one per accepted zone/metric/timestamp)
-- p_phase_hourly:   phase_climate_hourly rows to upsert
-- p_variety_hourly: variety_climate_hourly rows to upsert
create or replace function commit_climate_import_batch(
  p_batch_id uuid,
  p_imports jsonb,
  p_readings jsonb,
  p_phase_hourly jsonb,
  p_variety_hourly jsonb
) returns void as $$
begin
  -- id is generated by the caller (not left to the column default) so
  -- climate_readings rows below can reference the correct import_id even
  -- though both are inserted together in this same transaction.
  insert into climate_imports (id, organization_id, filename, file_hash, readings_stored, batch_id, measured_at, filename_timestamp, week_number, timestamp_conflict, timestamp_warning)
  select
    (r->>'id')::uuid,
    (r->>'organization_id')::uuid,
    r->>'filename',
    r->>'file_hash',
    coalesce((r->>'readings_stored')::integer, 0),
    (r->>'batch_id')::uuid,
    (r->>'measured_at')::timestamptz,
    (r->>'filename_timestamp')::timestamptz,
    (r->>'week_number')::integer,
    coalesce((r->>'timestamp_conflict')::boolean, false),
    r->>'timestamp_warning'
  from jsonb_array_elements(p_imports) as r
  on conflict (organization_id, file_hash) do nothing;

  insert into climate_readings (organization_id, import_id, zone_label, measured_at, metric_name, value, unit, source_file)
  select
    (r->>'organization_id')::uuid,
    (r->>'import_id')::uuid,
    r->>'zone_label',
    (r->>'measured_at')::timestamptz,
    r->>'metric_name',
    (r->>'value')::numeric,
    r->>'unit',
    r->>'source_file'
  from jsonb_array_elements(p_readings) as r
  on conflict (organization_id, measured_at, zone_label, metric_name)
  do update set value = excluded.value, unit = excluded.unit, source_file = excluded.source_file;

  insert into phase_climate_hourly (
    organization_id, phase_id, measured_at,
    radiation_cumulative_j_cm2, radiation_interval_delta_j_cm2, radiation_interval_minutes, radiation_quality_flag,
    drain_water_pct, source_zone_label, source_batch_id
  )
  select
    (r->>'organization_id')::uuid,
    (r->>'phase_id')::uuid,
    (r->>'measured_at')::timestamptz,
    (r->>'radiation_cumulative_j_cm2')::numeric,
    (r->>'radiation_interval_delta_j_cm2')::numeric,
    (r->>'radiation_interval_minutes')::integer,
    r->>'radiation_quality_flag',
    (r->>'drain_water_pct')::numeric,
    r->>'source_zone_label',
    (r->>'source_batch_id')::uuid
  from jsonb_array_elements(p_phase_hourly) as r
  on conflict (phase_id, measured_at) do update set
    radiation_cumulative_j_cm2 = excluded.radiation_cumulative_j_cm2,
    radiation_interval_delta_j_cm2 = excluded.radiation_interval_delta_j_cm2,
    radiation_interval_minutes = excluded.radiation_interval_minutes,
    radiation_quality_flag = excluded.radiation_quality_flag,
    drain_water_pct = excluded.drain_water_pct,
    source_zone_label = excluded.source_zone_label,
    source_batch_id = excluded.source_batch_id;

  insert into variety_climate_hourly (
    organization_id, variety_id, measured_at,
    air_temperature_avg_c, air_temperature_zone_count,
    relative_humidity_avg_pct, relative_humidity_zone_count,
    co2_avg_ppm, co2_zone_count,
    ec_avg, ec_zone_count,
    ph_avg, ph_zone_count,
    irrigation_cumulative_avg_ml, irrigation_zone_count, irrigation_interval_delta_ml, irrigation_interval_minutes, irrigation_quality_flag,
    expected_zone_count,
    phase_id, radiation_cumulative_j_cm2, radiation_interval_delta_j_cm2,
    quality_warnings, source_batch_id
  )
  select
    (r->>'organization_id')::uuid,
    (r->>'variety_id')::uuid,
    (r->>'measured_at')::timestamptz,
    (r->>'air_temperature_avg_c')::numeric, coalesce((r->>'air_temperature_zone_count')::integer, 0),
    (r->>'relative_humidity_avg_pct')::numeric, coalesce((r->>'relative_humidity_zone_count')::integer, 0),
    (r->>'co2_avg_ppm')::numeric, coalesce((r->>'co2_zone_count')::integer, 0),
    (r->>'ec_avg')::numeric, coalesce((r->>'ec_zone_count')::integer, 0),
    (r->>'ph_avg')::numeric, coalesce((r->>'ph_zone_count')::integer, 0),
    (r->>'irrigation_cumulative_avg_ml')::numeric, coalesce((r->>'irrigation_zone_count')::integer, 0),
    (r->>'irrigation_interval_delta_ml')::numeric, (r->>'irrigation_interval_minutes')::integer, r->>'irrigation_quality_flag',
    coalesce((r->>'expected_zone_count')::integer, 0),
    (r->>'phase_id')::uuid, (r->>'radiation_cumulative_j_cm2')::numeric, (r->>'radiation_interval_delta_j_cm2')::numeric,
    coalesce((select array_agg(x) from jsonb_array_elements_text(r->'quality_warnings') as x), '{}'),
    (r->>'source_batch_id')::uuid
  from jsonb_array_elements(p_variety_hourly) as r
  on conflict (variety_id, measured_at) do update set
    air_temperature_avg_c = excluded.air_temperature_avg_c, air_temperature_zone_count = excluded.air_temperature_zone_count,
    relative_humidity_avg_pct = excluded.relative_humidity_avg_pct, relative_humidity_zone_count = excluded.relative_humidity_zone_count,
    co2_avg_ppm = excluded.co2_avg_ppm, co2_zone_count = excluded.co2_zone_count,
    ec_avg = excluded.ec_avg, ec_zone_count = excluded.ec_zone_count,
    ph_avg = excluded.ph_avg, ph_zone_count = excluded.ph_zone_count,
    irrigation_cumulative_avg_ml = excluded.irrigation_cumulative_avg_ml, irrigation_zone_count = excluded.irrigation_zone_count,
    irrigation_interval_delta_ml = excluded.irrigation_interval_delta_ml, irrigation_interval_minutes = excluded.irrigation_interval_minutes,
    irrigation_quality_flag = excluded.irrigation_quality_flag,
    expected_zone_count = excluded.expected_zone_count,
    phase_id = excluded.phase_id, radiation_cumulative_j_cm2 = excluded.radiation_cumulative_j_cm2, radiation_interval_delta_j_cm2 = excluded.radiation_interval_delta_j_cm2,
    quality_warnings = excluded.quality_warnings, source_batch_id = excluded.source_batch_id;

  update climate_import_batches
  set status = 'committed', committed_at = now(), error_message = null
  where id = p_batch_id;
end;
$$ language plpgsql;
