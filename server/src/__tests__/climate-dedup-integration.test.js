/**
 * Integration tests for same-batch duplicate-reading detection/dedup in the
 * climate import pipeline (climateDuplicates.ts, climateImportBatches.ts).
 *
 * Unlike projection-math.test.ts, this is NOT dependency-free — it makes
 * real HTTP calls against a running server and writes to the configured
 * Supabase project, cleaning up its own test batches afterward (never
 * touches pre-existing batches).
 *
 * Run with the dev server already running on :3001:
 *   npx tsx src/index.ts &
 *   node src/__tests__/climate-dedup-integration.test.js
 */

const BASE = {
  temp:  [25.5,25.3,25.8,25.4,26.0,26.0,26.2,25.9,26.0,26.1,26.1,26.0,26.2,25.9,26.6,27.2,26.8,26.2,26.7,27.1,26.4,25.5],
  rh:    [78,75,78,78,76,78,80,73,75,74,76,74,74,75,73,74,72,75,76,80,75,76],
  co2:   [356,356,356,356,356,354,342,342,342,363,371,371,371,371,366,306,347,358,397,397,375,397],
  ec:    [2.3,2.4,2.3,2.4,2.4,2.4,2.2,2.4,2.4,2.4,2.4,2.4,2.4,2.4,2.3,2.3,2.3,2.3,3.1,3.1,3.1,3.1],
  ph:    [4.4,5.0,4.4,5.0,4.4,5.0,5.0,5.0,5.0,5.0,4.9,4.9,4.9,4.9,5.9,5.9,6.0,6.0,6.0,6.0,6.0,6.0],
  irrig: [1102,1206,1102,1206,1102,1206,1212,1196,1212,1196,1224,1194,1224,1194,1158,1159,1230,1230,1015,1015,1015,1015],
};

function row(label, values) { return `"${label}",${values.map(v => `"${v ?? ''}"`).join(',')},"","",""`; }

// Deliberately far from any real greenhouse import date (the actual imported
// data spans 2026-07-07..11) so this suite never collides with committed
// production readings, regardless of what's been imported in the meantime.
const TEST_DATE = '10/1/2026'; // 2026-01-10, ISO week 2
const TEST_WEEK = 2;
const TEST_FILENAME_DATE = '20260110';

