# Mathieu data requests: GrowLink export, snapshot query, W38 checklist

Prepared 2026-10-04. Everything below is **read-only**. Each SQL block runs inside `begin transaction read only … rollback`, so even a mistyped statement cannot write.

Identifiers used:

| | |
|---|---|
| GrowLink Mathieu variety id | `f25660ec-4e2d-4654-9a4e-dd29d8b6fce5` (from CropLink `growlink_variety_links`) |
| CropLink Mathieu variety id | `207d1da5-e102-46ba-9740-c1998415870f` |
| ISO W28 – W40 2026 | Mon 2026-07-06 – Sun 2026-10-04 |
| Timezone | America/Toronto |

## 1. GrowLink export for Mathieu, W28–W40 (GrowLink Supabase, SQL editor)

Run each query and export the result as CSV with the file name shown. The filters select by **packing week** *or* **packed date**, so an entry that was filed under the wrong week still appears.

```sql
begin transaction read only;

-- 1a  yield_weeks.csv — one row per weekly entry
select ye.id                      as yield_entry_id,
       ye.organization_id,
       ye.variety_id,
       v.name                     as variety_name,
       ye.year                    as packing_year,
       ye.week                    as packing_week,
       ye.packed_date,
       ye.total_kg,
       ye.average_fruit_weight_g,
       ye.total_cases,
       ye.kg_per_m2,
       ye.size_kg,
       ye.created_at,
       ye.updated_at
from public.yield_entries ye
join public.varieties v on v.id = ye.variety_id
where ye.variety_id = 'f25660ec-4e2d-4654-9a4e-dd29d8b6fce5'
  and ((ye.year = 2026 and ye.week between 27 and 41)
       or ye.packed_date between date '2026-06-29' and date '2026-10-11')
order by ye.year, ye.week;

-- 1b  daily_breakdown.csv — every packing day behind those entries
select d.id as breakdown_id, d.yield_entry_id, ye.year as packing_year, ye.week as packing_week,
       d.packed_date, d.total_kg, d.average_fruit_weight_g, d.size_kg, d.created_at, d.updated_at
from public.yield_entry_daily_breakdown d
join public.yield_entries ye on ye.id = d.yield_entry_id
where ye.variety_id = 'f25660ec-4e2d-4654-9a4e-dd29d8b6fce5'
  and ((ye.year = 2026 and ye.week between 27 and 41)
       or d.packed_date between date '2026-06-29' and date '2026-10-11')
order by d.packed_date, d.id;

-- 1c  variety.csv — area as GrowLink holds it
select id, organization_id, name, color, status, area_m2, created_at, updated_at
from public.varieties
where id = 'f25660ec-4e2d-4654-9a4e-dd29d8b6fce5';

-- 1d  import_lots.csv — FlowMaster packline lots (PDF/CSV) behind the weeks
select r.id, r.lot_number, r.variety_id, r.iso_year, r.iso_week, r.start_time,
       r.source_filename, r.imported_at, r.csv_mapping_template_id, r.source_file_id
from public.yield_import_runs r
where r.variety_id = 'f25660ec-4e2d-4654-9a4e-dd29d8b6fce5'
  and ((r.iso_year = 2026 and r.iso_week between 27 and 41)
       or r.start_time between timestamptz '2026-06-29 00:00 America/Toronto' and timestamptz '2026-10-12 00:00 America/Toronto')
order by r.start_time nulls last, r.lot_number;

-- 1e  pending_imports.csv — lots parsed but never applied (possible missing kg)
select p.id, p.lot_number, p.variety_name, p.override_variety_id, p.iso_year, p.iso_week, p.start_time,
       p.parsed_total_kg, p.average_fruit_weight_g, p.size_kg, p.warnings, p.unknown_sizes,
       p.source_filename, p.source_type, p.data_source_type, p.needs_template, p.uploaded_at
from public.agent_pending_imports p
where (p.override_variety_id = 'f25660ec-4e2d-4654-9a4e-dd29d8b6fce5' or p.variety_name ilike '%mathieu%')
  and (p.iso_year = 2026 and p.iso_week between 27 and 41)
order by p.uploaded_at;

-- 1f  all_varieties_w36_w40.csv — context for Mathieu's share of each week
select v.name as variety_name, ye.year as packing_year, ye.week as packing_week, ye.packed_date,
       ye.total_kg, ye.average_fruit_weight_g, ye.updated_at
from public.yield_entries ye
join public.varieties v on v.id = ye.variety_id
where ye.organization_id = (select organization_id from public.varieties where id = 'f25660ec-4e2d-4654-9a4e-dd29d8b6fce5')
  and ye.year = 2026 and ye.week between 36 and 40
order by ye.week, v.name;

rollback;
```

What each file answers: weekly and daily AFW (1a, 1b), whether W38 kg is missing or filed under another week (1a, 1b, 1d, 1e), the area GrowLink uses for kg/m² (1c), and whether the W38 dip is Mathieu-only (1f).

## 2. Projection snapshots around 2026-09-19 (CropLink Supabase, SQL editor)

