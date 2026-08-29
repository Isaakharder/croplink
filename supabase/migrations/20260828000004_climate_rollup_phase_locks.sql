-- Concurrency protection for the climate rollup (Round 10, Phase 4 --
-- revised to a proper lease, not a fixed-timeout lock).
--
-- FOR UPDATE SKIP LOCKED (in claim_climate_rollup_jobs) already prevents two
-- workers from claiming the SAME job row. This closes a narrower, separate
-- gap: two DIFFERENT job rows whose time ranges overlap could still run
-- their read-compute-write sequences concurrently and interleave.
--
-- Session-level pg_advisory_lock/unlock is NOT safe here: PostgREST serves
-- each RPC call over a pooled connection with no guaranteed affinity between
-- calls, so a lock acquired in one call could be released (or never
-- released) on a different underlying Postgres session than intended.
--
-- A real lease ROW, keyed by phase_id, sidesteps that: ordinary table data,
-- visible and race-free across any connection via the PRIMARY KEY
-- constraint, no session affinity required. A `lease_expires_at` recovers a
-- crashed worker's phase without waiting forever -- but unlike a simple
-- fixed-timeout lock, a HEALTHY worker can RENEW its lease before it
-- expires, and every WRITE is gated by an atomic, row-locked re-check that
-- this job still owns a non-expired lease at the moment of writing, not
-- just at the moment it first acquired it. That gate is what actually
-- prevents a former owner from writing after its lease was taken over --
-- acquiring the lease alone only prevents a NEW owner from double-acquiring;
-- it says nothing about an OLD owner that's still mid-write.

create table if not exists climate_rollup_phase_locks (
  phase_id         uuid        primary key,
  locked_by        uuid        not null,
  acquired_at      timestamptz not null default now(),
  lease_expires_at timestamptz not null
);

-- Attempts to acquire (or take over an expired) lease for one phase on
-- behalf of job `p_job_id`. Re-entrant: a job that already holds a
-- non-expired lease for this phase gets `true` back without disturbing
-- `acquired_at`. Race-free under concurrent callers via the same
-- INSERT ... ON CONFLICT DO UPDATE ... WHERE pattern used everywhere else
-- in this app for "only if the current state still satisfies X": Postgres
-- evaluates the WHERE clause against the row as it exists AT THE TIME OF
-- THE UPDATE, atomically, so two simultaneous callers can never both see
-- "expired" and both win -- exactly one UPDATE actually applies.
create or replace function acquire_climate_rollup_phase_lock(
  p_phase_id uuid,
  p_job_id uuid,
  p_lease_seconds integer default 600
) returns boolean as $$
declare
  acquired boolean;
begin
  insert into climate_rollup_phase_locks (phase_id, locked_by, acquired_at, lease_expires_at)
  values (p_phase_id, p_job_id, now(), now() + (p_lease_seconds || ' seconds')::interval)
  on conflict (phase_id) do update
    set locked_by = excluded.locked_by,
        acquired_at = case when climate_rollup_phase_locks.locked_by = p_job_id then climate_rollup_phase_locks.acquired_at else excluded.acquired_at end,
        lease_expires_at = excluded.lease_expires_at
    where climate_rollup_phase_locks.locked_by = p_job_id           -- re-entrant: already ours, just renew
       or climate_rollup_phase_locks.lease_expires_at < now();      -- expired: takeover

  select exists(
    select 1 from climate_rollup_phase_locks where phase_id = p_phase_id and locked_by = p_job_id
  ) into acquired;
  return acquired;
end;
$$ language plpgsql;

-- Extends a lease this job already holds. Fails (returns false) if the
-- lease was taken over by someone else in the meantime -- the caller must
-- treat that as "I no longer own this phase" and stop writing.
create or replace function renew_climate_rollup_phase_lock(
  p_phase_id uuid,
  p_job_id uuid,
  p_lease_seconds integer default 600
) returns boolean as $$
declare
  affected_rows integer;
