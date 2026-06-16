-- Case weight (kg per case) used to convert projected kg into expected case counts.

alter table varieties
  add column if not exists case_kg numeric;
