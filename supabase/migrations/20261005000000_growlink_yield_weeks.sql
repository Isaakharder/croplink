-- GrowLink v2 yield detail, synced by POST /api/growlink/yield-weeks/sync-internal
-- (internal-ops auth). Kept separate from growlink_harvest_actuals because
-- that table is served by an unauthenticated public GET with select('*');
-- nothing public reads these tables.
--
-- Raw upstream values are stored as received (raw_payload + typed copies),
-- with upstream ids, timestamps and sync-run provenance, so every derived
-- value (e.g. weekly AFW) can be recomputed. Weeks here are GrowLink PACKING
-- weeks (packing_year/packing_week/packed_date) — never CropLink survey or
-- biological harvest weeks.
--
-- Depends on 20261004000000_iso_week_53.sql (iso_weeks_in_year).

create table growlink_yield_weeks (
  id                         uuid        primary key default gen_random_uuid(),
  growlink_yield_entry_id    uuid        not null unique,
  growlink_variety_id        uuid        not null,
  growlink_variety_name      text,
  packing_year               integer     not null,
  packing_week               integer     not null check (packing_week >= 1 and packing_week <= iso_weeks_in_year(packing_year)),
  packed_date                date,
  total_kg                   numeric,
  average_fruit_weight_g     numeric,
  total_cases                numeric,
  size_kg                    jsonb       not null default '{}'::jsonb,
  kg_per_m2                  numeric,
  daily                      jsonb       not null default '[]'::jsonb,
  daily_breakdown_complete   boolean,
  last_write_source          text,
  -- GrowLink variety record's own area_m2 (one crop record; can double-count across renamed/split records)
  variety_area_m2            numeric,
  variety_updated_at         timestamptz,
  -- GrowLink's measured greenhouse-row footprint — GrowLink's own physical-area rule
  physical_area_m2           numeric,
  physical_area_row_count    integer     not null default 0,
  physical_area_rows_missing_dimensions integer not null default 0,
  upstream_created_at        timestamptz not null,
  -- Exact upstream string (microsecond precision) — used for the keyset cursor.
  upstream_updated_at_raw    text        not null,
  upstream_updated_at        timestamptz not null,
  settlement_status          text        not null check (settlement_status in ('settled', 'provisional')),
  settled_at                 timestamptz,
  settlement_reason          text,
  upstream_status            text        not null default 'active' check (upstream_status in ('active', 'deleted_upstream', 'missing_upstream')),
  upstream_status_changed_at timestamptz,
  -- Set by the first VERIFIED complete manifest that lacked this id; a second
  -- consecutive verified manifest is required before 'missing_upstream'.
  missing_candidate_run_id   uuid,
  raw_payload                jsonb       not null,
  payload_sha256             text        not null,
  api_version                text        not null default 'v2',
  first_seen_run_id          uuid        not null,
  last_seen_run_id           uuid        not null,
  first_seen_at              timestamptz not null default now(),
  last_seen_at               timestamptz not null default now()
);
create index growlink_yield_weeks_variety_week_idx on growlink_yield_weeks (growlink_variety_id, packing_year, packing_week);
create index growlink_yield_weeks_status_idx on growlink_yield_weeks (upstream_status, settlement_status);

-- Every observed change to a synced week; was_settled marks late edits.
create table growlink_yield_week_revisions (
  id                      bigserial   primary key,
  growlink_yield_entry_id uuid        not null,
  sync_run_id             uuid        not null,
  change_kind             text        not null check (change_kind in ('update', 'deleted_upstream', 'missing_upstream', 'restored')),
  was_settled             boolean     not null,
  changed_fields          text[]      not null default '{}',
  previous_payload        jsonb,
  current_payload         jsonb,
  detected_at             timestamptz not null default now()
);
create index growlink_yield_week_revisions_entry_idx on growlink_yield_week_revisions (growlink_yield_entry_id, detected_at);
create index growlink_yield_week_revisions_late_idx on growlink_yield_week_revisions (detected_at) where was_settled;

create table growlink_sync_runs (
  id                       uuid        primary key,
  kind                     text        not null check (kind in ('yield-weeks', 'deletions', 'manifest-reconciliation')),
  status                   text        not null check (status in ('running', 'succeeded', 'failed', 'aborted')),
  started_at               timestamptz not null,
  finished_at              timestamptz,
  -- sha256 fingerprint of the GrowLink key used (first 16 hex chars) — never the key.
  key_fingerprint          text,
  cursor_before            jsonb,
  cursor_after             jsonb,
  pages                    integer     not null default 0,
  fetched                  integer     not null default 0,
  created                  integer     not null default 0,
  updated                  integer     not null default 0,
  unchanged                integer     not null default 0,
  rejected                 integer     not null default 0,
  rejected_records         jsonb       not null default '[]'::jsonb,
  manifest_id              uuid,
  manifest_expected_count  integer,
  manifest_checksum        text,
  manifest_verified        boolean,
  missing_candidates       integer,
  marked_missing           integer,
  restored                 integer,
  error                    text
);
create index growlink_sync_runs_kind_started_idx on growlink_sync_runs (kind, started_at desc);

create table growlink_sync_state (
  endpoint        text        primary key check (endpoint in ('yield-weeks', 'deletions')),
  cursor          jsonb       not null,
  key_fingerprint text,
  updated_at      timestamptz not null default now()
);

alter table growlink_yield_weeks enable row level security;
alter table growlink_yield_week_revisions enable row level security;
alter table growlink_sync_runs enable row level security;
alter table growlink_sync_state enable row level security;

-- Server-only: no table privilege for the API roles (TRUNCATE/REFERENCES/
-- TRIGGER are not governed by RLS, and new tables may receive default grants).
revoke all on table growlink_yield_weeks, growlink_yield_week_revisions, growlink_sync_runs, growlink_sync_state from anon, authenticated, public;
revoke all on sequence growlink_yield_week_revisions_id_seq from anon, authenticated, public;
