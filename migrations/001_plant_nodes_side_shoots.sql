-- Add side-shoot support to plant_nodes
ALTER TABLE plant_nodes
  ADD COLUMN IF NOT EXISTS node_label     text,
  ADD COLUMN IF NOT EXISTS parent_node_id uuid REFERENCES plant_nodes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS side           text,
  ADD COLUMN IF NOT EXISTS is_side_shoot  boolean NOT NULL DEFAULT false;
