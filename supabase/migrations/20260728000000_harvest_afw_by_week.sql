-- Actual (or manually-overridden) average fruit weight, keyed by the week
-- fruit is HARVESTED — not by the week fruit was set. Replaces
-- fruit_weight_by_week (which stored AFW by SET week, a mismatch with real
-- fruit weight being a property of when the fruit was actually picked) as
-- the source AFW now feeds harvest kg projections through. That table is
-- left in place, untouched, for historical reference only — the app no
-- longer reads or writes it after this migration.
--
-- Carry-forward semantics: for any harvest week with no row of its own, the
-- app resolves AFW as the latest (by week_number, same year only) row that
-- exists at or before that week — see resolveAfwCarryForward() in
-- server/src/lib/afwCarryForward.ts. No data is migrated from
-- fruit_weight_by_week: a set-week AFW forecast has no valid 1:1 mapping to
-- a harvest week (it fans out across setWeek+4..+10 via
-- harvest_timing_profiles at different percentages each), so reinterpreting
-- old rows would be a guess, not a fact. This table starts empty.
--
-- source distinguishes a real harvest measurement ('actual') from a
-- user-entered guess for a future, not-yet-harvested week ('override') —
-- an 'override' is never allowed to overwrite an existing 'actual' for the
-- same week (enforced in server/src/routes/harvestAfwByWeek.ts, not by a
-- DB constraint, since both share the same unique key and either could
-- legally occupy that row from the DB's point of view).

create table harvest_afw_by_week (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        null,
  variety_id        uuid        not null references varieties(id) on delete cascade,
  year              integer     not null,
  week_number       integer     not null check (week_number >= 1 and week_number <= 52),
  weight_grams      numeric     not null check (weight_grams > 0),
  source            text        not null check (source in ('actual', 'override')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (variety_id, year, week_number)
);

create index idx_harvest_afw_by_week_variety_year
  on harvest_afw_by_week (variety_id, year, week_number);

create trigger update_harvest_afw_by_week_updated_at
  before update on harvest_afw_by_week for each row execute function update_updated_at_column();
