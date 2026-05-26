-- Track lifecycle of each fruit from SetFruit through Harvest
CREATE TABLE IF NOT EXISTS fruit_instances (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid,
  variety_id            uuid        NOT NULL REFERENCES varieties(id)          ON DELETE CASCADE,
  measurement_row_id    uuid        NOT NULL REFERENCES measurement_rows(id)   ON DELETE CASCADE,
  measurement_stem_id   uuid        NOT NULL REFERENCES measurement_stems(id)  ON DELETE CASCADE,
  plant_node_id         uuid        NOT NULL REFERENCES plant_nodes(id)        ON DELETE CASCADE,

  -- Set event
  set_year              integer     NOT NULL,
  set_week_number       integer     NOT NULL,
  set_date              date        NOT NULL DEFAULT CURRENT_DATE,
  set_status_id         uuid                 REFERENCES weekly_node_statuses(id),

  -- Harvest event (populated when harvested)
  harvested_year        integer,
  harvested_week_number integer,
  harvested_date        date,
  harvest_status_id     uuid                 REFERENCES weekly_node_statuses(id),

  -- Lifecycle status: set | harvested | aborted | pruned
  status                text        NOT NULL DEFAULT 'set',

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- One fruit instance per node per set-week (prevents duplicates on re-recording)
  UNIQUE (plant_node_id, set_year, set_week_number)
);

-- Efficient lookups for ripening-actuals calculations
CREATE INDEX IF NOT EXISTS idx_fruit_instances_variety_set
  ON fruit_instances (variety_id, set_year, set_week_number);

CREATE INDEX IF NOT EXISTS idx_fruit_instances_variety_harvested
  ON fruit_instances (variety_id, harvested_year, harvested_week_number);

CREATE INDEX IF NOT EXISTS idx_fruit_instances_plant_node
  ON fruit_instances (plant_node_id);

CREATE INDEX IF NOT EXISTS idx_fruit_instances_stem
  ON fruit_instances (measurement_stem_id);

CREATE INDEX IF NOT EXISTS idx_fruit_instances_row
  ON fruit_instances (measurement_row_id);
