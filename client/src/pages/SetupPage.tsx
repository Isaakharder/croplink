import { useState, useEffect, useCallback, useMemo } from 'react';
import { Season, Variety, Phase, Zone, VarietyZone } from '../types';
import { varietiesApi, yearsApi, phasesApi, zonesApi, varietyZonesApi } from '../services/api';
import { uniqueYears, yearNumbers } from '../utils/years';

// ─── VarietyModal ─────────────────────────────────────────────────────────────

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
        result = await varietiesApi.create({ ...basePayload, year });
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

// ─── VarietyZonesModal ────────────────────────────────────────────────────────
// Loads its own phase/zone/assignment data so the Varieties tab stays lean.

function VarietyZonesModal({
  variety,
  onClose,
}: {
  variety: Variety;
  onClose: () => void;
}) {
  const [phases, setPhases] = useState<Phase[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [existingVZ, setExistingVZ] = useState<VarietyZone[]>([]);
  const [selectedZoneIds, setSelectedZoneIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const [p, z, vz] = await Promise.all([phasesApi.list(), zonesApi.list(), varietyZonesApi.list()]);
        setPhases(p);
        setZones(z);
        const mine = vz.filter(x => x.variety_id === variety.id);
        setExistingVZ(mine);
        setSelectedZoneIds(new Set(mine.map(x => x.zone_id)));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [variety.id]);

  async function handleSave() {
    setSaving(true);
    try {
      const currentIds = new Set(existingVZ.map(x => x.zone_id));
      const toAdd = [...selectedZoneIds].filter(id => !currentIds.has(id));
      const toRemove = [...currentIds].filter(id => !selectedZoneIds.has(id));
      await Promise.all(toRemove.map(zid => varietyZonesApi.unassign(zid)));
      await Promise.all(toAdd.map(zid => varietyZonesApi.assign({ variety_id: variety.id, zone_id: zid })));
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
      setSaving(false);
    }
  }

  function toggleZone(zoneId: string, checked: boolean) {
    setSelectedZoneIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(zoneId); else next.delete(zoneId);
      return next;
    });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">Zone Assignments — {variety.name}</div>
        {error && <div className="alert alert-error">{error}</div>}
        {loading ? (
          <div className="loading">Loading…</div>
        ) : phases.length === 0 ? (
          <div className="empty-state">No phases or zones defined yet. Create them in the Zones tab first.</div>
        ) : (
          phases.map(phase => {
            const phaseZones = zones.filter(z => z.phase_id === phase.id);
            if (phaseZones.length === 0) return null;
            return (
              <div key={phase.id} className="mb-4">
                <div style={{ fontWeight: 600, marginBottom: 8 }}>{phase.name}</div>
                {phaseZones.map(zone => (
                  <label key={zone.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={selectedZoneIds.has(zone.id)}
                      onChange={e => toggleZone(zone.id, e.target.checked)}
                    />
                    <span>{zone.name}</span>
                    <code style={{ fontSize: '0.8em', opacity: 0.6 }}>{zone.import_key}</code>
                  </label>
                ))}
              </div>
            );
          })
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save Assignments'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── PhaseModal ───────────────────────────────────────────────────────────────

function PhaseModal({
  initial,
  onSave,
  onClose,
}: {
  initial?: Phase | null;
  onSave: (p: Phase) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Name is required');
    setSaving(true);
    try {
      const result = initial?.id
        ? await phasesApi.update(initial.id, { name: name.trim() })
        : await phasesApi.create({ name: name.trim() });
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
        <div className="modal-title">{initial ? 'Edit Phase' : 'New Phase'}</div>
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Phase Name *</label>
            <input
              className="form-control"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Phase 1"
              autoFocus
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Phase'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── ZoneModal ────────────────────────────────────────────────────────────────

function ZoneModal({
  initial,
  phaseId,
  onSave,
  onClose,
}: {
  initial?: Zone | null;
  phaseId: string;
  onSave: (z: Zone) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [importKey, setImportKey] = useState(initial?.import_key ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Name is required');
    if (!importKey.trim()) return setError('Import key is required');
    setSaving(true);
    try {
      const result = initial?.id
        ? await zonesApi.update(initial.id, { name: name.trim(), import_key: importKey.trim() })
        : await zonesApi.create({ phase_id: phaseId, name: name.trim(), import_key: importKey.trim() });
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
        <div className="modal-title">{initial ? 'Edit Zone' : 'New Zone'}</div>
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Zone Name *</label>
            <input
              className="form-control"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Zone 1A"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label className="form-label">Import Key *</label>
            <input
              className="form-control"
              value={importKey}
              onChange={e => setImportKey(e.target.value)}
              placeholder="e.g. zone-1a"
            />
            <small style={{ display: 'block', marginTop: 4, opacity: 0.65, fontSize: '0.8em' }}>
              Stable label used as zone_label in CSV / agent imports
            </small>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Zone'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── ZonesTab ─────────────────────────────────────────────────────────────────

function ZonesTab() {
  const [phases, setPhases] = useState<Phase[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [varietyZones, setVarietyZones] = useState<VarietyZone[]>([]);
  const [allVarieties, setAllVarieties] = useState<Variety[]>([]);
  const [loading, setLoading] = useState(true);
  const [phaseModal, setPhaseModal] = useState<{ open: boolean; item?: Phase | null }>({ open: false });
  const [zoneModal, setZoneModal] = useState<{ open: boolean; item?: Zone | null; phaseId: string }>({ open: false, phaseId: '' });

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [p, z, vz, v] = await Promise.all([
        phasesApi.list(),
        zonesApi.list(),
        varietyZonesApi.list(),
        varietiesApi.list(),
      ]);
      setPhases(p);
      setZones(z);
      setVarietyZones(vz);
      setAllVarieties(v);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const zoneVarietyMap = useMemo(
    () => new Map(varietyZones.map(vz => [vz.zone_id, vz.variety_id])),
    [varietyZones]
  );

  async function handleDeletePhase(id: string) {
    if (!confirm('Delete this phase and all its zones?')) return;
    await phasesApi.delete(id);
    setPhases(prev => prev.filter(p => p.id !== id));
    setZones(prev => prev.filter(z => z.phase_id !== id));
  }

  async function handleDeleteZone(id: string) {
    if (!confirm('Delete this zone?')) return;
    await zonesApi.delete(id);
    setZones(prev => prev.filter(z => z.id !== id));
    setVarietyZones(prev => prev.filter(vz => vz.zone_id !== id));
  }

  async function handleVarietyAssign(zoneId: string, varietyId: string) {
    if (varietyId === '') {
      await varietyZonesApi.unassign(zoneId);
      setVarietyZones(prev => prev.filter(vz => vz.zone_id !== zoneId));
    } else {
      const result = await varietyZonesApi.assign({ variety_id: varietyId, zone_id: zoneId });
      setVarietyZones(prev => [...prev.filter(vz => vz.zone_id !== zoneId), result]);
    }
  }

  if (loading) return <div className="loading">Loading…</div>;

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div className="card-title" style={{ margin: 0 }}>Phases &amp; Zones</div>
        <button className="btn btn-primary btn-sm" onClick={() => setPhaseModal({ open: true, item: null })}>
          + Phase
        </button>
      </div>

      {phases.length === 0 ? (
        <div className="empty-state">No phases yet. Add a phase to get started.</div>
      ) : (
        phases.map(phase => {
          const phaseZones = zones.filter(z => z.phase_id === phase.id);
          return (
            <div key={phase.id} className="card mb-4">
              <div className="flex items-center justify-between mb-4">
                <div className="card-title" style={{ margin: 0 }}>{phase.name}</div>
                <div className="flex gap-2">
                  <button className="btn btn-secondary btn-sm" onClick={() => setPhaseModal({ open: true, item: phase })}>Edit</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleDeletePhase(phase.id)}>Delete</button>
                  <button className="btn btn-primary btn-sm" onClick={() => setZoneModal({ open: true, item: null, phaseId: phase.id })}>+ Zone</button>
                </div>
              </div>

              {phaseZones.length === 0 ? (
                <div className="empty-state">No zones in this phase.</div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Zone Name</th>
                        <th>Import Key</th>
                        <th>Variety</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {phaseZones.map(zone => (
                        <tr key={zone.id}>
                          <td style={{ fontWeight: 600 }}>{zone.name}</td>
                          <td><code>{zone.import_key}</code></td>
                          <td>
                            <select
                              className="form-control"
                              style={{ width: 200 }}
                              value={zoneVarietyMap.get(zone.id) ?? ''}
                              onChange={e => handleVarietyAssign(zone.id, e.target.value)}
                            >
                              <option value="">— unassigned —</option>
                              {allVarieties.map(v => (
                                <option key={v.id} value={v.id}>{v.name}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <div className="flex gap-2">
                              <button className="btn btn-secondary btn-sm" onClick={() => setZoneModal({ open: true, item: zone, phaseId: zone.phase_id })}>Edit</button>
                              <button className="btn btn-secondary btn-sm" onClick={() => handleDeleteZone(zone.id)}>Delete</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })
      )}

      {phaseModal.open && (
        <PhaseModal
          initial={phaseModal.item}
          onSave={p => {
            setPhases(prev => {
              const exists = prev.find(x => x.id === p.id);
              return exists ? prev.map(x => x.id === p.id ? p : x) : [...prev, p];
            });
            setPhaseModal({ open: false });
          }}
          onClose={() => setPhaseModal({ open: false })}
        />
      )}

      {zoneModal.open && (
        <ZoneModal
          initial={zoneModal.item}
          phaseId={zoneModal.phaseId}
          onSave={z => {
            setZones(prev => {
              const exists = prev.find(x => x.id === z.id);
              return exists ? prev.map(x => x.id === z.id ? z : x) : [...prev, z];
            });
            setZoneModal({ open: false, phaseId: '' });
          }}
          onClose={() => setZoneModal({ open: false, phaseId: '' })}
        />
      )}
    </>
  );
}

// ─── SetupPage ────────────────────────────────────────────────────────────────

export function SetupPage() {
  const currentYear = new Date().getFullYear();
  const [tab, setTab] = useState<'varieties' | 'zones'>('varieties');
  const [years, setYears] = useState<Season[]>([]);
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [yearInput, setYearInput] = useState(String(currentYear));
  const [loadingYears, setLoadingYears] = useState(true);
  const [loadingVarieties, setLoadingVarieties] = useState(false);
  const [varietyModal, setVarietyModal] = useState<{ open: boolean; item?: Variety | null }>({ open: false });
  const [zoneAssignModal, setZoneAssignModal] = useState<{ open: boolean; variety?: Variety | null }>({ open: false });

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

  useEffect(() => { loadYears(); }, [loadYears]);
  useEffect(() => { loadVarieties(selectedYear); }, [loadVarieties, selectedYear]);

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
        <div className="flex gap-2">
          <button
            className={`btn btn-sm ${tab === 'varieties' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setTab('varieties')}
          >
            Varieties
          </button>
          <button
            className={`btn btn-sm ${tab === 'zones' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setTab('zones')}
          >
            Zones
          </button>
        </div>
      </div>

      <div className="page-body">
        {tab === 'varieties' ? (
          <>
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
                              <button className="btn btn-secondary btn-sm" onClick={() => setZoneAssignModal({ open: true, variety: v })}>
                                Zones
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
          </>
        ) : (
          <ZonesTab />
        )}
      </div>

      {varietyModal.open && (
        <VarietyModal
          initial={varietyModal.item}
          year={selectedYear}
          onSave={v => {
            setVarieties(prev => {
              const exists = prev.find(x => x.id === v.id);
              return exists ? prev.map(x => x.id === v.id ? v : x) : [...prev, v];
            });
            setVarietyModal({ open: false });
          }}
          onClose={() => setVarietyModal({ open: false })}
        />
      )}

      {zoneAssignModal.open && zoneAssignModal.variety && (
        <VarietyZonesModal
          variety={zoneAssignModal.variety}
          onClose={() => setZoneAssignModal({ open: false })}
        />
      )}
    </>
  );
}
