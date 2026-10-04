// Orchestrates GrowLink v2 sync runs over an injectable repository so the
// whole flow is testable without a database. Every run is recorded; the
// resume cursor only advances when every row in the run was written.
import { writeWithRowFallback, RejectedRecord } from './growlinkHarvestSync';
import {
  StoredYieldWeek, Revision, V2ManifestPage, SyncAbort, ManifestVerificationError,
  collectPages, planYieldWeekUpserts, planTombstones, verifyManifest, planMissingReconciliation,
} from './growlinkYieldSync';
import { GrowlinkV2Client } from './growlinkV2Client';

export type SyncEndpoint = 'yield-weeks' | 'deletions';

export interface SyncRun {
  id: string;
  kind: 'yield-weeks' | 'deletions' | 'manifest-reconciliation';
  status: 'running' | 'succeeded' | 'failed' | 'aborted';
  started_at: string;
  finished_at: string | null;
  key_fingerprint: string;
  cursor_before: string | null;
  cursor_after: string | null;
  pages: number;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  rejected: number;
  rejected_records: RejectedRecord[];
  manifest_id: string | null;
  manifest_expected_count: number | null;
  manifest_checksum: string | null;
  manifest_verified: boolean | null;
  missing_candidates: number | null;
  marked_missing: number | null;
  restored: number | null;
  error: string | null;
}

export interface YieldWeekRepo {
  getCursor(endpoint: SyncEndpoint): Promise<string | null>;
  setCursor(endpoint: SyncEndpoint, cursor: string, keyFingerprint: string): Promise<void>;
  getByIds(ids: string[]): Promise<StoredYieldWeek[]>;
  getAllForReconciliation(): Promise<StoredYieldWeek[]>;
  /** Batch write; resolves to an error message or null. */
  writeRows(rows: StoredYieldWeek[], mode: 'insert' | 'update'): Promise<string | null>;
  insertRevisions(revisions: Revision[]): Promise<void>;
  saveRun(run: SyncRun): Promise<void>;
}

export interface RunnerDeps {
  client: GrowlinkV2Client;
  repo: YieldWeekRepo;
  now?: () => Date;
  newId: () => string;
}

const MAX_MANIFEST_PAGES = 10_000;

function newRun(deps: RunnerDeps, kind: SyncRun['kind'], cursorBefore: string | null): SyncRun {
  return {
    id: deps.newId(), kind, status: 'running', started_at: (deps.now?.() ?? new Date()).toISOString(), finished_at: null,
    key_fingerprint: deps.client.keyFingerprint, cursor_before: cursorBefore, cursor_after: null, pages: 0, fetched: 0, created: 0, updated: 0,
    unchanged: 0, rejected: 0, rejected_records: [], manifest_id: null, manifest_expected_count: null, manifest_checksum: null,
    manifest_verified: null, missing_candidates: null, marked_missing: null, restored: null, error: null,
  };
}

async function finish(deps: RunnerDeps, run: SyncRun, err?: unknown): Promise<SyncRun> {
  if (err) {
    run.status = err instanceof SyncAbort || err instanceof ManifestVerificationError ? 'aborted' : 'failed';
    run.error = err instanceof Error ? err.message : String(err);
  }
  run.finished_at = (deps.now?.() ?? new Date()).toISOString();
  await deps.repo.saveRun(run);
  return run;
}

/** Writes rows with per-row fallback; returns failures and the ids that were written. */
async function writeAll(repo: YieldWeekRepo, rows: StoredYieldWeek[], mode: 'insert' | 'update') {
  const res = await writeWithRowFallback(
    rows as unknown as Record<string, unknown>[],
    (batch) => repo.writeRows(batch as unknown as StoredYieldWeek[], mode),
    (row) => ({ harvestId: row.growlink_yield_entry_id as string, year: row.packing_year, week: row.packing_week })
  );
  const failedIds = new Set(res.failed.map((f) => f.harvestId));
  return { written: res.written, failed: res.failed, failedIds };
}

