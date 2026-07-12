-- The prior migration (20260713000000) added hour_difference_minutes /
-- hour_conflict / hour_warning / raw_content columns to climate_imports, but
-- commit_climate_import_batch's INSERT statement was never updated to
-- populate them — they were silently defaulting to null/false on every
-- commit. Fix: re-create the function with those columns included, keeping
-- the DISTINCT ON safety net from 20260712000000 intact.
create or replace function commit_climate_import_batch(
  p_batch_id uuid,
  p_imports jsonb,
  p_readings jsonb,
  p_phase_hourly jsonb,
  p_variety_hourly jsonb
) returns void as $$
begin
  insert into climate_imports (
    id, organization_id, filename, file_hash, readings_stored, batch_id,
    measured_at, filename_timestamp, week_number, timestamp_conflict, timestamp_warning,
    hour_difference_minutes, hour_conflict, hour_warning, raw_content
  )
  select
    (d.r->>'id')::uuid,
    (d.r->>'organization_id')::uuid,
    d.r->>'filename',
    d.r->>'file_hash',
    coalesce((d.r->>'readings_stored')::integer, 0),
    (d.r->>'batch_id')::uuid,
    (d.r->>'measured_at')::timestamptz,
    (d.r->>'filename_timestamp')::timestamptz,
    (d.r->>'week_number')::integer,
    coalesce((d.r->>'timestamp_conflict')::boolean, false),
    d.r->>'timestamp_warning',
    (d.r->>'hour_difference_minutes')::integer,
    coalesce((d.r->>'hour_conflict')::boolean, false),
    d.r->>'hour_warning',
    d.r->>'raw_content'
  from (
    select distinct on (r->>'organization_id', r->>'file_hash') r
    from jsonb_array_elements(p_imports) with ordinality as t(r, ord)
    order by r->>'organization_id', r->>'file_hash', ord desc
  ) as d
  on conflict (organization_id, file_hash) do nothing;

  insert into climate_readings (organization_id, import_id, zone_label, measured_at, metric_name, value, unit, source_file)
  select
    (d.r->>'organization_id')::uuid,
    (d.r->>'import_id')::uuid,
    d.r->>'zone_label',
    (d.r->>'measured_at')::timestamptz,
    d.r->>'metric_name',
    (d.r->>'value')::numeric,
    d.r->>'unit',
    d.r->>'source_file'
  from (
    select distinct on (r->>'organization_id', r->>'measured_at', r->>'zone_label', r->>'metric_name') r
    from jsonb_array_elements(p_readings) with ordinality as t(r, ord)
    order by r->>'organization_id', r->>'measured_at', r->>'zone_label', r->>'metric_name', ord desc
  ) as d
  on conflict (organization_id, measured_at, zone_label, metric_name)
  do update set value = excluded.value, unit = excluded.unit, source_file = excluded.source_file;

  insert into phase_climate_hourly (
    organization_id, phase_id, measured_at,
    radiation_cumulative_j_cm2, radiation_interval_delta_j_cm2, radiation_interval_minutes, radiation_quality_flag,
    drain_water_pct, source_zone_label, source_batch_id
  )
  select
    (d.r->>'organization_id')::uuid,
    (d.r->>'phase_id')::uuid,
    (d.r->>'measured_at')::timestamptz,
    (d.r->>'radiation_cumulative_j_cm2')::numeric,
    (d.r->>'radiation_interval_delta_j_cm2')::numeric,
    (d.r->>'radiation_interval_minutes')::integer,
    d.r->>'radiation_quality_flag',
    (d.r->>'drain_water_pct')::numeric,
    d.r->>'source_zone_label',
    (d.r->>'source_batch_id')::uuid
  from (
    select distinct on (r->>'phase_id', r->>'measured_at') r
    from jsonb_array_elements(p_phase_hourly) with ordinality as t(r, ord)
    order by r->>'phase_id', r->>'measured_at', ord desc
  ) as d
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
    (d.r->>'organization_id')::uuid,
    (d.r->>'variety_id')::uuid,
    (d.r->>'measured_at')::timestamptz,
    (d.r->>'air_temperature_avg_c')::numeric, coalesce((d.r->>'air_temperature_zone_count')::integer, 0),
    (d.r->>'relative_humidity_avg_pct')::numeric, coalesce((d.r->>'relative_humidity_zone_count')::integer, 0),
    (d.r->>'co2_avg_ppm')::numeric, coalesce((d.r->>'co2_zone_count')::integer, 0),
    (d.r->>'ec_avg')::numeric, coalesce((d.r->>'ec_zone_count')::integer, 0),
    (d.r->>'ph_avg')::numeric, coalesce((d.r->>'ph_zone_count')::integer, 0),
    (d.r->>'irrigation_cumulative_avg_ml')::numeric, coalesce((d.r->>'irrigation_zone_count')::integer, 0),
    (d.r->>'irrigation_interval_delta_ml')::numeric, (d.r->>'irrigation_interval_minutes')::integer, d.r->>'irrigation_quality_flag',
    coalesce((d.r->>'expected_zone_count')::integer, 0),
    (d.r->>'phase_id')::uuid, (d.r->>'radiation_cumulative_j_cm2')::numeric, (d.r->>'radiation_interval_delta_j_cm2')::numeric,
    coalesce((select array_agg(x) from jsonb_array_elements_text(d.r->'quality_warnings') as x), '{}'),
    (d.r->>'source_batch_id')::uuid
  from (
    select distinct on (r->>'variety_id', r->>'measured_at') r
    from jsonb_array_elements(p_variety_hourly) with ordinality as t(r, ord)
    order by r->>'variety_id', r->>'measured_at', ord desc
  ) as d
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