```sql
begin transaction read only;

-- 2a  Did the daily snapshot job run either side of the change?
select date_trunc('day', effective_at at time zone 'America/Toronto') as day, count(*) as snapshots
from public.projection_snapshots
where variety_id = '207d1da5-e102-46ba-9740-c1998415870f'
  and effective_at >= timestamptz '2026-09-12 00:00 America/Toronto'
  and effective_at <  timestamptz '2026-09-27 00:00 America/Toronto'
group by 1 order by 1;

-- 2b  The last snapshot before and the first after 2026-09-19 21:36 UTC
(select 'before' as side, id, snapshot_run_id, effective_at, created_at, calculation_version, total_kg,
        afw_source, timing_curve_source, survival_factor_source,
        projected_kg_by_week, afw_by_week, cohort_counts, timing_curve, survival_factor
   from public.projection_snapshots
  where variety_id = '207d1da5-e102-46ba-9740-c1998415870f' and effective_at < timestamptz '2026-09-19 21:36:18+00'
  order by effective_at desc limit 1)
union all
(select 'after', id, snapshot_run_id, effective_at, created_at, calculation_version, total_kg,
        afw_source, timing_curve_source, survival_factor_source,
        projected_kg_by_week, afw_by_week, cohort_counts, timing_curve, survival_factor
   from public.projection_snapshots
  where variety_id = '207d1da5-e102-46ba-9740-c1998415870f' and effective_at >= timestamptz '2026-09-19 21:36:18+00'
  order by effective_at asc limit 1);

-- 2c  Week-by-week kg in both snapshots (harvest weeks present in either)
with pick as (
  (select 'before' side, projected_kg_by_week, afw_by_week from public.projection_snapshots
    where variety_id = '207d1da5-e102-46ba-9740-c1998415870f' and effective_at < timestamptz '2026-09-19 21:36:18+00'
    order by effective_at desc limit 1)
  union all
  (select 'after', projected_kg_by_week, afw_by_week from public.projection_snapshots
    where variety_id = '207d1da5-e102-46ba-9740-c1998415870f' and effective_at >= timestamptz '2026-09-19 21:36:18+00'
    order by effective_at asc limit 1)
)
select side, k.key as harvest_week, k.value as projected_kg, afw_by_week -> k.key as afw
from pick, jsonb_each(projected_kg_by_week) k
order by k.key::int, side;

rollback;
```

How to read it: if the inputs other than area are unchanged between the two snapshots (same `cohort_counts`, `timing_curve`, `survival_factor` and AFW for a week), then `projected_kg_after / projected_kg_before` for that week equals `area_after / area_before`. Today's area is 11,627 m², so `area_before = 11,627 × before / after`. If the cohort or curve inputs also changed, area can't be isolated this way. Stem count can't be recovered from snapshots under any circumstances. If 2a shows no snapshots on those days, check whether the Supabase project has point-in-time recovery covering 2026-09-19. A restore must go to a **separate** project, never over production.

## 3. W38 investigation checklist (GrowLink and FlowMaster)

Context: Mathieu's GrowLink W38 total is 2,777 kg, 5.1% of all varieties that week, against a typical 18.4%. That is about **7,300 kg short**. Packed date 2026-09-18 (Fri), last edited 2026-09-22. W37 (13,738) and W39 (9,860) look normal, and every other variety's W38 looks normal.

GrowLink
- [ ] In 1b, list the W38 daily rows. How many packing days were there? A normal week has several; one day suggests the other days are missing or filed elsewhere.
- [ ] In 1a and 1b, look for any Mathieu rows with `packed_date` between 2026-09-14 and 09-20 filed under **W37 or W39**. Their kg would show up as an excess there.
- [ ] In 1e, look for Mathieu lots from W38 still sitting in `agent_pending_imports` (parsed but never approved), and for lots with `variety_name` misspelled or unmatched.
- [ ] In 1d, compare the lot numbers and `start_time`s for W38 with the FlowMaster lot list for 2026-09-14 to 09-20. Any lot missing from `yield_import_runs` was never imported.
- [ ] Check whether any W38 Mathieu lot was imported under **another variety**. Compare 1f's other-variety W38 totals with their W37/W39 levels.
- [ ] Look at `updated_at` 2026-09-22 21:30 UTC, which is after the week ended. Was the W38 entry edited by hand, collapsing its daily breakdown? After the v2 migration, `last_write_source` and `yield_entry_revisions` answer this directly. Before it, ask whoever edited Kg Entries that day.
- [ ] Confirm the W38 `average_fruit_weight_g` and `total_cases` are plausible against neighbouring weeks. A unit or size-mapping error would show here.

FlowMaster
- [ ] Export the packline lot report for Mathieu, 2026-09-14 to 2026-09-20 (lot number, start time, kg by size, AFW, cases).
- [ ] Reconcile the FlowMaster total with GrowLink's W38 total. If FlowMaster shows about 10 t, the shortfall is in import or entry; if it also shows about 2.8 t, it's real, or the harvest was packed under another week or variety.
- [ ] Check for lots where the variety was set wrong at the packline, and for lots that straddle the W38/W39 boundary.

Harvest records (if available)
- [ ] Compare the harvest crew's picking log for Mathieu that week. CropLink's tracked stems recorded 97 harvested fruit in the W38 survey, a normal-to-high week.

Outcome to record: the corrected W38 kg (if any), its source, and whether W32/W33 (32.8% / 7.3% share) show the same misfiling pattern.
