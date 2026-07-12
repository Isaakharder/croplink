-- Deterministic climate feature engine — Phase 1 storage.
--
-- One row per (variety_id, measured_at), mirroring the grain of
-- variety_climate_hourly. Holds the derived features that aren't already
-- present on that table (degree-hours, VPD + band, daylight flag, EC/pH
-- hour-over-hour deltas) plus cheap passthroughs of the columns most often
-- needed alongside them (CO2, radiation delta, irrigation delta/interval) so
-- the exposure-window aggregator can read a single table for most inputs.
-- Raw EC/pH/temperature/RH averages are NOT duplicated here — callers join
-- back to variety_climate_hourly by (variety_id, measured_at) when they need
-- those (e.g. for EC/pH stability stddev).
--
-- Populated by server/src/lib/climateFeatureRecompute.ts, triggered
-- non-fatally after a climate import batch commits or a timestamp
-- correction is applied — never by a database trigger, so the derivation
-- logic (including the crop-specific constants in climateFeatures.ts) stays
-- in one place and is easy to change without a migration.

create table variety_climate_hourly_features (
  id                              uuid        primary key default gen_random_uuid(),
  organization_id                 uuid        null,
  variety_id                      uuid        not null references varieties(id) on delete cascade,
  measured_at                     timestamptz not null,

  degree_hours                    numeric(6,3),
  vpd_kpa                         numeric(5,3),
  vpd_band                        text,
  is_daylight                     boolean     not null default false,
  ec_delta                        numeric(6,3),
  ph_delta                        numeric(6,3),

  -- Passthroughs from variety_climate_hourly, kept here for cheap single-table reads.
  co2_avg_ppm                     numeric(8,2),
  radiation_interval_delta_j_cm2  numeric(10,2),
  irrigation_interval_delta_ml    numeric(10,2),
  irrigation_interval_minutes     integer,

  source_variety_hourly_id        uuid references variety_climate_hourly(id) on delete cascade,

  -- Provenance: the exact config that produced this row's derived values.
  -- Always set explicitly by the application on every write (see
  -- climateFeatures.ts) — the defaults below only cover the unlikely case of
  -- a manual insert and mirror the current constants, they are not the
  -- source of truth. When base temp / cap / VPD bands are recalibrated
  -- later, these columns let old and new rows be told apart unambiguously
  -- instead of silently reinterpreting history under the new config.
  degree_hour_base_temp_c         numeric(4,1) not null default 10.0,
  degree_hour_upper_cap_c         numeric(4,1) not null default 30.0,
  vpd_band_config_version         text        not null default 'bell-pepper-vpd-bands-v1',
  feature_engine_version          text        not null default 'climate-features-v1',

  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);

create unique index variety_climate_hourly_features_variety_measured_at_uq
  on variety_climate_hourly_features (variety_id, measured_at);
create index variety_climate_hourly_features_org_measured_idx
  on variety_climate_hourly_features (organization_id, measured_at);

create trigger update_variety_climate_hourly_features_updated_at
  before update on variety_climate_hourly_features for each row execute function update_updated_at_column();
