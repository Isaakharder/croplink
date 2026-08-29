-- Append-only immutable forecast snapshots (Round 10, Phase 6).
--
-- Every prior round's backtest/audit work has been blocked by the same
-- limitation: there is no historical record of what CropLink's projection
-- candidates actually said at a given point in time, so "how accurate was
-- last month's forecast" can never be answered honestly -- only
-- reconstructed after the fact from today's data, which is exactly the kind
-- of hindsight leakage this whole engagement has been careful to avoid.
--
-- This table freezes one row per (snapshot_run_id, variety_id): every
-- candidate's projected kg by week, the cohort/timing/survival/AFW inputs
-- that produced it, and the climate coverage known as of that moment.
-- Genuinely immutable -- the trigger below rejects any UPDATE outright, not
-- just "shouldn't be updated by convention." GrowLink actuals are joined
-- against these rows LATER, for evaluation, never written back into them.

create table if not exists projection_snapshots (
  id                      uuid        primary key default gen_random_uuid(),
  snapshot_run_id         uuid        not null,
  organization_id         uuid,
  season_id               uuid        not null references seasons(id),
  variety_id              uuid        not null references varieties(id),
  year                    integer     not null,

  calculation_version     text        not null,
  created_at              timestamptz not null default now(),
  effective_at            timestamptz not null,

  -- Cohort composition as of effective_at, keyed by set_week_number ->
  -- {harvested, aborted, pruned, open, avgFruitSet, source}. jsonb rather
  -- than a normalized child table: this is a frozen fact record, never
  -- queried relationally, and the shape intentionally varies by candidate.
  cohort_counts           jsonb       not null,
  timing_curve            jsonb       not null,
  timing_curve_source     text        not null,
  survival_factor         jsonb,
  survival_factor_source  text,
  afw_by_week             jsonb       not null,
  afw_source              text        not null,

  -- What the climate pipeline actually knew as of effective_at -- NOT a
  -- climate-informed prediction (none is active yet), just the observational
  -- context, matching the Climate Context card's own "observational only"
  -- framing.
  climate_exposure_known  jsonb,
  climate_coverage_quality jsonb,
  future_climate_assumption jsonb,

  projected_kg_by_week    jsonb       not null,
  total_kg                numeric(12,1) not null,

  constraint projection_snapshots_run_variety_uq unique (snapshot_run_id, variety_id)
);

create index if not exists idx_projection_snapshots_variety_effective
  on projection_snapshots (variety_id, effective_at);

create index if not exists idx_projection_snapshots_run
  on projection_snapshots (snapshot_run_id);

-- True immutability, not just an app-level convention: once written, a
-- snapshot row can never be changed, only superseded by a new row in a
-- later run. Deletion is still allowed (for genuine mistakes / test-data
-- cleanup), but silent mutation is not.
create or replace function reject_projection_snapshot_update()
returns trigger as $$
begin
  raise exception 'projection_snapshots is append-only: row % cannot be updated (id=%)', old.id, old.id;
end;
$$ language plpgsql;

drop trigger if exists trg_projection_snapshots_no_update on projection_snapshots;
create trigger trg_projection_snapshots_no_update
  before update on projection_snapshots
  for each row execute function reject_projection_snapshot_update();