begin
  update climate_rollup_phase_locks
  set lease_expires_at = now() + (p_lease_seconds || ' seconds')::interval
  where phase_id = p_phase_id and locked_by = p_job_id;
  get diagnostics affected_rows = row_count;
  return affected_rows > 0;
end;
$$ language plpgsql;

-- Releases a lease -- only if `p_job_id` is still the current owner. A
-- former owner whose lease was already taken over cannot delete the NEW
-- owner's lock by calling this after the fact (the WHERE clause simply
-- matches nothing, so the new owner's row survives untouched).
create or replace function release_climate_rollup_phase_lock(p_phase_id uuid, p_job_id uuid)
returns void as $$
begin
  delete from climate_rollup_phase_locks where phase_id = p_phase_id and locked_by = p_job_id;
end;
$$ language plpgsql;

-- The write-time gate: verifies (and, via FOR UPDATE, briefly locks) that
-- `p_job_id` still holds a non-expired lease for EVERY phase in
-- `p_phase_ids`, then performs the phase_climate_hourly and
-- variety_climate_hourly upserts atomically in the same transaction. If any
-- lease check fails, the function raises and the ENTIRE transaction rolls
-- back -- no partial write ever lands. This is what actually closes the
-- "former owner writes after losing the lease" gap: the FOR UPDATE takes a
-- real row lock on climate_rollup_phase_locks for the duration of the
-- check, so a concurrent acquire_climate_rollup_phase_lock takeover attempt
-- on the SAME phase blocks until this transaction commits or rolls back --
-- there is no window where both an old and new owner believe they can
-- write at the same time.
create or replace function rollup_write_locked(
  p_job_id uuid,
  p_phase_ids uuid[],
  p_phase_hourly jsonb,
  p_variety_hourly jsonb
) returns void as $$
declare
  pid uuid;
  still_valid boolean;
