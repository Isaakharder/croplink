import { useState, useEffect, useMemo } from 'react';
import { Season, Variety, HarvestProjectionsResult, BreakerLearningResult } from '../types';
import { yearsApi, varietiesApi, harvestProjectionsApi, breakerLearningApi } from '../services/api';
import { defaultYear, uniqueYears } from '../utils/years';

function getIsoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

export function ProjectionsPage() {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [selectedVarietyId, setSelectedVarietyId] = useState<string>('');
  const [data, setData] = useState<HarvestProjectionsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [breakerData, setBreakerData] = useState<BreakerLearningResult | null>(null);

  useEffect(() => {
    yearsApi.list().then((s) => {
      setSeasons(s);
      setSelectedYear(defaultYear(s));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedYear) return;
    varietiesApi.list(undefined, selectedYear).then((vs) => {
      setVarieties(vs.filter((v) => v.is_active));
      setSelectedVarietyId('');
    }).catch(() => {});
  }, [selectedYear]);

  useEffect(() => {
    if (!selectedYear) return;
    setLoading(true);
    setError(null);
    harvestProjectionsApi
      .get(selectedYear, selectedVarietyId || undefined)
      .then((result) => {
        setData(result);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load projections');
        setLoading(false);
      });
  }, [selectedYear, selectedVarietyId]);

  // Load breaker learning data whenever a single variety is selected
  useEffect(() => {
    if (!selectedVarietyId || !selectedYear) {
      setBreakerData(null);
      return;
    }
    breakerLearningApi.get(selectedYear, selectedVarietyId)
      .then(setBreakerData)
      .catch(() => setBreakerData(null));
  }, [selectedYear, selectedVarietyId]);

  const years = useMemo(() => uniqueYears(seasons), [seasons]);

  const activeWeeks = useMemo(() => {
    if (!data) return [];
    return data.weeklyTotals.filter((w) => w.totalKg > 0).map((w) => w.week);
  }, [data]);

  const weeklyRows = useMemo(() => {
    if (!data) return [];
    return activeWeeks.map((week) => data.weeklyTotals.find((w) => w.week === week)!);
  }, [data, activeWeeks]);

  const colors = useMemo(() => {
    if (!data) return [];
    return Object.keys(data.colorTotals).sort();
  }, [data]);

  const grandTotal = useMemo(() => {
    if (!data) return 0;
    return Math.round(data.varietyTotals.reduce((s, v) => s + v.totalKg, 0) * 10) / 10;
  }, [data]);

  function fmt(n: number) {
    return n > 0 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—';
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h2>Projections</h2>
          <p className="page-subtitle">Expected harvest by week from fruit set &amp; timing profiles</p>
        </div>
      </div>

      <div className="selector-bar">
        <label>Year</label>
        <select
          className="form-control"
          style={{ width: 180 }}
          value={selectedYear}
          onChange={(e) => setSelectedYear(Number(e.target.value))}
        >
          {years.map((s) => (
            <option key={s.id} value={s.year}>{s.year}</option>
          ))}
        </select>
        <label>Variety</label>
        <select
          className="form-control"
          style={{ width: 160 }}
          value={selectedVarietyId}
          onChange={(e) => setSelectedVarietyId(e.target.value)}
        >
          <option value="">All Varieties</option>
          {varieties.map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </select>
      </div>

      {loading && <div className="loading-state">Loading projections…</div>}
      {error && <div className="error-banner">{error}</div>}

      {data && !loading && (
        <>
          {activeWeeks.length === 0 ? (
            <div className="empty-state">
              <p>No projection data for this selection.</p>
              <p className="empty-hint">Make sure harvest timing profiles and fruit weights are entered in the Calculator.</p>
            </div>
          ) : (
            <>
              {/* Breaker adjustment card — only when a single variety is selected */}
              {breakerData && selectedVarietyId && (() => {
                const currentWeek = breakerData.currentWeek;
                const nextWeek = currentWeek === 52 ? 1 : currentWeek + 1;
                const baseKg = data?.weeklyTotals.find(w => w.week === nextWeek)?.byVariety[selectedVarietyId] ?? 0;
                const adjustedKg = Math.round((baseKg + breakerData.nextWeekBreakerKgEstimate) * 10) / 10;
                return (
                  <div className="projections-card projections-card--full breaker-card">
                    <div className="breaker-card-header">
                      <h3 className="projections-card-title" style={{ marginBottom: 0 }}>
                        Breaker Adjustment — Next Week (W{nextWeek})
                      </h3>
                      {breakerData.sampleSize > 0 && (
                        <span className="breaker-sample-tag">n={breakerData.sampleSize} historical</span>
                      )}
                    </div>

                    <div className="breaker-grid">
                      <div className="breaker-section">
                        <div className="breaker-section-label">Current week (W{currentWeek})</div>
                        <div className="breaker-stat-row">
                          <span>Breaker nodes</span>
                          <strong>{breakerData.currentWeekBreakerCount}</strong>
                        </div>
                        <div className="breaker-stat-row">
                          <span>Measured stems</span>
                          <strong>{breakerData.currentWeekMeasuredStemCount}</strong>
                        </div>
                        <div className="breaker-stat-row">
                          <span>Breaker fruit / m²</span>
                          <strong>{breakerData.currentWeekBreakerFruitPerM2.toFixed(3)}</strong>
                        </div>
                      </div>

                      {breakerData.sampleSize > 0 && (
                        <div className="breaker-section">
                          <div className="breaker-section-label">Historical learning</div>
                          <div className="breaker-stat-row">
                            <span>Avg weeks to harvest</span>
                            <strong>{breakerData.avgBreakerToHarvestWeeks.toFixed(1)}</strong>
                          </div>
                          <div className="breaker-stat-row">
                            <span>Harvested within 1 wk</span>
                            <strong>{breakerData.harvestedWithinOneWeekPercent.toFixed(0)}%</strong>
                          </div>
                        </div>
                      )}

                      <div className="breaker-section breaker-section--estimate">
                        <div className="breaker-section-label">W{nextWeek} estimate</div>
                        <div className="breaker-stat-row">
                          <span>Base projection</span>
                          <strong>{baseKg > 0 ? baseKg.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} kg</strong>
                        </div>
                        <div className="breaker-stat-row breaker-adjustment-row">
                          <span>+ Breaker adjust</span>
                          <strong className="breaker-adj-value">
                            {breakerData.nextWeekBreakerKgEstimate > 0
                              ? `+${breakerData.nextWeekBreakerKgEstimate.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg`
                              : breakerData.missingAfwWarning ? 'no AFW/g' : '—'}
                          </strong>
                        </div>
                        <div className="breaker-stat-row breaker-total-row">
                          <span>= Adjusted total</span>
                          <strong className="breaker-total-value">
                            {adjustedKg > 0 ? adjustedKg.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} kg
                          </strong>
                        </div>
                        {breakerData.missingAfwWarning && (
                          <div className="breaker-warning">AFW/g not set for W{nextWeek} — enter in Calculator</div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Summary cards row */}
              <div className="projections-summary-row">
                <div className="projections-card">
                  <h3 className="projections-card-title">Variety Totals</h3>
                  <table className="projections-summary-table">
                    <thead>
                      <tr>
                        <th>Variety</th>
                        <th>Color</th>
                        <th className="num-cell">Total (kg)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.varietyTotals.map((v) => (
                        <tr key={v.id}>
                          <td>{v.name}</td>
                          <td className="color-cell">{v.color ?? '—'}</td>
                          <td className="num-cell">{fmt(v.totalKg)}</td>
                        </tr>
                      ))}
                    </tbody>
                    {data.varietyTotals.length > 1 && (
                      <tfoot>
                        <tr className="totals-row">
                          <td colSpan={2}>Total</td>
                          <td className="num-cell">{fmt(grandTotal)}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>

                {colors.length > 1 && (
                  <div className="projections-card">
                    <h3 className="projections-card-title">Color Totals</h3>
                    <table className="projections-summary-table">
                      <thead>
                        <tr>
                          <th>Color</th>
                          <th className="num-cell">Total (kg)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {colors.map((c) => (
                          <tr key={c}>
                            <td className="color-cell">{c}</td>
                            <td className="num-cell">{fmt(data.colorTotals[c] ?? 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Weekly by variety table */}
              <div className="projections-card projections-card--full">
                <h3 className="projections-card-title">Weekly Projections by Variety</h3>
                <div className="projections-table-scroll">
                  <table className="projections-table">
                    <thead>
                      <tr>
                        <th className="proj-wk-col">Wk</th>
                        {data.varieties.map((v) => (
                          <th key={v.id}>
                            {v.name}
                            {v.color ? <span className="proj-color-tag">{v.color}</span> : null}
                          </th>
                        ))}
                        {data.varieties.length > 1 && <th className="proj-total-col">Total kg</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {weeklyRows.map(({ week, byVariety, totalKg }) => (
                        <tr key={week}>
                          <td className="proj-wk-col">W{week}</td>
                          {data.varieties.map((v) => (
                            <td key={v.id} className="num-cell">
                              {fmt(byVariety[v.id] ?? 0)}
                            </td>
                          ))}
                          {data.varieties.length > 1 && (
                            <td className="num-cell proj-total-col">
                              <strong>{fmt(totalKg)}</strong>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Color-by-week table (only when multiple colors present) */}
              {colors.length > 1 && (
                <div className="projections-card projections-card--full">
                  <h3 className="projections-card-title">Weekly Projections by Color</h3>
                  <div className="projections-table-scroll">
                    <table className="projections-table">
                      <thead>
                        <tr>
                          <th className="proj-wk-col">Wk</th>
                          {colors.map((c) => <th key={c}>{c}</th>)}
                          <th className="proj-total-col">Total kg</th>
                        </tr>
                      </thead>
                      <tbody>
                        {weeklyRows.map(({ week, byColor, totalKg }) => (
                          <tr key={week}>
                            <td className="proj-wk-col">W{week}</td>
                            {colors.map((c) => (
                              <td key={c} className="num-cell">
                                {fmt(byColor[c] ?? 0)}
                              </td>
                            ))}
                            <td className="num-cell proj-total-col">
                              <strong>{fmt(totalKg)}</strong>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
