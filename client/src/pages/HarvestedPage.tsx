import { useState, useEffect, useCallback } from 'react';
import { Season, Variety, HarvestedEntry } from '../types';
import { varietiesApi, yearsApi, harvestedApi } from '../services/api';
import { defaultYear, uniqueYears, yearNumbers } from '../utils/years';

function HarvestedModal({
  initial,
  varietyId,
  year,
  selectedWeek,
  onSave,
  onClose,
}: {
  initial?: HarvestedEntry | null;
  varietyId: string;
  year: number;
  selectedWeek: number;
  onSave: (e: HarvestedEntry) => void;
  onClose: () => void;
}) {
  const [week, setWeek] = useState(initial?.week_number ?? selectedWeek);
  const [kg, setKg] = useState(initial?.kg?.toString() ?? '');
  const [cases, setCases] = useState(initial?.cases?.toString() ?? '');
  const [caseWeight, setCaseWeight] = useState(initial?.case_weight_kg?.toString() ?? '');
  const [harvestDate, setHarvestDate] = useState(initial?.harvest_date ?? new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!kg) return setError('kg is required');
    if (Number(kg) < 0) return setError('kg cannot be negative');
    if (week < 1 || week > 52) return setError('Week must be 1–52');
    setSaving(true);
    try {
      const payload = {
        variety_id: varietyId,
        year,
        week_number: week,
        kg: Number(kg),
        cases: cases ? Number(cases) : null,
        case_weight_kg: caseWeight ? Number(caseWeight) : null,
        harvest_date: harvestDate,
        notes: notes || null,
      };
      let result: HarvestedEntry;
      if (initial?.id) {
        result = await harvestedApi.update(initial.id, payload);
      } else {
        result = await harvestedApi.create(payload);
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
        <div className="modal-title">{initial ? 'Edit Harvest Entry' : 'Log Harvest'}</div>
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Week *</label>
              <input className="form-control" type="number" min="1" max="52" value={week} onChange={e => setWeek(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label className="form-label">Harvest Date *</label>
              <input className="form-control" type="date" value={harvestDate} onChange={e => setHarvestDate(e.target.value)} />
            </div>
          </div>
          <div className="grid-3">
            <div className="form-group">
              <label className="form-label">kg *</label>
              <input className="form-control" type="number" step="0.01" min="0" value={kg} onChange={e => setKg(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Cases</label>
              <input className="form-control" type="number" step="1" min="0" value={cases} onChange={e => setCases(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Case Weight (kg)</label>
              <input className="form-control" type="number" step="0.01" min="0" value={caseWeight} onChange={e => setCaseWeight(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Notes</label>
            <input className="form-control" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes…" />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Entry'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function HarvestedPage() {
  const [years, setYears] = useState<Season[]>([]);
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [entries, setEntries] = useState<HarvestedEntry[]>([]);
  const [selectedYear, setSelectedYear] = useState(0);
  const [selectedVariety, setSelectedVariety] = useState('');
  const [selectedWeek, setSelectedWeek] = useState(1);
  const [modal, setModal] = useState<{ open: boolean; item?: HarvestedEntry | null }>({ open: false });
  const [loading, setLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    yearsApi.list().then(data => {
      setYears(prev => uniqueYears([...data, ...prev]));
      setSelectedYear(prev => prev || defaultYear(data));
    });
  }, []);

  useEffect(() => {
    if (!selectedYear) return;
    yearsApi.getOrCreate(selectedYear).then(season => {
      setYears(prev => uniqueYears([season, ...prev]));
    });
    varietiesApi.list(undefined, selectedYear).then(data => {
      setVarieties(data);
      const active = data.find(v => v.is_active) ?? data[0];
      if (active) setSelectedVariety(active.id);
      else setSelectedVariety('');
    });
  }, [selectedYear]);

  const loadEntries = useCallback(async () => {
    if (!selectedVariety) { setEntries([]); return; }
    setLoading(true);
    try {
      const data = await harvestedApi.list(selectedVariety, selectedYear);
      setEntries(data);
    } finally {
      setLoading(false);
    }
  }, [selectedVariety, selectedYear]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  const totalKg = entries.reduce((s, e) => s + Number(e.kg), 0);
  const totalCases = entries.reduce((s, e) => s + (e.cases ? Number(e.cases) : 0), 0);
  const avgKgPerCase = totalCases > 0 ? totalKg / totalCases : null;

  async function handleDelete(id: string) {
    await harvestedApi.delete(id);
    setEntries(prev => prev.filter(e => e.id !== id));
    setDeleteConfirm(null);
  }

  return (
    <>
      <div className="page-header">
        <h2>Harvested</h2>
        <button
          className="btn btn-primary"
          disabled={!selectedVariety}
          onClick={() => setModal({ open: true, item: null })}
        >
          + Log Harvest
        </button>
      </div>

      <div className="selector-bar">
        <label>Year</label>
        <select className="form-control" style={{ width: 180 }} value={selectedYear} onChange={e => setSelectedYear(Number(e.target.value))}>
          {yearNumbers(years).map(year => <option key={year} value={year}>{year}</option>)}
        </select>
        <label>Variety</label>
        <select className="form-control" style={{ width: 160 }} value={selectedVariety} onChange={e => setSelectedVariety(e.target.value)}>
          <option value="">— select —</option>
          {varieties.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <label>Week</label>
        <select className="form-control" style={{ width: 90 }} value={selectedWeek} onChange={e => setSelectedWeek(Number(e.target.value))}>
          {Array.from({ length: 52 }, (_, i) => i + 1).map(w => (
            <option key={w} value={w}>Wk {w}</option>
          ))}
        </select>
      </div>

      <div className="page-body">
        {/* Summary cards */}
        {entries.length > 0 && (
          <div className="grid-3 mb-4">
            <div className="stat-card">
              <div className="stat-label">Total kg</div>
              <div className="stat-value">{totalKg.toFixed(1)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Total Cases</div>
              <div className="stat-value">{totalCases > 0 ? totalCases.toFixed(0) : '—'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Avg kg / Case</div>
              <div className="stat-value">{avgKgPerCase ? avgKgPerCase.toFixed(2) : '—'}</div>
            </div>
          </div>
        )}

        <div className="card">
          {!selectedVariety ? (
            <div className="empty-state">Select a year and variety to view harvested data.</div>
          ) : loading ? (
            <div className="loading">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="empty-state">No harvest entries yet. Log one above.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Week</th>
                    <th>Harvest Date</th>
                    <th>kg</th>
                    <th>Cases</th>
                    <th>Case Weight (kg)</th>
                    <th>Notes</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(entry => (
                    <tr key={entry.id}>
                      <td>Wk {entry.week_number}</td>
                      <td>{entry.harvest_date}</td>
                      <td style={{ fontWeight: 600 }}>{Number(entry.kg).toFixed(1)}</td>
                      <td>{entry.cases ?? '—'}</td>
                      <td>{entry.case_weight_kg ?? '—'}</td>
                      <td style={{ color: 'var(--gray-500)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {entry.notes ?? '—'}
                      </td>
                      <td>
                        <div className="flex gap-2">
                          <button className="btn btn-secondary btn-sm" onClick={() => setModal({ open: true, item: entry })}>
                            Edit
                          </button>
                          {deleteConfirm === entry.id ? (
                            <>
                              <button className="btn btn-danger btn-sm" onClick={() => handleDelete(entry.id)}>Confirm</button>
                              <button className="btn btn-secondary btn-sm" onClick={() => setDeleteConfirm(null)}>Cancel</button>
                            </>
                          ) : (
                            <button className="btn btn-danger btn-sm" onClick={() => setDeleteConfirm(entry.id)}>Delete</button>
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
      </div>

      {modal.open && selectedVariety && (
        <HarvestedModal
          initial={modal.item}
          varietyId={selectedVariety}
          year={selectedYear}
          selectedWeek={selectedWeek}
          onSave={(entry) => {
            setEntries(prev => {
              const exists = prev.find(e => e.id === entry.id);
              return exists ? prev.map(e => e.id === entry.id ? entry : e) : [...prev, entry];
            });
            setModal({ open: false });
          }}
          onClose={() => setModal({ open: false })}
        />
      )}
    </>
  );
}
