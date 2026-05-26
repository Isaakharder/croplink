import { useState, useEffect, useCallback } from 'react';
import { Season, Variety } from '../types';
import { varietiesApi, yearsApi } from '../services/api';
import { uniqueYears, yearNumbers } from '../utils/years';

function VarietyModal({
  initial,
  year,
  onSave,
  onClose,
}: {
  initial?: Variety | null;
  year: number;
  onSave: (v: Variety) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? '');
  const [plantDate, setPlantDate] = useState(initial?.plant_date ?? '');
  const [pullOutDate, setPullOutDate] = useState(initial?.pull_out_date ?? '');
  const [areaM2, setAreaM2] = useState<string>(initial?.area_m2?.toString() ?? '');
  const [plantCount, setPlantCount] = useState<string>(initial?.plant_count?.toString() ?? '');
  const [stemCount, setStemCount] = useState<string>(initial?.total_stem_count?.toString() ?? '');
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Name is required');
    setSaving(true);
    try {
      const basePayload = {
        name: name.trim(),
        color: color.trim() || null,
        plant_date: plantDate || null,
        pull_out_date: pullOutDate || null,
        area_m2: areaM2 ? Number(areaM2) : null,
        plant_count: plantCount ? Number(plantCount) : null,
        total_stem_count: stemCount ? Number(stemCount) : null,
        is_active: isActive,
      };

      let result: Variety;
      if (initial?.id) {
        result = await varietiesApi.update(initial.id, {
          ...basePayload,
          season_id: initial.season_id,
        });
      } else {
        result = await varietiesApi.create({
          ...basePayload,
          year,
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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{initial ? 'Edit Variety' : 'New Variety'}</div>
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Name *</label>
            <input className="form-control" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Sweet Red" />
          </div>
          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Color</label>
              <input className="form-control" value={color} onChange={e => setColor(e.target.value)} placeholder="e.g. Red" />
            </div>
            <div className="form-group">
              <label className="form-label">Active</label>
              <select className="form-control" value={isActive ? 'yes' : 'no'} onChange={e => setIsActive(e.target.value === 'yes')}>
                <option value="yes">Active</option>
                <option value="no">Inactive</option>
              </select>
            </div>
          </div>
          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Plant Date</label>
              <input className="form-control" type="date" value={plantDate} onChange={e => setPlantDate(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Pull-Out Date</label>
              <input className="form-control" type="date" value={pullOutDate} onChange={e => setPullOutDate(e.target.value)} />
            </div>
          </div>
          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Area (m²)</label>
              <input className="form-control" type="number" step="0.01" min="0" value={areaM2} onChange={e => setAreaM2(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Plant Count</label>
              <input className="form-control" type="number" min="0" value={plantCount} onChange={e => setPlantCount(e.target.value)} />
            </div>
          </div>
          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Total Stem Count</label>
              <input className="form-control" type="number" min="0" value={stemCount} onChange={e => setStemCount(e.target.value)} />
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Variety'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function SetupPage() {
  const currentYear = new Date().getFullYear();
  const [years, setYears] = useState<Season[]>([]);
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [yearInput, setYearInput] = useState(String(currentYear));
  const [loadingYears, setLoadingYears] = useState(true);
  const [loadingVarieties, setLoadingVarieties] = useState(false);
  const [varietyModal, setVarietyModal] = useState<{ open: boolean; item?: Variety | null }>({ open: false });

  const loadYears = useCallback(async () => {
    setLoadingYears(true);
    try {
      const data = await yearsApi.list();
      setYears(prev => uniqueYears([...data, ...prev]));
    } finally {
      setLoadingYears(false);
    }
  }, []);

  const ensureYear = useCallback(async (year: number) => {
    const existing = years.find(item => item.year === year);
    if (existing) return existing;
    const created = await yearsApi.getOrCreate(year);
    setYears(prev => uniqueYears([created, ...prev]));
    return created;
  }, [years]);

  const loadVarieties = useCallback(async (year: number) => {
    setLoadingVarieties(true);
    try {
      await ensureYear(year);
      const data = await varietiesApi.list(undefined, year);
      setVarieties(data);
    } finally {
      setLoadingVarieties(false);
    }
  }, [ensureYear]);

  useEffect(() => {
    loadYears();
  }, [loadYears]);

  useEffect(() => {
    loadVarieties(selectedYear);
  }, [loadVarieties, selectedYear]);

  const yearOptions = yearNumbers(years, currentYear);

  async function handleAddYear() {
    const year = Number(yearInput);
    if (!year) return;
    const season = await ensureYear(year);
    setSelectedYear(season.year);
    setYearInput(String(season.year));
  }

  return (
    <>
      <div className="page-header">
        <h2>Setup</h2>
      </div>
      <div className="page-body">
        <div className="card mb-4">
          <div className="flex items-center justify-between mb-4">
            <div className="card-title" style={{ margin: 0 }}>Year</div>
            <div className="flex gap-2 items-center">
              <select
                className="form-control"
                style={{ width: 160 }}
                value={selectedYear}
                onChange={e => setSelectedYear(Number(e.target.value))}
              >
                {yearOptions.map(year => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </select>
              <input
                className="form-control"
                style={{ width: 120 }}
                type="number"
                min="2000"
                max="2100"
                value={yearInput}
                onChange={e => setYearInput(e.target.value)}
                placeholder="Add year"
              />
              <button className="btn btn-primary btn-sm" onClick={handleAddYear}>+ Add Year</button>
            </div>
          </div>
          <div className="grid-3">
            <div className="stat-card">
              <div className="stat-label">Selected Year</div>
              <div className="stat-value" style={{ fontSize: 18 }}>{selectedYear}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Known Years</div>
              <div className="stat-value" style={{ fontSize: 18 }}>{yearOptions.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Varieties</div>
              <div className="stat-value" style={{ fontSize: 18 }}>{varieties.length}</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div className="card-title" style={{ margin: 0 }}>Varieties for {selectedYear}</div>
            <button className="btn btn-primary btn-sm" onClick={() => setVarietyModal({ open: true, item: null })}>
              + New Variety
            </button>
          </div>
          {loadingYears || loadingVarieties ? (
            <div className="loading">Loading…</div>
          ) : varieties.length === 0 ? (
            <div className="empty-state">No varieties for {selectedYear}. Add one above.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Color</th>
                    <th>Plant Date</th>
                    <th>Pull-Out Date</th>
                    <th>Area (m²)</th>
                    <th>Plants</th>
                    <th>Stems</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {varieties.map(v => (
                    <tr key={v.id} className={!v.is_active ? 'inactive' : ''}>
                      <td style={{ fontWeight: 600 }}>{v.name}</td>
                      <td>{v.color ?? '—'}</td>
                      <td>{v.plant_date ?? '—'}</td>
                      <td>{v.pull_out_date ?? '—'}</td>
                      <td>{v.area_m2 ?? '—'}</td>
                      <td>{v.plant_count ?? '—'}</td>
                      <td>{v.total_stem_count ?? '—'}</td>
                      <td>
                        <span className={`badge ${v.is_active ? 'badge-green' : 'badge-gray'}`}>
                          {v.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td>
                        <div className="flex gap-2">
                          <button className="btn btn-secondary btn-sm" onClick={() => setVarietyModal({ open: true, item: v })}>
                            Edit
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={async () => {
                              const updated = await varietiesApi.setActive(v.id, !v.is_active);
                              setVarieties(prev => prev.map(x => x.id === v.id ? updated : x));
                            }}
                          >
                            {v.is_active ? 'Deactivate' : 'Activate'}
                          </button>
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

      {varietyModal.open && (
        <VarietyModal
          initial={varietyModal.item}
          year={selectedYear}
          onSave={(v) => {
            setVarieties(prev => {
              const exists = prev.find(x => x.id === v.id);
              return exists ? prev.map(x => x.id === v.id ? v : x) : [...prev, v];
            });
            setVarietyModal({ open: false });
          }}
          onClose={() => setVarietyModal({ open: false })}
        />
      )}
    </>
  );
}
