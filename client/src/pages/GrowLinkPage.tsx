import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Variety,
  GrowlinkVarietyLink,
  GrowlinkHarvestActual,
  GrowlinkHarvestActualsSyncResult,
  GrowlinkLinkStatus,
  GrowlinkConnectionStatus,
} from '../types';
import {
  varietiesApi,
  growlinkVarietyLinksApi,
  growlinkHarvestActualsApi,
  growlinkConnectionApi,
} from '../services/api';

const STATUS_BADGE: Record<GrowlinkLinkStatus, string> = {
  linked: 'badge-green',
  unlinked: 'badge-gray',
  conflict: 'badge-red',
};

const STATUS_LABEL: Record<GrowlinkLinkStatus, string> = {
  linked: 'Linked',
  unlinked: 'Unlinked',
  conflict: 'Conflict',
};

const CONNECTION_STATUS_BADGE: Record<GrowlinkConnectionStatus, string> = {
  not_configured: 'badge-gray',
  connected: 'badge-green',
  connection_failed: 'badge-red',
};

const CONNECTION_STATUS_LABEL: Record<GrowlinkConnectionStatus, string> = {
  not_configured: 'Not Configured',
  connected: 'Connected',
  connection_failed: 'Connection Failed',
};

function formatDateTime(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

// A variety as reported by GrowLink's own API — not a CropLink DB entity, so
// it doesn't live in types/index.ts. Normalized defensively since the exact
// field names on GrowLink's side aren't something we control here.
interface GrowlinkRemoteVariety {
  id: string;
  name: string;
  color: string | null;
}

function normalizeGrowlinkVariety(raw: unknown): GrowlinkRemoteVariety | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = r.id ?? r.varietyId ?? r.variety_id ?? r.uuid;
  const name = r.name ?? r.varietyName ?? r.variety_name ?? r.label;
  if (typeof id !== 'string' || !id) return null;
  if (typeof name !== 'string' || !name) return null;
  const colorRaw = r.color ?? r.colour ?? null;
  const color = typeof colorRaw === 'string' && colorRaw.trim() ? colorRaw.trim() : null;
  return { id, name, color };
}

