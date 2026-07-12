/**
 * Integration tests for the timestamp-resolution fix (filename hour is now
 * authoritative; Ridder's System Time/Date/Week rows validate it only — see
 * server/src/lib/ridderParser.ts resolveTimestamp), the repair-import path
 * (climate_import_staged_files.status = 'repair'), and the manual
 * hour-correction endpoints (server/src/lib/climateCorrections.ts).
 *
 * Same style as climate-dedup-integration.test.js: real HTTP calls against a
 * running server + real Supabase writes, cleaning up its own test data.
 *
 * Run with the dev server already running on :3001:
 *   npx tsx src/index.ts &
 *   node src/__tests__/climate-timestamp-resolution-integration.test.js
 */

require('dotenv').config({ path: '.env' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BASE = {
  temp:  [25.5,25.3,25.8,25.4,26.0,26.0,26.2,25.9,26.0,26.1,26.1,26.0,26.2,25.9,26.6,27.2,26.8,26.2,26.7,27.1,26.4,25.5],
  rh:    [78,75,78,78,76,78,80,73,75,74,76,74,74,75,73,74,72,75,76,80,75,76],
  co2:   [356,356,356,356,356,354,342,342,342,363,371,371,371,371,366,306,347,358,397,397,375,397],
  ec:    [2.3,2.4,2.3,2.4,2.4,2.4,2.2,2.4,2.4,2.4,2.4,2.4,2.4,2.4,2.3,2.3,2.3,2.3,3.1,3.1,3.1,3.1],
  ph:    [4.4,5.0,4.4,5.0,4.4,5.0,5.0,5.0,5.0,5.0,4.9,4.9,4.9,4.9,5.9,5.9,6.0,6.0,6.0,6.0,6.0,6.0],
  irrig: [1102,1206,1102,1206,1102,1206,1212,1196,1212,1196,1224,1194,1224,1194,1158,1159,1230,1230,1015,1015,1015,1015],
};

function row(label, values) { return `"${label}",${values.map(v => `"${v ?? ''}"`).join(',')},"","",""`; }

function buildCsv({ systemDate, systemTime, week, tempOverride, irrigOverride }) {
  const temp = [...BASE.temp];
  if (tempOverride) for (const [i, v] of Object.entries(tempOverride)) temp[i] = v;
  const irrig = [...BASE.irrig];
  if (irrigOverride) for (const [i, v] of Object.entries(irrigOverride)) irrig[i] = v;
  const radiation = new Array(22).fill(''); radiation[0] = '1110.3'; radiation[14] = '1110.3';
  const drain = new Array(22).fill(''); drain[0] = '33.9'; drain[14] = '25.8';
  const lines = [
    row('', new Array(22).fill('')),
    row('Block heating', Array.from({ length: 22 }, (_, i) => `Zone ${i + 1}`)),
    row('Air temperature [°C]', temp),
    row('RH [%]', BASE.rh),
    row('CO2 concentration [ppm]', BASE.co2),
    row('Radiation sum [J/cm²]', radiation),
    row('Average EC [mS/cm]', BASE.ec),
    row('Average pH', BASE.ph),
    row('Cumulative irrigation (dripper) [ml/dripp]', irrig),
    row('Cumulative drain water percentage [%]', drain),
    row('Group activation time [hh:mm]', (() => { const g = new Array(22).fill(''); g[0] = 'Real time - 17:10'; g[14] = 'Real time - 17:41'; return g; })()),
    row('Weather system', (() => { const g = new Array(22).fill(''); g[0] = 'System'; return g; })()),
    row('System time [hh:mm]', (() => { const g = new Array(22).fill(''); g[0] = `Real time - ${systemTime}`; return g; })()),
    row('System date [dd/mm/yyyy]', (() => { const g = new Array(22).fill(''); g[0] = systemDate; return g; })()),
    row('Week number', (() => { const g = new Array(22).fill(''); g[0] = String(week); return g; })()),
    row('Sunrise today [hh:mm]', (() => { const g = new Array(22).fill(''); g[0] = 'Real time - 06:00'; return g; })()),
    row('Sunset today [hh:mm]', (() => { const g = new Array(22).fill(''); g[0] = 'Real time - 21:09'; return g; })()),
    row('', new Array(22).fill('')),
  ];
  return lines.join('\n') + '\n';
}

async function uploadFiles(fileSpecs) {
  const form = new FormData();
  for (const spec of fileSpecs) {
    const blob = new Blob([spec.content], { type: 'text/csv' });
    form.append('files', blob, spec.name);
  }
  const res = await fetch('http://localhost:3001/api/climate/import-batches', { method: 'POST', body: form });
  return res.json();
}

async function confirmBatch(batchId, resolutions) {
  const res = await fetch(`http://localhost:3001/api/climate/import-batches/${batchId}/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolutions: resolutions ?? {} }),
  });
  return res.json();
}

async function previewCorrection(filename) {
  const res = await fetch('http://localhost:3001/api/climate/import-batches/corrections/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename }),
  });
  return res.json();
}

async function applyCorrection(filename) {
  const res = await fetch('http://localhost:3001/api/climate/import-batches/corrections/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename }),
  });
  return res.json();
}

let pass = 0, fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}` + (detail ? ` — ${JSON.stringify(detail)}` : '')); fail++; }
}

const testBatchIds = [];
const legacyImportIds = [];
const correctionSourceFilenames = [];
let repairFilename;

async function main() {
  // ── Test 1: filename and System Time agree ──
  console.log('\n[Test 1] Filename hour and System Time agree');
  {
    const c = buildCsv({ systemDate: '12/7/2026', systemTime: '09:00', week: 28 });
    const r = await uploadFiles([{ name: 'HR1_20260712_090001.csv', content: c }]);
    testBatchIds.push(r.batchId);
    const f = r.files.find((x) => x.filename === 'HR1_20260712_090001.csv');
    assert('no hour warning', f.hourWarning === null, f);
    assert('hourConflict is false', f.hourConflict === false, f);
    assert('hasUnresolvedHourConflicts is false', r.hasUnresolvedHourConflicts === false, r);
    assert('measuredAt uses the agreed hour (09:00 local)', new Date(f.resolvedMeasuredAt).toISOString() === new Date(Date.UTC(2026, 6, 12, 13, 0, 0)).toISOString(), f);
  }

  // ── Test 2: System Time stale by 1 hour (behind filename) ──
  console.log('\n[Test 2] System Time is 1 hour stale (behind the filename)');
  {
    const c = buildCsv({ systemDate: '12/7/2026', systemTime: '09:00', week: 28 });
    const r = await uploadFiles([{ name: 'HR2_20260712_100002.csv', content: c }]); // filename hour 10, System Time hour 9
    testBatchIds.push(r.batchId);
    const f = r.files.find((x) => x.filename === 'HR2_20260712_100002.csv');
    assert('non-blocking hour warning present', typeof f.hourWarning === 'string' && f.hourWarning.includes('stale'), f);
    assert('hourConflict is false (non-blocking)', f.hourConflict === false, f);
    assert('hasUnresolvedHourConflicts is false', r.hasUnresolvedHourConflicts === false, r);
    // Filename hour (10 local) is authoritative -> 14:00 UTC, not 13:00 UTC (System Time's hour).
    assert('measuredAt uses the FILENAME hour (10:00 local), not System Time', new Date(f.resolvedMeasuredAt).toISOString() === new Date(Date.UTC(2026, 6, 12, 14, 0, 0)).toISOString(), f);
    const confirmed = await confirmBatch(r.batchId, {});
    assert('commits without needing any resolution', confirmed.status === 'committed', confirmed);
  }

  // ── Test 3: System Time 1 hour ahead of filename ──
  console.log('\n[Test 3] System Time is 1 hour ahead of the filename');
  {
    const c = buildCsv({ systemDate: '12/7/2026', systemTime: '12:00', week: 28 });
    const r = await uploadFiles([{ name: 'HR3_20260712_110003.csv', content: c }]); // filename hour 11, System Time hour 12
    testBatchIds.push(r.batchId);
    const f = r.files.find((x) => x.filename === 'HR3_20260712_110003.csv');
    assert('non-blocking hour warning present', typeof f.hourWarning === 'string' && f.hourWarning.includes('ahead'), f);
    assert('hourConflict is false (non-blocking)', f.hourConflict === false, f);
    assert('measuredAt uses the FILENAME hour (11:00 local)', new Date(f.resolvedMeasuredAt).toISOString() === new Date(Date.UTC(2026, 6, 12, 15, 0, 0)).toISOString(), f);
  }

  // ── Test 4: difference greater than 1 hour -> blocking, needs confirmation ──
  console.log('\n[Test 4] System Time differs from filename by more than 1 hour');
  {
    const c = buildCsv({ systemDate: '12/7/2026', systemTime: '09:00', week: 28, tempOverride: { 1: 30.4 } }); // distinguishing marker so this file's hash never collides with Test 2's
    const r = await uploadFiles([{ name: 'HR4_20260712_130004.csv', content: c }]); // filename hour 13, System Time hour 9 -> 4h diff
    testBatchIds.push(r.batchId);
    const f = r.files.find((x) => x.filename === 'HR4_20260712_130004.csv');
    assert('hourConflict is true (blocking)', f.hourConflict === true, f);
    assert('hasUnresolvedHourConflicts is true', r.hasUnresolvedHourConflicts === true, r);

    const confirm1 = await confirmBatch(r.batchId, {});
    assert('confirm returns conflicts', confirm1.status === 'conflicts', confirm1);
    const hourConflict = confirm1.conflicts.find((cf) => cf.kind === 'hour_discrepancy');
    assert('conflict kind is hour_discrepancy', !!hourConflict, confirm1);
    const confirm2 = await confirmBatch(r.batchId, { [hourConflict.conflictId]: 'confirm_filename_hour' });
    assert('commits after explicit confirmation', confirm2.status === 'committed', confirm2);
  }

  // ── Test 5: date-label locale disagreement is unaffected by the hour fix ──
  console.log('\n[Test 5] Date-format disagreement (existing behavior) still resolves via week number');
  {
    // "7/13/2026" only parses sensibly as mm/dd (month 7, day 13) since day=13 can't be a month;
    // the week-number check should still confirm the correct date, independent of the hour fix.
    const c = buildCsv({ systemDate: '7/13/2026', systemTime: '10:00', week: 29 });
    const r = await uploadFiles([{ name: 'HR5_20260713_100005.csv', content: c }]);
    testBatchIds.push(r.batchId);
    const f = r.files.find((x) => x.filename === 'HR5_20260713_100005.csv');
    assert('date-level conflict/warning still functions independently of the hour fix', f.timestampConflict === true && typeof f.timestampWarning === 'string', f);
    assert('hour still agrees (no hour warning)', f.hourWarning === null, f);
  }

  // ── Test 6: midnight/date rollover with circular hour-diff wraparound ──
  console.log('\n[Test 6] Midnight rollover: filename hour 0 vs System Time hour 23 (previous day)');
  {
    const c = buildCsv({ systemDate: '14/7/2026', systemTime: '23:00', week: 29 });
    const r = await uploadFiles([{ name: 'HR6_20260714_000006.csv', content: c }]); // filename hour 0, System Time hour 23
    testBatchIds.push(r.batchId);
    const f = r.files.find((x) => x.filename === 'HR6_20260714_000006.csv');
    assert('wraparound treated as 1-hour stale, not 23-hour', f.hourConflict === false && typeof f.hourWarning === 'string' && f.hourWarning.includes('stale'), f);
    assert('measuredAt uses filename hour (00:00 local on 2026-07-14)', new Date(f.resolvedMeasuredAt).toISOString() === new Date(Date.UTC(2026, 6, 14, 4, 0, 0)).toISOString(), f);
  }

  // ── Test 7: DST spring-forward nonexistent local hour ──
  console.log('\n[Test 7] DST spring-forward nonexistent hour (2026-03-08 02:00 America/Toronto)');
  {
    const c = buildCsv({ systemDate: '8/3/2026', systemTime: '02:00', week: 10 });
    const r = await uploadFiles([{ name: 'HR7_20260308_020007.csv', content: c }]);
    testBatchIds.push(r.batchId);
    const f = r.files.find((x) => x.filename === 'HR7_20260308_020007.csv');
    assert('parser does not crash and produces a defined timestamp', f.resolvedMeasuredAt != null && !Number.isNaN(new Date(f.resolvedMeasuredAt).getTime()), f);
  }

  // ── Test 8: DST fall-back repeated local hour ──
  console.log('\n[Test 8] DST fall-back repeated hour (2026-11-01 01:00 America/Toronto occurs twice)');
  {
    const c = buildCsv({ systemDate: '1/11/2026', systemTime: '01:00', week: 44 });
    const r = await uploadFiles([{ name: 'HR8_20261101_010008.csv', content: c }]);
    testBatchIds.push(r.batchId);
    const f = r.files.find((x) => x.filename === 'HR8_20261101_010008.csv');
    assert('parser does not crash and produces a defined timestamp', f.resolvedMeasuredAt != null && !Number.isNaN(new Date(f.resolvedMeasuredAt).getTime()), f);
  }

  // ── Test 11: repair import after the original batch is already committed ──
  console.log('\n[Test 11] Repair import: a file that lost a value conflict and stored 0 readings can be re-uploaded');
  {
    const c1 = buildCsv({ systemDate: '12/7/2026', systemTime: '20:00', week: 28 });
    const c2 = buildCsv({ systemDate: '12/7/2026', systemTime: '20:00', week: 28, tempOverride: { 0: 44.4 } });
    repairFilename = 'HR11_b_20260712_200001.csv';
    const r = await uploadFiles([
      { name: 'HR11_a_20260712_200000.csv', content: c1 },
      { name: repairFilename, content: c2 },
    ]);
    testBatchIds.push(r.batchId);
    const confirm1 = await confirmBatch(r.batchId, {});
    assert('round 1 surfaces batch_duplicate conflict', confirm1.status === 'conflicts', confirm1);
    const bd = confirm1.conflicts[0];
    const winner = bd.candidates.find((cand) => cand.filename === 'HR11_a_20260712_200000.csv');
    const confirm2 = await confirmBatch(r.batchId, { [bd.conflictId]: winner.stagedFileId });
    assert('original batch commits with the loser storing 0 readings', confirm2.status === 'committed', confirm2);

    const { data: loserImport } = await supabase.from('climate_imports').select('*').eq('filename', repairFilename).maybeSingle();
    assert('loser has a climate_imports row with readings_stored = 0', loserImport && loserImport.readings_stored === 0, loserImport);

    // Re-upload the exact same (loser) file content as a brand-new batch.
    const r2 = await uploadFiles([{ name: repairFilename, content: c2 }]);
    testBatchIds.push(r2.batchId);
    const repairFile = r2.files.find((x) => x.filename === repairFilename);
    assert('staged status is "repair", not "duplicate"', repairFile.status === 'repair', repairFile);
    assert('filesRepair count is 1', r2.filesRepair === 1, r2);
    assert('repairDetails present', r2.repairDetails.length === 1, r2);

    const confirm3 = await confirmBatch(r2.batchId, {});
    // The loser's value (44.4) still genuinely disagrees with the now-permanent
    // winner's value at the same hour — that's a normal 'reading' conflict, not
    // a silent duplicate write.
    assert('repair re-surfaces the still-unresolved value disagreement as a normal reading conflict', confirm3.status === 'conflicts' && confirm3.conflicts.some((cf) => cf.kind === 'reading'), confirm3);
    // A changed zone reading can legitimately produce BOTH a reading-level
    // conflict AND a dependent variety_hourly conflict (its average changed
    // too) — resolve every conflict returned, not just the first one.
    const repairResolutions = {};
    for (const cf of confirm3.conflicts) repairResolutions[cf.conflictId] = 'overwrite';
    const confirm4 = await confirmBatch(r2.batchId, repairResolutions);
    assert('repair batch commits once the value conflict is resolved', confirm4.status === 'committed', confirm4);
    assert('repairedFiles lists the repaired filename', confirm4.repairedFiles?.includes(repairFilename), confirm4);

    const { data: repairedImport } = await supabase.from('climate_imports').select('*').eq('filename', repairFilename).maybeSingle();
    assert('the SAME climate_imports row id was reused (no duplicate ledger row)', repairedImport.id === loserImport.id, { repairedImport, loserImport });
    assert('readings_stored updated to a nonzero count', repairedImport.readings_stored > 0, repairedImport);
  }

  // ── Test 12: reprocessing retained historical source data ──
  console.log('\n[Test 12] Committed imports retain their raw CSV text for reprocessing');
  {
    const { data: imp } = await supabase.from('climate_imports').select('raw_content').eq('filename', 'HR2_20260712_100002.csv').maybeSingle();
    assert('raw_content was persisted permanently on the committed import row', typeof imp?.raw_content === 'string' && imp.raw_content.includes('Air temperature'), imp);
  }
}

// ── Test 9 & 10: manual correction of an already-committed (legacy, wrongly
// labeled) reading — these bypass the parser/upload entirely and insert
// directly, simulating data committed under the OLD hour-resolution bug
// before this fix existed. The correction endpoints (climateCorrections.ts)
// must relabel it to its filename-authoritative hour and recompute the
// affected phase/variety hourly rows and cumulative deltas. ────────────────
async function runCorrectionTests() {
  console.log('\n[Test 9] Correcting a legacy wrongly-labeled reading fills the previously-missing hour');
  const { data: batch } = await supabase.from('climate_import_batches').insert({ organization_id: null, status: 'committed', file_count: 1 }).select('id').single();
  testBatchIds.push(batch.id);

  const wrongMeasuredAt = new Date(Date.UTC(2026, 6, 15, 12, 0, 0)).toISOString(); // 08:00 local
  const correctMeasuredAt = new Date(Date.UTC(2026, 6, 15, 13, 0, 0)).toISOString(); // 09:00 local (filename hour)
  const filenameTimestamp = new Date(Date.UTC(2026, 6, 15, 13, 0, 3)).toISOString();
  const legacyFilename = 'LEGACY_20260715_090003.csv';
  correctionSourceFilenames.push(legacyFilename);

  const { data: legacyImport } = await supabase.from('climate_imports').insert({
    organization_id: null, filename: legacyFilename, file_hash: `legacyhash-${Date.now()}`,
    readings_stored: 1, batch_id: batch.id, measured_at: wrongMeasuredAt, filename_timestamp: filenameTimestamp,
    week_number: 29, timestamp_conflict: false, timestamp_warning: null,
    hour_difference_minutes: -60, hour_conflict: false, hour_warning: 'legacy stale System Time (simulated)',
  }).select('id').single();
  legacyImportIds.push(legacyImport.id);

  await supabase.from('climate_readings').insert({
    organization_id: null, import_id: legacyImport.id, zone_label: 'Zone 1', measured_at: wrongMeasuredAt,
    metric_name: 'irrigation_cumulative_ml', value: 5000, unit: 'ml', source_file: legacyFilename,
  });

  // A later same-day reading whose delta depends on the corrected cumulative value.
  const nextMeasuredAt = new Date(Date.UTC(2026, 6, 15, 14, 0, 0)).toISOString(); // 10:00 local
  const { data: nextImport } = await supabase.from('climate_imports').insert({
    organization_id: null, filename: 'LEGACY_NEXT_20260715_100000.csv', file_hash: `legacyhash-next-${Date.now()}`,
    readings_stored: 1, batch_id: batch.id, measured_at: nextMeasuredAt, filename_timestamp: nextMeasuredAt,
    week_number: 29, timestamp_conflict: false, timestamp_warning: null,
  }).select('id').single();
  legacyImportIds.push(nextImport.id);
  await supabase.from('climate_readings').insert({
    organization_id: null, import_id: nextImport.id, zone_label: 'Zone 1', measured_at: nextMeasuredAt,
    metric_name: 'irrigation_cumulative_ml', value: 5300, unit: 'ml', source_file: 'LEGACY_NEXT_20260715_100000.csv',
  });

  const preview = await previewCorrection(legacyFilename);
  assert('preview identifies the old (wrong) and new (filename-authoritative) hour', preview.oldMeasuredAtUtc === wrongMeasuredAt && preview.newMeasuredAtUtc === correctMeasuredAt, preview);
  assert('preview finds no conflicting reading at the target hour', preview.conflictsAtTarget.length === 0, preview);
  assert('preview says it can apply', preview.canApply === true, preview);
  assert('recompute set spans old, new, and the next same-day hour', preview.recomputeTimestamps.length === 3, preview);

  const applied = await applyCorrection(legacyFilename);
  assert('apply succeeds', applied.status === 'corrected', applied);

  const { data: movedReading } = await supabase.from('climate_readings').select('measured_at').eq('source_file', legacyFilename).maybeSingle();
  assert('the reading itself moved to the corrected hour', new Date(movedReading.measured_at).toISOString() === correctMeasuredAt, movedReading);

  const { data: correctedImport } = await supabase.from('climate_imports').select('measured_at').eq('id', legacyImport.id).maybeSingle();
  assert('climate_imports.measured_at updated to the corrected hour', new Date(correctedImport.measured_at).toISOString() === correctMeasuredAt, correctedImport);

  const { data: correction } = await supabase.from('climate_import_corrections').select('*').eq('id', applied.correctionId).maybeSingle();
  assert('an audit record was written', !!correction && correction.correction_type === 'timestamp_relabel', correction);
  assert('audit record has affected variety/phase hourly ids recorded', Array.isArray(correction.affected_variety_hourly_ids), correction);

  console.log('\n[Test 10] Correction recalculates the following hour\'s irrigation delta');
  const { data: nextRow } = await supabase.from('variety_climate_hourly').select('irrigation_interval_delta_ml, irrigation_quality_flag').eq('measured_at', nextMeasuredAt).order('irrigation_interval_delta_ml', { ascending: false }).limit(1).maybeSingle();
  // Zone 1 is linked to a variety in this environment (used throughout the
  // other climate tests) — its delta at 10:00 local should now be computed
  // against the corrected 09:00 cumulative (5000 ml), i.e. 5300 - 5000 = 300,
  // not against whatever the STALE 08:00 hour previously implied.
  assert('next hour delta recomputed against the corrected cumulative anchor', nextRow && Math.abs(nextRow.irrigation_interval_delta_ml - 300) < 1, nextRow);

  console.log('\n[Test 9b] Correction refuses when a conflicting reading already exists at the target hour');
  const blockedFilename = 'LEGACY_BLOCKED_20260716_090003.csv';
  correctionSourceFilenames.push(blockedFilename);
  const blockedWrong = new Date(Date.UTC(2026, 6, 16, 12, 0, 0)).toISOString();
  const blockedCorrect = new Date(Date.UTC(2026, 6, 16, 13, 0, 0)).toISOString();
  const blockedFilenameTs = new Date(Date.UTC(2026, 6, 16, 13, 0, 3)).toISOString();
  const { data: blockedImport } = await supabase.from('climate_imports').insert({
    organization_id: null, filename: blockedFilename, file_hash: `legacyhash-blocked-${Date.now()}`,
    readings_stored: 1, batch_id: batch.id, measured_at: blockedWrong, filename_timestamp: blockedFilenameTs,
    week_number: 29, timestamp_conflict: false, timestamp_warning: null,
  }).select('id').single();
  legacyImportIds.push(blockedImport.id);
  await supabase.from('climate_readings').insert({
    organization_id: null, import_id: blockedImport.id, zone_label: 'Zone 2', measured_at: blockedWrong,
    metric_name: 'temperature_c', value: 22.2, unit: '°C', source_file: blockedFilename,
  });
  // A pre-existing reading already occupies the TARGET hour for the same zone/metric.
  const { data: otherImport } = await supabase.from('climate_imports').insert({
    organization_id: null, filename: 'LEGACY_OTHER_20260716_090000.csv', file_hash: `legacyhash-other-${Date.now()}`,
    readings_stored: 1, batch_id: batch.id, measured_at: blockedCorrect, filename_timestamp: blockedCorrect,
    week_number: 29, timestamp_conflict: false, timestamp_warning: null,
  }).select('id').single();
  legacyImportIds.push(otherImport.id);
  await supabase.from('climate_readings').insert({
    organization_id: null, import_id: otherImport.id, zone_label: 'Zone 2', measured_at: blockedCorrect,
    metric_name: 'temperature_c', value: 30.0, unit: '°C', source_file: 'LEGACY_OTHER_20260716_090000.csv',
  });

  const blockedPreview = await previewCorrection(blockedFilename);
  assert('preview reports a conflict at the target hour', blockedPreview.conflictsAtTarget.length === 1, blockedPreview);
  assert('preview says it cannot apply', blockedPreview.canApply === false, blockedPreview);
  const blockedApply = await applyCorrection(blockedFilename);
  assert('apply refuses (does not silently overwrite)', blockedApply.error != null, blockedApply);
}

main()
  .then(runCorrectionTests)
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await supabase.from('climate_import_corrections').delete().eq('source_filename', repairFilename);
    for (const filename of correctionSourceFilenames) {
      await supabase.from('climate_readings').delete().eq('source_file', filename);
    }
    await supabase.from('climate_readings').delete().eq('source_file', 'LEGACY_NEXT_20260715_100000.csv');
    await supabase.from('climate_readings').delete().eq('source_file', 'LEGACY_OTHER_20260716_090000.csv');
    await supabase.from('climate_import_corrections').delete().in('source_filename', [...correctionSourceFilenames]);
    for (const id of legacyImportIds) {
      await supabase.from('climate_imports').delete().eq('id', id);
    }
    for (const id of testBatchIds) {
      if (!id) continue;
      await supabase.from('variety_climate_hourly').delete().eq('source_batch_id', id);
      await supabase.from('phase_climate_hourly').delete().eq('source_batch_id', id);
      await supabase.from('climate_imports').delete().eq('batch_id', id);
      await supabase.from('climate_import_staged_files').delete().eq('batch_id', id);
      await supabase.from('climate_import_batches').delete().eq('id', id);
    }
    console.log(`\nCleaned up ${testBatchIds.filter(Boolean).length} test batches and ${legacyImportIds.length} legacy import rows.`);
    console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
  });
