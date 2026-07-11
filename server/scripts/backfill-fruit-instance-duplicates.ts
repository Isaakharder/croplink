/**
 * One-off backfill: merges duplicate fruit_instances rows created by the
 * pre-fix handleSetFruit(), which created a new row every week a node was
 * re-recorded as SetFruit instead of only on the first observation.
 *
 * A node can only have one *open* (status='set') cycle at a time, so any
 * consecutive run of 'set' rows for the same node — optionally followed by
 * exactly one resolving row (harvested/aborted/pruned) — belongs to a single
 * true fruit instance. This script merges each such run into its earliest
 * row (the true original set week) and deletes the rest, carrying over any
 * breaker/harvest fields found on the later duplicates.
 *
 * Run with:
 *   npx tsx scripts/backfill-fruit-instance-duplicates.ts            (dry run)
 *   npx tsx scripts/backfill-fruit-instance-duplicates.ts --apply    (writes)
 */
import { supabase } from '../src/lib/supabase';

type Row = {
  id: string;
  plant_node_id: string;
  set_year: number;
  set_week_number: number;
  status: string;
  harvested_year: number | null;
  harvested_week_number: number | null;
  harvested_date: string | null;
  harvest_status_id: string | null;
  breaker_year: number | null;
  breaker_week_number: number | null;
  breaker_date: string | null;
  breaker_status_id: string | null;
};

type Cycle = { rows: Row[] };

function buildCycles(rowsForNode: Row[]): Cycle[] {
  const sorted = [...rowsForNode].sort((a, b) =>
    a.set_year !== b.set_year ? a.set_year - b.set_year : a.set_week_number - b.set_week_number
  );

  const cycles: Cycle[] = [];
  let current: Row[] = [];

  for (const row of sorted) {
    current.push(row);
    if (row.status !== 'set') {
      cycles.push({ rows: current });
      current = [];
    }
  }
  if (current.length > 0) cycles.push({ rows: current });

  return cycles;
}

async function main() {
  const apply = process.argv.includes('--apply');

  const { data: allRows, error } = await supabase
    .from('fruit_instances')
    .select(
      'id, plant_node_id, set_year, set_week_number, status, harvested_year, harvested_week_number, harvested_date, harvest_status_id, breaker_year, breaker_week_number, breaker_date, breaker_status_id'
    );
  if (error) throw new Error(error.message);

  const byNode = new Map<string, Row[]>();
  for (const row of (allRows ?? []) as Row[]) {
    if (!byNode.has(row.plant_node_id)) byNode.set(row.plant_node_id, []);
    byNode.get(row.plant_node_id)!.push(row);
  }

  let nodesAffected = 0;
  let rowsToDelete = 0;
  const plan: { canonical: Row; update: Partial<Row>; deleteIds: string[] }[] = [];

  for (const [, nodeRows] of byNode) {
    const cycles = buildCycles(nodeRows);
    for (const cycle of cycles) {
      if (cycle.rows.length <= 1) continue;

      const [canonical, ...rest] = cycle.rows;
      const last = cycle.rows[cycle.rows.length - 1];

      const breakerSource = cycle.rows.find((r) => r.breaker_week_number != null);
      const update: Partial<Row> = {};

      if (last.status !== 'set') {
        update.status = last.status;
        update.harvested_year = last.harvested_year;
        update.harvested_week_number = last.harvested_week_number;
        update.harvested_date = last.harvested_date;
        update.harvest_status_id = last.harvest_status_id;
      }
      if (breakerSource) {
        update.breaker_year = breakerSource.breaker_year;
        update.breaker_week_number = breakerSource.breaker_week_number;
        update.breaker_date = breakerSource.breaker_date;
        update.breaker_status_id = breakerSource.breaker_status_id;
      }

      plan.push({ canonical, update, deleteIds: rest.map((r) => r.id) });
      nodesAffected++;
      rowsToDelete += rest.length;
    }
  }

  console.log(`Nodes with duplicate cycles to merge: ${nodesAffected}`);
  console.log(`Rows that will be deleted: ${rowsToDelete}`);
  console.log(`Total fruit_instances rows before: ${(allRows ?? []).length}`);
  console.log(`Total fruit_instances rows after:  ${(allRows ?? []).length - rowsToDelete}`);

  console.log('\nSample of first 5 merge operations:');
  for (const p of plan.slice(0, 5)) {
    console.log({
      canonicalId: p.canonical.id,
      canonicalSetWeek: `${p.canonical.set_year}-W${p.canonical.set_week_number}`,
      update: p.update,
      deletedIds: p.deleteIds,
    });
  }

  if (!apply) {
    console.log('\nDry run only — no changes written. Re-run with --apply to execute.');
    return;
  }

  console.log('\nApplying changes...');
  let done = 0;
  for (const p of plan) {
    if (Object.keys(p.update).length > 0) {
      const { error: updErr } = await supabase
        .from('fruit_instances')
        .update({ ...p.update, updated_at: new Date().toISOString() })
        .eq('id', p.canonical.id);
      if (updErr) {
        console.error(`Failed to update ${p.canonical.id}:`, updErr.message);
        continue;
      }
    }
    if (p.deleteIds.length > 0) {
      const { error: delErr } = await supabase.from('fruit_instances').delete().in('id', p.deleteIds);
      if (delErr) {
        console.error(`Failed to delete duplicates for ${p.canonical.id}:`, delErr.message);
        continue;
      }
    }
    done++;
  }
  console.log(`Done. ${done}/${plan.length} merges applied.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
