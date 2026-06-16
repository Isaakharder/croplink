-- Climate Agent integration: Block Summary climate data (air temperature, RH,
-- calculated heating setpoint), keyed to a physical greenhouse "block" rather
-- than a crop Variety/Season.

create table blocks (
  id                      uuid        primary key default gen_random_uuid(),
  organization_id         uuid        null,
  name                    text        not null,
  climate_agent_block_key text        not null,
  is_active               boolean     not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create unique index blocks_climate_agent_block_key_uq
  on blocks (climate_agent_block_key);

create table block_climate_summaries (
  id                     uuid        primary key default gen_random_uuid(),
  organization_id        uuid        null,
  block_id               uuid        not null references blocks(id) on delete cascade,
  measured_at            timestamptz not null,
  air_temperature_c      numeric(5,2) null,
  relative_humidity_pct  numeric(5,2) null,
  heating_setpoint_c     numeric(5,2) null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create unique index block_climate_summaries_block_measured_at_uq
  on block_climate_summaries (block_id, measured_at);

create index block_climate_summaries_org_measured_at_idx
  on block_climate_summaries (organization_id, measured_at);

create trigger update_blocks_updated_at
  before update on blocks for each row execute function update_updated_at_column();

create trigger update_block_climate_summaries_updated_at
  before update on block_climate_summaries for each row execute function update_updated_at_column();
