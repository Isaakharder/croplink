-- Add side-shoot support columns to plant_nodes

ALTER TABLE plant_nodes
  ADD COLUMN IF NOT EXISTS node_label text;

ALTER TABLE plant_nodes
  ADD COLUMN IF NOT EXISTS parent_node_id uuid REFERENCES plant_nodes(id);

ALTER TABLE plant_nodes
  ADD COLUMN IF NOT EXISTS side text;

ALTER TABLE plant_nodes
  ADD COLUMN IF NOT EXISTS is_side_shoot boolean NOT NULL DEFAULT false;
