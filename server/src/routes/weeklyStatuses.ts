import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

// GET /weekly-statuses?stemId=&year=&weekNumber=
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { stemId, year, weekNumber } = req.query;
    if (!stemId) {
      return res.status(400).json({ error: 'stemId is required' });
    }

    const { data: nodes, error: nodesError } = await supabase
      .from('plant_nodes')
      .select('id')
      .eq('measurement_stem_id', stemId as string);
    if (nodesError) throw new Error(nodesError.message);

    if (!nodes || nodes.length === 0) {
      return res.json([]);
    }

    const nodeIds = nodes.map((n) => n.id);

    let query = supabase
      .from('weekly_node_statuses')
      .select('*')
      .in('plant_node_id', nodeIds);

    if (year) query = query.eq('year', Number(year));
    if (weekNumber) query = query.eq('week_number', Number(weekNumber));

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

// POST /weekly-statuses/upsert
router.post('/upsert', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { plantNodeId, seasonId, year, weekNumber, status, notes, organization_id } = req.body;
    if (!plantNodeId || !year || !weekNumber) {
      return res.status(400).json({ error: 'plantNodeId, year, and weekNumber are required' });
    }
    if (weekNumber < 1 || weekNumber > 53) {
      return res.status(400).json({ error: 'weekNumber must be between 1 and 53' });
    }

    // Save the weekly node status (existing behaviour, unchanged)
    const { data, error } = await supabase
      .from('weekly_node_statuses')
      .upsert(
        {
          plant_node_id: plantNodeId,
          season_id: seasonId,
          year,
          week_number: weekNumber,
          status,
          notes,
          organization_id,
          recorded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'plant_node_id,year,week_number' }
      )
      .select()
      .single();
    if (error) throw new Error(error.message);

    // Sync fruit_instances based on the new status (non-fatal — never blocks the response)
    let fruitInstanceWarning: string | undefined;
    try {
      fruitInstanceWarning = await syncFruitInstance({
        weeklyStatusId: data.id,
        plantNodeId,
        year,
        weekNumber,
        status,
        organizationId: organization_id ?? null,
      });
    } catch (e) {
      console.error('[fruit_instances] sync error:', e instanceof Error ? e.message : e);
    }

    if (fruitInstanceWarning) {
      return res.json({ ...data, _fruitInstanceWarning: fruitInstanceWarning });
    }
    res.json(data);
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Fruit instance lifecycle sync
// ---------------------------------------------------------------------------

interface SyncArgs {
  weeklyStatusId: string;
  plantNodeId: string;
  year: number;
  weekNumber: number;
  status: string;
  organizationId: string | null;
}

async function syncFruitInstance(args: SyncArgs): Promise<string | undefined> {
  const { weeklyStatusId, plantNodeId, year, weekNumber, status, organizationId } = args;

  if (status === 'SetFruit') {
    return handleSetFruit({ weeklyStatusId, plantNodeId, year, weekNumber, organizationId });
  }
  if (status === 'BreakerFruit') {
    await handleBreaker({ weeklyStatusId, plantNodeId, year, weekNumber });
    return undefined;
  }
  if (status === 'Harvested') {
    return handleHarvested({ weeklyStatusId, plantNodeId, year, weekNumber });
  }
  if (status === 'Aborted' || status === 'Pruned') {
    await handleTerminated({ plantNodeId, status });
  }
  return undefined;
}

// Look up variety_id / row_id / stem_id for a plant node (single join query)
async function resolveNodeHierarchy(plantNodeId: string) {
  const { data, error } = await supabase
    .from('plant_nodes')
    .select(`
      id,
      organization_id,
      measurement_stem_id,
      measurement_stems (
        id,
        measurement_row_id,
        measurement_rows (
          id,
          variety_id
        )
      )
    `)
    .eq('id', plantNodeId)
    .single();
  if (error || !data) throw new Error(`Node ${plantNodeId} not found`);

  const stem = Array.isArray(data.measurement_stems)
    ? data.measurement_stems[0]
    : data.measurement_stems;
  const row = Array.isArray(stem?.measurement_rows)
    ? stem.measurement_rows[0]
    : stem?.measurement_rows;

  if (!stem || !row) throw new Error(`Hierarchy incomplete for node ${plantNodeId}`);

  return {
    nodeOrgId: (data as { organization_id?: string | null }).organization_id ?? null,
    stemId: stem.id as string,
    rowId: row.id as string,
    varietyId: (row as { variety_id: string }).variety_id,
  };
}

async function handleSetFruit(args: {
  weeklyStatusId: string;
  plantNodeId: string;
  year: number;
  weekNumber: number;
  organizationId: string | null;
}): Promise<undefined> {
  const { weeklyStatusId, plantNodeId, year, weekNumber, organizationId } = args;
  const { nodeOrgId, stemId, rowId, varietyId } = await resolveNodeHierarchy(plantNodeId);

  const today = new Date().toISOString().slice(0, 10);

  // Check for existing instance (unique constraint: plant_node_id + set_year + set_week_number)
  const { data: existing } = await supabase
    .from('fruit_instances')
    .select('id')
    .eq('plant_node_id', plantNodeId)
    .eq('set_year', year)
    .eq('set_week_number', weekNumber)
    .maybeSingle();

  if (existing) {
    // Update the status link in case it was re-recorded
    await supabase
      .from('fruit_instances')
      .update({ set_status_id: weeklyStatusId, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
  } else {
    await supabase.from('fruit_instances').insert({
      organization_id: nodeOrgId ?? organizationId,
      variety_id: varietyId,
      measurement_row_id: rowId,
      measurement_stem_id: stemId,
      plant_node_id: plantNodeId,
      set_year: year,
      set_week_number: weekNumber,
      set_date: today,
      set_status_id: weeklyStatusId,
      status: 'set',
    });
  }
  return undefined;
}

async function handleHarvested(args: {
  weeklyStatusId: string;
  plantNodeId: string;
  year: number;
  weekNumber: number;
}): Promise<string | undefined> {
  const { weeklyStatusId, plantNodeId, year, weekNumber } = args;

  // Find the most recent open (set) fruit instance for this node
  const { data: instances } = await supabase
    .from('fruit_instances')
    .select('id')
    .eq('plant_node_id', plantNodeId)
    .eq('status', 'set')
    .order('set_year', { ascending: false })
    .order('set_week_number', { ascending: false })
    .limit(1);

  if (!instances || instances.length === 0) {
    return 'No SetFruit instance found for this node — harvest recorded but not linked to a set event.';
  }

  const today = new Date().toISOString().slice(0, 10);
  await supabase
    .from('fruit_instances')
    .update({
      harvested_year: year,
      harvested_week_number: weekNumber,
      harvested_date: today,
      harvest_status_id: weeklyStatusId,
      status: 'harvested',
      updated_at: new Date().toISOString(),
    })
    .eq('id', instances[0].id);

  return undefined;
}

async function handleBreaker(args: {
  weeklyStatusId: string;
  plantNodeId: string;
  year: number;
  weekNumber: number;
}): Promise<void> {
  const { weeklyStatusId, plantNodeId, year, weekNumber } = args;

  // Find the most recent open fruit_instance for this node
  const { data: instances } = await supabase
    .from('fruit_instances')
    .select('id, breaker_week_number')
    .eq('plant_node_id', plantNodeId)
    .eq('status', 'set')
    .order('set_year', { ascending: false })
    .order('set_week_number', { ascending: false })
    .limit(1);

  if (!instances || instances.length === 0) return;

  const inst = instances[0] as { id: string; breaker_week_number: number | null };

  // Only record the FIRST breaker observation — don't overwrite if already set
  if (inst.breaker_week_number != null) return;

  const today = new Date().toISOString().slice(0, 10);
  await supabase
    .from('fruit_instances')
    .update({
      breaker_year: year,
      breaker_week_number: weekNumber,
      breaker_date: today,
      breaker_status_id: weeklyStatusId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', inst.id);
}

async function handleTerminated(args: {
  plantNodeId: string;
  status: string;
}): Promise<void> {
  const { plantNodeId, status } = args;

  const { data: instances } = await supabase
    .from('fruit_instances')
    .select('id')
    .eq('plant_node_id', plantNodeId)
    .eq('status', 'set')
    .order('set_year', { ascending: false })
    .order('set_week_number', { ascending: false })
    .limit(1);

  if (instances && instances.length > 0) {
    await supabase
      .from('fruit_instances')
      .update({ status: status.toLowerCase(), updated_at: new Date().toISOString() })
      .eq('id', instances[0].id);
  }
}

export default router;
