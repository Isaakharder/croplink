-- ISO years have 52 or 53 weeks (53 when Dec 28 falls in week 53 — e.g.
-- 2026, 2032). Every week column in this schema was created with
-- CHECK (week_number <= 52), so the first W53 status, harvest entry, AFW
-- row, timing profile, or GrowLink actual (2026-W53 starts Mon Dec 28)
-- would be rejected by the database. Replace those checks with one that
-- validates against the row's own ISO year.

create or replace function iso_weeks_in_year(y integer)
returns integer
language sql
immutable
strict
as $$
  select extract(week from make_date(y, 12, 28))::integer
$$;

-- Drop the existing "<= 52" checks by definition rather than by name, so
-- this works regardless of how Postgres auto-named the inline constraints.
do $$
declare
  r record;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname
    from pg_constraint c
    where c.contype = 'c'
      and c.conrelid in (
        'weekly_node_statuses'::regclass,
        'fruit_weight_by_week'::regclass,
        'harvest_timing_profiles'::regclass,
        'harvested_entries'::regclass,
        'harvest_afw_by_week'::regclass,
        'growlink_harvest_actuals'::regclass
      )
      and pg_get_constraintdef(c.oid) ~ 'week_number <= 52'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

alter table weekly_node_statuses
  add constraint weekly_node_statuses_iso_week_check
  check (week_number >= 1 and week_number <= iso_weeks_in_year(year));

alter table fruit_weight_by_week
  add constraint fruit_weight_by_week_iso_week_check
  check (week_number >= 1 and week_number <= iso_weeks_in_year(year));

alter table harvest_timing_profiles
  add constraint harvest_timing_profiles_iso_week_check
  check (set_week_number >= 1 and set_week_number <= iso_weeks_in_year(year));

alter table harvested_entries
  add constraint harvested_entries_iso_week_check
  check (week_number >= 1 and week_number <= iso_weeks_in_year(year));

alter table harvest_afw_by_week
  add constraint harvest_afw_by_week_iso_week_check
  check (week_number >= 1 and week_number <= iso_weeks_in_year(year));

alter table growlink_harvest_actuals
  add constraint growlink_harvest_actuals_iso_week_check
  check (week_number >= 1 and week_number <= iso_weeks_in_year(year));
