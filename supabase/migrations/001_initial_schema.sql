-- GrowLink Projection - Initial Schema
-- Run this in your Supabase SQL editor or via supabase CLI migrations

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- SEASONS
-- ============================================================
CREATE TABLE seasons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID,  -- TODO: add RLS policies once org auth is implemented
  name TEXT NOT NULL,
  year INTEGER NOT NULL,
  plant_date DATE,
  pull_out_date DATE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_seasons_org_year ON seasons (organization_id, year);

-- ============================================================
-- VARIETIES
-- ============================================================
CREATE TABLE varieties (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID,
  season_id UUID NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  area_m2 NUMERIC,
  plant_count INTEGER,
  total_stem_count INTEGER,
  average_fruit_weight_grams NUMERIC,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_varieties_org_season ON varieties (organization_id, season_id, name);

-- ============================================================
-- MEASUREMENT ROWS
-- ============================================================
CREATE TABLE measurement_rows (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID,
  variety_id UUID NOT NULL REFERENCES varieties(id) ON DELETE CASCADE,
  row_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_measurement_rows_org_variety ON measurement_rows (organization_id, variety_id);

-- ============================================================
-- MEASUREMENT STEMS
-- ============================================================
CREATE TABLE measurement_stems (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID,
  measurement_row_id UUID NOT NULL REFERENCES measurement_rows(id) ON DELETE CASCADE,
  stem_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_measurement_stems_org_row ON measurement_stems (organization_id, measurement_row_id);

-- ============================================================
-- PLANT NODES
-- ============================================================
CREATE TABLE plant_nodes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID,
  measurement_stem_id UUID NOT NULL REFERENCES measurement_stems(id) ON DELETE CASCADE,
  node_number INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_plant_nodes_org_stem ON plant_nodes (organization_id, measurement_stem_id);

-- ============================================================
-- WEEKLY NODE STATUSES
-- ============================================================
CREATE TABLE weekly_node_statuses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID,
  plant_node_id UUID NOT NULL REFERENCES plant_nodes(id) ON DELETE CASCADE,
  season_id UUID REFERENCES seasons(id),
  year INTEGER NOT NULL,
  week_number INTEGER NOT NULL CHECK (week_number >= 1 AND week_number <= 52),
  status TEXT NOT NULL,
  notes TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plant_node_id, year, week_number)
);

CREATE INDEX idx_weekly_node_statuses_node_week ON weekly_node_statuses (plant_node_id, year, week_number);

-- ============================================================
-- FRUIT WEIGHT BY WEEK
-- ============================================================
CREATE TABLE fruit_weight_by_week (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID,
  variety_id UUID NOT NULL REFERENCES varieties(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  week_number INTEGER NOT NULL CHECK (week_number >= 1 AND week_number <= 52),
  weight_grams NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (variety_id, year, week_number)
);

CREATE INDEX idx_fruit_weight_variety_year ON fruit_weight_by_week (variety_id, year, week_number);

-- ============================================================
-- HARVEST TIMING PROFILES
-- ============================================================
CREATE TABLE harvest_timing_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID,
  variety_id UUID NOT NULL REFERENCES varieties(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  set_week_number INTEGER NOT NULL CHECK (set_week_number >= 1 AND set_week_number <= 52),
  avg_fruit_set NUMERIC NOT NULL DEFAULT 0,
  week1_percent NUMERIC NOT NULL DEFAULT 0,
  week2_percent NUMERIC NOT NULL DEFAULT 0,
  week3_percent NUMERIC NOT NULL DEFAULT 0,
  week4_percent NUMERIC NOT NULL DEFAULT 0,
  week5_percent NUMERIC NOT NULL DEFAULT 0,
  week6_percent NUMERIC NOT NULL DEFAULT 0,
  week7_percent NUMERIC NOT NULL DEFAULT 0,
  week8_percent NUMERIC NOT NULL DEFAULT 0,
  week9_percent NUMERIC NOT NULL DEFAULT 0,
  week10_percent NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (variety_id, year, set_week_number)
);

CREATE INDEX idx_harvest_timing_variety_year ON harvest_timing_profiles (variety_id, year, set_week_number);

-- ============================================================
-- HARVESTED ENTRIES
-- ============================================================
CREATE TABLE harvested_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID,
  variety_id UUID NOT NULL REFERENCES varieties(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  week_number INTEGER NOT NULL CHECK (week_number >= 1 AND week_number <= 52),
  kg NUMERIC NOT NULL CHECK (kg >= 0),
  cases NUMERIC,
  case_weight_kg NUMERIC,
  harvest_date DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_harvested_entries_variety_year ON harvested_entries (variety_id, year, week_number);

-- ============================================================
-- DASHBOARD SETTINGS
-- ============================================================
CREATE TABLE dashboard_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID,
  setting_key TEXT NOT NULL,
  setting_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- UPDATED_AT TRIGGER FUNCTION
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to all tables with updated_at
CREATE TRIGGER update_seasons_updated_at BEFORE UPDATE ON seasons FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_varieties_updated_at BEFORE UPDATE ON varieties FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_measurement_rows_updated_at BEFORE UPDATE ON measurement_rows FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_measurement_stems_updated_at BEFORE UPDATE ON measurement_stems FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_plant_nodes_updated_at BEFORE UPDATE ON plant_nodes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_weekly_node_statuses_updated_at BEFORE UPDATE ON weekly_node_statuses FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_fruit_weight_by_week_updated_at BEFORE UPDATE ON fruit_weight_by_week FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_harvest_timing_profiles_updated_at BEFORE UPDATE ON harvest_timing_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_harvested_entries_updated_at BEFORE UPDATE ON harvested_entries FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_dashboard_settings_updated_at BEFORE UPDATE ON dashboard_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- RLS NOTES
-- TODO: Once org/auth system is implemented, enable RLS:
--   ALTER TABLE seasons ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY "org_isolation" ON seasons
--     USING (organization_id = current_setting('app.organization_id')::uuid);
-- Repeat for all tables.
-- ============================================================
