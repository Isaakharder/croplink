-- Add variety-level season dates without dropping the original season columns.

alter table varieties
  add column if not exists plant_date date,
  add column if not exists pull_out_date date;

update varieties v
set
  plant_date = coalesce(v.plant_date, s.plant_date),
  pull_out_date = coalesce(v.pull_out_date, s.pull_out_date)
from seasons s
where v.season_id = s.id
  and (v.plant_date is null or v.pull_out_date is null);