-- Climate Agent: file-level import tracking and generic readings store.
-- The organizations table provides API key authentication (keys stored as SHA-256 hashes).

create table organizations (
  id           uuid        primary key default gen_random_uuid(),
  name         text        not null,
  api_key_hash text        not null,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index organizations_api_key_hash_uq on organizations (api_key_hash);

create trigger update_organizations_updated_at
  before update on organizations for each row execute function update_updated_at_column();

-- One row per file received from the Climate Agent. Unique per (org, file_hash)
-- so replaying the same file is a no-op rather than a double-insert.
create table climate_imports (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null references organizations(id),
  filename         text        not null,
  file_hash        text        not null,
  readings_stored  integer     not null default 0,
  created_at       timestamptz not null default now()
);

create unique index climate_imports_org_file_hash_uq
  on climate_imports (organization_id, file_hash);

create index climate_imports_org_created_idx
  on climate_imports (organization_id, created_at desc);

-- Tall-format readings: one row per metric per zone per timestamp.
-- Unique on (org, measured_at, zone_label, metric_name) so individual readings
-- are also idempotent even if they arrive via different files.
--
-- Supported metric_name values:
--   ec                    mS/cm
--   ph                    (dimensionless)
--   temperature_c         °C
--   relative_humidity_pct %
--   co2_ppm               ppm
--   drain_water_pct       %
--   feed_water_volume_ml  ml
--   radiation_sum_j_cm2   J/cm²
create table climate_readings (
  id               uuid          primary key default gen_random_uuid(),
  organization_id  uuid          not null references organizations(id),
  import_id        uuid          not null references climate_imports(id) on delete cascade,
  zone_label       text          not null,
  measured_at      timestamptz   not null,
  metric_name      text          not null,
  value            numeric(10,4) null,
  unit             text          null,
  source_file      text          null,
  created_at       timestamptz   not null default now()
);

create unique index climate_readings_org_time_zone_metric_uq
  on climate_readings (organization_id, measured_at, zone_label, metric_name);

create index climate_readings_org_zone_measured_idx
  on climate_readings (organization_id, zone_label, measured_at);
