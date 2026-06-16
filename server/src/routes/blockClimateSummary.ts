import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { climateAgentAuth } from '../middleware/climateAgentAuth';
import { chunkArray } from '../lib/chunkArray';

const router = Router();

interface IngestReading {
  blockKey: string;
  organizationId?: string | null;
  measuredAt: string;
  airTemperatureC?: number | null;
  relativeHumidityPct?: number | null;
  heatingSetpointC?: number | null;
}

// POST /block-summary/ingest  (Climate Agent only — requires X-Climate-Agent-Key)
router.post('/ingest', climateAgentAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const readings = req.body?.readings as IngestReading[] | undefined;
    if (!Array.isArray(readings) || readings.length === 0) {
      return res.status(400).json({ error: 'readings array is required' });
    }
    for (const r of readings) {
      if (!r.blockKey || !r.measuredAt) {
        return res.status(400).json({ error: 'Each reading requires blockKey and measuredAt' });
      }
    }

    // Auto-create any blocks the agent hasn't reported before. name mirrors the
    // agent's block key until blocks get an editable label in the UI.
    const blockKeys = Array.from(new Set(readings.map(r => r.blockKey)));
    const blockSeed = blockKeys.map(key => ({
      climate_agent_block_key: key,
      name: key,
      organization_id: readings.find(r => r.blockKey === key)?.organizationId ?? null,
      updated_at: new Date().toISOString(),
    }));
    const { data: blocks, error: blocksError } = await supabase
      .from('blocks')
      .upsert(blockSeed, { onConflict: 'climate_agent_block_key' })
      .select('id, climate_agent_block_key');
    if (blocksError) throw new Error(blocksError.message);

    const blockIdByKey = new Map((blocks ?? []).map(b => [b.climate_agent_block_key, b.id]));

    const rows = readings.map(r => ({
      block_id: blockIdByKey.get(r.blockKey),
      organization_id: r.organizationId ?? null,
      measured_at: r.measuredAt,
      air_temperature_c: r.airTemperatureC ?? null,
      relative_humidity_pct: r.relativeHumidityPct ?? null,
      heating_setpoint_c: r.heatingSetpointC ?? null,
      updated_at: new Date().toISOString(),
    }));

    const results: unknown[] = [];
    for (const chunk of chunkArray(rows, 500)) {
      const { data, error } = await supabase
        .from('block_climate_summaries')
        .upsert(chunk, { onConflict: 'block_id,measured_at' })
        .select();
      if (error) throw new Error(error.message);
      results.push(...(data ?? []));
    }

    res.status(201).json({ inserted: results.length, records: results });
  } catch (e) {
    next(e);
  }
});

// GET /block-summary?blockId=&start=&end=  (ISO timestamps, both optional)
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { blockId, start, end } = req.query;
    if (!blockId) {
      return res.status(400).json({ error: 'blockId is required' });
    }
    let query = supabase
      .from('block_climate_summaries')
      .select('*')
      .eq('block_id', blockId as string)
      .order('measured_at', { ascending: true });
    if (start) query = query.gte('measured_at', start as string);
    if (end) query = query.lte('measured_at', end as string);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

export default router;
