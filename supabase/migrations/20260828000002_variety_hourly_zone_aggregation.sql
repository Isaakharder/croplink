-- Zone-aggregation correctness + transparency for variety_climate_hourly
-- (Round 10, Phase "verify variety-level linked-zone aggregation").
--
-- Two fixes this adds columns for:
--
-- 1. VPD was being computed downstream (in variety_climate_hourly_features)
--    FROM the already-averaged air_temperature_avg_c / relative_humidity_avg_pct
--    -- a real Jensen's-inequality bug: VPD is nonlinear in temperature, so
--    VPD(avg(T), avg(RH)) is not the same as avg(VPD(T_i, RH_i)) in general.
--    vpd_avg_kpa here is computed per-zone from that zone's own temperature +
--    RH reading, THEN averaged -- the correct order. The features table's
--    vpd_kpa now passes this through instead of recomputing it.
--
-- 2. The existing coverage math (hoursObserved / hoursExpected against rows
--    in variety_climate_hourly_features) already does NOT penalize a 5/6-zone
--    hour -- a row gets written whenever at least one linked zone reports
--    anything. But that was an emergent property of the code, not an
--    explicit, auditable fact. temporal_covered / zones_linked /
--    zones_reporting / zone_participation_pct make it explicit.
--
-- zone_diagnostics carries per-metric {count, min, max, spread, outlierZone,
-- outlierFlagged} plus a weightingMethod note -- jsonb rather than a wide
-- column-per-metric-per-stat schema, since this is diagnostic/audit data,
-- not something queried relationally.

alter table variety_climate_hourly
  add column if not exists vpd_avg_kpa            numeric(6,4),
  add column if not exists vpd_zone_count          integer not null default 0,
  add column if not exists temporal_covered        boolean not null default false,
  add column if not exists zones_linked            integer not null default 0,
  add column if not exists zones_reporting         integer not null default 0,
  add column if not exists zone_participation_pct  numeric(5,2),
  add column if not exists zone_diagnostics        jsonb;

alter table variety_climate_hourly_features
  add column if not exists vpd_source text not null default 'legacy_averaged_temp_rh';
comment on column variety_climate_hourly_features.vpd_source is
  'legacy_averaged_temp_rh: vpd_kpa was computed here from already-zone-averaged T/RH (the pre-fix behavior, kept on old rows for honesty). per_zone_averaged: vpd_kpa was passed through from variety_climate_hourly.vpd_avg_kpa, computed per-zone before averaging (the corrected behavior). Lets a query distinguish which rows predate the fix without needing a separate migration/backfill flag.';
