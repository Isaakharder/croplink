# Variety configuration audit history — design

Status: **proposal, not migrated.**

## Problem

Forecast kg scales tracked-stem counts by `varieties.total_stem_count / measured stems / area_m2`. Those fields are edited in place through `PATCH /api/projection/varieties/:id` (which accepts any column in the body), and CropLink keeps no history of them. A forecast or backtest therefore always uses *today's* configuration, even for past weeks.

**The 2026-09-19 change to Mathieu cannot be reconstructed reliably.** `varieties.updated_at` shows that something changed at 2026-09-19 21:36 UTC, but not which field or what the old value was. Current values: area 11,627 m², plants 40,068, stems 80,136, plant date 2026-01-26, pull-out date 2026-12-31, case 5.1 kg. The only partial evidence:

- `projection_snapshots` rows (if the daily snapshot cron ran before and after that date) store `projected_kg_by_week`, cohort fruit/m² and `afw_by_week`. Their ratio can back out the **area** used by each snapshot. It cannot back out stem count, because snapshot fruit/m² came from stored profiles, not a live recomputation. There is no API route to read snapshots, so checking this needs read-only database access.
- A Supabase point-in-time backup from before 2026-09-19, if the plan retains one, would contain the previous row.

Until one of these is checked, every result that depends on area or stem count before W38 assumes today's values.

## Design

```sql
create table variety_config_history (
  id              uuid        primary key default gen_random_uuid(),
  variety_id      uuid        not null references varieties(id) on delete cascade,
  field           text        not null check (field in (
                    'area_m2','plant_count','total_stem_count','is_active',
                    'plant_date','pull_out_date','case_kg','average_fruit_weight_grams')),
  old_value       jsonb,
  new_value       jsonb,
  -- When the change takes effect in the greenhouse (e.g. rows removed on
  -- Sep 14 but entered on Sep 19). Defaults to changed_at::date; the edit
  -- UI should let the grower set it.
  effective_from  date        not null,
  changed_at      timestamptz not null default now(),
  changed_by      text,                 -- null until CropLink has user auth
  source          text        not null check (source in ('ui','api','import','migration','backfill')),
  note            text
);
create index on variety_config_history (variety_id, field, effective_from);
```

- An `AFTER UPDATE` trigger on `varieties` writes one row per listed field whose value actually changed (`old is distinct from new`). `effective_from` comes from a transaction-local setting (`set_config('croplink.effective_from', …, true)`) that the API sets when the grower provides it, otherwise `changed_at::date`. `source` comes from `croplink.change_source` the same way, defaulting to `'api'`.
- An `AFTER INSERT` trigger records the initial values with `source = 'migration'` for existing rows (one-off backfill) and `'ui'`/`'api'` for new varieties, so every variety has a baseline.
- `PATCH /varieties/:id` gets an allow-list of editable columns, rejects unknown keys, and accepts an optional `effective_from`.
- Helper `varietyConfigAsOf(varietyId, date)`: the latest history row per field with `effective_from <= date`. The forecast and the backtest use it instead of the live row, so a past forecast date uses the configuration then in force.
- Retention: never pruned; the table is tiny.

## Migration notes (for later)

- Backfill one baseline row per variety and field from the current values with `source = 'backfill'` and `effective_from` = the variety's `created_at::date`, with a note that values before 2026-10 are unverified, plus a specific note on Mathieu's unrecoverable 2026-09-19 change.
- If snapshots or a backup recover Mathieu's pre-2026-09-19 area, insert it as a `backfill` row with `effective_from` = its original date and a note on how it was recovered.
- GrowLink would need the same pattern for its `varieties.area_m2` before CropLink can rely on GrowLink area history.