function normalizeGrowlinkVarieties(list: unknown[]): GrowlinkRemoteVariety[] {
  return list
    .map(normalizeGrowlinkVariety)
    .filter((v): v is GrowlinkRemoteVariety => v !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

type RemoteVarietiesState = 'loading' | 'ready' | 'unavailable';

// ─── GrowlinkConnectionCard ─────────────────────────────────────────────────

function GrowlinkConnectionCard({
  onVarietiesChange,
}: {
  onVarietiesChange: (varieties: GrowlinkRemoteVariety[] | null) => void;
}) {
  const [baseUrl, setBaseUrl] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [maskedKey, setMaskedKey] = useState<string | null>(null);
  const [status, setStatus] = useState<GrowlinkConnectionStatus>('not_configured');
  const [lastTestedAt, setLastTestedAt] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [varietyCount, setVarietyCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await growlinkConnectionApi.get();
      setBaseUrl(data.base_url ?? '');
      setHasKey(data.has_key);
      setMaskedKey(data.masked_key);
      setStatus(data.status);
      setLastTestedAt(data.last_tested_at);
      setLastError(data.last_error);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to load GrowLink connection settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!baseUrl.trim()) return setFormError('GrowLink API URL is required');
    if (!hasKey && !secretKey.trim()) return setFormError('Integration key is required');
    setSaving(true);
    try {
      const data = await growlinkConnectionApi.save({
        base_url: baseUrl.trim(),
        secret_key: secretKey.trim() || undefined,
      });
      setBaseUrl(data.base_url ?? '');
      setHasKey(data.has_key);
      setMaskedKey(data.masked_key);
      setStatus(data.status);
      setLastTestedAt(data.last_tested_at);
      setLastError(data.last_error);
      setSecretKey('');
      setVarietyCount(null);
      // base_url/key changed — the cached GrowLink variety list is stale until re-tested.
      onVarietiesChange(null);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setFormError('');
    if (!baseUrl.trim()) return setFormError('GrowLink API URL is required');
    if (!hasKey && !secretKey.trim()) return setFormError('Integration key is required');
    setTesting(true);
    try {
      const result = await growlinkConnectionApi.test({
        base_url: baseUrl.trim(),
        secret_key: secretKey.trim() || undefined,
      });
      if (result.ok) {
        setStatus('connected');
        setLastError(null);
        setVarietyCount(result.varietyCount);
        onVarietiesChange(normalizeGrowlinkVarieties(result.varieties));
      } else {
        setStatus('connection_failed');
        setLastError(result.error);
        setVarietyCount(null);
        onVarietiesChange(null);
      }
      setLastTestedAt(new Date().toISOString());
    } catch (err: unknown) {
      setStatus('connection_failed');
      setLastError(err instanceof Error ? err.message : 'Test failed');
      setVarietyCount(null);
      onVarietiesChange(null);
      setLastTestedAt(new Date().toISOString());
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <div className="card mb-4">
        <div className="loading">Loading…</div>
      </div>
    );
  }

  return (
    <div className="card mb-4">
      <div className="flex items-center justify-between mb-4">
        <div className="card-title" style={{ margin: 0 }}>GrowLink Connection</div>
        <span className={`badge ${CONNECTION_STATUS_BADGE[status]}`}>{CONNECTION_STATUS_LABEL[status]}</span>
      </div>

      {formError && <div className="alert alert-error mb-4">{formError}</div>}
      {!formError && status === 'connection_failed' && lastError && (
        <div className="alert alert-error mb-4">{lastError}</div>
      )}
      {!formError && status === 'connected' && varietyCount != null && (
        <div className="alert alert-success mb-4">
          Connected — {varietyCount} GrowLink {varietyCount === 1 ? 'variety' : 'varieties'} found.
        </div>
      )}

      <form onSubmit={handleSave}>
        <div className="grid-2">
          <div className="form-group">
            <label className="form-label">GrowLink API URL *</label>
            <input
              className="form-control"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="https://growlinkclient-production.up.railway.app"
            />
          </div>
          <div className="form-group">
            <label className="form-label">Integration Key {hasKey ? '' : '*'}</label>
            <input
              className="form-control"
              type="password"
              value={secretKey}
              onChange={e => setSecretKey(e.target.value)}
              placeholder="gki_..."
              autoComplete="off"
            />
            <small style={{ display: 'block', marginTop: 4, opacity: 0.65, fontSize: '0.8em' }}>
              {hasKey ? `Current key: ${maskedKey} — leave blank to keep it` : 'Not set yet'}
            </small>
          </div>
        </div>

        {lastTestedAt && (
          <div style={{ fontSize: '0.8em', opacity: 0.65, marginBottom: 12 }}>
            Last tested {formatDateTime(lastTestedAt)}
          </div>
        )}

        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save Connection'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={handleTest} disabled={testing}>
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── VarietyLinkModal ─────────────────────────────────────────────────────────

function VarietyLinkModal({
  initial,
  presetVariety,
  varietyOptions,
  links,
  remoteVarieties,
  remoteVarietiesState,
  onSave,
  onClose,
}: {
  initial?: GrowlinkVarietyLink | null;
  presetVariety?: Variety | null;
  varietyOptions: Variety[];
  links: GrowlinkVarietyLink[];
  remoteVarieties: GrowlinkRemoteVariety[] | null;
  remoteVarietiesState: RemoteVarietiesState;
  onSave: (link: GrowlinkVarietyLink) => void;
  onClose: () => void;
}) {
  const lockedVarietyName = initial?.variety?.name ?? presetVariety?.name ?? null;
  const [varietyId, setVarietyId] = useState(initial?.variety_id ?? presetVariety?.id ?? '');
  const [growlinkKey, setGrowlinkKey] = useState(initial?.growlink_variety_key ?? '');
  const [linkStatus, setLinkStatus] = useState<GrowlinkLinkStatus>(initial?.link_status ?? 'linked');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // A GrowLink variety can only back one local link at a time — hide options
  // already claimed by other links, but keep this link's own current choice
  // selectable.
  const usedGrowlinkKeys = useMemo(
    () => new Set(links.filter(l => l.id !== initial?.id).map(l => l.growlink_variety_key)),
    [links, initial]
  );

  const growlinkOptions = useMemo(() => {
    const base = (remoteVarieties ?? []).filter(v => v.id === growlinkKey || !usedGrowlinkKeys.has(v.id));
    if (growlinkKey && remoteVarietiesState === 'ready' && !base.some(v => v.id === growlinkKey)) {
      // Previously linked to a GrowLink variety that's no longer in the list
      // (renamed/removed upstream, or list not yet refreshed). Keep it
      // selectable so saving without changes doesn't silently clear it.
      base.unshift({ id: growlinkKey, name: 'Unmatched GrowLink variety', color: null });
    }
    return base;
  }, [remoteVarieties, remoteVarietiesState, growlinkKey, usedGrowlinkKeys]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!varietyId) return setError('Variety is required');
    if (!growlinkKey) return setError('Select a GrowLink variety');
    setSaving(true);
    try {
      let result: GrowlinkVarietyLink;
      if (initial?.id) {
        result = await growlinkVarietyLinksApi.update(initial.id, {
          growlink_variety_key: growlinkKey.trim(),
          link_status: linkStatus,
          notes: notes.trim() || null,
        });
      } else {
        result = await growlinkVarietyLinksApi.create({
          variety_id: varietyId,
          growlink_variety_key: growlinkKey.trim(),
          link_status: linkStatus,
          notes: notes.trim() || null,
        });
      }
      onSave(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">{initial ? 'Edit Variety Link' : 'New Variety Link'}</div>
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Variety *</label>
            {lockedVarietyName ? (
              <input className="form-control" value={lockedVarietyName} disabled />
            ) : (
              <select className="form-control" value={varietyId} onChange={e => setVarietyId(e.target.value)}>
                <option value="">— select variety —</option>
                {varietyOptions.map(v => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            )}
          </div>
          <div className="form-group">
            <label className="form-label">GrowLink Variety *</label>
            {remoteVarietiesState === 'unavailable' ? (
              <>
                <select className="form-control" disabled>
                  <option>Connect to GrowLink first.</option>
                </select>
                <small style={{ display: 'block', marginTop: 4, opacity: 0.65, fontSize: '0.8em' }}>
                  Configure and test the GrowLink Connection above to select a variety.
                </small>
              </>
            ) : (
              <select
                className="form-control"
                value={growlinkKey}
                disabled={remoteVarietiesState === 'loading'}
                onChange={e => setGrowlinkKey(e.target.value)}
              >
                <option value="">
                  {remoteVarietiesState === 'loading' ? 'Loading GrowLink varieties…' : '— select GrowLink variety —'}
                </option>
                {growlinkOptions.map(v => (
                  <option key={v.id} value={v.id} title={v.id}>
                    {v.name}{v.color ? ` (${v.color})` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="form-group">
            <label className="form-label">Link Status</label>
            <select className="form-control" value={linkStatus} onChange={e => setLinkStatus(e.target.value as GrowlinkLinkStatus)}>
              <option value="linked">Linked</option>
              <option value="unlinked">Unlinked</option>
              <option value="conflict">Conflict</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Notes</label>
            <input className="form-control" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes…" />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Link'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── VarietyLinksTab ────────────────────────────────────────────────────────

function VarietyLinksTab({
  remoteVarieties,
  remoteVarietiesState,
}: {
  remoteVarieties: GrowlinkRemoteVariety[] | null;
  remoteVarietiesState: RemoteVarietiesState;
}) {
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [links, setLinks] = useState<GrowlinkVarietyLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ open: boolean; item?: GrowlinkVarietyLink | null; presetVariety?: Variety | null }>({ open: false });
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [error, setError] = useState('');

  const remoteVarietiesById = useMemo(
    () => new Map((remoteVarieties ?? []).map(v => [v.id, v])),
    [remoteVarieties]
  );

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [v, l] = await Promise.all([varietiesApi.list(), growlinkVarietyLinksApi.list()]);
      setVarieties(v);
      setLinks(l);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load variety links');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const linkedVarietyIds = useMemo(() => new Set(links.map(l => l.variety_id)), [links]);
  const unlinkedVarieties = useMemo(
    () => varieties.filter(v => !linkedVarietyIds.has(v.id)),
    [varieties, linkedVarietyIds]
  );

  async function handleToggleStatus(link: GrowlinkVarietyLink) {
    const next: GrowlinkLinkStatus = link.link_status === 'linked' ? 'unlinked' : 'linked';
    try {
      const updated = await growlinkVarietyLinksApi.setStatus(link.id, next);
      setLinks(prev => prev.map(l => (l.id === updated.id ? updated : l)));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Update failed');
    }
  }

  async function handleDelete(id: string) {
    try {
      await growlinkVarietyLinksApi.delete(id);
      setLinks(prev => prev.filter(l => l.id !== id));
      setDeleteConfirm(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  if (loading) return <div className="loading">Loading…</div>;

  return (
    <>
      {error && <div className="alert alert-error mb-4">{error}</div>}

      <div className="card mb-4">
        <div className="flex items-center justify-between mb-4">
          <div className="card-title" style={{ margin: 0 }}>Variety Links</div>
          <button
            className="btn btn-primary btn-sm"
            disabled={unlinkedVarieties.length === 0}
            title={unlinkedVarieties.length === 0 ? 'Every variety already has a GrowLink link' : undefined}
            onClick={() => setModal({ open: true, item: null, presetVariety: null })}
          >
            + New Link
          </button>
        </div>
        {links.length === 0 ? (
          <div className="empty-state">No GrowLink variety links yet. Create one to map a local variety to GrowLink's variety key.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Variety</th>
                  <th>GrowLink Variety</th>
                  <th>Status</th>
                  <th>Last Synced</th>
                  <th>Notes</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {links.map(link => {
                  const remote = remoteVarietiesById.get(link.growlink_variety_key);
                  return (
                  <tr key={link.id}>
                    <td style={{ fontWeight: 600 }}>{link.variety?.name ?? '—'}</td>
                    <td>
                      {remote ? (
                        <span title={remote.id}>{remote.name}{remote.color ? ` (${remote.color})` : ''}</span>
                      ) : (
                        <span className="badge badge-yellow" title={link.growlink_variety_key}>Unresolved</span>
                      )}
                    </td>
                    <td><span className={`badge ${STATUS_BADGE[link.link_status]}`}>{STATUS_LABEL[link.link_status]}</span></td>
                    <td>{formatDateTime(link.last_synced_at)}</td>
                    <td style={{ color: 'var(--gray-500)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {link.notes ?? '—'}
                    </td>
                    <td>
                      <div className="flex gap-2">
                        <button className="btn btn-secondary btn-sm" onClick={() => setModal({ open: true, item: link, presetVariety: null })}>
                          Edit
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => handleToggleStatus(link)}>
                          {link.link_status === 'linked' ? 'Unlink' : 'Link'}
                        </button>
                        {deleteConfirm === link.id ? (
                          <>
                            <button className="btn btn-danger btn-sm" onClick={() => handleDelete(link.id)}>Confirm</button>
                            <button className="btn btn-secondary btn-sm" onClick={() => setDeleteConfirm(null)}>Cancel</button>
                          </>
                        ) : (
                          <button className="btn btn-danger btn-sm" onClick={() => setDeleteConfirm(link.id)}>Delete</button>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 12 }}>Unlinked Varieties</div>
        {unlinkedVarieties.length === 0 ? (
          <div className="empty-state">Every variety has a GrowLink link.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Variety</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {unlinkedVarieties.map(v => (
                  <tr key={v.id}>
                    <td style={{ fontWeight: 600 }}>{v.name}</td>
                    <td>
                      <span className={`badge ${v.is_active ? 'badge-green' : 'badge-gray'}`}>
                        {v.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <button className="btn btn-primary btn-sm" onClick={() => setModal({ open: true, item: null, presetVariety: v })}>
                        + Link
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal.open && (
        <VarietyLinkModal
          initial={modal.item}
          presetVariety={modal.presetVariety}
          varietyOptions={unlinkedVarieties}
          links={links}
          remoteVarieties={remoteVarieties}
          remoteVarietiesState={remoteVarietiesState}
          onSave={link => {
            setLinks(prev => {
              const exists = prev.find(l => l.id === link.id);
              return exists ? prev.map(l => (l.id === link.id ? link : l)) : [...prev, link];
            });
            setModal({ open: false });
          }}
          onClose={() => setModal({ open: false })}
        />
      )}
    </>
  );
}

// ─── HarvestActualsTab (read-only) ──────────────────────────────────────────

function HarvestActualsTab() {
  const [actuals, setActuals] = useState<GrowlinkHarvestActual[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [yearFilter, setYearFilter] = useState<number | ''>('');
  // Defaults to matched-only: unmatched records (varieties not yet added to
  // CropLink) are normal, expected, and intentionally excluded from the
  // default view and from every total on this page — they're not a broken
  // or incomplete sync, just not set up for reporting yet. Switching this
  // filter is the "collapsed section" a grower opens to audit them.
  const [matchFilter, setMatchFilter] = useState<'matched' | 'unmatched' | 'all'>('matched');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [syncResult, setSyncResult] = useState<GrowlinkHarvestActualsSyncResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await growlinkHarvestActualsApi.list();
      setActuals(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load harvest actuals');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSync() {
    setSyncing(true);
    setSyncError('');
    setSyncResult(null);
    try {
      const result = await growlinkHarvestActualsApi.sync();
      setSyncResult(result);
      await load();
    } catch (err: unknown) {
      setSyncError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  const years = useMemo(
    () => Array.from(new Set(actuals.map(a => a.year))).sort((a, b) => b - a),
    [actuals]
  );

  const byYear = useMemo(
    () => actuals.filter(a => yearFilter === '' || a.year === yearFilter),
    [actuals, yearFilter]
  );

  // The table respects the Match filter (default: matched-only) so a
  // grower can deliberately open it up to audit unmatched records.
  const filtered = useMemo(
    () => byYear.filter(a => {
      if (matchFilter === 'matched') return a.variety_id != null;
      if (matchFilter === 'unmatched') return a.variety_id == null;
      return true;
    }),
    [byYear, matchFilter]
  );

  // Every number reported as a "total" on this page is matched-only,
  // unconditionally — independent of whatever the Match filter is currently
  // showing in the table below, so switching the filter to inspect
  // unmatched rows can never leak them into a total.
  const matchedInYear = useMemo(() => byYear.filter(a => a.variety_id != null), [byYear]);
  const unmatchedInYear = useMemo(() => byYear.filter(a => a.variety_id == null), [byYear]);
  const totalKg = matchedInYear.reduce((s, a) => s + (a.kg != null ? Number(a.kg) : 0), 0);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div className="card-title" style={{ margin: 0 }}>Harvest Actuals</div>
        <button className="btn btn-secondary btn-sm" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync Now'}
        </button>
      </div>

      {syncError && <div className="alert alert-error mb-4">{syncError}</div>}
      {syncResult && (
        <div className="climate-info-banner mb-4">
          <div className="climate-info-banner-title">Sync complete</div>
          <p>
            Fetched {syncResult.fetched} record{syncResult.fetched === 1 ? '' : 's'} from GrowLink —{' '}
            {syncResult.created} new, {syncResult.updated} updated, {syncResult.unchanged} unchanged
            {syncResult.skipped > 0 ? `, ${syncResult.skipped} skipped (malformed)` : ''}.
          </p>
          <p>
            {syncResult.matched} matched to a variety already set up in CropLink
            {syncResult.unmatched > 0
              ? `. ${syncResult.unmatched} are for varieties not yet added here — stored for when you add and link them, not shown in totals until then.`
              : '.'}
          </p>
        </div>
      )}

      {error && <div className="alert alert-error mb-4">{error}</div>}

      <div className="flex gap-2 items-center mb-4">
        <label>Year</label>
        <select
          className="form-control"
          style={{ width: 140 }}
          value={yearFilter}
          onChange={e => setYearFilter(e.target.value ? Number(e.target.value) : '')}
        >
          <option value="">All years</option>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <label>Match</label>
        <select
          className="form-control"
          style={{ width: 180 }}
          value={matchFilter}
          onChange={e => setMatchFilter(e.target.value as typeof matchFilter)}
        >
          <option value="matched">Matched to a variety</option>
          <option value="unmatched">Not yet linked{unmatchedInYear.length > 0 ? ` (${unmatchedInYear.length})` : ''}</option>
          <option value="all">All</option>
        </select>
      </div>

      {loading ? (
        <div className="loading">Loading…</div>
      ) : actuals.length === 0 ? (
        <div className="empty-state">
          No harvest actuals yet. Click "Sync Now" to pull the latest records from GrowLink.
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          {matchFilter === 'matched'
            ? unmatchedInYear.length > 0
              ? `No records yet for varieties set up in CropLink. ${unmatchedInYear.length} record${unmatchedInYear.length === 1 ? ' is' : 's are'} stored for varieties not linked yet — switch Match to "Not yet linked" to see them.`
              : 'No harvest actuals for this year.'
            : 'No records match this filter.'}
        </div>
      ) : (
        <>
          {matchFilter !== 'matched' && (
            <div className="climate-info-banner mb-4">
              This view includes records for varieties not yet added to CropLink — they're excluded from totals, Projected vs Actual, and dashboards until you add and link the variety, then Sync Now again.
            </div>
          )}
          <div className="grid-3 mb-4">
            <div className="stat-card">
              <div className="stat-label">Matched Records</div>
              <div className="stat-value" style={{ fontSize: 18 }}>{matchedInYear.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Matched Total kg</div>
              <div className="stat-value" style={{ fontSize: 18 }}>{totalKg.toFixed(1)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Not Yet Linked</div>
              <div className="stat-value" style={{ fontSize: 18 }}>{unmatchedInYear.length}</div>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Harvest Date</th>
                  <th>Year / Week</th>
                  <th>Variety</th>
                  <th>GrowLink Harvest Key</th>
                  <th>kg</th>
                  <th>Cases</th>
                  <th>Case Weight (kg)</th>
                  <th>Synced At</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(a => (
                  <tr key={a.id}>
                    <td>{a.harvest_date}</td>
                    <td>{a.year} / Wk {a.week_number}</td>
                    <td>
                      {a.variety?.name ? (
                        a.variety.name
                      ) : (
                        <span className="badge badge-gray" title={`GrowLink variety key: ${a.growlink_variety_key}`}>Not yet linked</span>
                      )}
                    </td>
                    <td><code>{a.growlink_harvest_key}</code></td>
                    <td>{a.kg != null ? Number(a.kg).toFixed(1) : '—'}</td>
                    <td>{a.cases ?? '—'}</td>
                    <td>{a.case_weight_kg ?? '—'}</td>
                    <td>{formatDateTime(a.synced_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ─── GrowLinkPage ───────────────────────────────────────────────────────────

export function GrowLinkPage() {
  const [tab, setTab] = useState<'links' | 'actuals'>('links');
  const [remoteVarieties, setRemoteVarieties] = useState<GrowlinkRemoteVariety[] | null>(null);
  const [remoteVarietiesState, setRemoteVarietiesState] = useState<RemoteVarietiesState>('loading');

  // Populates the GrowLink Variety dropdown from the saved connection, without
  // requiring the user to click "Test Connection" first.
  const refreshRemoteVarieties = useCallback(async () => {
    setRemoteVarietiesState('loading');
    try {
      const result = await growlinkConnectionApi.test();
      if (result.ok) {
        setRemoteVarieties(normalizeGrowlinkVarieties(result.varieties));
        setRemoteVarietiesState('ready');
      } else {
        setRemoteVarieties(null);
        setRemoteVarietiesState('unavailable');
      }
    } catch {
      setRemoteVarieties(null);
      setRemoteVarietiesState('unavailable');
    }
  }, []);

  useEffect(() => { refreshRemoteVarieties(); }, [refreshRemoteVarieties]);

  function handleConnectionVarietiesChange(varieties: GrowlinkRemoteVariety[] | null) {
    setRemoteVarieties(varieties);
    setRemoteVarietiesState(varieties ? 'ready' : 'unavailable');
  }

  return (
    <>
      <div className="page-header">
        <h2>GrowLink</h2>
        <div className="flex gap-2">
          <button
            className={`btn btn-sm ${tab === 'links' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setTab('links')}
          >
            Variety Links
          </button>
          <button
            className={`btn btn-sm ${tab === 'actuals' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setTab('actuals')}
          >
            Harvest Actuals
          </button>
        </div>
      </div>

      <div className="page-body">
        <GrowlinkConnectionCard onVarietiesChange={handleConnectionVarietiesChange} />
        {tab === 'links' ? (
          <VarietyLinksTab remoteVarieties={remoteVarieties} remoteVarietiesState={remoteVarietiesState} />
        ) : (
          <HarvestActualsTab />
        )}
      </div>
    </>
  );
}
