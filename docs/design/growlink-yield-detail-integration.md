# GrowLink → CropLink yield-detail integration (v2) — design

Status: **approved 2026-10-04; code merged to both repositories' main branches. Migrations NOT applied, no key scope granted, sync not run.**

- GrowLink `main`: `0140_rls_fix_integration_keys.sql` (closes anonymous access to integration keys — apply first), then `0141_croplink_v2_yield_detail.sql`. Before 0141, v2 endpoints refuse every existing key (403), key lookups fall back to the pre-scope columns, and `last_write_source` is only written once `YIELD_WRITE_SOURCE_TRACKING=enabled`.
- CropLink `main`: `20261004000000_iso_week_53.sql`, then `20261005000000_growlink_yield_weeks.sql`. The sync route needs `INTERNAL_OPS_KEY` and `GROWLINK_CROPLINK_KEY` and is never called automatically.

Additions made during implementation: every list response carries `resumeCursor` (exact resume point, so rows sharing the last timestamp are never skipped); items carry both `varietyAreaM2` (the variety record) and `physicalAreaM2` / `physicalAreaRowCount` / `physicalAreaRowsMissingDimensions` (GrowLink's measured greenhouse-row footprint, its own physical-area rule from `utils/varietyAreaFootprints.ts`); `year`/`week` are exposed as `packingYear`/`packingWeek`.

## Why

CropLink's harvest forecasts convert tracked fruit counts to kilograms with an AFW (average fruit weight) that has not been measured since W32; the only AFW in CropLink was batch-entered on 2026-07-28. GrowLink already stores the packed figures that would fix this (`yield_entries.average_fruit_weight_g`, `total_cases`, `size_kg`, a per-packing-day breakdown, and `varieties.area_m2`), but the current CropLink integration exports only `total_kg`. CropLink also has no way to know when a GrowLink week is final, and GrowLink hard-deletes yield entries, so deletions never reach CropLink.

## Current state (verified in source)

| | GrowLink (`growlink` repo) | CropLink (`croplink` repo) |
|---|---|---|
| Endpoint | `GET /api/integrations/croplink/harvest-actuals` (`server/src/routes/croplinkIntegration.ts`) | `POST /api/growlink/harvest-actuals/sync` pulls it; `GET /api/growlink/harvest-actuals` serves stored rows |
| Auth | `X-Integration-Key`, SHA-256 hashed in `organization_integration_keys`, org-scoped, revocable, bound to `integration_name = 'croplink'` | **None** on its own GET routes (every CropLink GET is public); the GrowLink key is stored in `crop_integration_settings.secret_key` (plaintext column, masked in API responses) |
| Pagination | None — an unpaginated Supabase select, capped at 1,000 rows (202 rows today) | Full-snapshot diff each sync |
| Fields | id, variety, year, week, packed_date, total_kg, updated_at | stored in `growlink_harvest_actuals` (`select('*')` on the public GET) |
| Deletes | `DELETE /yield-entries/:id` is a hard delete, no tombstone | never removes rows |
| Daily breakdown | `yield_entry_daily_breakdown`; editing an entry **replaces all daily rows with one row** | not stored |
| Finality | no concept; observed edits up to 9 days after week end (2026) | none |

Because CropLink's GET routes are unauthenticated, the new fields must **not** be added to `growlink_harvest_actuals` (its public `select('*')` would leak them). They go in a new table that no public route reads.

## Authentication

Service-to-service, two legs:

1. **CropLink → GrowLink (data pull).** Reuse GrowLink's existing integration-key mechanism — it is already stronger than a shared env secret (hashed at rest, per-organization, revocable, `last_used_at` tracked). Add **scopes** so the existing key does not silently gain access to more data:
   - GrowLink migration: `alter table organization_integration_keys add column scopes text[] not null default '{harvest-actuals:read}'`.
   - `requireIntegrationKey('croplink', 'yield-detail:read')` checks both `integration_name` and the scope; v1 keeps working unchanged.
   - Issue a new key with `{harvest-actuals:read, yield-detail:read}` through the existing admin integration-keys route; revoke the old one after cut-over.
   - CropLink keeps the key in a Railway secret `GROWLINK_CROPLINK_KEY` (not the database), read only by the server.
   - Requests go over HTTPS only and through GrowLink's `strictLimiter`.
2. **Scheduler → CropLink (trigger the sync).** Same pattern as the rollup and snapshot crons: `POST /api/growlink/yield-weeks/sync-internal` behind `internalOpsAuth` (`X-Internal-Ops-Key`, constant-time compare). No public route triggers it. CropLink exposes the stored detail only through internal-ops-authenticated reads, or reads it server-side inside the forecast.

## API contract (GrowLink)

### `GET /api/integrations/croplink/v2/yield-weeks`

Headers: `X-Integration-Key` (scope `yield-detail:read`).

Query:

| param | meaning |
|---|---|
| `updatedAfter` | ISO timestamp; only rows with `updated_at` after this (incremental sync) |
| `cursor` | opaque keyset cursor from the previous page (`base64(updated_at|id)`) |
| `limit` | 1–500, default 500 |
| `year` | optional filter |

Ordering is keyset on `(updated_at asc, id asc)` — stable under concurrent edits, no offsets. The server requests `limit + 1` rows to set `hasMore`, so a page can never be silently truncated; if Supabase returns its own row cap the request fails with 500 rather than returning a short page.

Response `200` (values illustrative, not real Mathieu data):

```json
{
  "items": [
    {
      "yieldEntryId": "uuid",
      "varietyId": "uuid",
      "varietyName": "Mathieu",
      "year": 2026,
      "week": 38,
      "totalKg": 2777,
      "averageFruitWeightG": 210.5,
      "totalCases": 544,
      "sizeKg": { "XL": 812.0, "L": 1430.0, "M": 535.0 },
      "kgPerM2": 0.239,
      "packedDate": "2026-09-18",
      "daily": [
        { "packedDate": "2026-09-16", "totalKg": 1300, "averageFruitWeightG": 212.0, "sizeKg": {} },
        { "packedDate": "2026-09-18", "totalKg": 1477, "averageFruitWeightG": 209.2, "sizeKg": {} }
      ],
      "dailyBreakdownComplete": true,
      "varietyAreaM2": 11627,
      "varietyAreaUpdatedAt": "2026-05-25T19:40:39Z",
      "createdAt": "2026-09-18T20:11:02Z",
      "updatedAt": "2026-09-22T21:30:21Z",
      "settlement": { "status": "settled", "settledAt": "2026-10-01T04:00:00Z", "reason": "week ended 10+ days ago and unchanged for 3+ days" }
    }
  ],
  "nextCursor": "base64…",
  "hasMore": true,
  "serverTime": "2026-10-04T12:45:00Z"
}
```

Field notes:

- `dailyBreakdownComplete` is `false` when the entry was last changed through the manual edit route (which collapses the breakdown to one row). This needs a small GrowLink column, `yield_entries.last_write_source text check (in ('import','manual_create','manual_edit'))`, set by each write path.
- `settlement.status` is `provisional` until **both** the ISO week has ended at least 10 days ago (end of Sunday, America/Toronto) **and** `updated_at` is at least 3 days old. A later edit returns the row with `updatedAt` bumped and `settlement.status` back to `provisional`. The 10-day rule comes from the largest observed post-week edit (+9 days, W32 2026); GrowLink can later replace it with an explicit "week closed" action without changing the contract.
- `varietyAreaM2` is the area at read time. Area history needs the audit design in `variety-config-audit.md` (same pattern on the GrowLink side).

Errors: `401` (missing, invalid or revoked key, or missing scope), `400` (bad cursor, timestamp or limit), `429` (rate limit), `500` (never a partial page).

### `GET /api/integrations/croplink/v2/yield-week-deletions`

Same auth and keyset pagination over a new tombstone table:

```sql
create table public.integration_deletions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  entity text not null check (entity in ('yield_entry')),
  entity_id uuid not null,
  variety_id uuid, year integer, week integer,
  deleted_at timestamptz not null default now()
);
-- AFTER DELETE trigger on yield_entries inserts one row per deleted entry.
```

Item: `{ "yieldEntryId", "varietyId", "year", "week", "deletedAt" }`. Query: `deletedAfter`, `cursor`, `limit`.

### `GET /api/integrations/croplink/v2/yield-week-ids?year=`

Paginated list of **all** current `yieldEntryId`s plus `totalCount`. Used for a periodic full reconciliation that catches deletions made before the trigger existed, or missed by any path.

## CropLink changes

New migration (not applied):

- `growlink_yield_weeks` — one row per `yieldEntryId`: every v2 field, the raw payload `jsonb`, `settlement_status`, `settled_at`, `upstream_status` (`active` | `deleted_upstream` | `missing_upstream`), `upstream_status_changed_at`, `first_seen_at`, `last_seen_at`, `last_sync_run_id`. Unique index on `(growlink_yield_entry_id)`. This avoids the `organization_id IS NULL` uniqueness gap that the current table works around.
- `growlink_sync_runs` — one row per sync: started and finished times, cursors before and after, fetched/created/updated/unchanged/rejected counts, `rejected_records jsonb`, and the full-reconciliation result.
- `growlink_sync_state` — last `updatedAfter` and `deletedAfter` watermarks per endpoint.
- **No** public route reads these tables. `growlink_harvest_actuals` and its public GET stay as they are until a separate decision.

Sync (`POST /api/growlink/yield-weeks/sync-internal`, internal-ops auth):

1. Page `v2/yield-weeks?updatedAfter=<watermark>` until `hasMore = false`. Validate every item (ISO week for its year, non-negative numbers, `sizeKg` values, daily `packedDate`s inside the ISO week ± 7 days). Upsert valid rows using the existing `writeWithRowFallback`, so one bad row never blocks the batch. Record rejects on the run.
2. Advance the watermark only after every page has been written.
3. Page `v2/yield-week-deletions?deletedAfter=<watermark>`. Mark matching rows `upstream_status = 'deleted_upstream'`. **Never hard-delete**; deleted rows are excluded from totals, calibration and backtests, but kept for audit.
4. Weekly full reconciliation through `v2/yield-week-ids`. Only if the listing completes (`hasMore = false`, item count = `totalCount`): rows absent from it are marked `missing_upstream`, and only after **two consecutive** complete reconciliations agree. A sudden mass disappearance (more than 10% of rows) aborts the reconciliation and is reported instead of applied. Restoring a row upstream flips it back to `active`.
5. Forecast and backtest code reads `growlink_yield_weeks` where `upstream_status = 'active'`, uses `settlement_status = 'settled'` for calibration and scoring, and takes AFW from `averageFruitWeightG` (daily breakdown when complete).

## Required changes by repository

**growlink**

- Migration: `organization_integration_keys.scopes`; `integration_deletions` plus a delete trigger on `yield_entries`; `yield_entries.last_write_source`; an index on `yield_entries (organization_id, updated_at, id)`.
- `requireIntegrationKey(name, scope?)` scope check, plus tests (wrong scope gives 401; v1 is unaffected).
- `croplinkIntegration.ts`: the three v2 routes with keyset pagination and settlement computation, plus tests (pagination across exactly 500 / 501 / 1,000 / 1,001 rows, cursor stability under concurrent edits, settlement transitions, tombstones).
- Write paths set `last_write_source`.
- Admin integration-keys route: issue a key with scopes.
- v1 endpoint: add pagination too (it silently caps at 1,000 today), keeping its response shape.

**croplink**

- Migration: `growlink_yield_weeks`, `growlink_sync_runs`, `growlink_sync_state`.
- `lib/growlinkYieldSync.ts` (plan, validate, paginate, reconcile) plus tests, reusing `growlinkHarvestSync.ts` helpers.
- `routes/growlinkYieldWeeks.ts`: `POST /sync-internal` (internal-ops auth) and an internal-ops-auth `GET` for diagnostics.
- Railway: `GROWLINK_CROPLINK_KEY` secret; a cron entry like the existing ones, added only after separate approval.
- Forecast and backtest read AFW and settlement from the new table.

## Open questions

- Is `average_fruit_weight_g` filled for every FlowMaster import, or only some sources?
- Should the 10-day settlement rule become an explicit GrowLink "close week" action?
- Should CropLink's public GET routes get authentication in general? That is a pre-existing exposure, outside this design.
