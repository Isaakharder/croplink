// Offline action queue backed by IndexedDB.
// Supports transparent offline creation of rows/stems/nodes and status upserts,
// with temp-ID dependency resolution on sync.

import { remapId } from './optimisticStore';

const DB_NAME = 'croplink-offline';
const DB_VERSION = 1;
const QUEUE_STORE = 'queue';
const TEMP_IDS_STORE = 'tempIds';
const API_BASE = `${import.meta.env.VITE_API_URL ?? ''}/api/projection`;

export type ActionType = 'create_row' | 'create_stem' | 'create_node' | 'upsert_status';

export interface QueuedAction {
  id: string;
  type: ActionType;
  payload: Record<string, unknown>;
  /** Temp ID assigned to the created entity (null for upsert_status). */
  tempId: string | null;
  /** Payload field names that may hold temp IDs to resolve before execution. */
  tempIdFields: string[];
  status: 'pending' | 'failed';
  error: string | null;
  createdAt: number;
}

// ── Low-level IDB helpers ────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        const store = db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
        store.createIndex('by_status', 'status');
        store.createIndex('by_createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(TEMP_IDS_STORE)) {
        db.createObjectStore(TEMP_IDS_STORE, { keyPath: 'tempId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Public queue API ─────────────────────────────────────────────────────────

export function newTempId(): string {
  return `temp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function isTempId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith('temp_');
}

let _db: IDBDatabase | null = null;

async function getDB(): Promise<IDBDatabase> {
  if (!_db) _db = await openDB();
  return _db;
}

export async function enqueue(action: Omit<QueuedAction, 'id' | 'status' | 'error' | 'createdAt'>): Promise<QueuedAction> {
  const db = await getDB();
  const entry: QueuedAction = {
    ...action,
    id: newTempId(),
    status: 'pending',
    error: null,
    createdAt: Date.now(),
  };
  await idbPut(db, QUEUE_STORE, entry);
  notifyListeners();
  return entry;
}

export async function getPending(): Promise<QueuedAction[]> {
  const db = await getDB();
  const all = await idbGetAll<QueuedAction>(db, QUEUE_STORE);
  return all.filter((a) => a.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
}

export async function getAll(): Promise<QueuedAction[]> {
  const db = await getDB();
  return idbGetAll<QueuedAction>(db, QUEUE_STORE);
}

export async function getPendingCount(): Promise<number> {
  return (await getPending()).length;
}

export async function markFailed(id: string, error: string): Promise<void> {
  const db = await getDB();
  const entry = await idbGet<QueuedAction>(db, QUEUE_STORE, id);
  if (!entry) return;
  await idbPut(db, QUEUE_STORE, { ...entry, status: 'failed', error });
  notifyListeners();
}

export async function remove(id: string): Promise<void> {
  const db = await getDB();
  await idbDelete(db, QUEUE_STORE, id);
  notifyListeners();
}

export async function clearFailed(): Promise<void> {
  const db = await getDB();
  const all = await idbGetAll<QueuedAction>(db, QUEUE_STORE);
  await Promise.all(all.filter((a) => a.status === 'failed').map((a) => idbDelete(db, QUEUE_STORE, a.id)));
  notifyListeners();
}

export async function resetFailedToPending(): Promise<void> {
  const db = await getDB();
  const all = await idbGetAll<QueuedAction>(db, QUEUE_STORE);
  await Promise.all(
    all
      .filter((a) => a.status === 'failed')
      .map((a) => idbPut(db, QUEUE_STORE, { ...a, status: 'pending', error: null }))
  );
  notifyListeners();
}

// ── Temp ID map ───────────────────────────────────────────────────────────────

export async function setTempIdMapping(tempId: string, realId: string): Promise<void> {
  const db = await getDB();
  await idbPut(db, TEMP_IDS_STORE, { tempId, realId });
}

export async function resolveTempId(tempId: string): Promise<string | null> {
  const db = await getDB();
  const entry = await idbGet<{ tempId: string; realId: string }>(db, TEMP_IDS_STORE, tempId);
  return entry?.realId ?? null;
}

/** Resolve temp IDs in the specified payload fields. Returns null if any required dep is unresolved. */
async function resolvePayloadDeps(
  payload: Record<string, unknown>,
  tempIdFields: string[]
): Promise<Record<string, unknown> | null> {
  const resolved = { ...payload };
  for (const field of tempIdFields) {
    const val = resolved[field];
    if (!isTempId(val)) continue;
    const realId = await resolveTempId(val);
    if (!realId) return null; // dependency not yet resolved
    resolved[field] = realId;
  }
  return resolved;
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export interface SyncResult {
  synced: number;
  failed: number;
  remaining: number;
}

async function apiFetch(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error((errBody as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined;
  return res.json();
}

async function executeAction(
  type: ActionType,
  payload: Record<string, unknown>
): Promise<string | null> {
  switch (type) {
    case 'create_row': {
      const r = await apiFetch('/rows', payload) as { id: string };
      return r.id;
    }
    case 'create_stem': {
      const r = await apiFetch('/stems', payload) as { id: string };
      return r.id;
    }
    case 'create_node': {
      const r = await apiFetch('/nodes', payload) as { id: string };
      return r.id;
    }
    case 'upsert_status': {
      await apiFetch('/weekly-statuses/upsert', payload);
      return null;
    }
  }
}

/**
 * Sync all pending actions. Uses multi-pass so dependency chains resolve.
 * A pass keeps going as long as at least one action was executed successfully.
 */
export async function syncQueue(): Promise<SyncResult> {
  let synced = 0;
  let anyProgress = true;

  while (anyProgress) {
    anyProgress = false;
    const pending = await getPending();
    if (pending.length === 0) break;

    for (const action of pending) {
      // Try to resolve payload dependencies
      const resolvedPayload = await resolvePayloadDeps(action.payload, action.tempIdFields);
      if (resolvedPayload === null) continue; // dependency not yet available — skip for now

      try {
        const realId = await executeAction(action.type, resolvedPayload);
        if (action.tempId && realId) {
          await setTempIdMapping(action.tempId, realId);
          const entityType = action.type === 'create_row' ? 'row' : action.type === 'create_stem' ? 'stem' : 'node';
          remapId(action.tempId, realId, entityType as 'row' | 'stem' | 'node');
        }
        await remove(action.id);
        synced++;
        anyProgress = true;
      } catch (err) {
        await markFailed(action.id, err instanceof Error ? err.message : String(err));
        // Don't stop — continue with other actions that might be independent
      }
    }
  }

  const remaining = await getPendingCount();
  const allAfter = await getAll();
  const failed = allAfter.filter((a) => a.status === 'failed').length;
  notifyListeners();
  return { synced, failed, remaining };
}

// ── Change listeners (for reactive UI) ───────────────────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();

export function onQueueChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners() {
  listeners.forEach((fn) => fn());
}
