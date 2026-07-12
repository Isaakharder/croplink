/**
 * Regression test proving the old (variety-hourly) and new (variety-features)
 * daily/weekly radiation rollups agree, now that both use the shared
 * sumAccumulatedRadiationJCm2 rule (climateFeatures.ts) instead of each
 * summing radiation_interval_delta_j_cm2 independently.
 *
 * Read-only — makes real HTTP GET calls against a running server and reads
 * whatever climate history is already committed. Writes/creates nothing, so
 * there's no cleanup step (unlike climate-dedup-integration.test.js).
 *
 * Run with the dev server already running on :3001:
 *   npx tsx src/index.ts &
 *   node src/__tests__/climate-radiation-rollup-regression.test.js
 */

const BASE_URL = 'http://localhost:3001';

let pass = 0, fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}` + (detail ? ` — ${JSON.stringify(detail)}` : '')); fail++; }
}

async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function main() {
  const varieties = await getJson('/api/projection/varieties');
  // Target the specific varieties this bug was found against, but don't
  // fail the whole suite if the dataset has changed — just skip a variety
  // with no committed climate history instead of asserting against nothing.
  const targets = varieties.filter((v) => ['Cadalora', 'Mathieu'].includes(v.name));
  assert('at least one target variety (Cadalora/Mathieu) exists', targets.length > 0, varieties.map((v) => v.name));

  for (const variety of targets) {
    console.log(`\n[${variety.name}]`);
    for (const granularity of ['daily', 'weekly']) {
      const [oldResp, newResp] = await Promise.all([
        getJson(`/api/climate/variety-hourly?varietyId=${variety.id}&granularity=${granularity}`),
        getJson(`/api/climate/variety-features?varietyId=${variety.id}&granularity=${granularity}`),
      ]);
      const oldRows = oldResp.rows ?? [];
      const newRows = newResp.rows ?? [];

      assert(`${granularity}: old endpoint has committed data to compare`, oldRows.length > 0, oldResp);

      const oldNegative = oldRows.filter((r) => r.radiationIntervalTotalJCm2 != null && r.radiationIntervalTotalJCm2 < 0);
      assert(`${granularity}: old endpoint (variety-hourly) has no negative radiation totals`, oldNegative.length === 0, oldNegative);

      const newNegative = newRows.filter((r) => r.radiationIntervalTotalJCm2 != null && r.radiationIntervalTotalJCm2 < 0);
      assert(`${granularity}: new endpoint (variety-features) has no negative radiation totals`, newNegative.length === 0, newNegative);

      const newByBucket = new Map(newRows.map((r) => [r.bucket, r]));
      let mismatches = [];
      for (const oldBucket of oldRows) {
        const newBucket = newByBucket.get(oldBucket.bucket);
        if (!newBucket) continue; // variety-features can have fewer buckets if recompute hasn't been backfilled that far — not this test's concern
        const a = oldBucket.radiationIntervalTotalJCm2 ?? null;
        const b = newBucket.radiationIntervalTotalJCm2 ?? null;
        const equal = a === b || (a != null && b != null && Math.abs(a - b) < 0.001);
        if (!equal) mismatches.push({ bucket: oldBucket.bucket, old: a, new: b });
      }
      assert(`${granularity}: old and new endpoints report identical radiation totals per bucket`, mismatches.length === 0, mismatches);
    }
  }

  console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
