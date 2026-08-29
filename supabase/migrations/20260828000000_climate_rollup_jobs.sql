-- Durable job queue for the climate hourly-rollup pipeline (Round 10, Phase 1/2).
--
-- Background: raw climate_readings has been growing continuously via the
-- automated Climate Agent route (POST /api/v1/climate/imports), but nothing
-- ever triggered the derived phase_climate_hourly / variety_climate_hourly /
-- variety_climate_hourly_features rollup for that path -- only the manual
-- batch-upload-and-commit UI flow did. This table lets both the agent route
-- and the manual commit route enqueue rollup work durably (survives process
-- restarts, is retryable, and is observable) instead of doing it inline
-- (blocking the agent's response) or via a fire-and-forget promise (silently
-- lost on crash, no retry, no visibility).

create table if not exists climate_rollup_jobs (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    uuid,
  source             text        not null check (source in ('agent_import', 'batch_commit', 'correction', 'backfill')),
  source_import_id   uuid        references climate_imports(id),
  source_batch_id    uuid        references climate_import_batches(id),
  range_start        timestamptz not null,
  range_end          timestamptz not null,
  status             text        not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  attempt_count      integer     not null default 0,
  last_error         text,
  started_at         timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint climate_rollup_jobs_range_valid check (range_end >= range_start)
);

-- Claiming work in FIFO order; also the shape the diagnostics endpoint scans
-- for "pending/failed" counts.
create index if not exists idx_climate_rollup_jobs_status_created
  on climate_rollup_jobs (status, created_at);

create index if not exists idx_climate_rollup_jobs_org
  on climate_rollup_jobs (organization_id);

create or replace function set_climate_rollup_jobs_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_climate_rollup_jobs_updated_at on climate_rollup_jobs;
create trigger trg_climate_rollup_jobs_updated_at
  before update on climate_rollup_jobs
  for each row execute function set_climate_rollup_jobs_updated_at();

-- Atomically claims up to p_limit pending (or stuck-failed, if p_include_failed)
-- jobs by flipping them to 'running' in one statement, so two concurrent
-- worker invocations (e.g. two overlapping cron triggers) can never claim the
-- same job -- the UPDATE ... WHERE status = 'pending' ... RETURNING pattern
-- is safe under Postgres's row-level locking without an explicit advisory lock.
create or replace function claim_climate_rollup_jobs(p_limit integer default 5)
returns setof climate_rollup_jobs as $$
begin
  return query
  update climate_rollup_jobs
  set status = 'running', started_at = now(), attempt_count = attempt_count + 1
  where id in (
    select id from climate_rollup_jobs
    where status = 'pending'
    order by created_at asc
    limit p_limit
    for update skip locked
  )
  returning *;
end;
$$ language plpgsql;

-- Defense in depth: this function mutates job state (claims and marks rows
-- 'running') and is meant to be called ONLY by the server's own service-role
-- connection, from behind the internalOpsAuth-gated /rollup-jobs/process
-- route -- never directly. No existing migration in this app sets explicit
-- function grants (every other RPC, including commit_climate_import_batch,
-- relies on whatever Supabase's project-level defaults happen to be, and
-- there is no RLS enabled anywhere in this database) -- not retrofitting
-- that broader, pre-existing pattern here, but for this NEW function
-- specifically, explicitly restricting execution to service_role is a
-- purely additive change (service_role is unaffected either way) that
-- closes any theoretical direct-PostgREST-call path regardless of what
-- this project's default grants turn out to be.
revoke all on function claim_climate_rollup_jobs(integer) from public;
revoke all on function claim_climate_rollup_jobs(integer) from anon;
revoke all on function claim_climate_rollup_jobs(integer) from authenticated;
grant execute on function claim_climate_rollup_jobs(integer) to service_role;
