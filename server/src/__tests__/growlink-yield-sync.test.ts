/**
 * GrowLink v2 yield-detail sync: contract validation, pagination/resume,
 * authorization (GrowLink key + CropLink internal-ops route), provisional vs
 * settled, late edits, raw preservation and derived AFW, tombstones, and
 * manifest-verified deletion reconciliation. Runs against a fake GrowLink
 * (fetch implementation of the v2 contract) and an in-memory repository.
 *
 * Run with: npx tsx src/__tests__/growlink-yield-sync.test.ts
 */
import { createHash } from 'crypto';
import type { AddressInfo } from 'net';
import {
  V2YieldWeekItem, V2ManifestHeader, V2ManifestPage, StoredYieldWeek, Revision, SUPPORTED_MANIFEST_ALGORITHM,
  validateYieldWeekItem, payloadSha256, deriveWeeklyAfw, keyFingerprint, verifyManifest, manifestChecksum, planMissingReconciliation, toStoredRow,
} from '../lib/growlinkYieldSync';
import { createGrowlinkV2Client } from '../lib/growlinkV2Client';
import { runYieldWeekSync, runDeletionSync, runManifestReconciliation, YieldWeekRepo, SyncRun, SyncEndpoint } from '../lib/growlinkYieldSyncRunner';

