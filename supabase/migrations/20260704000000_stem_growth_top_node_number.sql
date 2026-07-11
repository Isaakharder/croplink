-- Records which main-stem node was the highest active node when a weekly
-- Veg growth reading was taken, so growth_cm can be positioned against the
-- plant stem's node numbering on the Row Canvas. Existing rows are left
-- null intentionally — there is no reliable way to derive their historical
-- top node from current node counts.
alter table stem_growth_measurements
  add column if not exists top_node_number integer null;
