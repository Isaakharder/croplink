-- Bug found via testing: organization_id is nullable on climate_readings and
-- climate_imports (this app has no auth/org system yet, so it's always
-- null), but standard SQL unique constraints treat NULL as distinct from
-- NULL — meaning the existing unique indexes, and any `ON CONFLICT` clause
-- targeting them, never actually matched two null-org rows against each
-- other. In practice: an intended "overwrite" silently inserted a second,
-- duplicate row instead of updating the first. Rebuilding both indexes with
-- NULLS NOT DISTINCT (Postgres 15+) makes null organization_id values
-- compare as equal for uniqueness, matching this app's actual single-tenant
-- reality until a real auth/org system exists.

-- First, collapse any duplicate rows this bug already produced, keeping the
-- most recently written one per key (matches "last write wins" — the same
-- semantics the broken ON CONFLICT DO UPDATE was supposed to provide).
delete from climate_readings a
using climate_readings b
where a.id <> b.id
  and a.organization_id is not distinct from b.organization_id
  and a.measured_at = b.measured_at
  and a.zone_label = b.zone_label
  and a.metric_name = b.metric_name
  and a.created_at < b.created_at;

delete from climate_imports a
using climate_imports b
where a.id <> b.id
  and a.organization_id is not distinct from b.organization_id
  and a.file_hash = b.file_hash
  and a.created_at < b.created_at;

drop index if exists climate_readings_org_time_zone_metric_uq;
create unique index climate_readings_org_time_zone_metric_uq
  on climate_readings (organization_id, measured_at, zone_label, metric_name) nulls not distinct;

drop index if exists climate_imports_org_file_hash_uq;
create unique index climate_imports_org_file_hash_uq
  on climate_imports (organization_id, file_hash) nulls not distinct;
