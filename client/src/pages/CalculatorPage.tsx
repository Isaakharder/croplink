import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Season, Variety, HarvestTimingProfile, ProjectionResult, RipeningActualsRow } from '../types';
import { varietiesApi, yearsApi, harvestTimingApi, projectionApi, fruitSetByWeekApi, fruitWeightsApi, ripeningActualsApi } from '../services/api';
import { defaultYear, getIsoWeek, uniqueYears, yearNumbers } from '../utils/years';

type RowDraft = {
  set_week_number: number;
  avg_fruit_set: string;
  week4_percent: string;
  week5_percent: string;
  week6_percent: string;
  week7_percent: string;
  week8_percent: string;
  week9_percent: string;
  week10_percent: string;
  weight_grams: string;
};

function calcCheck(row: RowDraft): number {
  return (
    Number(row.week4_percent || 0) +
    Number(row.week5_percent || 0) +
    Number(row.week6_percent || 0) +
    Number(row.week7_percent || 0) +
    Number(row.week8_percent || 0) +
    Number(row.week9_percent || 0) +
    Number(row.week10_percent || 0)
  );
}

function hasData(row: RowDraft): boolean {
  return Number(row.avg_fruit_set || 0) > 0 ||
    WEEK_COLS.some(col => Number((row[col] as string) || 0) > 0);
}

function makeEmptyRows(): RowDraft[] {
  return Array.from({ length: 52 }, (_, i) => ({
    set_week_number: i + 1,
    avg_fruit_set: '',
    week4_percent: '',
    week5_percent: '',
    week6_percent: '',
    week7_percent: '',
    week8_percent: '',
    week9_percent: '',
    week10_percent: '',
    weight_grams: '',
  }));
}

function profileToRow(p: HarvestTimingProfile): RowDraft {
  return {
    set_week_number: p.set_week_number,
    avg_fruit_set: p.avg_fruit_set ? String(p.avg_fruit_set) : '',
    week4_percent: p.week4_percent ? String(p.week4_percent) : '',
    week5_percent: p.week5_percent ? String(p.week5_percent) : '',
    week6_percent: p.week6_percent ? String(p.week6_percent) : '',
    week7_percent: p.week7_percent ? String(p.week7_percent) : '',
    week8_percent: p.week8_percent ? String(p.week8_percent) : '',
    week9_percent: p.week9_percent ? String(p.week9_percent) : '',
    week10_percent: p.week10_percent ? String(p.week10_percent) : '',
    weight_grams: '',
  };
}

const WEEK_COLS: (keyof RowDraft)[] = [
  'week4_percent', 'week5_percent', 'week6_percent',
  'week7_percent', 'week8_percent', 'week9_percent', 'week10_percent',
];

