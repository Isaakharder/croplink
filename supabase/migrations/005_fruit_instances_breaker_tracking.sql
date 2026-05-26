-- Add breaker-fruit tracking columns to fruit_instances

ALTER TABLE fruit_instances
  ADD COLUMN IF NOT EXISTS breaker_year         integer,
  ADD COLUMN IF NOT EXISTS breaker_week_number  integer,
  ADD COLUMN IF NOT EXISTS breaker_date         date,
  ADD COLUMN IF NOT EXISTS breaker_status_id    uuid REFERENCES weekly_node_statuses(id);