function buildCsv({ systemDate, systemTime, week, tempOverride, extraByte }) {
  const temp = [...BASE.temp];
  if (tempOverride) for (const [i, v] of Object.entries(tempOverride)) temp[i] = v;
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
    row('Cumulative irrigation (dripper) [ml/dripp]', BASE.irrig),
    row('Cumulative drain water percentage [%]', drain),
    row('Group activation time [hh:mm]', (() => { const g = new Array(22).fill(''); g[0] = 'Real time - 17:10'; g[14] = 'Real time - 17:41'; return g; })()),
    row('Weather system', (() => { const g = new Array(22).fill(''); g[0] = `System${extraByte ?? ''}`; return g; })()),
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

let pass = 0, fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}` + (detail ? ` — ${JSON.stringify(detail)}` : '')); fail++; }
}

const testBatchIds = [];

async function main() {
  // ── Test 1: two identical files (same content -> same hash) at the same timestamp ──
  console.log('\n[Test 1] Two identical files, same hash, same timestamp');
  {
    const content = buildCsv({ systemDate: TEST_DATE, systemTime: '10:00', week: TEST_WEEK });
    const r = await uploadFiles([
      { name: 'T1_20260110_100000.csv', content },
      { name: 'T1_20260110_100000_copy.csv', content },
    ]);
    testBatchIds.push(r.batchId);
    assert('one file parsed, one marked duplicate (exact hash)', r.filesParsed === 1 && r.filesDuplicate === 1, r);
  }

  // ── Test 2: different filenames/bytes, identical normalized readings ──
  console.log('\n[Test 2] Different files (different hash), identical normalized readings');
  let test2BatchId;
  {
    const c1 = buildCsv({ systemDate: TEST_DATE, systemTime: '11:00', week: TEST_WEEK });
    const c2 = buildCsv({ systemDate: TEST_DATE, systemTime: '11:00', week: TEST_WEEK, extraByte: ' ' }); // differs by 1 byte -> different hash, same parsed values
    const r = await uploadFiles([
      { name: 'T2_20260110_110000.csv', content: c1 },
      { name: 'T2_20260110_110001.csv', content: c2 },
    ]);
    test2BatchId = r.batchId;
    testBatchIds.push(r.batchId);
    assert('2 files parsed (different hashes)', r.filesParsed === 2, r);
    assert('1 duplicate timestamp detected', r.duplicateTimestamps.length === 1, r);
    assert('classified as identical (0 conflicting)', r.identicalDuplicateTimestampCount === 1 && r.conflictingDuplicateTimestampCount === 0, r);

    const confirmed = await confirmBatch(test2BatchId, {});
    assert('commits with no conflicts', confirmed.status === 'committed', confirmed);
    assert('some readings skipped as identical duplicates', (confirmed.readingsSkippedAsDuplicate ?? 0) > 0, confirmed);
  }

  // ── Test 3: same timestamp, ONE conflicting zone/metric ──
  console.log('\n[Test 3] Same timestamp, one conflicting zone/metric (Zone 1 temp)');
  let test3BatchId, test3ConflictId;
  {
    const c1 = buildCsv({ systemDate: TEST_DATE, systemTime: '12:00', week: TEST_WEEK });
    const c2 = buildCsv({ systemDate: TEST_DATE, systemTime: '12:00', week: TEST_WEEK, tempOverride: { 0: 40.0 } });
    const r = await uploadFiles([
      { name: 'T3_20260110_120000.csv', content: c1 },
      { name: 'T3_20260110_120001.csv', content: c2 },
    ]);
    test3BatchId = r.batchId;
    testBatchIds.push(r.batchId);
    assert('conflicting duplicate timestamp detected', r.conflictingDuplicateTimestampCount === 1, r);
    const detail = r.duplicateTimestampDetails.find((d) => d.conflictingReadingCount > 0);
    assert('exactly 1 conflicting reading (Zone1 temp only)', detail?.conflictingReadingCount === 1, detail);

    const confirmed = await confirmBatch(test3BatchId, {});
    assert('confirm returns conflicts (unresolved)', confirmed.status === 'conflicts', confirmed);
    assert('conflict kind is batch_duplicate', confirmed.conflicts?.[0]?.kind === 'batch_duplicate', confirmed);
    test3ConflictId = confirmed.conflicts?.[0]?.conflictId;
    const winner = confirmed.conflicts?.[0]?.candidates?.[0]?.stagedFileId;
    const confirmed2 = await confirmBatch(test3BatchId, { [test3ConflictId]: winner });
    assert('commits after resolving batch_duplicate conflict', confirmed2.status === 'committed', confirmed2);
  }

  // ── Test 4: same timestamp, MANY conflicting metrics ──
  console.log('\n[Test 4] Same timestamp, many conflicting metrics (zones 1-10 temp)');
  {
    const manyOverride = {}; for (let i = 0; i < 10; i++) manyOverride[i] = 50 + i;
    const c1 = buildCsv({ systemDate: TEST_DATE, systemTime: '13:00', week: TEST_WEEK });
    const c2 = buildCsv({ systemDate: TEST_DATE, systemTime: '13:00', week: TEST_WEEK, tempOverride: manyOverride });
    const r = await uploadFiles([
      { name: 'T4_20260110_130000.csv', content: c1 },
      { name: 'T4_20260110_130001.csv', content: c2 },
    ]);
    testBatchIds.push(r.batchId);
    const detail = r.duplicateTimestampDetails.find((d) => d.conflictingReadingCount > 0);
    assert('10 conflicting readings detected', detail?.conflictingReadingCount === 10, detail);
    assert('hasUnresolvedDuplicateConflicts true', r.hasUnresolvedDuplicateConflicts === true, r);
  }

  // ── Test 5: three files, two agree one differs ──
  console.log('\n[Test 5] Three files at the same timestamp: two agree, one differs');
  {
    const c1 = buildCsv({ systemDate: TEST_DATE, systemTime: '14:00', week: TEST_WEEK });
    const c2 = buildCsv({ systemDate: TEST_DATE, systemTime: '14:00', week: TEST_WEEK });
    const c3 = buildCsv({ systemDate: TEST_DATE, systemTime: '14:00', week: TEST_WEEK, tempOverride: { 0: 33.3 } });
    const r = await uploadFiles([
      { name: 'T5_20260110_140000.csv', content: c1 },
      { name: 'T5_20260110_140001.csv', content: c2 + ' ' }, // ensure distinct hash from c1
      { name: 'T5_20260110_140002.csv', content: c3 },
    ]);
    testBatchIds.push(r.batchId);
    const detail = r.duplicateTimestampDetails.find((d) => d.conflictingReadingCount > 0);
    assert('2-agree-1-differs still classified as conflict (not silently majority-resolved)', detail?.conflictingReadingCount >= 1, detail);
    const zoneOneConflict = detail?.conflictingMetricsZones.find((cz) => cz.zoneLabel === 'Zone 1' && cz.metricName === 'temperature_c');
    assert('conflict lists all 3 candidates for Zone 1 temp', zoneOneConflict?.candidates?.length === 3, zoneOneConflict);
  }

  // ── Test 6: duplicate timestamps combined with already-committed permanent readings ──
  console.log('\n[Test 6] Batch-internal duplicate that also conflicts with already-committed data');
  {
    const cBase = buildCsv({ systemDate: TEST_DATE, systemTime: '15:00', week: TEST_WEEK });
    const rBase = await uploadFiles([{ name: 'T6_base_20260110_150000.csv', content: cBase }]);
    testBatchIds.push(rBase.batchId);
    const confirmedBase = await confirmBatch(rBase.batchId, {});
    assert('base commit succeeds', confirmedBase.status === 'committed', confirmedBase);

    // Now a NEW batch: two files at the SAME hour, both disagreeing with the committed value AND each other.
    const c1 = buildCsv({ systemDate: TEST_DATE, systemTime: '15:00', week: TEST_WEEK, tempOverride: { 0: 60.0 } });
    const c2 = buildCsv({ systemDate: TEST_DATE, systemTime: '15:00', week: TEST_WEEK, tempOverride: { 0: 61.0 } });
    const r2 = await uploadFiles([
      { name: 'T6_dup_20260110_150000.csv', content: c1 },
      { name: 'T6_dup_20260110_150001.csv', content: c2 },
    ]);
    testBatchIds.push(r2.batchId);
    const confirm1 = await confirmBatch(r2.batchId, {});
    assert('round 1: batch_duplicate conflict surfaces first', confirm1.status === 'conflicts' && confirm1.conflicts?.[0]?.kind === 'batch_duplicate', confirm1);
    const bd = confirm1.conflicts[0];
    const confirm2 = await confirmBatch(r2.batchId, { [bd.conflictId]: bd.candidates[0].stagedFileId });
    assert('round 2: reading conflict vs permanent data surfaces next', confirm2.status === 'conflicts' && confirm2.conflicts?.some((c) => c.kind === 'reading'), confirm2);
    assert('round 2 also surfaces the dependent variety_hourly conflict (avg changed too)', confirm2.conflicts?.some((c) => c.kind === 'variety_hourly'), confirm2);
    // Resolve every round-2 conflict, not just one — a changed zone reading
    // can legitimately produce both a reading-level AND variety-level conflict.
    const round2Resolutions = { [bd.conflictId]: bd.candidates[0].stagedFileId };
    for (const c of confirm2.conflicts) round2Resolutions[c.conflictId] = 'overwrite';
    const confirm3 = await confirmBatch(r2.batchId, round2Resolutions);
    assert('final commit succeeds after both rounds fully resolved', confirm3.status === 'committed', confirm3);
  }

  // ── Test 8: multiple duplicate timestamps in one large batch ──
  console.log('\n[Test 8] Multiple duplicate timestamps in one batch (mix of identical + conflicting)');
  {
    const files = [];
    // hour 16: identical duplicate
    const h16a = buildCsv({ systemDate: TEST_DATE, systemTime: '16:00', week: TEST_WEEK });
    const h16b = buildCsv({ systemDate: TEST_DATE, systemTime: '16:00', week: TEST_WEEK, extraByte: '  ' });
    files.push({ name: 'T8_a_160000.csv', content: h16a }, { name: 'T8_b_160001.csv', content: h16b });
    // hour 17: conflicting duplicate
    const h17a = buildCsv({ systemDate: TEST_DATE, systemTime: '17:00', week: TEST_WEEK });
    const h17b = buildCsv({ systemDate: TEST_DATE, systemTime: '17:00', week: TEST_WEEK, tempOverride: { 5: 15.0 } });
    files.push({ name: 'T8_c_170000.csv', content: h17a }, { name: 'T8_d_170001.csv', content: h17b });
    // hour 18: unique, no duplicate
    const h18 = buildCsv({ systemDate: TEST_DATE, systemTime: '18:00', week: TEST_WEEK });
    files.push({ name: 'T8_e_180000.csv', content: h18 });

    const r = await uploadFiles(files);
    testBatchIds.push(r.batchId);
    assert('2 duplicate timestamps detected', r.duplicateTimestamps.length === 2, r);
    assert('1 identical + 1 conflicting', r.identicalDuplicateTimestampCount === 1 && r.conflictingDuplicateTimestampCount === 1, r);
  }

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  // Clean up test batches created here (never touches pre-existing/real batches).
  require('dotenv').config({ path: '.env' });
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  for (const id of testBatchIds) {
    if (!id) continue;
    await supabase.from('variety_climate_hourly').delete().eq('source_batch_id', id);
    await supabase.from('phase_climate_hourly').delete().eq('source_batch_id', id);
    await supabase.from('climate_imports').delete().eq('batch_id', id);
    await supabase.from('climate_import_staged_files').delete().eq('batch_id', id);
    await supabase.from('climate_import_batches').delete().eq('id', id);
  }
  console.log(`\nCleaned up ${testBatchIds.filter(Boolean).length} test batches.`);
});
