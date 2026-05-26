import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MobileRowCard, Variety } from '../types';
import { mobileRowsApi, rowsApi, varietiesApi } from '../services/api';
import { OfflineBanner } from '../components/OfflineBanner';
import { onRemap } from '../services/optimisticStore';

function getIsoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function TextPromptModal({
  title,
  label,
  defaultValue,
  onClose,
  onSave,
}: {
  title: string;
  label: string;
  defaultValue?: string;
  onClose: () => void;
  onSave: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(defaultValue ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) { setError(`${label} is required`); return; }
    setSaving(true);
    try {
      await onSave(value.trim());
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">{label}</label>
            <input className="form-control" value={value} onChange={e => setValue(e.target.value)} autoFocus />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function MobileMeasurementsPage() {
  const today = useMemo(() => new Date(), []);
  const currentYear = today.getFullYear();
  const currentWeek = getIsoWeek(today);
  const todayLabel = today.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  const navigate = useNavigate();

  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [rowCardsByVariety, setRowCardsByVariety] = useState<Record<string, MobileRowCard[] | undefined>>({});
  const [loadingVarieties, setLoadingVarieties] = useState(true);
  const [addRowTarget, setAddRowTarget] = useState<Variety | null>(null);

  useEffect(() => {
    setLoadingVarieties(true);
    varietiesApi
      .list(undefined, currentYear)
      .then(data => setVarieties(data.filter(v => v.is_active)))
      .finally(() => setLoadingVarieties(false));
  }, [currentYear]);

  useEffect(() => {
    varieties.forEach(variety => {
      mobileRowsApi.list(variety.id).then(cards => {
        setRowCardsByVariety(prev => ({ ...prev, [variety.id]: cards }));
      });
    });
  }, [varieties]);

  useEffect(() => {
    return onRemap((tempId, realId, type) => {
      if (type !== 'row') return;
      setRowCardsByVariety(prev => {
        const next: Record<string, MobileRowCard[] | undefined> = { ...prev };
        for (const varId of Object.keys(next)) {
          const cards = next[varId];
          if (cards) {
            next[varId] = cards.map(c => c.id === tempId ? { ...c, id: realId } : c);
          }
        }
        return next;
      });
    });
  }, []);

  async function handleAddRow(variety: Variety, rowName: string) {
    const created = await rowsApi.create({
      variety_id: variety.id,
      row_name: rowName,
      sort_order: (rowCardsByVariety[variety.id]?.length ?? 0) + 1,
    });
    const newCard: MobileRowCard = {
      id: created.id,
      row_name: created.row_name,
      variety_id: created.variety_id,
      sort_order: created.sort_order,
      stem_count: 0,
      last_updated: created.updated_at,
    };
    setRowCardsByVariety(prev => ({
      ...prev,
      [variety.id]: [...(prev[variety.id] ?? []), newCard],
    }));
  }

  function openCanvas(row: MobileRowCard, variety: Variety) {
    navigate(`/mobile/row/${row.id}`, {
      state: {
        rowName: row.row_name,
        varietyId: variety.id,
        varietyName: variety.name,
        varietyColor: variety.color ?? null,
      },
    });
  }

  return (
    <div className="mobile-page">
      <header className="mobile-header">
        <div>
          <h1>Measurements</h1>
          <p>{todayLabel} &middot; Week {currentWeek}</p>
        </div>
        <Link className="btn btn-secondary" to="/measurements">Desktop</Link>
      </header>

      <OfflineBanner />
      <div className="mobile-content">
        {loadingVarieties ? (
          <div className="empty-state card">Loading varieties…</div>
        ) : varieties.length === 0 ? (
          <div className="empty-state card">No active varieties for {currentYear}. Add them in Setup.</div>
        ) : (
          varieties.map(variety => {
            const rowCards = rowCardsByVariety[variety.id];
            return (
              <section key={variety.id} style={{ marginBottom: 28 }}>
                <div className="variety-section-header">
                  <div className="variety-section-title">
                    {variety.color && (
                      <span className="variety-color-dot" style={{ background: variety.color }} />
                    )}
                    <span>{variety.name}</span>
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => setAddRowTarget(variety)}
                  >
                    + Add Row
                  </button>
                </div>

                {rowCards === undefined ? (
                  <div style={{ color: 'var(--gray-400)', fontSize: 13, padding: '8px 0' }}>Loading rows…</div>
                ) : rowCards.length === 0 ? (
                  <div className="empty-state" style={{ padding: 16, fontSize: 13 }}>
                    No rows yet. Tap + Add Row to create one.
                  </div>
                ) : (
                  <div className="row-card-grid">
                    {rowCards.map(row => (
                      <button
                        key={row.id}
                        className="row-card"
                        onClick={() => openCanvas(row, variety)}
                      >
                        <div className="row-card-name">{row.row_name}</div>
                        <div className="row-card-meta">
                          <span>{row.stem_count} stem{row.stem_count !== 1 ? 's' : ''}</span>
                          <span>Wk {currentWeek}</span>
                        </div>
                        <div className="row-card-footer">
                          <span>
                            {new Date(row.last_updated).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                            })}
                          </span>
                          {variety.color && (
                            <span className="row-card-color-dot" style={{ background: variety.color }} />
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>

      {addRowTarget && (
        <TextPromptModal
          title={`Add Row — ${addRowTarget.name}`}
          label="Row number or name"
          defaultValue="Row "
          onClose={() => setAddRowTarget(null)}
          onSave={async value => {
            await handleAddRow(addRowTarget, value);
          }}
        />
      )}
    </div>
  );
}
