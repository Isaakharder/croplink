-- Generic per-org settings for external integrations (GrowLink, and any future
-- integration). One row per (organization_id, integration_name).
--
-- secret_key is stored as plain text: there is no existing reversible-encryption
-- pattern in this codebase to build on (climate_imports/organizations use a
-- one-way hash for verifying *inbound* keys, which doesn't work here since we
-- need the plaintext back out to send as an outbound header). Never return
-- secret_key from the API and never log it.

create table crop_integration_settings (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        null,
  integration_name text        not null,
  base_url         text,
  secret_key       text,
  status           text        not null default 'not_configured' check (status in ('not_configured', 'connected', 'connection_failed')),
  last_tested_at   timestamptz,
  last_success_at  timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One settings row per integration per org (see caveat on organization_id
-- being null today in zones_org_import_key_uq — same applies here; the API
-- looks up the existing row explicitly rather than relying solely on this
-- index to prevent duplicates while organization_id is null).
create unique index crop_integration_settings_org_name_uq on crop_integration_settings (organization_id, integration_name);

create trigger update_crop_integration_settings_updated_at
  before update on crop_integration_settings for each row
  execute function update_updated_at_column();
