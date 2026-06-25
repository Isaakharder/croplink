-- Phases, Zones, and Variety-Zone assignments for CropLink Setup.
--
-- phases:  logical groupings (e.g. "Phase 1", "Phase 2")
-- zones:   individual growing areas within a phase; import_key is the stable
--          label used as zone_label in climate_readings imports
-- variety_zones: current variety planted in each zone (unique per zone, so one
--          variety per zone; a variety may span multiple zones)

create table phases (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        null,
  name            text        not null,
  sort_order      integer     not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index phases_org_sort_idx on phases (organization_id, sort_order);

create trigger update_phases_updated_at
  before update on phases for each row
  execute function update_updated_at_column();

create table zones (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        null,
  phase_id        uuid        not null references phases(id) on delete cascade,
  name            text        not null,
  import_key      text        not null,
  sort_order      integer     not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- import_key must be unique per org — it is the zone_label used in climate_readings
create unique index zones_org_import_key_uq on zones (organization_id, import_key);
create index zones_phase_sort_idx on zones (phase_id, sort_order);

create trigger update_zones_updated_at
  before update on zones for each row
  execute function update_updated_at_column();

create table variety_zones (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        null,
  variety_id      uuid        not null references varieties(id) on delete cascade,
  zone_id         uuid        not null references zones(id) on delete cascade,
  created_at      timestamptz not null default now()
);

-- One variety per zone at a time; a variety may appear in many zones
create unique index variety_zones_zone_uq on variety_zones (zone_id);
create index variety_zones_variety_idx on variety_zones (variety_id);
