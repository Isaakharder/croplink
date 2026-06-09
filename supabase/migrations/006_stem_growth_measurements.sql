-- Vegetative/growth measurements recorded per stem per week.
-- One reading per stem per (year, week) — enforced by the unique index below.

create table stem_growth_measurements (
  id                  uuid         primary key default gen_random_uuid(),
  organization_id     uuid         null,
  variety_id          uuid         not null references varieties(id),
  season_id           uuid         null references seasons(id),
  year                integer      not null,
  week_number         integer      not null check (week_number between 1 and 53),
  measurement_row_id  uuid         not null references measurement_rows(id),
  measurement_stem_id uuid         not null references measurement_stems(id),
  growth_cm           numeric(6,2) not null check (growth_cm > 0),
  notes               text         null,
  created_at          timestamptz  not null default now(),
  updated_at          timestamptz  not null default now()
);

create unique index stem_growth_measurements_stem_week_uq
  on stem_growth_measurements (measurement_stem_id, year, week_number);

create index stem_growth_measurements_variety_year_week_idx
  on stem_growth_measurements (variety_id, year, week_number);
