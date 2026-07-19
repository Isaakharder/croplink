/**
 * One-off backfill: recomputes ph_avg / ph_zone_count on every existing
 * variety_climate_hourly row, now that a raw pH reading of exactly 0 is
 * treated as a missing/sentinel value (see SENTINEL_ZERO_METRICS in
 * server/src/lib/climateAveraging.ts) instead of being averaged in as a real
 * measurement. Only touches pH — EC was investigated for the same pattern
 * and found not to have it, so it's left untouched.
 *
 * Recomputes ph_avg/ph_zone_count directly from the raw climate_readings
 * backing each row (same zone-link + averaging rule as
 * computeVarietyHourlyRow), and updates the pH line within
 * quality_warnings to match. Every other field on the row (temperature,
 * humidity, CO2, EC, radiation, irrigation) is left untouched.
 *
 * Idempotent: recomputes from source every time, so re-running (even
 * repeatedly, even with --apply) converges to the same result and a
 * second run reports zero rows changed.
 *
 * Run with:
 *   npx tsx scripts/backfill-ph-sentinel-zeros.ts            (dry run)
 *   npx tsx scripts/backfill-ph-sentinel-zeros.ts --apply    (writes)
 */
import { supabase } from '../src/lib/supabase';
import { averageValid } from '../src/lib/climateAveraging';

interface VarietyHourlyRow {
  id: string;
  variety_id: string;
  measured_at: string;
  ph_avg: number | null;
  ph_zone_count: number;
  expected_zone_count: number;
  quality_warnings: string[];
}

interface RawPhReading {
  zone_label: string;
  measured_at: string;
  value: number;
}

function isSentinelZero(value: number): boolean {
  return value === 0;
}

// Same tolerance climateImportBatches.ts's sameValue() uses for conflict
// detection — values within this of each other are floating-point rounding
// noise (e.g. 5.067 vs 5.0667), not a real difference this backfill should
// touch. Without it, re-running the script would never converge to zero
// changes, since two independently-computed roundings of the same average
// can land a few ten-thousandths apart every time.
const VALUE_EPSILON = 0.0005;

function valuesDiffer(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  return Math.abs(a - b) >= VALUE_EPSILON;
}

/** Replaces (or removes) the "pH: ..." line in quality_warnings, leaving every other warning untouched. */
function updatePhWarning(existing: string[], newPhWarning: string | null): string[] {
  const withoutPh = existing.filter((w) => !w.startsWith('pH:'));
  return newPhWarning ? [...withoutPh, newPhWarning] : withoutPh;
}

async function fetchAllRows<T>(build: (from: number, to: number) => Promise<{ data: T[] | null; error: any }>): Promise<T[]> {
  let all: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    all = all.concat(data ?? []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function main() {
  const apply = process.argv.includes('--apply');

  const allRows = await fetchAllRows<VarietyHourlyRow>((from, to) =>
    supabase.from('variety_climate_hourly')
      .select('id, variety_id, measured_at, ph_avg, ph_zone_count, expected_zone_count, quality_warnings')
      .range(from, to)
  );
  console.log(`Total variety_climate_hourly rows: ${allRows.length}`);

  const { data: varietyZones } = await supabase
    .from('variety_zones')
    .select('variety_id, zones(import_key)');
  const zonesByVariety = new Map<string, string[]>();
  for (const vz of (varietyZones ?? []) as any[]) {
    const importKey = Array.isArray(vz.zones) ? vz.zones[0]?.import_key : vz.zones?.import_key;
    if (!importKey) continue;
    if (!zonesByVariety.has(vz.variety_id)) zonesByVariety.set(vz.variety_id, []);
    zonesByVariety.get(vz.variety_id)!.push(importKey);
  }
  console.log(`Varieties with linked zones: ${zonesByVariety.size}`);

  // All raw pH readings, grouped by (zone_label, measured_at) for O(1) lookup —
  // small enough dataset (thousands of rows) to hold in memory at once.
  const rawPh = await fetchAllRows<RawPhReading>((from, to) =>
    supabase.from('climate_readings').select('zone_label, measured_at, value').eq('metric_name', 'ph').range(from, to)
  );
  console.log(`Total raw pH readings: ${rawPh.length}`);
  const phByZoneAndHour = new Map<string, number>(); // key: `${zone_label}|${measured_at}`
  for (const r of rawPh) {
    phByZoneAndHour.set(`${r.zone_label}|${r.measured_at}`, r.value);
  }

  let changedCount = 0;
  let unchangedCount = 0;
  let noZonesLinkedCount = 0;
  const plan: { row: VarietyHourlyRow; newAvg: number | null; newCount: number; newWarnings: string[] }[] = [];

  for (const row of allRows) {
    const zoneLabels = zonesByVariety.get(row.variety_id) ?? [];
    if (zoneLabels.length === 0) { noZonesLinkedCount++; continue; }

    const values = zoneLabels.map((zl) => {
      const raw = phByZoneAndHour.get(`${zl}|${row.measured_at}`) ?? null;
      return raw != null && isSentinelZero(raw) ? null : raw;
    });
    const { avg, count } = averageValid(values);

    const changed = valuesDiffer(avg, row.ph_avg) || count !== row.ph_zone_count;
    if (!changed) { unchangedCount++; continue; }

    let newPhWarning: string | null = null;
    if (count === 0) newPhWarning = 'pH: no valid linked-zone reading';
    else if (row.expected_zone_count > 0 && count < row.expected_zone_count) newPhWarning = `pH: ${count}/${row.expected_zone_count} zones contributed`;
    const newWarnings = updatePhWarning(row.quality_warnings ?? [], newPhWarning);

    plan.push({ row, newAvg: avg, newCount: count, newWarnings });
    changedCount++;
  }

  console.log(`\nRows with no zones currently linked (skipped): ${noZonesLinkedCount}`);
  console.log(`Rows unchanged (ph_avg/ph_zone_count already correct): ${unchangedCount}`);
  console.log(`Rows that will change: ${changedCount}`);

  console.log('\nSample of first 10 changes:');
  for (const p of plan.slice(0, 10)) {
    console.log({
      variety_id: p.row.variety_id,
      measured_at: p.row.measured_at,
      before: { ph_avg: p.row.ph_avg, ph_zone_count: p.row.ph_zone_count },
      after: { ph_avg: p.newAvg, ph_zone_count: p.newCount },
    });
  }

  if (!apply) {
    console.log('\nDry run only — no changes written. Re-run with --apply to execute.');
    return;
  }

  console.log('\nApplying changes...');
  let done = 0;
  for (const p of plan) {
    const { error } = await supabase
      .from('variety_climate_hourly')
      .update({ ph_avg: p.newAvg, ph_zone_count: p.newCount, quality_warnings: p.newWarnings })
      .eq('id', p.row.id);
    if (error) {
      console.error(`Failed to update ${p.row.id}:`, error.message);
      continue;
    }
    done++;
  }
  console.log(`Done. ${done}/${plan.length} rows updated.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