export async function runYieldWeekSync(deps: RunnerDeps): Promise<SyncRun> {
  const cursorBefore = await deps.repo.getCursor('yield-weeks');
  const run = newRun(deps, 'yield-weeks', cursorBefore);
  await deps.repo.saveRun(run);
  try {
    const collected = await collectPages((c) => deps.client.yieldWeeksPage(c), cursorBefore, (i) => String(i.yieldEntryId).toLowerCase());
    run.pages = collected.pages;
    run.fetched = collected.items.length;
    const ids = collected.items.map((i) => String(i.yieldEntryId).toLowerCase());
    const existing = new Map((await deps.repo.getByIds(ids)).map((r) => [r.growlink_yield_entry_id, r]));
    const plan = planYieldWeekUpserts(collected.items, existing, run.id, run.started_at);
    const ins = await writeAll(deps.repo, plan.inserts, 'insert');
    const upd = await writeAll(deps.repo, plan.updates, 'update');
    const failed = [...ins.failed, ...upd.failed];
    const failedIds = new Set([...ins.failedIds, ...upd.failedIds]);
    await deps.repo.insertRevisions(plan.revisions.filter((r) => !failedIds.has(r.growlink_yield_entry_id)));
    run.created = ins.written;
    run.updated = upd.written;
    run.unchanged = plan.counts.unchanged;
    run.rejected_records = [...plan.rejected, ...failed];
    run.rejected = run.rejected_records.length;
    if (failed.length === 0 && collected.resumeCursor) {
      await deps.repo.setCursor('yield-weeks', collected.resumeCursor, deps.client.keyFingerprint);
      run.cursor_after = collected.resumeCursor;
    }
    run.status = failed.length === 0 ? 'succeeded' : 'failed';
    if (failed.length) run.error = `${failed.length} row(s) failed to write; cursor not advanced so they are retried next run`;
    return finish(deps, run);
  } catch (e) {
    return finish(deps, run, e);
  }
}

export async function runDeletionSync(deps: RunnerDeps): Promise<SyncRun> {
  const cursorBefore = await deps.repo.getCursor('deletions');
  const run = newRun(deps, 'deletions', cursorBefore);
  await deps.repo.saveRun(run);
  try {
    const collected = await collectPages((c) => deps.client.deletionsPage(c), cursorBefore, (t) => String(t.tombstoneId));
    run.pages = collected.pages;
    run.fetched = collected.items.length;
    const existing = new Map((await deps.repo.getByIds(collected.items.map((t) => t.yieldEntryId.toLowerCase()))).map((r) => [r.growlink_yield_entry_id, r]));
    const plan = planTombstones(collected.items, existing, run.id, run.started_at);
    const upd = await writeAll(deps.repo, plan.updates, 'update');
    await deps.repo.insertRevisions(plan.revisions.filter((r) => !upd.failedIds.has(r.growlink_yield_entry_id)));
    run.updated = upd.written;
    run.unchanged = plan.unknown;
    run.rejected_records = upd.failed;
    run.rejected = upd.failed.length;
    if (upd.failed.length === 0 && collected.resumeCursor) {
      await deps.repo.setCursor('deletions', collected.resumeCursor, deps.client.keyFingerprint);
      run.cursor_after = collected.resumeCursor;
    }
    run.status = upd.failed.length === 0 ? 'succeeded' : 'failed';
    return finish(deps, run);
  } catch (e) {
    return finish(deps, run, e);
  }
}

export async function runManifestReconciliation(deps: RunnerDeps): Promise<SyncRun> {
  const run = newRun(deps, 'manifest-reconciliation', null);
  await deps.repo.saveRun(run);
  try {
    const header = await deps.client.createManifest();
    run.manifest_id = header.manifestId;
    run.manifest_expected_count = header.expectedCount;
    run.manifest_checksum = header.checksum;
    const pages: V2ManifestPage[] = [];
    let cursor: string | null = '0';
    while (cursor !== null) {
      if (pages.length >= MAX_MANIFEST_PAGES) throw new SyncAbort('manifest has too many pages');
      const page: V2ManifestPage = await deps.client.manifestPage(header.manifestId, cursor);
      pages.push(page);
      if (page.hasMore && page.nextCursor === cursor) throw new SyncAbort('manifest cursor did not advance');
      cursor = page.hasMore ? page.nextCursor : null;
    }
    run.pages = pages.length;
    run.manifest_verified = false;
    const verified = verifyManifest(header, pages); // throws ManifestVerificationError → aborted, nothing marked
    run.manifest_verified = true;
    run.fetched = verified.ids.size;
    const rows = await deps.repo.getAllForReconciliation();
    const plan = planMissingReconciliation(rows, verified, run.id, run.started_at);
    run.missing_candidates = plan.counts.newCandidates;
    run.marked_missing = plan.counts.markedMissing;
    run.restored = plan.counts.restored;
    if (plan.aborted) {
      run.status = 'aborted';
      run.error = plan.reason;
      return finish(deps, run);
    }
    const upd = await writeAll(deps.repo, plan.updates, 'update');
    await deps.repo.insertRevisions(plan.revisions.filter((r) => !upd.failedIds.has(r.growlink_yield_entry_id)));
    run.updated = upd.written;
    run.rejected_records = upd.failed;
    run.rejected = upd.failed.length;
    run.status = upd.failed.length === 0 ? 'succeeded' : 'failed';
    return finish(deps, run);
  } catch (e) {
    return finish(deps, run, e);
  }
}