export function CalculatorPage() {
  const todayYear   = useMemo(() => new Date().getFullYear(), []);
  const currentWeek = useMemo(() => getIsoWeek(new Date()), []);

  const [years, setYears] = useState<Season[]>([]);
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [selectedYear, setSelectedYear] = useState(todayYear);
  const [selectedVariety, setSelectedVariety] = useState('');
  const [rows, setRows] = useState<RowDraft[]>(makeEmptyRows());
  const [projection, setProjection] = useState<ProjectionResult | null>(null);
  const [actuals, setActuals] = useState<RipeningActualsRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [error, setError] = useState('');
  const [loadKey, setLoadKey] = useState(0);
  // Row indices (0-based) that have real mobile-measured fruit set — these cells are read-only
  const [measuredWeeks, setMeasuredWeeks] = useState<Set<number>>(new Set());

  const currentWeekRowRef = useRef<HTMLTableRowElement>(null);

  // Fill-down drag state
  const [fillDrag, setFillDrag] = useState<{
    col: keyof RowDraft;
    srcRowIdx: number;
    curRowIdx: number;
  } | null>(null);
  const [activeCell, setActiveCell] = useState<{ rowIdx: number; col: keyof RowDraft } | null>(null);
  const fillDragRef = useRef(fillDrag);
  fillDragRef.current = fillDrag;

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

  const loadData = useCallback(async () => {
    if (!selectedVariety || !selectedYear) return;
    try {
      const [profiles, fruitSetData, weights, proj, actualsData] = await Promise.all([
        harvestTimingApi.list(selectedVariety, selectedYear),
        fruitSetByWeekApi.get(selectedVariety, selectedYear).catch(() => []),
        fruitWeightsApi.list(selectedVariety, selectedYear).catch(() => []),
        projectionApi.get(selectedVariety, selectedYear).catch(() => null),
        ripeningActualsApi.get(selectedVariety, selectedYear).catch(() => []),
      ]);
      const base = makeEmptyRows();
      for (const p of profiles) {
        const idx = p.set_week_number - 1;
        if (idx >= 0 && idx < 52) base[idx] = profileToRow(p);
      }
      // Overlay mobile-measured fruit-set values (only when > 0; never wipe manual forecasts)
      const newMeasuredWeeks = new Set<number>();
      for (const fs of fruitSetData) {
        const idx = fs.weekNumber - 1;
        if (idx >= 0 && idx < 52 && fs.fruitSetPerM2 > 0) {
          newMeasuredWeeks.add(idx);
          base[idx] = { ...base[idx], avg_fruit_set: fs.fruitSetPerM2.toFixed(2) };
        }
      }
      setMeasuredWeeks(newMeasuredWeeks);
      // Merge saved fruit weights
      for (const w of weights) {
        const idx = (w as { week_number: number }).week_number - 1;
        if (idx >= 0 && idx < 52 && (w as { weight_grams: number }).weight_grams) {
          base[idx] = { ...base[idx], weight_grams: String((w as { weight_grams: number }).weight_grams) };
        }
      }
      setRows(base);
      setProjection(proj);
      setActuals(actualsData ?? []);
      setLoadKey(k => k + 1);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Load failed');
    }
  }, [selectedVariety, selectedYear]);

  useEffect(() => { loadData(); }, [loadData]);

  // Global mouse listeners for fill-down drag — attached only while a drag is active
  const isDragging = fillDrag !== null;
  useEffect(() => {
    if (!isDragging) return;

    function handleMouseMove(e: MouseEvent) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const tr = el?.closest('[data-row-idx]');
      if (tr instanceof HTMLElement && tr.dataset.rowIdx !== undefined) {
        const idx = parseInt(tr.dataset.rowIdx, 10);
        if (!isNaN(idx)) {
          setFillDrag(prev => prev && idx > prev.srcRowIdx ? { ...prev, curRowIdx: idx } : prev);
        }
      }
    }

    function handleMouseUp() {
      const drag = fillDragRef.current;
      if (drag && drag.curRowIdx > drag.srcRowIdx) {
        setRows(prev => {
          const srcValue = prev[drag.srcRowIdx][drag.col] as string;
          const next = [...prev];
          for (let i = drag.srcRowIdx + 1; i <= drag.curRowIdx; i++) {
            next[i] = { ...next[i], [drag.col]: srcValue };
          }
          return next;
        });
      }
      setFillDrag(null);
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // Crosshair cursor + no text-selection while dragging
  useEffect(() => {
    if (!isDragging) return;
    document.body.style.cursor = 'crosshair';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging]);

  // After each load completes, scroll the current week row into the centre of
  // the visible table area — but only when viewing the current calendar year.
  useEffect(() => {
    if (loadKey === 0 || selectedYear !== todayYear) return;
    const raf = requestAnimationFrame(() => {
      currentWeekRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
  }, [loadKey, selectedYear, todayYear]);

  function updateCell(weekIdx: number, field: keyof RowDraft, value: string) {
    setRows(prev => {
      const next = [...prev];
      next[weekIdx] = { ...next[weekIdx], [field]: value };
      return next;
    });
  }

  async function handleSave() {
    if (!selectedVariety) return;
    setSaving(true);
    setError('');
    setSaveMsg('');
    try {
      const timingRows = rows
        .filter(r => hasData(r))
        .map(r => ({
          variety_id: selectedVariety,
          year: selectedYear,
          set_week_number: r.set_week_number,
          avg_fruit_set: Number(r.avg_fruit_set || 0),
          week1_percent: 0,
          week2_percent: 0,
          week3_percent: 0,
          week4_percent: Number(r.week4_percent || 0),
          week5_percent: Number(r.week5_percent || 0),
          week6_percent: Number(r.week6_percent || 0),
          week7_percent: Number(r.week7_percent || 0),
          week8_percent: Number(r.week8_percent || 0),
          week9_percent: Number(r.week9_percent || 0),
          week10_percent: Number(r.week10_percent || 0),
        }));

      const weightRows = rows
        .filter(r => Number(r.weight_grams || 0) > 0)
        .map(r => ({
          variety_id: selectedVariety,
          year: selectedYear,
          week_number: r.set_week_number,
          weight_grams: Number(r.weight_grams),
        }));

      if (timingRows.length === 0 && weightRows.length === 0) {
        setSaveMsg('Nothing to save — enter some data first.');
        return;
      }

      await Promise.all([
        timingRows.length > 0 ? harvestTimingApi.upsertMany(timingRows) : Promise.resolve(),
        weightRows.length > 0 ? fruitWeightsApi.upsertMany(weightRows) : Promise.resolve(),
      ]);
      const proj = await projectionApi.get(selectedVariety, selectedYear).catch(() => null);
      setProjection(proj);
      setSaveMsg('Saved successfully!');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const peakProjection = projection?.weeks.reduce(
    (best, w) => (w.projected_fruit_per_m2 > best.projected_fruit_per_m2 ? w : best),
    { week: 0, projected_fruit_per_m2: 0 }
  );

  return (
    <>
      <div className="page-header">
        <h2>Fruit Development Calculator</h2>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving || !selectedVariety}>
          {saving ? 'Saving…' : 'Save Fruit Development'}
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
      </div>

      {error && <div className="alert alert-error" style={{ margin: '12px 24px 0' }}>{error}</div>}
      {saveMsg && <div className="alert" style={{ margin: '12px 24px 0', background: 'var(--green-100)', color: 'var(--green-700)', border: '1px solid var(--green-200)' }}>{saveMsg}</div>}

      <div className="page-body">
        {!selectedVariety ? (
          <div className="empty-state">Select a year and variety to edit fruit development.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20 }}>
            {/* Main calculator table */}
            <div className="card" style={{ padding: 0 }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--gray-200)', fontWeight: 700, fontSize: 14, color: 'var(--gray-700)' }}>
                Weekly Fruit Set & Harvest %
              </div>
              <div className="calculator-table-scroll">
                <table className="calc-table">
                  <thead>
                    <tr>
                      <th>Wk</th>
                      <th className="calculator-fruit-set-col" title="Mobile-measured where available. Enter a forecast for future weeks — mobile data will override it when it arrives.">
                        Fruit Set / m²
                      </th>
                      <th>+4%</th>
                      <th>+5%</th>
                      <th>+6%</th>
                      <th>+7%</th>
                      <th>+8%</th>
                      <th>+9%</th>
                      <th>+10%</th>
                      <th>Check %</th>
                      <th className="calc-afw-col">AFW/g</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const check = calcCheck(row);
                      const hasAnyData = hasData(row);
                      let checkClass = 'check-blank';
                      let checkLabel = '';
                      if (hasAnyData || check > 0) {
                        checkLabel = check.toFixed(0) + '%';
                        checkClass = check === 100 ? 'check-good' : 'check-bad';
                      }
                      const isCurrentWeek = selectedYear === todayYear && row.set_week_number === currentWeek;
                      return (
                        <tr
                          key={row.set_week_number}
                          ref={isCurrentWeek ? currentWeekRowRef : null}
                          className={isCurrentWeek ? 'calc-row-current-week' : undefined}
                          data-row-idx={i}
                        >
                          <td style={{ fontWeight: 600, color: 'var(--gray-500)', whiteSpace: 'nowrap' }}>{i + 1}</td>
                          <td className="fruit-set-auto-cell calculator-fruit-set-col">
                            {measuredWeeks.has(i) ? (
                              // Read-only: value comes from mobile measurements
                              row.avg_fruit_set
                                ? <span className="fruit-set-auto-value" title="Measured — from mobile">
                                    {Number(row.avg_fruit_set).toFixed(2)}
                                  </span>
                                : <span className="fruit-set-auto-empty">—</span>
                            ) : (
                              // Editable: manual forecast for weeks without mobile data
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={row.avg_fruit_set}
                                placeholder="—"
                                onChange={e => updateCell(i, 'avg_fruit_set', e.target.value)}
                                className="fruit-set-forecast-input"
                                title="Enter a forecast — mobile measurements will override this when available"
                              />
                            )}
                          </td>
                          {WEEK_COLS.map(col => {
                            const showHandle =
                              (activeCell?.rowIdx === i && activeCell?.col === col) ||
                              (fillDrag?.srcRowIdx === i && fillDrag?.col === col);
                            const inRange = fillDrag != null && fillDrag.col === col &&
                              i > fillDrag.srcRowIdx && i <= fillDrag.curRowIdx;
                            return (
                              <td key={col} style={{ position: 'relative' }}>
                                <input
                                  type="number"
                                  min="0"
                                  max="100"
                                  step="1"
                                  value={row[col] as string}
                                  placeholder="0"
                                  onChange={e => updateCell(i, col, e.target.value)}
                                  onFocus={() => setActiveCell({ rowIdx: i, col })}
                                  onBlur={() => setActiveCell(null)}
                                  className={inRange ? 'fill-drag-highlight' : undefined}
                                />
                                {showHandle && (
                                  <div
                                    className="fill-handle"
                                    onMouseDown={e => {
                                      e.preventDefault();
                                      setFillDrag({ col, srcRowIdx: i, curRowIdx: i });
                                    }}
                                  />
                                )}
                              </td>
                            );
                          })}
                          <td className={checkClass}>{checkLabel || '—'}</td>
                          <td className="calc-afw-col" style={{ position: 'relative' }}>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={row.weight_grams}
                              placeholder="0"
                              onChange={e => updateCell(i, 'weight_grams', e.target.value)}
                              onFocus={() => setActiveCell({ rowIdx: i, col: 'weight_grams' })}
                              onBlur={() => setActiveCell(null)}
                              className={
                                fillDrag?.col === 'weight_grams' && i > fillDrag.srcRowIdx && i <= fillDrag.curRowIdx
                                  ? 'fill-drag-highlight'
                                  : undefined
                              }
                            />
                            {((activeCell?.rowIdx === i && activeCell?.col === 'weight_grams') ||
                              (fillDrag?.srcRowIdx === i && fillDrag?.col === 'weight_grams')) && (
                              <div
                                className="fill-handle"
                                onMouseDown={e => {
                                  e.preventDefault();
                                  setFillDrag({ col: 'weight_grams', srcRowIdx: i, curRowIdx: i });
                                }}
                              />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Projection card */}
            <div>
              <div className="card mb-4">
                <div className="card-title">Projected Harvest Summary</div>
                {projection ? (
                  <>
                    <div className="stat-card mb-4" style={{ border: 'none', padding: '0 0 12px', borderBottom: '1px solid var(--gray-100)' }}>
                      <div className="stat-label">Total Projected Fruit / m²</div>
                      <div className="stat-value">{projection.total_projected.toFixed(2)}</div>
                    </div>
                    <div className="stat-card mb-4" style={{ border: 'none', padding: '0 0 12px', borderBottom: '1px solid var(--gray-100)' }}>
                      <div className="stat-label">Peak Week</div>
                      <div className="stat-value">Week {projection.peak_week}</div>
                    </div>
                    <div className="stat-card" style={{ border: 'none', padding: '0' }}>
                      <div className="stat-label">Peak Projected Fruit / m²</div>
                      <div className="stat-value">{projection.peak_projected.toFixed(2)}</div>
                    </div>
                  </>
                ) : (
                  <div style={{ color: 'var(--gray-400)', fontSize: 13 }}>Save data to see projections.</div>
                )}
              </div>

              {projection && projection.weeks.filter(w => w.projected_fruit_per_m2 > 0).length > 0 && (
                <div className="card">
                  <div className="card-title">Projected by Week</div>
                  <div className="table-wrap" style={{ maxHeight: 400, overflowY: 'auto' }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Harvest Wk</th>
                          <th>Fruit / m²</th>
                        </tr>
                      </thead>
                      <tbody>
                        {projection.weeks
                          .filter(w => w.projected_fruit_per_m2 > 0)
                          .map(w => (
                            <tr key={w.week} style={{ fontWeight: w.week === peakProjection?.week ? 700 : 400 }}>
                              <td>Week {w.week}</td>
                              <td style={{ color: w.week === peakProjection?.week ? 'var(--green-700)' : undefined }}>
                                {w.projected_fruit_per_m2.toFixed(3)}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Actual harvest timing reference (read-only, from fruit_instances) */}
              <div className="card" style={{ marginTop: 16 }}>
                <div className="card-title">Actual Harvest Timing</div>
                {actuals.length === 0 ? (
                  <div style={{ color: 'var(--gray-400)', fontSize: 12 }}>
                    No fruit tracking data yet.<br />
                    Record SetFruit and Harvested statuses on mobile to populate.
                  </div>
                ) : (
                  <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
                    <table style={{ fontSize: 11 }}>
                      <thead>
                        <tr>
                          <th title="Set week">Wk</th>
                          <th title="Number of set fruit instances">n</th>
                          <th>+4%</th>
                          <th>+5%</th>
                          <th>+6%</th>
                          <th>+7%</th>
                          <th>+8%</th>
                          <th>+9%</th>
                          <th>+10%</th>
                        </tr>
                      </thead>
                      <tbody>
                        {actuals.map(row => {
                          const p = row.harvestedPercentByOffset;
                          const fmt = (v: number) => v > 0 ? v.toFixed(0) + '%' : '—';
                          return (
                            <tr key={row.setWeekNumber}>
                              <td style={{ fontWeight: 600, color: 'var(--gray-500)' }}>{row.setWeekNumber}</td>
                              <td style={{ color: 'var(--gray-500)' }}>{row.setCount}</td>
                              <td>{fmt(p.week4Percent)}</td>
                              <td>{fmt(p.week5Percent)}</td>
                              <td>{fmt(p.week6Percent)}</td>
                              <td>{fmt(p.week7Percent)}</td>
                              <td>{fmt(p.week8Percent)}</td>
                              <td>{fmt(p.week9Percent)}</td>
                              <td>{fmt(p.week10Percent)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
