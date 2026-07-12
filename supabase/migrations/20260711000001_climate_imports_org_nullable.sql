-- climate_imports/climate_readings originally required organization_id NOT NULL,
-- assuming per-org API-key auth. This app has no user/session auth system yet
-- (confirmed during the variety-hourly pipeline build), so the manual CSV
-- upload path has no organization to supply. Relax to match every other table
-- in this schema (blocks, zones, phases, variety_zones), which already allow
-- a null organization_id pending a future auth system.
alter table climate_imports alter column organization_id drop not null;
alter table climate_readings alter column organization_id drop not null;
