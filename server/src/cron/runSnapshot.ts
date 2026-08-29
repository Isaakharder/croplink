// One-shot entry point for the "croplink-snapshot-cron" Railway service.
// Meant to run once daily, before greenhouse work begins, on a fixed UTC
// schedule. Calls POST /snapshots/run on the main API service for the
// current UTC year, with a date-derived runId so a same-day retry (a
// misfire, a manual re-run) is idempotent rather than creating a second
// snapshot run for the day -- see projectionSnapshotService's immutability
// guarantees, proven idempotent under retry in Round 10's verification.
import { createHash } from 'crypto';
import { callInternalOps } from './internalOpsClient';

interface SnapshotResponse {
  runId: string;
  varietiesSnapshotted: number;
}

const REQUEST_TIMEOUT_MS = Number(process.env.SNAPSHOT_CRON_TIMEOUT_MS) || 90_000;

function todayUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

// projection_snapshots.snapshot_run_id is a `uuid` column, so the runId sent
// to /snapshots/run must itself be a valid UUID -- a plain "daily-<date>"
// string is rejected by Postgres. A deterministic UUIDv5 (RFC 4122, hashed
// from the UTC date) keeps the property that motivated a date-derived id in
// the first place: a same-day retry (misfire, manual re-run) reproduces the
// exact same runId and is idempotent, while the next day's run gets a
// genuinely different one.
const SNAPSHOT_CRON_NAMESPACE = '6f6dc9be-8b8e-4d0d-9f57-2fbb9e8e6a11';
function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(Buffer.concat([namespaceBytes, Buffer.from(name, 'utf8')])).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 4122
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function main(): Promise<number> {
  const year = new Date().getUTCFullYear();
  const runId = uuidV5(`croplink-daily-snapshot-${todayUtcDateKey()}`, SNAPSHOT_CRON_NAMESPACE);
  console.log(`[snapshot-cron] POST /api/climate/snapshots/run (year=${year}, runId=${runId}, timeoutMs=${REQUEST_TIMEOUT_MS})`);
  const result = (await callInternalOps('/api/climate/snapshots/run', { year, runId }, REQUEST_TIMEOUT_MS)) as SnapshotResponse;
  console.log(`[snapshot-cron] runId=${result.runId} varietiesSnapshotted=${result.varietiesSnapshotted}`);
  return 0;
}

// See processRollup.ts for why this sets exitCode and lets Node exit
// naturally instead of calling process.exit() directly.
main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    console.error(`[snapshot-cron] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
