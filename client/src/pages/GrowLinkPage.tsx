import { useState, useEffect, useCallback, useMemo } from 'react';
import { Variety, GrowlinkVarietyLink, GrowlinkHarvestActual, GrowlinkLinkStatus } from '../types';
import { varietiesApi, growlinkVarietyLinksApi, growlinkHarvestActualsApi } from '../services/api';

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

function formatDateTime(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

// ─── VarietyLinkModal ─────────────────────────────────────────────────────────

function VarietyLinkModal({
  initial,
  presetVariety,
  varietyOptions,
  onSave,
  onClose,
}: {
  initial?: GrowlinkVarietyLink | null;
  presetVariety?: Variety | null;
  varietyOptions: Variety[];
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!varietyId) return setError('Variety is required');
    if (!growlinkKey.trim()) return setError('GrowLink variety key is required');
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
            <label className="form-label">GrowLink Variety Key *</label>
            <input
              className="form-control"
              value={growlinkKey}
              onChange={e => setGrowlinkKey(e.target.value)}
              placeholder="e.g. GL-VAR-00231"
            />
            <small style={{ display: 'block', marginTop: 4, opacity: 0.65, fontSize: '0.8em' }}>
              Stable identifier GrowLink uses for this variety
            </small>
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

function VarietyLinksTab() {
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [links, setLinks] = useState<GrowlinkVarietyLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ open: boolean; item?: GrowlinkVarietyLink | null; presetVariety?: Variety | null }>({ open: false });
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [error, setError] = useState('');

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
                  <th>GrowLink Key</th>
                  <th>Status</th>
                  <th>Last Synced</th>
                  <th>Notes</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {links.map(link => (
                  <tr key={link.id}>
                    <td style={{ fontWeight: 600 }}>{link.variety?.name ?? '—'}</td>
                    <td><code>{link.growlink_variety_key}</code></td>
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
                ))}
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
  const [matchFilter, setMatchFilter] = useState<'all' | 'matched' | 'unmatched'>('all');

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

  const years = useMemo(
    () => Array.from(new Set(actuals.map(a => a.year))).sort((a, b) => b - a),
    [actuals]
  );

  const filtered = useMemo(() => {
    return actuals.filter(a => {
      if (yearFilter !== '' && a.year !== yearFilter) return false;
      if (matchFilter === 'matched' && !a.variety_id) return false;
      if (matchFilter === 'unmatched' && a.variety_id) return false;
      return true;
    });
  }, [actuals, yearFilter, matchFilter]);

  const totalKg = filtered.reduce((s, a) => s + (a.kg != null ? Number(a.kg) : 0), 0);
  const unmatchedCount = filtered.filter(a => !a.variety_id).length;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div className="card-title" style={{ margin: 0 }}>Harvest Actuals</div>
        <button className="btn btn-secondary btn-sm" disabled title="GrowLink sync isn't set up yet">
          Sync Now
        </button>
      </div>

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
          <option value="all">All</option>
          <option value="matched">Matched to a variety</option>
          <option value="unmatched">Unmatched</option>
        </select>
      </div>

      {loading ? (
        <div className="loading">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          No harvest actuals yet. These records are populated automatically once GrowLink sync is enabled — there's nothing to enter here manually.
        </div>
      ) : (
        <>
          <div className="grid-3 mb-4">
            <div className="stat-card">
              <div className="stat-label">Records</div>
              <div className="stat-value" style={{ fontSize: 18 }}>{filtered.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Total kg</div>
              <div className="stat-value" style={{ fontSize: 18 }}>{totalKg.toFixed(1)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Unmatched</div>
              <div className="stat-value" style={{ fontSize: 18 }}>{unmatchedCount}</div>
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
                        <span className="badge badge-yellow" title={`GrowLink variety key: ${a.growlink_variety_key}`}>Unmatched</span>
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
        {tab === 'links' ? <VarietyLinksTab /> : <HarvestActualsTab />}
      </div>
    </>
  );
}
