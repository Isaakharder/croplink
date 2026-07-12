-- Timestamp resolution fix: the filename hour is now authoritative for the
-- canonical hourly bucket; Ridder's System Time/Date/Week rows are used only
-- to validate it (see server/src/lib/ridderParser.ts resolveTimestamp). This
-- migration adds the columns needed to (a) audit that validation permanently,
-- (b) retain enough source data after commit to reprocess history, and
-- (c) record manual corrections made to already-committed data.

-- ── A: hour-discrepancy audit fields ────────────────────────────────────────
alter table climate_import_staged_files
  add column if not exists hour_difference_minutes integer,
  add column if not exists hour_conflict           boolean not null default false,
  add column if not exists hour_warning            text,
  add column if not exists existing_import_id      uuid references climate_imports(id),
  add column if not exists existing_measured_at    timestamptz;

-- 'repair' = this staged file's hash matches a prior climate_imports row that
-- never actually stored its readings (readings_stored = 0, e.g. it lost a
-- same-batch conflict) — see server/src/lib/climateCorrections.ts.
alter table climate_import_staged_files
  drop constraint if exists climate_import_staged_files_status_check;
alter table climate_import_staged_files
  add constraint climate_import_staged_files_status_check
  check (status in ('parsed', 'duplicate', 'error', 'repair'));

alter table climate_imports
  add column if not exists hour_difference_minutes integer,
  add column if not exists hour_conflict           boolean not null default false,
  add column if not exists hour_warning            text;

-- ── B: permanent raw CSV text, so any committed import can be reprocessed
-- after a parser fix, timestamp fix, zone-link change, averaging change, or
-- conflict-resolution mistake, without needing the original file again.
-- Chosen over external object storage: these files are small plaintext CSVs
-- (tens of KB), so a text column keeps them in the same transactional store
-- and the same backups as everything else, with no bucket/signed-URL/lifecycle
-- policy to operate. Nullable because historical rows predate this column.
alter table climate_import_staged_files
  add column if not exists raw_content text;

alter table climate_imports
  add column if not exists raw_content text;

-- ── C/D: permanent audit trail for manual corrections (hour relabeling) and
-- repair imports (filling in a previously-lost reading under the corrected
-- timestamp rule).
create table if not exists climate_import_corrections (
  id                           uuid        primary key default gen_random_uuid(),
  organization_id              uuid        null,
  correction_type              text        not null check (correction_type in ('timestamp_relabel', 'repair_import')),
  source_filename              text        not null,
  source_file_hash             text,
  old_measured_at              timestamptz,
  new_measured_at              timestamptz not null,
  affected_reading_count       integer     not null default 0,
  affected_variety_hourly_ids  uuid[]      not null default '{}',
  affected_phase_hourly_ids    uuid[]      not null default '{}',
  notes                        text,
  performed_at                 timestamptz not null default now()
);

create index if not exists climate_import_corrections_filename_idx
  on climate_import_corrections (source_filename);

-- ── RPC: atomically relabel a single source file's readings to a new hour and
-- recompute the affected phase/variety hourly rows (vacated hour, corrected
-- hour, and whatever else Node determined needed recomputing — e.g. the next
-- same-day hour, whose cumulative delta depends on the corrected hour).
-- Node computes every row ahead of time (same pattern as commit_climate_import_batch);
-- this function is purely the transactional boundary.
create or replace function correct_climate_reading_timestamp(
  p_source_filename text,
  p_old_measured_at timestamptz,
  p_new_measured_at timestamptz,
  p_import_id uuid,
  p_import_updates jsonb,
  p_phase_hourly jsonb,
  p_variety_hourly jsonb,
  p_correction_audit jsonb
) returns uuid as $$
declare
  v_correction_id uuid;
begin
  update climate_readings
  set measured_at = p_new_measured_at
  where source_file = p_source_filename
    and measured_at = p_old_measured_at;

  update climate_imports
  set
    measured_at = coalesce((p_import_updates->>'measured_at')::timestamptz, measured_at),
    hour_difference_minutes = (p_import_updates->>'hour_difference_minutes')::integer,
    hour_conflict = coalesce((p_import_updates->>'hour_conflict')::boolean, false),
    hour_warning = p_import_updates->>'hour_warning',
    readings_stored = coalesce((p_import_updates->>'readings_stored')::integer, readings_stored)
  where id = p_import_id;

  -- Phase-hourly rows: upsert every recomputed timestamp (vacated / corrected
  -- / next-same-day). A timestamp with no remaining data (nulls throughout)
  -- is still upserted so stale values don't linger.
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

  insert into climate_import_corrections (
    organization_id, correction_type, source_filename, source_file_hash,
    old_measured_at, new_measured_at, affected_reading_count,
    affected_variety_hourly_ids, affected_phase_hourly_ids, notes
  )
  select
    (a->>'organization_id')::uuid,
    a->>'correction_type',
    a->>'source_filename',
    a->>'source_file_hash',
    (a->>'old_measured_at')::timestamptz,
    (a->>'new_measured_at')::timestamptz,
    coalesce((a->>'affected_reading_count')::integer, 0),
    coalesce((select array_agg((x)::uuid) from jsonb_array_elements_text(a->'affected_variety_hourly_ids') as x), '{}'),
    coalesce((select array_agg((x)::uuid) from jsonb_array_elements_text(a->'affected_phase_hourly_ids') as x), '{}'),
    a->>'notes'
  from jsonb_array_elements(jsonb_build_array(p_correction_audit)) as a
  returning id into v_correction_id;

  return v_correction_id;
end;
$$ language plpgsql;

-- Lets Node back-fill affected_variety_hourly_ids/affected_phase_hourly_ids
-- once it knows the actual row ids (the RPC above inserts the audit row
-- before those upserts' ids are convenient to gather in the same round trip).
create or replace function set_climate_correction_affected_ids(
  p_correction_id uuid,
  p_variety_hourly_ids uuid[],
  p_phase_hourly_ids uuid[]
) returns void as $$
begin
  update climate_import_corrections
  set affected_variety_hourly_ids = p_variety_hourly_ids,
      affected_phase_hourly_ids = p_phase_hourly_ids
  where id = p_correction_id;
end;
$$ language plpgsql;
