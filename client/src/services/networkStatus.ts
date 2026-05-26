import { useEffect, useState } from 'react';
import {
  getPendingCount,
  onQueueChange,
  resetFailedToPending,
  syncQueue,
} from './offlineQueue';

export type SyncStatus = 'online' | 'offline' | 'syncing' | 'synced' | 'error';

// ── Module-level state ────────────────────────────────────────────────────────

let _status: SyncStatus = navigator.onLine ? 'online' : 'offline';
let _pendingCount = 0;
let _syncError: string | null = null;

type StatusListener = (status: SyncStatus, pending: number, error: string | null) => void;
const listeners = new Set<StatusListener>();

function notify() {
  listeners.forEach((fn) => fn(_status, _pendingCount, _syncError));
}

function setStatus(s: SyncStatus, err: string | null = null) {
  _status = s;
  _syncError = err;
  notify();
}

async function refreshPendingCount() {
  _pendingCount = await getPendingCount();
  notify();
}

// ── Sync orchestration ────────────────────────────────────────────────────────

let syncInFlight = false;

export async function triggerSync(): Promise<void> {
  if (syncInFlight || !navigator.onLine) return;
  const count = await getPendingCount();
  if (count === 0) {
    setStatus('online');
    return;
  }

  syncInFlight = true;
  setStatus('syncing');

  try {
    // Reset previously failed actions so they get a fresh attempt
    await resetFailedToPending();
    const result = await syncQueue();
    _pendingCount = result.remaining;

    if (result.failed > 0) {
      setStatus('error', `${result.failed} action(s) failed to sync`);
    } else if (result.remaining > 0) {
      // Some actions still blocked (unresolved deps) — try again on next online event
      setStatus('online');
    } else {
      setStatus('synced');
      // Revert to 'online' after a brief visual confirmation
      setTimeout(() => {
        if (_status === 'synced') setStatus('online');
        notify();
      }, 2500);
    }
  } catch (err) {
    setStatus('error', err instanceof Error ? err.message : 'Sync failed');
  } finally {
    syncInFlight = false;
    await refreshPendingCount();
  }
}

// ── Network event wiring ──────────────────────────────────────────────────────

window.addEventListener('online', () => {
  setStatus('online');
  triggerSync();
});

window.addEventListener('offline', () => {
  setStatus('offline');
});

// Keep pending count in sync with queue changes
onQueueChange(refreshPendingCount);

// Initialise
refreshPendingCount();
if (navigator.onLine) {
  triggerSync();
}

// ── Public observer ───────────────────────────────────────────────────────────

export function subscribe(fn: StatusListener): () => void {
  listeners.add(fn);
  fn(_status, _pendingCount, _syncError);
  return () => listeners.delete(fn);
}

// ── React hooks ───────────────────────────────────────────────────────────────

export function useNetworkStatus() {
  const [state, setState] = useState<{ status: SyncStatus; pending: number; error: string | null }>({
    status: _status,
    pending: _pendingCount,
    error: _syncError,
  });

  useEffect(() => {
    return subscribe((status, pending, error) => {
      setState({ status, pending, error });
    });
  }, []);

  return state;
}
