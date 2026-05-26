import { useNetworkStatus, triggerSync } from '../services/networkStatus';

export function OfflineBanner() {
  const { status, pending, error } = useNetworkStatus();

  if (status === 'online' && pending === 0) return null;

  const isSyncing = status === 'syncing';
  const isOffline = status === 'offline';
  const isError   = status === 'error';
  const isSynced  = status === 'synced';

  let bannerClass = 'offline-banner';
  if (isOffline) bannerClass += ' offline-banner--offline';
  else if (isError) bannerClass += ' offline-banner--error';
  else if (isSynced) bannerClass += ' offline-banner--synced';
  else bannerClass += ' offline-banner--pending';

  let message = '';
  if (isOffline) {
    message = pending > 0
      ? `Offline — ${pending} change${pending !== 1 ? 's' : ''} pending sync`
      : 'Offline — changes will sync when connection returns';
  } else if (isSyncing) {
    message = 'Syncing…';
  } else if (isSynced) {
    message = 'Synced ✓';
  } else if (isError) {
    message = error ?? 'Sync error';
  } else if (pending > 0) {
    message = `${pending} change${pending !== 1 ? 's' : ''} pending sync`;
  }

  return (
    <div className={bannerClass} role="status" aria-live="polite">
      <span className="offline-banner-text">{message}</span>
      {!isOffline && !isSyncing && pending > 0 && (
        <button
          type="button"
          className="offline-banner-sync-btn"
          onClick={() => triggerSync()}
          disabled={isSyncing}
        >
          Sync now
        </button>
      )}
    </div>
  );
}