let pass = 0;
let fail = 0;
function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); fail++; }
}
function assertClose(label: string, actual: number, expected: number, tol = 1e-9): void {
  if (Math.abs(actual - expected) <= tol) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label} — expected ~${expected}, got ${actual}`); fail++; }
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VARIETY = 'f25660ec-0000-4000-8000-000000000001';

function item(n: number, overrides: Partial<V2YieldWeekItem> = {}): V2YieldWeekItem {
  return {
    yieldEntryId: uuid(n), varietyId: VARIETY, varietyName: 'Mathieu', packingYear: 2026, packingWeek: 30 + (n % 10), packedDate: '2026-07-24',
    totalKg: 1000 + n, averageFruitWeightG: 210, totalCases: 200, sizeKg: { xl: 600, l: 400 + n }, kgPerM2: 0.09, daily: [],
    dailyBreakdownComplete: true, lastWriteSource: 'import_pdf', varietyAreaM2: 11627, varietyUpdatedAt: '2026-05-25T19:40:39Z',
    physicalAreaM2: 11600.5, physicalAreaRowCount: 40, physicalAreaRowsMissingDimensions: 0,
    createdAt: '2026-07-24T10:00:00Z', updatedAt: `2026-07-25T10:00:${String(n % 60).padStart(2, '0')}.000000+00:00`,
    settlement: { status: 'provisional', settledAt: null, reason: 'week has not been over for 10 days yet' },
    ...overrides,
  };
}

// ── Fake GrowLink (v2 contract) ─────────────────────────────────────────────
const VALID_KEY = 'gki_test_detail_key_0123456789abcdef';
const V1_KEY = 'gki_test_v1_only';
class FakeGrowlink {
  items: V2YieldWeekItem[] = [];
  tombstones: { tombstoneId: string; yieldEntryId: string; varietyId: string | null; packingYear: number | null; packingWeek: number | null; deletedAt: string }[] = [];
  manifests = new Map<string, V2ManifestHeader & { ids: string[] }>();
  pageSize = 2;
  stallCursor = false;
  failOnPage: number | null = null;
  tamper: ((p: V2ManifestPage, i: number) => V2ManifestPage) | null = null;
  manifestCreatedAt = '2026-10-04T12:00:00.000Z';
  private calls = 0;

  private enc = (at: string, id: string) => Buffer.from(JSON.stringify({ at, id })).toString('base64url');
  private dec = (c: string) => JSON.parse(Buffer.from(c, 'base64url').toString()) as { at: string; id: string };

  private page<T>(list: T[], key: (t: T) => [string, string], cursor: string | null) {
    const sorted = [...list].sort((a, b) => { const [ua, ia] = key(a); const [ub, ib] = key(b); return ua < ub ? -1 : ua > ub ? 1 : ia.localeCompare(ib); });
    const c = cursor ? this.dec(cursor) : null;
    const after = c ? sorted.filter((t) => { const [u, i] = key(t); return u > c.at || (u === c.at && i > c.id); }) : sorted;
    const slice = after.slice(0, this.pageSize + 1);
    const hasMore = slice.length > this.pageSize;
    const items = slice.slice(0, this.pageSize);
    const last = items[items.length - 1];
    const lastKey = last ? key(last) : null;
    const next = hasMore && lastKey ? this.enc(lastKey[0], lastKey[1]) : null;
    return { items, nextCursor: this.stallCursor && hasMore ? cursor ?? next : next, resumeCursor: lastKey ? this.enc(lastKey[0], lastKey[1]) : cursor, hasMore, serverTime: '2026-10-04T12:00:00Z' };
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const key = (init?.headers as Record<string, string>)?.['X-Integration-Key'];
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (!key || (key !== VALID_KEY && key !== V1_KEY)) return json(401, { message: 'Invalid or revoked integration key.' });
    if (key === V1_KEY) return json(403, { message: 'Integration key lacks the yield-detail:read scope.' });
    this.calls++;
    if (this.failOnPage != null && this.calls === this.failOnPage) return json(500, { message: 'Failed to load yield weeks.' });
    const path = url.pathname.replace('/api/integrations/croplink/v2', '');
    const cursor = url.searchParams.get('cursor');
    if (path === '/yield-weeks') return json(200, this.page(this.items, (i) => [i.updatedAt, i.yieldEntryId], cursor));
    if (path === '/yield-week-deletions') return json(200, this.page(this.tombstones, (t) => [t.deletedAt, t.tombstoneId], cursor));
    if (path === '/yield-week-manifests' && init?.method === 'POST') {
      const ids = this.items.map((i) => i.yieldEntryId).sort();
      const m = { manifestId: uuid(900000 + this.manifests.size), expectedCount: ids.length, checksum: manifestChecksum(ids), algorithm: SUPPORTED_MANIFEST_ALGORITHM, createdAt: this.manifestCreatedAt, expiresAt: '2026-10-04T13:00:00.000Z', ids };
      this.manifests.set(m.manifestId, m);
      const { ids: _ids, ...header } = m;
      return json(201, header);
    }
    const mm = path.match(/^\/yield-week-manifests\/([^/]+)\/ids$/);
    if (mm) {
      const m = this.manifests.get(mm[1])!;
      const offset = Number(cursor ?? 0);
      const ids = m.ids.slice(offset, offset + this.pageSize);
      const next = offset + ids.length;
      const { ids: _ids, ...header } = m;
      let page: V2ManifestPage = { ...header, offset, ids, nextCursor: next < m.ids.length ? String(next) : null, hasMore: next < m.ids.length };
      if (this.tamper) page = this.tamper(page, offset / this.pageSize);
      return json(200, page);
    }
    return json(404, { message: 'not found' });
  };
  resetCalls() { this.calls = 0; }
}

class MemoryRepo implements YieldWeekRepo {
  rows = new Map<string, StoredYieldWeek>();
  revisions: Revision[] = [];
  runs: SyncRun[] = [];
  cursors = new Map<SyncEndpoint, string>();
  failIds = new Set<string>();
  async getCursor(e: SyncEndpoint) { return this.cursors.get(e) ?? null; }
  async setCursor(e: SyncEndpoint, c: string) { this.cursors.set(e, c); }
  async getByIds(ids: string[]) { return ids.map((i) => this.rows.get(i)).filter((r): r is StoredYieldWeek => !!r).map((r) => structuredClone(r)); }
  async getAllForReconciliation() { return [...this.rows.values()].map((r) => structuredClone(r)); }
  async writeRows(rows: StoredYieldWeek[]) {
    if (rows.some((r) => this.failIds.has(r.growlink_yield_entry_id))) return 'simulated check-constraint violation';
    for (const r of rows) this.rows.set(r.growlink_yield_entry_id, structuredClone(r));
    return null;
  }
  async insertRevisions(revs: Revision[]) { this.revisions.push(...revs); }
  async saveRun(run: SyncRun) { const i = this.runs.findIndex((r) => r.id === run.id); if (i >= 0) this.runs[i] = { ...run }; else this.runs.push({ ...run }); }
}

let idSeq = 0;
const newId = () => uuid(500000 + ++idSeq);
const setup = () => {
  const gl = new FakeGrowlink();
  const repo = new MemoryRepo();
  const deps = (key = VALID_KEY) => ({ client: createGrowlinkV2Client({ baseUrl: 'https://growlink.test', key, fetchImpl: gl.fetch }), repo, newId, now: () => new Date('2026-10-04T12:00:00Z') });
  return { gl, repo, deps };
};

(async () => {
  console.log('contract validation');
  assert('valid item', validateYieldWeekItem(item(1)), null);
  assert('2026 packing W53 accepted', validateYieldWeekItem(item(1, { packingWeek: 53 })), null);
  assert('2025 packing W53 rejected', validateYieldWeekItem(item(1, { packingYear: 2025, packingWeek: 53 })), 'invalid packing week 53 for 2025');
  assert('negative AFW rejected', validateYieldWeekItem(item(1, { averageFruitWeightG: -1 })), 'invalid averageFruitWeightG');
  assert('implausible AFW rejected', validateYieldWeekItem(item(1, { averageFruitWeightG: 5000 })), 'averageFruitWeightG implausible (> 2000 g)');
  assert('bad daily date rejected', validateYieldWeekItem(item(1, { daily: [{ breakdownId: 'b', packedDate: '18/09/2026', totalKg: 1, averageFruitWeightG: 200, sizeKg: {}, updatedAt: '2026-09-18T00:00:00Z' }] })), 'invalid daily packedDate');
  assert('settled without settledAt rejected', validateYieldWeekItem(item(1, { settlement: { status: 'settled', settledAt: null, reason: '' } })), 'settled without settledAt');
  assert('unknown settlement status rejected', validateYieldWeekItem(item(1, { settlement: { status: 'final' as 'settled', settledAt: null, reason: '' } })), 'invalid settlement.status');
  assert('non-uuid id rejected', validateYieldWeekItem(item(1, { yieldEntryId: '42' })), 'invalid yieldEntryId');
  assert('negative physical area rejected', validateYieldWeekItem(item(1, { physicalAreaM2: -5 })), 'invalid physicalAreaM2');
  assert('more undimensioned rows than rows rejected', validateYieldWeekItem(item(1, { physicalAreaRowCount: 2, physicalAreaRowsMissingDimensions: 3 })), 'invalid physicalAreaRowsMissingDimensions');
  assert('no footprint (null area, 0 rows) accepted', validateYieldWeekItem(item(1, { physicalAreaM2: null, physicalAreaRowCount: 0, physicalAreaRowsMissingDimensions: 0 })), null);

  console.log('raw preservation, packing-week naming, derived AFW');
  {
    const it = item(7, { daily: [
      { breakdownId: 'b1', packedDate: '2026-07-21', totalKg: 400, averageFruitWeightG: 200, sizeKg: {}, updatedAt: '2026-07-21T10:00:00Z' },
      { breakdownId: 'b2', packedDate: '2026-07-24', totalKg: 607, averageFruitWeightG: 230, sizeKg: {}, updatedAt: '2026-07-24T10:00:00Z' },
    ] });
    const row = toStoredRow(it, 'run-1', '2026-10-04T12:00:00Z');
    assert('raw payload stored verbatim', row.raw_payload, it);
    assert('upstream ids and exact timestamp kept', [row.growlink_yield_entry_id, row.growlink_variety_id, row.upstream_updated_at_raw], [uuid(7), VARIETY, it.updatedAt]);
    assert('both area figures kept with their provenance', [row.variety_area_m2, row.physical_area_m2, row.physical_area_row_count], [11627, 11600.5, 40]);
    assert('weeks stored as packing weeks only', Object.keys(row).filter((k) => /week|year/.test(k)).sort(), ['packing_week', 'packing_year']);
    const reordered = JSON.parse(JSON.stringify({ ...it, sizeKg: { l: it.sizeKg.l, xl: it.sizeKg.xl } }));
    assert('payload hash ignores key order', payloadSha256(reordered), payloadSha256(it));
    assert('payload hash ignores settlement', payloadSha256({ ...it, settlement: { status: 'settled', settledAt: '2026-08-04T04:00:00Z', reason: 'x' } }), payloadSha256(it));
    const afw = deriveWeeklyAfw(it);
    assertClose('AFW combines daily rows as total grams / total fruit when the breakdown is complete', afw.afwG!, (1007 * 1000) / (400_000 / 200 + 607_000 / 230));
    assert('…with method and version recorded', [afw.method, afw.version], ['daily-fruit-weighted', 'afw-v1']);
    assert('falls back to entry-level AFW after a manual edit', deriveWeeklyAfw({ ...it, dailyBreakdownComplete: false }).method, 'entry-level');
    assert('unavailable when nothing is recorded', deriveWeeklyAfw({ ...it, averageFruitWeightG: null, daily: [] }).afwG, null);
  }

  console.log('pagination and resume');
  {
    const { gl, repo, deps } = setup();
    gl.items = [1, 2, 3, 4, 5].map((n) => item(n));
    const run = await runYieldWeekSync(deps());
    assert('5 rows over 3 pages', [run.status, run.pages, run.created, repo.rows.size], ['succeeded', 3, 5, 5]);
    assert('resume cursor persisted', repo.cursors.has('yield-weeks'), true);
    gl.items.push(item(6, { updatedAt: gl.items[4].updatedAt }), item(8, { updatedAt: '2026-07-26T00:00:00.000000+00:00' }));
    const run2 = await runYieldWeekSync(deps());
    assert('next run fetches only rows after the last stored one (incl. a same-timestamp tie)', [run2.fetched, run2.created], [2, 2]);
  }
  {
    const { gl, repo, deps } = setup();
    gl.items = [1, 2, 3, 4, 5].map((n) => item(n));
    gl.stallCursor = true;
    const run = await runYieldWeekSync(deps());
    assert('stalled cursor aborts without writing or moving the cursor', [run.status, repo.rows.size, repo.cursors.has('yield-weeks')], ['aborted', 0, false]);
  }
  {
    const { gl, repo, deps } = setup();
    gl.items = [1, 2, 3, 4, 5].map((n) => item(n));
    gl.failOnPage = 2;
    const run = await runYieldWeekSync(deps());
    assert('a failed page fails the run with nothing written and the cursor unchanged', [run.status, repo.rows.size, repo.cursors.has('yield-weeks')], ['failed', 0, false]);
  }
  {
    const { gl, repo, deps } = setup();
    gl.items = [1, 2, 3].map((n) => item(n));
    repo.failIds.add(uuid(2));
    const run = await runYieldWeekSync(deps());
    assert('one unwritable row: others written, run failed, cursor NOT advanced', [run.status, repo.rows.size, repo.cursors.has('yield-weeks'), run.rejected_records.map((r) => r.harvestId)], ['failed', 2, false, [uuid(2)]]);
    gl.items.push(item(9, { packingWeek: 99 }));
    repo.failIds.clear();
    const run2 = await runYieldWeekSync(deps());
    assert('retry writes the remaining row; invalid upstream item is reported, not stored', [run2.status, repo.rows.has(uuid(2)), repo.rows.has(uuid(9)), run2.rejected_records.map((r) => r.stage)], ['succeeded', true, false, ['validation']]);
  }

  console.log('authorization');
  {
    const { gl, deps, repo } = setup();
    gl.items = [item(1)];
    const wrong = await runYieldWeekSync(deps('gki_wrong'));
    assert('wrong GrowLink key → run failed with 401', [wrong.status, /returned 401/.test(wrong.error ?? '')], ['failed', true]);
    const v1 = await runYieldWeekSync(deps(V1_KEY));
    assert('v1-only key → 403 (scope missing)', /returned 403/.test(v1.error ?? ''), true);
    const ok = await runYieldWeekSync(deps());
    assert('run records a key fingerprint, never the key', [ok.key_fingerprint, JSON.stringify(repo.runs).includes(VALID_KEY)], [keyFingerprint(VALID_KEY), false]);
    assert('fingerprint is a 16-char sha256 prefix', keyFingerprint(VALID_KEY), createHash('sha256').update(VALID_KEY).digest('hex').slice(0, 16));
  }
  {
    process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy';
    process.env.INTERNAL_OPS_KEY = 'ops-secret-for-tests';
    const express = (await import('express')).default;
    const { createGrowlinkYieldWeeksRouter } = await import('../routes/growlinkYieldWeeks');
    const { gl, repo } = setup();
    gl.items = [item(1)];
    const env: NodeJS.ProcessEnv = { GROWLINK_BASE_URL: 'https://growlink.test', GROWLINK_CROPLINK_KEY: VALID_KEY };
    const app = express();
    app.use(express.json());
    app.use('/api/growlink/yield-weeks', createGrowlinkYieldWeeksRouter(repo, env, gl.fetch));
    const server = app.listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/growlink/yield-weeks/sync-internal`;
    const post = (headers: Record<string, string>, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert('no internal ops key → 401', (await post({})).status, 401);
    assert('wrong internal ops key → 401', (await post({ 'X-Internal-Ops-Key': 'nope' })).status, 401);
    assert('bad mode → 400', (await post({ 'X-Internal-Ops-Key': 'ops-secret-for-tests' }, { mode: 'everything' })).status, 400);
    const okRes = await post({ 'X-Internal-Ops-Key': 'ops-secret-for-tests' });
    const okBody = await okRes.json() as { runs: SyncRun[] };
    assert('valid key → 200 with both incremental runs', [okRes.status, okBody.runs.map((r) => [r.kind, r.status])], [200, [['yield-weeks', 'succeeded'], ['deletions', 'succeeded']]]);
    assert('response never contains the GrowLink key', JSON.stringify(okBody).includes(VALID_KEY), false);
    delete env.GROWLINK_CROPLINK_KEY;
    assert('missing GROWLINK_CROPLINK_KEY secret → 503', (await post({ 'X-Internal-Ops-Key': 'ops-secret-for-tests' })).status, 503);
    server.close();
  }

  console.log('provisional / settled and late edits');
  {
    const { gl, repo, deps } = setup();
    gl.items = [item(1)];
    await runYieldWeekSync(deps());
    assert('first seen as provisional', repo.rows.get(uuid(1))!.settlement_status, 'provisional');
    gl.items[0] = { ...gl.items[0], updatedAt: '2026-07-25T10:00:01.500000+00:00', settlement: { status: 'settled', settledAt: '2026-08-06T04:00:00.000Z', reason: 'settled' } };
    gl.items[0].updatedAt = repo.rows.get(uuid(1))!.upstream_updated_at_raw; // same data, newer settlement only
    gl.items[0] = { ...gl.items[0], updatedAt: gl.items[0].updatedAt };
    repo.cursors.delete('yield-weeks'); // re-read from the start
    await runYieldWeekSync(deps());
    assert('settlement-only change: status updated, no revision', [repo.rows.get(uuid(1))!.settlement_status, repo.revisions.length], ['settled', 0]);
    gl.items[0] = { ...gl.items[0], totalKg: 1500, updatedAt: '2026-10-03T09:00:00.000000+00:00', settlement: { status: 'provisional', settledAt: null, reason: 'changed within the last 3 days' } };
    const run = await runYieldWeekSync(deps());
    const rev = repo.revisions[0];
    assert('late edit to a settled week is recorded', [repo.revisions.length, rev.change_kind, rev.was_settled, rev.changed_fields.includes('totalKg')], [1, 'update', true, true]);
    assert('…with both payloads kept', [rev.previous_payload!.totalKg, rev.current_payload!.totalKg], [1001, 1500]);
    assert('…and the week is provisional again', [repo.rows.get(uuid(1))!.settlement_status, run.updated], ['provisional', 1]);
  }

  console.log('tombstones');
  {
    const { gl, repo, deps } = setup();
    gl.items = [1, 2].map((n) => item(n));
    await runYieldWeekSync(deps());
    gl.tombstones = [
      { tombstoneId: uuid(801), yieldEntryId: uuid(2), varietyId: VARIETY, packingYear: 2026, packingWeek: 32, deletedAt: '2026-10-02T00:00:00.000000+00:00' },
      { tombstoneId: uuid(802), yieldEntryId: uuid(77), varietyId: null, packingYear: null, packingWeek: null, deletedAt: '2026-10-02T00:00:01.000000+00:00' },
    ];
    const run = await runDeletionSync(deps());
    assert('tombstoned row marked deleted_upstream, never removed', [repo.rows.get(uuid(2))!.upstream_status, repo.rows.size], ['deleted_upstream', 2]);
    assert('unknown tombstones ignored and counted', [run.status, run.unchanged], ['succeeded', 1]);
    assert('deletion audited', repo.revisions.map((r) => r.change_kind), ['deleted_upstream']);
  }

  console.log('manifest verification (nothing marked unless every page proves one complete manifest)');
  {
    const header: V2ManifestHeader = { manifestId: uuid(1), expectedCount: 3, checksum: manifestChecksum([uuid(1), uuid(2), uuid(3)]), algorithm: SUPPORTED_MANIFEST_ALGORITHM, createdAt: '2026-10-04T12:00:00Z', expiresAt: '2026-10-04T13:00:00Z' };
    const pages: V2ManifestPage[] = [
      { ...header, offset: 0, ids: [uuid(1), uuid(2)], nextCursor: '2', hasMore: true },
      { ...header, offset: 2, ids: [uuid(3)], nextCursor: null, hasMore: false },
    ];
    assert('valid manifest verifies', [...verifyManifest(header, pages).ids].length, 3);
    const bad = (label: string, ps: V2ManifestPage[], h: V2ManifestHeader = header) => {
      try { verifyManifest(h, ps); assert(label, 'verified', 'rejected'); } catch { assert(label, 'rejected', 'rejected'); }
    };
    bad('page from a different manifest', [pages[0], { ...pages[1], manifestId: uuid(2) }]);
    bad('checksum mismatch', pages, { ...header, checksum: 'x' });
    bad('count mismatch', [pages[0], { ...pages[1], ids: [] }]);
    bad('offset gap', [pages[0], { ...pages[1], offset: 3 }]);
    bad('final page still says hasMore', [pages[0], { ...pages[1], hasMore: true, nextCursor: '3' }]);
    bad('missing final page', [pages[0]]);
    bad('unsupported algorithm', pages, { ...header, algorithm: 'md5' });
    bad('duplicate ids', [pages[0], { ...pages[1], ids: [uuid(2)] }], { ...header, checksum: manifestChecksum([uuid(1), uuid(2), uuid(2)]) });
  }

  console.log('deletion reconciliation');
  {
    const { gl, repo, deps } = setup();
    gl.items = Array.from({ length: 12 }, (_, i) => item(i + 1));
    await runYieldWeekSync(deps());
    const gone = gl.items.splice(4, 1)[0]; // deleted upstream with no tombstone (pre-trigger)
    let r = await runManifestReconciliation(deps());
    assert('first verified absence → candidate only', [r.status, r.manifest_verified, r.missing_candidates, repo.rows.get(gone.yieldEntryId)!.upstream_status], ['succeeded', true, 1, 'active']);
    r = await runManifestReconciliation(deps());
    assert('second consecutive verified absence → missing_upstream (kept, audited)', [r.marked_missing, repo.rows.get(gone.yieldEntryId)!.upstream_status, repo.revisions.at(-1)!.change_kind], [1, 'missing_upstream', 'missing_upstream']);
    gl.items.push(gone);
    r = await runManifestReconciliation(deps());
    assert('reappears upstream → restored', [r.restored, repo.rows.get(gone.yieldEntryId)!.upstream_status], [1, 'active']);

    const flaky = gl.items.splice(0, 1)[0];
    await runManifestReconciliation(deps()); // candidate
    gl.items.push(flaky);
    await runManifestReconciliation(deps()); // present → candidate cleared
    gl.items.splice(gl.items.indexOf(flaky), 1);
    r = await runManifestReconciliation(deps());
    assert('absences must be consecutive (an intervening sighting resets)', [r.marked_missing, repo.rows.get(flaky.yieldEntryId)!.upstream_status], [0, 'active']);
    gl.items.push(flaky);
    await runManifestReconciliation(deps());

    gl.tamper = (p, i) => (i === 1 ? { ...p, manifestId: uuid(424242) } : p);
    gl.items.splice(0, 1);
    r = await runManifestReconciliation(deps());
    assert('a page from another manifest aborts the run; nothing marked', [r.status, r.manifest_verified, r.missing_candidates, repo.runs.at(-1)!.status], ['aborted', false, null, 'aborted']);
    gl.tamper = (p) => ({ ...p, checksum: '0'.repeat(64) });
    r = await runManifestReconciliation(deps());
    assert('a checksum that does not match aborts the run', [r.status, r.manifest_verified], ['aborted', false]);
    gl.tamper = null;

    gl.items.splice(0, 3);
    r = await runManifestReconciliation(deps());
    assert('mass disappearance (>10% of active rows) is reported, not applied', [r.status, /not applied/.test(r.error ?? ''), [...repo.rows.values()].filter((x) => x.upstream_status !== 'active').length], ['aborted', true, 0]);
  }
  {
    const rows = [toStoredRow(item(1), 'r', '2026-10-04T00:00:00Z'), toStoredRow(item(2, { createdAt: '2026-10-04T12:30:00Z' }), 'r', '2026-10-04T12:31:00Z')];
    rows.forEach((x) => (x.missing_candidate_run_id = 'previous-run'));
    const plan = planMissingReconciliation(rows, { ids: new Set(), createdAt: '2026-10-04T12:00:00Z' }, 'run', '2026-10-04T12:40:00Z', 1);
    assert('rows created upstream after the manifest snapshot are never flagged', [plan.counts.considered, plan.counts.markedMissing, plan.updates.map((u) => u.growlink_yield_entry_id)], [1, 1, [uuid(1)]]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
