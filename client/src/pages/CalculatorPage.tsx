import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from 'react';
import { Season, Variety, RipeningActualsResult, RipeningActualsRow, RipeningActualsOffsetCell, BreakerForecastMeta, SetWeekCohortClimateRow } from '../types';
import { varietiesApi, yearsApi, harvestTimingApi, fruitSetByWeekApi, fruitWeightsApi, ripeningActualsApi, climateTrainingDatasetApi } from '../services/api';
import { defaultYear, getIsoWeek, uniqueYears, yearNumbers } from '../utils/years';
import { CalculatorClimateExposure } from '../components/CalculatorClimateExposure';

// Shows a decimal place only when the value actually has a fractional part —
// forecast counts/percentages are fractional by nature, confirmed ones never are.
function fmt1(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

type RowDraft = {
  set_week_number: number;
  avg_fruit_set: string;
  weight_grams: string;
};

function makeEmptyRows(): RowDraft[] {
  return Array.from({ length: 52 }, (_, i) => ({
    set_week_number: i + 1,
    avg_fruit_set: '',
    weight_grams: '',
  }));
}

const OFFSET_COLS = [4, 5, 6, 7, 8, 9, 10];
const SUMMARY_OFFSETS = [6, 7, 8, 9, 10];

function fmtWeeks(v: number | null): string {
  return v == null ? '—' : v.toFixed(1);
}

function weekLabel(rawWeek: number): string {
  return rawWeek > 52 ? `${rawWeek - 52} (next yr)` : String(rawWeek);
}

function offsetTooltip(row: RipeningActualsRow, cell: RipeningActualsOffsetCell): string {
  const harvestWeekLabel = weekLabel(row.setWeekNumber + cell.offset);
  const lines = [
    `Set week: ${row.setWeekNumber}`,
    `Harvest week: ${harvestWeekLabel} (+${cell.offset} wk)`,
    `Total set instances: ${row.setCount}`,
    `Confirmed harvested at this offset: ${cell.harvestedCount}`,
    `Breaker forecast at this offset: ${fmt1(cell.breakerExpectedCount)} expected fruit (probabilistic — not individually confirmed)`,
    `Row totals — harvested: ${row.harvestedCount}, currently breaker (actual): ${row.breakerCount}, other outstanding: ${row.otherOutstandingCount}, aborted: ${row.abortedCount}, pruned: ${row.prunedCount}`,
  ];
  if (cell.harvestedSampleStems.length > 0) lines.push(`Harvested sample: ${cell.harvestedSampleStems.join(', ')}`);
  if (cell.breakerSampleStems.length > 0) lines.push(`Breaker sample: ${cell.breakerSampleStems.join(', ')}`);
  return lines.join('\n');
}

function totalTooltip(row: RipeningActualsRow): string {
  const lines = [
    `Set week: ${row.setWeekNumber}`,
    `Total set instances: ${row.setCount}`,
    `Confirmed harvested (any week): ${row.harvestedCount}`,
    `Currently breaker (actual count): ${row.breakerCount}`,
    `Other outstanding (SetFruit/MatureGreen, never yet breaker): ${row.otherOutstandingCount}`,
    `Aborted: ${row.abortedCount}`,
    `Pruned: ${row.prunedCount}`,
  ];
  if (row.unreconciledCount > 0) {
    lines.push(`${row.unreconciledCount} need review — has breaker history but latest recorded status no longer confirms it, and it hasn't resolved to Harvested/Aborted/Pruned either`);
  }
  if (row.breakerRolledForwardCount > 0) {
    lines.push(`${row.breakerRolledForwardCount} breaker instance(s) missed their original predicted week and were rolled forward`);
  }
  if (row.outsideWindowHarvestedCount > 0) {
    lines.push(`${row.outsideWindowHarvestedCount} harvested outside the +4..+10 window (counted in total, not shown in a column)`);
  }
  if (row.breakerEarlierExpectedCount > 0 || row.breakerLaterExpectedCount > 0) {
    lines.push(
      `Breaker forecast outside +4..+10 window: ${fmt1(row.breakerEarlierExpectedCount)} earlier, ${fmt1(row.breakerLaterExpectedCount)} later (expected fruit, counted in total, not shown in a column)`
    );
  }
  return lines.join('\n');
}

function RowDetail({ row, breakerForecast }: { row: RipeningActualsRow; breakerForecast: BreakerForecastMeta }) {
  return (
    <div className="row-detail">
      <div className="row-detail-summary">
        <div><span>Total set</span><strong>{row.setCount}</strong></div>
        <div><span>Harvested</span><strong>{row.harvestedCount}</strong></div>
        <div><span>Currently breaker</span><strong>{row.breakerCount}</strong></div>
        <div><span>Other outstanding</span><strong>{row.otherOutstandingCount}</strong></div>
        <div><span>Aborted</span><strong>{row.abortedCount}</strong></div>
        <div><span>Pruned</span><strong>{row.prunedCount}</strong></div>
        <div><span>Needs review</span><strong>{row.unreconciledCount}</strong></div>
        <div><span>Forecast method</span><strong>{breakerForecast.method === 'learned' ? 'Learned breaker timing' : 'Next-week fallback'}</strong></div>
        <div><span>Historical sample</span><strong>n={breakerForecast.sampleSize} (min {breakerForecast.minSampleSize})</strong></div>
        <div><span>Rolled-forward breakers</span><strong>{row.breakerRolledForwardCount}</strong></div>
      </div>
      {breakerForecast.method === 'learned' && (
        <div className="row-detail-profile">
          Expected distribution: same {fmt1(breakerForecast.profilePercent.same)}% · +1wk {fmt1(breakerForecast.profilePercent.plus1)}%
          {' '}· +2wk {fmt1(breakerForecast.profilePercent.plus2)}% · +3wk {fmt1(breakerForecast.profilePercent.plus3)}% · later {fmt1(breakerForecast.profilePercent.later)}%
        </div>
      )}
      <div className="row-detail-table-scroll">
        <table className="row-detail-table">
          <thead>
            <tr>
              <th>Row</th>
              <th>Stem</th>
              <th>Node</th>
              <th>Set wk</th>
              <th>1st breaker wk</th>
              <th>Latest status</th>
              <th>Actual harvest wk</th>
              <th>Orig. expected wk</th>
              <th>Current expected wk</th>
              <th>Rolled fwd?</th>
              <th>Flag</th>
            </tr>
          </thead>
          <tbody>
            {row.instances.map(inst => (
              <tr key={inst.id} className={inst.needsReview ? 'row-detail-flagged' : undefined}>
                <td>{inst.row}</td>
                <td>{inst.stem}</td>
                <td>{inst.node ?? '—'}</td>
                <td>W{inst.setWeek}</td>
                <td>{inst.firstBreakerWeek != null ? `W${inst.firstBreakerWeek}` : '—'}</td>
                <td>{inst.latestStatus ? `${inst.latestStatus}${inst.latestStatusWeek != null ? ` (W${inst.latestStatusWeek})` : ''}` : '—'}</td>
                <td>{inst.actualHarvestWeek != null ? `W${inst.actualHarvestWeek}` : '—'}</td>
                <td>{inst.originalExpectedHarvestWeek != null ? `W${inst.originalExpectedHarvestWeek}` : '—'}</td>
                <td>{inst.currentExpectedHarvestWeek != null ? `W${inst.currentExpectedHarvestWeek}` : '—'}</td>
                <td>{inst.firstBreakerWeek != null ? (inst.rolledForward ? 'Yes' : 'No') : '—'}</td>
                <td>
                  {inst.needsReview ? (
                    <span className="row-detail-flag-badge" title={inst.needsReviewReason ?? undefined}>Needs review</span>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CalculatorPage() {
  const todayYear   = useMemo(() => new Date().getFullYear(), []);
  const currentWeek = useMemo(() => getIsoWeek(new Date()), []);

  const [years, setYears] = useState<Season[]>([]);
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [selectedYear, setSelectedYear] = useState(todayYear);
  const [selectedVariety, setSelectedVariety] = useState('');
  const [rows, setRows] = useState<RowDraft[]>(makeEmptyRows());
  const [actuals, setActuals] = useState<RipeningActualsResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [error, setError] = useState('');
  const [loadKey, setLoadKey] = useState(0);
  // Row indices (0-based) that have real mobile-measured fruit set — these cells are read-only
  const [measuredWeeks, setMeasuredWeeks] = useState<Set<number>>(new Set());
  // Set weeks whose row-detail (instance-level audit table) is expanded
  const [expandedWeeks, setExpandedWeeks] = useState<Set<number>>(new Set());

  function toggleExpanded(setWeekNumber: number) {
    setExpandedWeeks(prev => {
      const next = new Set(prev);
      if (next.has(setWeekNumber)) next.delete(setWeekNumber);
      else next.add(setWeekNumber);
      return next;
    });
  }

  const currentWeekRowRef = useRef<HTMLTableRowElement>(null);

  // Fill-down drag state — only used for the AFW column now
  const [fillDrag, setFillDrag] = useState<{
    srcRowIdx: number;
    curRowIdx: number;
  } | null>(null);
  const [activeCell, setActiveCell] = useState<{ rowIdx: number; col: 'weight_grams' } | null>(null);
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
      const [profiles, fruitSetData, weights, actualsData] = await Promise.all([
        harvestTimingApi.list(selectedVariety, selectedYear),
        fruitSetByWeekApi.get(selectedVariety, selectedYear).catch(() => []),
        fruitWeightsApi.list(selectedVariety, selectedYear).catch(() => []),
        ripeningActualsApi.get(selectedVariety, selectedYear).catch(() => null),
      ]);
      const base = makeEmptyRows();
      for (const p of profiles) {
        const idx = p.set_week_number - 1;
        if (idx >= 0 && idx < 52) {
          base[idx] = { ...base[idx], avg_fruit_set: p.avg_fruit_set ? String(p.avg_fruit_set) : '' };
        }
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
      setActuals(actualsData);
      setLoadKey(k => k + 1);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Load failed');
    }
  }, [selectedVariety, selectedYear]);

  useEffect(() => { loadData(); }, [loadData]);

  // Climate exposure per set-week cohort — a separate, non-fatal fetch that
  // never touches the projection/forecast load above. One request covers
  // every set-week at once (not per-row), looked up by set_week_number when
  // a row's Climate Exposure section is expanded.
  const [climateCohorts, setClimateCohorts] = useState<SetWeekCohortClimateRow[]>([]);
  const [expandedClimateWeeks, setExpandedClimateWeeks] = useState<Set<number>>(new Set());

  function toggleClimateExpanded(setWeekNumber: number) {
    setExpandedClimateWeeks(prev => {
      const next = new Set(prev);
      if (next.has(setWeekNumber)) next.delete(setWeekNumber);
      else next.add(setWeekNumber);
      return next;
    });
  }

  useEffect(() => {
    if (!selectedVariety || !selectedYear) { setClimateCohorts([]); return; }
    climateTrainingDatasetApi.get(selectedVariety, selectedYear, 'cohort')
      .then(r => setClimateCohorts(r.rows as SetWeekCohortClimateRow[]))
      .catch(() => setClimateCohorts([]));
  }, [selectedVariety, selectedYear]);

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
          const srcValue = prev[drag.srcRowIdx].weight_grams;
          const next = [...prev];
          for (let i = drag.srcRowIdx + 1; i <= drag.curRowIdx; i++) {
            next[i] = { ...next[i], weight_grams: srcValue };
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
      // Only avg_fruit_set is owned by this page now — the week4..week10
      // percent columns are derived from fruit_instances, not entered here,
      // so they're deliberately omitted (an upsert only touches the columns
      // it sends; leaving them out preserves whatever the Projections page
      // last had, rather than zeroing them out).
      const timingRows = rows
        .filter(r => Number(r.avg_fruit_set || 0) > 0)
        .map(r => ({
          variety_id: selectedVariety,
          year: selectedYear,
          set_week_number: r.set_week_number,
          avg_fruit_set: Number(r.avg_fruit_set || 0),
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
      setSaveMsg('Saved successfully!');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const actualsByWeek = useMemo(() => {
    const map = new Map<number, RipeningActualsRow>();
    for (const r of actuals?.rows ?? []) map.set(r.setWeekNumber, r);
    return map;
  }, [actuals]);

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
                Weekly Fruit Set &amp; Actual Harvest Timing
              </div>
              {actuals && (
                <div className="forecast-method-banner">
                  <span>
                    Forecast method: <strong>{actuals.breakerForecast.method === 'learned' ? 'Learned breaker timing' : 'Next-week fallback'}</strong>
                  </span>
                  <span>
                    Historical breaker sample: <strong>n={actuals.breakerForecast.sampleSize}</strong>
                    {actuals.breakerForecast.method === 'fallback' && <> (minimum required: {actuals.breakerForecast.minSampleSize})</>}
                  </span>
                  {actuals.breakerForecast.method === 'learned' && (
                    <span
                      title={`Same week: ${fmt1(actuals.breakerForecast.profilePercent.same)}%\n+1 week: ${fmt1(actuals.breakerForecast.profilePercent.plus1)}%\n+2 weeks: ${fmt1(actuals.breakerForecast.profilePercent.plus2)}%\n+3 weeks: ${fmt1(actuals.breakerForecast.profilePercent.plus3)}%\n+3 or later: ${fmt1(actuals.breakerForecast.profilePercent.later)}%`}
                    >
                      Profile: same {fmt1(actuals.breakerForecast.profilePercent.same)}% · +1wk {fmt1(actuals.breakerForecast.profilePercent.plus1)}% · +2wk {fmt1(actuals.breakerForecast.profilePercent.plus2)}% · +3wk {fmt1(actuals.breakerForecast.profilePercent.plus3)}% · later {fmt1(actuals.breakerForecast.profilePercent.later)}%
                    </span>
                  )}
                </div>
              )}
              <div className="calculator-table-scroll">
                <table className="calc-table">
                  <thead>
                    <tr>
                      <th>Wk</th>
                      <th className="calculator-fruit-set-col" title="Mobile-measured where available. Enter a forecast for future weeks — mobile data will override it when it arrives.">
                        Fruit Set / m²
                      </th>
                      {OFFSET_COLS.map(o => (
                        <th key={o} title={`Green: % harvested exactly ${o} weeks after set.\nOrange: % expected fruit (probabilistic forecast, not confirmed) whose best current estimate falls ${o} weeks after set.`}>
                          +{o} wk
                        </th>
                      ))}
                      <th title="Green: % harvested at any offset (may exceed the +4..+10 window).\nOrange: % expected fruit from the current breaker population (probabilistic forecast, may exceed the +4..+10 window).">
                        Harvested / Breaker
                      </th>
                      <th className="calc-afw-col" title="Average fruit weight — still used by the Projections page and breaker adjustment">AFW/g</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const isCurrentWeek = selectedYear === todayYear && row.set_week_number === currentWeek;
                      const actualRow = actualsByWeek.get(row.set_week_number);
                      const hasDetail = !!actualRow && actualRow.setCount > 0;
                      const isExpanded = hasDetail && expandedWeeks.has(row.set_week_number);
                      const climateCohort = climateCohorts.find(c => c.setWeekNumber === row.set_week_number);
                      const hasClimateDetail = !!climateCohort;
                      const isClimateExpanded = hasClimateDetail && expandedClimateWeeks.has(row.set_week_number);
                      const totalCols = 2 + OFFSET_COLS.length + 2;
                      return (
                        <Fragment key={row.set_week_number}>
                        <tr
                          ref={isCurrentWeek ? currentWeekRowRef : null}
                          className={isCurrentWeek ? 'calc-row-current-week' : undefined}
                          data-row-idx={i}
                        >
                          <td style={{ fontWeight: 600, color: 'var(--gray-500)', whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              {hasDetail ? (
                                <button
                                  type="button"
                                  className="row-expand-toggle"
                                  onClick={() => toggleExpanded(row.set_week_number)}
                                  title="Show underlying fruit-instance detail for this set week"
                                >
                                  <span className={`row-expand-chevron${isExpanded ? ' row-expand-chevron--open' : ''}`}>▸</span>
                                  {i + 1}
                                </button>
                              ) : (
                                i + 1
                              )}
                              {hasClimateDetail && (
                                <button
                                  type="button"
                                  className="row-expand-toggle row-expand-toggle--climate"
                                  onClick={() => toggleClimateExpanded(row.set_week_number)}
                                  title="Show climate exposure for this set week"
                                >
                                  <span className={`row-expand-chevron${isClimateExpanded ? ' row-expand-chevron--open' : ''}`}>▸</span>
                                  Climate
                                </button>
                              )}
                            </div>
                          </td>
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
                          {OFFSET_COLS.map(offset => {
                            const cell = actualRow?.offsets.find(o => o.offset === offset);
                            if (!actualRow || !cell || actualRow.setCount === 0) {
                              return <td key={offset} className="actual-cell-blank">—</td>;
                            }
                            const showHarvested = cell.hasOccurred;
                            const showBreaker = cell.breakerExpectedCount > 0;
                            if (!showHarvested && !showBreaker) {
                              return (
                                <td key={offset} className="actual-cell-blank" title="This offset hasn't happened yet">—</td>
                              );
                            }
                            return (
                              <td key={offset} className="actual-cell" title={offsetTooltip(actualRow, cell)}>
                                {showHarvested && (
                                  <div className="actual-cell-harvested">
                                    <div className="actual-cell-pct actual-cell-pct-harvested">{cell.harvestedPercent.toFixed(0)}%</div>
                                    <div className="actual-cell-count">{cell.harvestedCount}/{actualRow.setCount}</div>
                                  </div>
                                )}
                                {showBreaker && (
                                  <div className="actual-cell-breaker">
                                    <div className="actual-cell-pct actual-cell-pct-breaker">+{fmt1(cell.breakerExpectedPercent)}%</div>
                                    <div className="actual-cell-count">{fmt1(cell.breakerExpectedCount)} exp / {actualRow.setCount}</div>
                                  </div>
                                )}
                              </td>
                            );
                          })}
                          <td className="actual-cell actual-cell-total">
                            {actualRow && actualRow.setCount > 0 ? (
                              <div title={totalTooltip(actualRow)}>
                                <div className="actual-cell-harvested">
                                  <div className="actual-cell-pct actual-cell-pct-harvested">{actualRow.harvestedPercent.toFixed(0)}%</div>
                                  <div className="actual-cell-count">{actualRow.harvestedCount}/{actualRow.setCount}</div>
                                </div>
                                {actualRow.breakerCount > 0 && (
                                  <div className="actual-cell-breaker">
                                    <div className="actual-cell-pct actual-cell-pct-breaker">+{fmt1(actualRow.breakerPercent)}%</div>
                                    <div className="actual-cell-count">{actualRow.breakerCount}/{actualRow.setCount}</div>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="actual-cell-blank-inline">—</span>
                            )}
                          </td>
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
                                fillDrag != null && i > fillDrag.srcRowIdx && i <= fillDrag.curRowIdx
                                  ? 'fill-drag-highlight'
                                  : undefined
                              }
                            />
                            {((activeCell?.rowIdx === i && activeCell?.col === 'weight_grams') ||
                              (fillDrag?.srcRowIdx === i)) && (
                              <div
                                className="fill-handle"
                                onMouseDown={e => {
                                  e.preventDefault();
                                  setFillDrag({ srcRowIdx: i, curRowIdx: i });
                                }}
                              />
                            )}
                          </td>
                        </tr>
                        {isExpanded && actualRow && (
                          <tr className="row-detail-row">
                            <td colSpan={totalCols}>
                              <RowDetail row={actualRow} breakerForecast={actuals!.breakerForecast} />
                            </td>
                          </tr>
                        )}
                        {isClimateExpanded && climateCohort && (
                          <tr className="row-detail-row">
                            <td colSpan={totalCols}>
                              <div className="row-detail">
                                <div className="card-title" style={{ marginBottom: 12 }}>Climate Exposure</div>
                                <CalculatorClimateExposure cohort={climateCohort} varietyId={selectedVariety} year={selectedYear} />
                              </div>
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="actual-legend">
                <span className="actual-legend-item"><span className="actual-legend-swatch actual-legend-swatch-harvested" /> Actually harvested</span>
                <span className="actual-legend-item"><span className="actual-legend-swatch actual-legend-swatch-breaker" /> Expected fruit — probabilistic forecast from current breakers, not confirmed</span>
                <span className="actual-legend-item"><span className="actual-legend-swatch actual-legend-swatch-blank">—</span> Timing week has not occurred</span>
              </div>
            </div>

            {/* Actual Harvest Timing Summary — replaces the old manually-derived projection summary */}
            <div>
              <div className="card mb-4">
                <div className="card-title">Actual Harvest Timing Summary</div>
                {actuals && (actuals.summary.totalCompleted > 0 || actuals.summary.totalCurrentBreakers > 0) ? (
                  <>
                    <div className="summary-stat-row">
                      <span>Avg weeks to harvest</span>
                      <strong>{fmtWeeks(actuals.summary.avgWeeksToHarvest)}</strong>
                    </div>
                    <div className="summary-stat-row">
                      <span>Median weeks to harvest</span>
                      <strong>{fmtWeeks(actuals.summary.medianWeeksToHarvest)}</strong>
                    </div>
                    <div className="summary-stat-row">
                      <span>Most common offset</span>
                      <strong>{actuals.summary.modeWeeksToHarvest != null ? `+${actuals.summary.modeWeeksToHarvest} wk` : '—'}</strong>
                    </div>

                    <div className="summary-divider" />
                    {SUMMARY_OFFSETS.map(o => (
                      <div className="summary-stat-row" key={o}>
                        <span>Harvested by +{o} wk</span>
                        <strong>{(actuals.summary.cumulativePercentByOffset[`week${o}`] ?? 0).toFixed(0)}%</strong>
                      </div>
                    ))}

                    <div className="summary-divider" />
                    <div className="summary-stat-row">
                      <span>Total completed</span>
                      <strong>{actuals.summary.totalCompleted}</strong>
                    </div>
                    <div className="summary-stat-row">
                      <span>Total outstanding</span>
                      <strong>{actuals.summary.totalOutstanding}</strong>
                    </div>
                    <div className="summary-stat-row">
                      <span>Total aborted</span>
                      <strong>{actuals.summary.totalAborted}</strong>
                    </div>
                    <div className="summary-stat-row">
                      <span>Total pruned</span>
                      <strong>{actuals.summary.totalPruned}</strong>
                    </div>
                    <div className="summary-stat-row">
                      <span>Sample size</span>
                      <strong>n={actuals.summary.sampleSize}</strong>
                    </div>

                    <div className="summary-divider" />
                    <div className="summary-stat-row">
                      <span>Forecast method</span>
                      <strong>{actuals.breakerForecast.method === 'learned' ? 'Learned' : 'Fallback'}</strong>
                    </div>
                    <div className="summary-stat-row">
                      <span className="summary-stat-breaker-label">Currently breaker (actual)</span>
                      <strong className="summary-stat-breaker-value">{actuals.summary.totalCurrentBreakers}</strong>
                    </div>
                    {actuals.summary.totalUnreconciled > 0 && (
                      <div className="summary-stat-row">
                        <span>Needs review</span>
                        <strong>{actuals.summary.totalUnreconciled}</strong>
                      </div>
                    )}
                    {actuals.summary.totalBreakerRolledForward > 0 && (
                      <div className="summary-stat-row">
                        <span className="summary-stat-breaker-label">— missed original week, rolled forward</span>
                        <strong className="summary-stat-breaker-value">{actuals.summary.totalBreakerRolledForward}</strong>
                      </div>
                    )}
                    <div className="summary-note">
                      Breaker values are provisional forecasts — not counted in totals above. Disappears here and appears as a confirmed harvest once recorded.
                    </div>
                  </>
                ) : (
                  <div style={{ color: 'var(--gray-400)', fontSize: 13 }}>
                    No completed fruit instances yet.<br />
                    Record SetFruit and Harvested statuses on mobile to populate this summary.
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
