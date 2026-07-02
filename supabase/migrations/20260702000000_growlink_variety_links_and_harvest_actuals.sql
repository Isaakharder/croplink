-- GrowLink Variety Links and Harvest Actuals
--
-- GrowLink is an external grower platform. These tables are the local side of
-- a future sync integration and are deliberately sync-ready even though no
-- sync service exists yet:
--
-- growlink_variety_links: maps a local variety to GrowLink's own stable key
--   for that variety. Managed entirely by hand today (create/edit/link/
--   unlink/delete via the UI); a future sync service would read this table
--   to resolve which local variety a GrowLink record belongs to, and may
--   also flag 'conflict' if GrowLink reports a change that needs review.
--
-- growlink_harvest_actuals: harvest records as reported by GrowLink. Stores
--   the raw growlink_variety_key exactly as received (a harvest actual can
--   arrive before its variety is linked) alongside a resolved variety_id
--   (nullable until a growlink_variety_links row matches). Owned by GrowLink
--   — rows are only ever written by the future sync/"Sync Now" action, never
--   edited by hand, so there are no user-facing write endpoints yet.

create table growlink_variety_links (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       uuid        null,
  variety_id            uuid        not null references varieties(id) on delete cascade,
  growlink_variety_key  text        not null,
  link_status           text        not null default 'linked' check (link_status in ('linked', 'unlinked', 'conflict')),
  notes                 text,
  last_synced_at        timestamptz null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- One GrowLink link per local variety
create unique index growlink_variety_links_variety_uq on growlink_variety_links (variety_id);
-- A GrowLink variety key must be unique per org
create unique index growlink_variety_links_org_key_uq on growlink_variety_links (organization_id, growlink_variety_key);
create index growlink_variety_links_status_idx on growlink_variety_links (link_status);

create trigger update_growlink_variety_links_updated_at
  before update on growlink_variety_links for each row
  execute function update_updated_at_column();

create table growlink_harvest_actuals (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       uuid        null,
  growlink_harvest_key  text        not null,
  growlink_variety_key  text        not null,
  variety_id            uuid        null references varieties(id) on delete set null,
  harvest_date          date        not null,
  year                  integer     not null,
  week_number           integer     not null check (week_number >= 1 and week_number <= 52),
  kg                    numeric     check (kg is null or kg >= 0),
  cases                 numeric,
  case_weight_kg        numeric,
  source_payload        jsonb,
  synced_at             timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- growlink_harvest_key is the idempotency key a future sync would upsert on
create unique index growlink_harvest_actuals_org_key_uq on growlink_harvest_actuals (organization_id, growlink_harvest_key);
create index growlink_harvest_actuals_variety_idx on growlink_harvest_actuals (variety_id);
create index growlink_harvest_actuals_variety_key_idx on growlink_harvest_actuals (growlink_variety_key);
create index growlink_harvest_actuals_year_week_idx on growlink_harvest_actuals (year, week_number);

create trigger update_growlink_harvest_actuals_updated_at
  before update on growlink_harvest_actuals for each row
  execute function update_updated_at_column();