begin
  foreach pid in array (select coalesce(array_agg(x order by x), array[]::uuid[]) from unnest(p_phase_ids) as x) loop
    select (locked_by = p_job_id and lease_expires_at > now())
      into still_valid
      from climate_rollup_phase_locks
      where phase_id = pid
      for update;
    if still_valid is not true then
      raise exception 'LEASE_LOST: phase % lease is no longer held by job %', pid, p_job_id;
    end if;
  end loop;

  if jsonb_array_length(p_phase_hourly) > 0 then
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
  end if;

  if jsonb_array_length(p_variety_hourly) > 0 then
    insert into variety_climate_hourly (
      organization_id, variety_id, measured_at,
      air_temperature_avg_c, air_temperature_zone_count,
      relative_humidity_avg_pct, relative_humidity_zone_count,
      vpd_avg_kpa, vpd_zone_count,
      co2_avg_ppm, co2_zone_count,
      ec_avg, ec_zone_count,
      ph_avg, ph_zone_count,
      irrigation_cumulative_avg_ml, irrigation_zone_count, irrigation_interval_delta_ml, irrigation_interval_minutes, irrigation_quality_flag,
      expected_zone_count,
      phase_id, radiation_cumulative_j_cm2, radiation_interval_delta_j_cm2,
      quality_warnings, source_batch_id,
      temporal_covered, zones_linked, zones_reporting, zone_participation_pct, zone_diagnostics
    )
    select
      (d.r->>'organization_id')::uuid,
      (d.r->>'variety_id')::uuid,
      (d.r->>'measured_at')::timestamptz,
      (d.r->>'air_temperature_avg_c')::numeric, coalesce((d.r->>'air_temperature_zone_count')::integer, 0),
      (d.r->>'relative_humidity_avg_pct')::numeric, coalesce((d.r->>'relative_humidity_zone_count')::integer, 0),
      (d.r->>'vpd_avg_kpa')::numeric, coalesce((d.r->>'vpd_zone_count')::integer, 0),
      (d.r->>'co2_avg_ppm')::numeric, coalesce((d.r->>'co2_zone_count')::integer, 0),
      (d.r->>'ec_avg')::numeric, coalesce((d.r->>'ec_zone_count')::integer, 0),
      (d.r->>'ph_avg')::numeric, coalesce((d.r->>'ph_zone_count')::integer, 0),
      (d.r->>'irrigation_cumulative_avg_ml')::numeric, coalesce((d.r->>'irrigation_zone_count')::integer, 0),
      (d.r->>'irrigation_interval_delta_ml')::numeric, (d.r->>'irrigation_interval_minutes')::integer, d.r->>'irrigation_quality_flag',
      coalesce((d.r->>'expected_zone_count')::integer, 0),
      (d.r->>'phase_id')::uuid, (d.r->>'radiation_cumulative_j_cm2')::numeric, (d.r->>'radiation_interval_delta_j_cm2')::numeric,
      coalesce((select array_agg(x) from jsonb_array_elements_text(d.r->'quality_warnings') as x), '{}'),
      (d.r->>'source_batch_id')::uuid,
      coalesce((d.r->>'temporal_covered')::boolean, false),
      coalesce((d.r->>'zones_linked')::integer, 0),
      coalesce((d.r->>'zones_reporting')::integer, 0),
      (d.r->>'zone_participation_pct')::numeric,
      d.r->'zone_diagnostics'
    from (
      select distinct on (r->>'variety_id', r->>'measured_at') r
      from jsonb_array_elements(p_variety_hourly) with ordinality as t(r, ord)
      order by r->>'variety_id', r->>'measured_at', ord desc
    ) as d
    on conflict (variety_id, measured_at) do update set
      air_temperature_avg_c = excluded.air_temperature_avg_c, air_temperature_zone_count = excluded.air_temperature_zone_count,
      relative_humidity_avg_pct = excluded.relative_humidity_avg_pct, relative_humidity_zone_count = excluded.relative_humidity_zone_count,
      vpd_avg_kpa = excluded.vpd_avg_kpa, vpd_zone_count = excluded.vpd_zone_count,
      co2_avg_ppm = excluded.co2_avg_ppm, co2_zone_count = excluded.co2_zone_count,
      ec_avg = excluded.ec_avg, ec_zone_count = excluded.ec_zone_count,
      ph_avg = excluded.ph_avg, ph_zone_count = excluded.ph_zone_count,
      irrigation_cumulative_avg_ml = excluded.irrigation_cumulative_avg_ml, irrigation_zone_count = excluded.irrigation_zone_count,
      irrigation_interval_delta_ml = excluded.irrigation_interval_delta_ml, irrigation_interval_minutes = excluded.irrigation_interval_minutes,
      irrigation_quality_flag = excluded.irrigation_quality_flag,
      expected_zone_count = excluded.expected_zone_count,
      phase_id = excluded.phase_id, radiation_cumulative_j_cm2 = excluded.radiation_cumulative_j_cm2, radiation_interval_delta_j_cm2 = excluded.radiation_interval_delta_j_cm2,
      quality_warnings = excluded.quality_warnings, source_batch_id = excluded.source_batch_id,
      temporal_covered = excluded.temporal_covered, zones_linked = excluded.zones_linked,
      zones_reporting = excluded.zones_reporting, zone_participation_pct = excluded.zone_participation_pct,
      zone_diagnostics = excluded.zone_diagnostics;
  end if;
end;
$$ language plpgsql;

revoke all on function acquire_climate_rollup_phase_lock(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function acquire_climate_rollup_phase_lock(uuid, uuid, integer) to service_role;
revoke all on function renew_climate_rollup_phase_lock(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function renew_climate_rollup_phase_lock(uuid, uuid, integer) to service_role;
revoke all on function release_climate_rollup_phase_lock(uuid, uuid) from public, anon, authenticated;
grant execute on function release_climate_rollup_phase_lock(uuid, uuid) to service_role;
revoke all on function rollup_write_locked(uuid, uuid[], jsonb, jsonb) from public, anon, authenticated;
grant execute on function rollup_write_locked(uuid, uuid[], jsonb, jsonb) to service_role;
