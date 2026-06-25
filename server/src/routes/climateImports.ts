import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { climateImportAuth } from '../middleware/climateImportAuth';
import { chunkArray } from '../lib/chunkArray';

const router = Router();

// Supported metric_name values the agent should normalise to before posting:
//   ec                    mS/cm
//   ph                    (dimensionless)
//   temperature_c         °C
//   relative_humidity_pct %
//   co2_ppm               ppm
//   drain_water_pct       %
//   feed_water_volume_ml  ml
//   radiation_sum_j_cm2   J/cm²

interface Reading {
  zone_label: string;
  measured_at: string;
  metric_name: string;
  value?: number | null;
  unit?: string | null;
  source_file?: string | null;
}

// POST /api/v1/climate/imports
// Called by the external Climate Agent after it parses a Block Summary file.
// Body: { file_hash, filename, readings: [{ zone_label, measured_at, metric_name, value, unit?, source_file? }] }
// Returns:
//   201 { status: "created",   import_id, readings_stored }
//   200 { status: "duplicate", import_id }
router.post('/', climateImportAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { file_hash, filename, readings } = req.body as {
      file_hash?: string;
      filename?: string;
      readings?: Reading[];
    };

    if (!file_hash || typeof file_hash !== 'string') {
      return res.status(400).json({ error: 'file_hash is required' });
    }
    if (!Array.isArray(readings) || readings.length === 0) {
      return res.status(400).json({ error: 'readings array is required and must not be empty' });
    }
    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      if (!r.zone_label) {
        return res.status(400).json({ error: `readings[${i}]: zone_label is required` });
      }
      if (!r.measured_at) {
        return res.status(400).json({ error: `readings[${i}]: measured_at is required` });
      }
      if (!r.metric_name) {
        return res.status(400).json({ error: `readings[${i}]: metric_name is required` });
      }
    }

    const orgId = req.organization!.id;

    // Duplicate file check
    const { data: existing } = await supabase
      .from('climate_imports')
      .select('id')
      .eq('organization_id', orgId)
      .eq('file_hash', file_hash)
      .maybeSingle();

    if (existing) {
      return res.status(200).json({ status: 'duplicate', import_id: existing.id });
    }

    // Create the import record
    const { data: importRow, error: importError } = await supabase
      .from('climate_imports')
      .insert({
        organization_id: orgId,
        filename: filename ?? 'unknown',
        file_hash,
        readings_stored: 0,
      })
      .select('id')
      .single();

    if (importError || !importRow) {
      throw new Error(importError?.message ?? 'Failed to create climate_imports record');
    }

    // Insert readings — skip exact duplicates (same org + timestamp + zone + metric)
    const rows = readings.map(r => ({
      organization_id: orgId,
      import_id: importRow.id,
      zone_label: r.zone_label,
      measured_at: r.measured_at,
      metric_name: r.metric_name,
      value: r.value ?? null,
      unit: r.unit ?? null,
      source_file: r.source_file ?? null,
    }));

    let readingsStored = 0;
    for (const chunk of chunkArray(rows, 500)) {
      const { data, error } = await supabase
        .from('climate_readings')
        .upsert(chunk, {
          onConflict: 'organization_id,measured_at,zone_label,metric_name',
          ignoreDuplicates: true,
        })
        .select('id');
      if (error) throw new Error(error.message);
      readingsStored += (data ?? []).length;
    }

    // Patch the import row with the final count
    await supabase
      .from('climate_imports')
      .update({ readings_stored: readingsStored })
      .eq('id', importRow.id);

    return res.status(201).json({
      status: 'created',
      import_id: importRow.id,
      readings_stored: readingsStored,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
