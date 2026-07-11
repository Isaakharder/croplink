import { useState, useEffect, useMemo } from 'react';
import { Season, Variety, HarvestProjectionsResult, BreakerLearningResult } from '../types';
import { yearsApi, varietiesApi, harvestProjectionsApi, breakerLearningApi } from '../services/api';
import { defaultYear, uniqueYears } from '../utils/years';

export function ProjectionsPage() {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [selectedVarietyId, setSelectedVarietyId] = useState<string>('');
  const [data, setData] = useState<HarvestProjectionsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [breakerData, setBreakerData] = useState<BreakerLearningResult | null>(null);
  const [caseKgInput, setCaseKgInput] = useState<string>('');
  const [showBreakerDetails, setShowBreakerDetails] = useState(false);

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

  // Keep the Case kg input in sync with whichever variety is selected
  useEffect(() => {
    const variety = varieties.find((v) => v.id === selectedVarietyId);
    setCaseKgInput(variety?.case_kg != null ? String(variety.case_kg) : '');
  }, [selectedVarietyId, varieties]);

  async function saveCaseKg() {
    if (!selectedVarietyId) return;
    const trimmed = caseKgInput.trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    if (parsed != null && (Number.isNaN(parsed) || parsed < 0)) return;
    try {
      const updated = await varietiesApi.update(selectedVarietyId, { case_kg: parsed });
      setVarieties((prev) => prev.map((v) => (v.id === selectedVarietyId ? { ...v, case_kg: updated.case_kg } : v)));
    } catch {
      // leave the input as-is; it will resync from server data on next load
    }
  }

  const years = useMemo(() => uniqueYears(seasons), [seasons]);

  const caseKgByVariety = useMemo(() => {
    const map: Record<string, number | null | undefined> = {};
    for (const v of varieties) map[v.id] = v.case_kg;
    return map;
  }, [varieties]);

  const activeWeeks = useMemo(() => {
    if (!data) return [];
    const weekSet = new Set<number>();
    for (const v of data.varieties) {
      for (const w of v.weeks) {
        if (w.projectedFruitPerM2 > 0) weekSet.add(w.week);
      }
    }
    return Array.from(weekSet).sort((a, b) => a - b);
  }, [data]);

  const hasMissingAfwWeeks = useMemo(() => {
    if (!data) return false;
    for (const v of data.varieties) {
      for (const w of v.weeks) {
        if (w.projectedFruitPerM2 > 0 && w.projectedKg === 0) return true;
      }
    }
    return false;
  }, [data]);

  const fruitPerM2Map = useMemo(() => {
    const map: Record<string, Record<number, number>> = {};
    if (!data) return map;
    for (const v of data.varieties) {
      map[v.id] = {};
      for (const w of v.weeks) {
        if (w.projectedFruitPerM2 > 0) map[v.id][w.week] = w.projectedFruitPerM2;
      }
    }
    return map;
  }, [data]);

  const weeklyRows = useMemo(() => {
    if (!data) return [];
    return activeWeeks.map((week) => data.weeklyTotals.find((w) => w.week === week)!);
  }, [data, activeWeeks]);

  const colors = useMemo(() => {
    if (!data) return [];
    return Object.keys(data.colorTotals).sort();
  }, [data]);

  function fmt(n: number) {
    return n > 0 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—';
  }

  function casesLabel(kg: number, caseKg: number | null | undefined): string {
    if (kg <= 0 || !caseKg || caseKg <= 0) return '—';
    return `${Math.round(kg / caseKg).toLocaleString()} cs`;
  }

  function totalCasesLabel(byVariety: Record<string, number>): string {
    if (!data) return '—';
    let sum = 0;
    let any = false;
    for (const v of data.varieties) {
      const kg = byVariety[v.id] ?? 0;
      const caseKg = caseKgByVariety[v.id];
      if (kg > 0 && caseKg && caseKg > 0) {
        sum += kg / caseKg;
        any = true;
      }
    }
    return any ? `${Math.round(sum).toLocaleString()} cs` : '—';
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
        <label>Case kg</label>
        <input
          type="number"
          min="0"
          step="0.1"
          className="form-control"
          style={{ width: 100 }}
          value={caseKgInput}
          disabled={!selectedVarietyId}
          placeholder={selectedVarietyId ? '0' : '—'}
          title={selectedVarietyId ? '' : 'Select a variety to set its case weight'}
          onChange={(e) => setCaseKgInput(e.target.value)}
          onBlur={saveCaseKg}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
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
              {hasMissingAfwWeeks && (
                <div className="warning-banner">
                  Some harvest weeks have projected fruit but no AFW/g — enter AFW/g in the Calculator to see kg estimates.
                </div>
              )}

              {/* Breaker adjustment card — only when a single variety is selected */}
              {breakerData && selectedVarietyId && (() => {
                const currentWeek = breakerData.currentWeek;
                const nextWeek = breakerData.nextWeek;
                const baseKg = data?.weeklyTotals.find(w => w.week === nextWeek)?.byVariety[selectedVarietyId] ?? 0;
                const adjustedKg = Math.round((baseKg + breakerData.nextWeekBreakerKgEstimate) * 10) / 10;
                const caseKg = caseKgByVariety[selectedVarietyId];
                const n = (v: number, digits = 0) => v.toLocaleString(undefined, { maximumFractionDigits: digits });
                return (
                  <div className="projections-card projections-card--full breaker-card">
                    <div className="breaker-card-header">
                      <h3 className="projections-card-title" style={{ marginBottom: 0 }}>
                        Breaker Adjustment — Next Week (W{nextWeek})
                      </h3>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {breakerData.sampleSize > 0 && (
                          <span className="breaker-sample-tag">n={breakerData.sampleSize} historical</span>
                        )}
                        <button
                          type="button"
                          className="breaker-details-toggle"
                          onClick={() => setShowBreakerDetails((v) => !v)}
                        >
                          {showBreakerDetails ? 'Hide calculation' : 'Show calculation'}
                        </button>
                      </div>
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
                        <div className="breaker-stat-row">
                          <span>Harvested / m²</span>
                          <strong>
                            {breakerData.currentWeekHarvestedFruitPerM2.toFixed(3)}
                            {breakerData.currentWeekHarvestedKgEstimate > 0 && (
                              <span className="breaker-cases-sub"> (~{n(breakerData.currentWeekHarvestedKgEstimate)} kg)</span>
                            )}
                          </strong>
                        </div>
                        <div className="breaker-harvested-note">
                          Display only — not used for historical learning or projection correction.
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
                            <span>Historical 1-week harvest rate</span>
                            <strong>{breakerData.harvestedWithinOneWeekPercent.toFixed(0)}%</strong>
                          </div>
                        </div>
                      )}

                      <div className="breaker-section breaker-section--estimate">
                        <div className="breaker-section-label">W{nextWeek} estimate</div>
                        <div className="breaker-stat-row">
                          <span>Base projection</span>
                          <strong>
                            {baseKg > 0 ? n(baseKg) : '—'} kg
                            <span className="breaker-cases-sub"> ({casesLabel(baseKg, caseKg)})</span>
                          </strong>
                        </div>
                        <div className="breaker-stat-row breaker-adjustment-row">
                          <span>+ Breaker adjust</span>
                          <strong className="breaker-adj-value">
                            {breakerData.nextWeekBreakerKgEstimate > 0
                              ? `+${n(breakerData.nextWeekBreakerKgEstimate)} kg`
                              : breakerData.adjustmentSuppressed ? 'not applied'
                              : breakerData.missingAfwWarning ? 'no AFW/g' : '—'}
                          </strong>
                        </div>
                        {breakerData.nextWeekBreakerKgEstimate > 0 && (
                          <div className="breaker-adj-note">
                            {breakerData.harvestedWithinOneWeekPercent.toFixed(0)}% applied conversion rate ×{' '}
                            {n(breakerData.nextWeekBreakerKgEstimateRaw)} kg raw estimate
                            (historical 1-week harvest rate, n={breakerData.sampleSize})
                          </div>
                        )}
                        {breakerData.adjustmentSuppressed && (
                          <div className="breaker-warning">
                            Sample too small (n={breakerData.sampleSize} &lt; {breakerData.minSampleSizeForAdjustment}) —
                            raw estimate would be {n(breakerData.nextWeekBreakerKgEstimateRaw)} kg but is not applied
                          </div>
                        )}
                        <div className="breaker-stat-row breaker-total-row">
                          <span>= Adjusted total</span>
                          <strong className="breaker-total-value">
                            {adjustedKg > 0 ? n(adjustedKg) : '—'} kg
                            <span className="breaker-cases-sub"> ({casesLabel(adjustedKg, caseKg)})</span>
                          </strong>
                        </div>
                        {breakerData.missingAfwWarning && (
                          <div className="breaker-warning">AFW/g not set for W{nextWeek} — enter in Calculator</div>
                        )}
                      </div>
                    </div>

                    {showBreakerDetails && (
                      <div className="breaker-details">
                        <div className="breaker-details-block">
                          <div className="breaker-details-title">Breaker adjustment — worked calculation</div>
                          <table className="breaker-details-table">
                            <tbody>
                              <tr><td>Sampled breaker nodes (W{currentWeek})</td><td>{breakerData.currentWeekBreakerCount}</td></tr>
                              <tr><td>Measured stems (W{currentWeek})</td><td>{breakerData.currentWeekMeasuredStemCount}</td></tr>
                              <tr><td>Variety total configured stems</td><td>{n(breakerData.varietyTotalStemCount)}</td></tr>
                              <tr><td>Variety area</td><td>{n(breakerData.varietyAreaM2)} m²</td></tr>
                              <tr><td>Breaker fruit / m²</td><td>{breakerData.currentWeekBreakerFruitPerM2.toFixed(3)}</td></tr>
                              <tr><td>AFW used (W{nextWeek})</td><td>{breakerData.nextWeekAfw > 0 ? `${breakerData.nextWeekAfw} g` : 'not set'}</td></tr>
                              <tr><td>Raw estimated kg (before scaling)</td><td>{n(breakerData.nextWeekBreakerKgEstimateRaw)} kg</td></tr>
                              <tr><td>Historical 1-week harvest rate</td><td>{breakerData.harvestedWithinOneWeekPercent.toFixed(0)}%</td></tr>
                              <tr><td>Historical sample count</td><td>n={breakerData.sampleSize} (min required: {breakerData.minSampleSizeForAdjustment})</td></tr>
                              <tr><td>Applied adjustment kg</td><td>{n(breakerData.nextWeekBreakerKgEstimate)} kg</td></tr>
                              <tr><td>Suppressed?</td>
                                <td>
                                  {breakerData.adjustmentSuppressed
                                    ? `Yes — sample below minimum (n=${breakerData.sampleSize} < ${breakerData.minSampleSizeForAdjustment})`
                                    : 'No'}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                          <pre className="breaker-details-formula">{
`breaker fruit/m² = (breaker nodes / measured stems) × total stems / area
                  = (${breakerData.currentWeekBreakerCount} / ${breakerData.currentWeekMeasuredStemCount}) × ${n(breakerData.varietyTotalStemCount)} / ${n(breakerData.varietyAreaM2)}
                  = ${breakerData.currentWeekBreakerFruitPerM2.toFixed(3)} /m²

raw estimated kg = breaker fruit/m² × area × AFW / 1000
                  = ${breakerData.currentWeekBreakerFruitPerM2.toFixed(3)} × ${n(breakerData.varietyAreaM2)} × ${breakerData.nextWeekAfw}g / 1000
                  = ${n(breakerData.nextWeekBreakerKgEstimateRaw)} kg

applied kg = raw estimated kg × historical 1-week harvest rate (only if n ≥ ${breakerData.minSampleSizeForAdjustment})
           = ${n(breakerData.nextWeekBreakerKgEstimateRaw)} × ${breakerData.harvestedWithinOneWeekPercent.toFixed(0)}%${breakerData.adjustmentSuppressed ? '  →  suppressed (n too small)' : ''}
           = ${n(breakerData.nextWeekBreakerKgEstimate)} kg`
                          }</pre>
                        </div>

                        <div className="breaker-details-block">
                          <div className="breaker-details-title">Harvested estimate — worked calculation (display only)</div>
                          <table className="breaker-details-table">
                            <tbody>
                              <tr><td>Harvested nodes (W{currentWeek})</td><td>{breakerData.currentWeekHarvestedCount}</td></tr>
                              <tr><td>Measured stems (W{currentWeek})</td><td>{breakerData.currentWeekMeasuredStemCount}</td></tr>
                              <tr><td>Variety total configured stems</td><td>{n(breakerData.varietyTotalStemCount)}</td></tr>
                              <tr><td>Variety area</td><td>{n(breakerData.varietyAreaM2)} m²</td></tr>
                              <tr><td>Harvested fruit / m²</td><td>{breakerData.currentWeekHarvestedFruitPerM2.toFixed(3)}</td></tr>
                              <tr><td>AFW used (W{currentWeek}, current week)</td><td>{breakerData.currentWeekAfw > 0 ? `${breakerData.currentWeekAfw} g` : 'not set'}</td></tr>
                              <tr><td>Estimated harvested kg</td><td>{n(breakerData.currentWeekHarvestedKgEstimate)} kg</td></tr>
                            </tbody>
                          </table>
                          <pre className="breaker-details-formula">{
`harvested fruit/m² = (harvested nodes / measured stems) × total stems / area
                    = (${breakerData.currentWeekHarvestedCount} / ${breakerData.currentWeekMeasuredStemCount}) × ${n(breakerData.varietyTotalStemCount)} / ${n(breakerData.varietyAreaM2)}
                    = ${breakerData.currentWeekHarvestedFruitPerM2.toFixed(3)} /m²

estimated harvested kg = harvested fruit/m² × area × AFW / 1000
                        = ${breakerData.currentWeekHarvestedFruitPerM2.toFixed(3)} × ${n(breakerData.varietyAreaM2)} × ${breakerData.currentWeekAfw}g / 1000
                        = ${n(breakerData.currentWeekHarvestedKgEstimate)} kg

Same variety area and the same current-week AFW as the breaker section above
(AFW keyed by week ${currentWeek}, not week ${nextWeek} — this fruit is already harvested).
Used for display only; not fed into historical learning or projection correction.`
                          }</pre>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Summary cards row */}
              {colors.length > 1 && (
                <div className="projections-summary-row">
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
                </div>
              )}

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
                          {data.varieties.map((v) => {
                            const kg = byVariety[v.id] ?? 0;
                            const fruitPerM2 = fruitPerM2Map[v.id]?.[week] ?? 0;
                            if (kg > 0) {
                              return (
                                <td key={v.id} className="num-cell">
                                  {fmt(kg)}
                                  <div className="proj-cases-sub">{casesLabel(kg, caseKgByVariety[v.id])}</div>
                                </td>
                              );
                            } else if (fruitPerM2 > 0) {
                              return (
                                <td key={v.id} className="num-cell proj-no-afw">
                                  {fruitPerM2.toFixed(2)}<span className="proj-m2-unit">/m²</span>
                                </td>
                              );
                            } else {
                              return <td key={v.id} className="num-cell">—</td>;
                            }
                          })}
                          {data.varieties.length > 1 && (
                            <td className="num-cell proj-total-col">
                              <strong>{fmt(totalKg)}</strong>
                              <div className="proj-cases-sub">{totalCasesLabel(byVariety)}</div>
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
                        {weeklyRows.map(({ week, byColor, byVariety, totalKg }) => (
                          <tr key={week}>
                            <td className="proj-wk-col">W{week}</td>
                            {colors.map((c) => (
                              <td key={c} className="num-cell">
                                {fmt(byColor[c] ?? 0)}
                              </td>
                            ))}
                            <td className="num-cell proj-total-col">
                              <strong>{fmt(totalKg)}</strong>
                              <div className="proj-cases-sub">{totalCasesLabel(byVariety)}</div>
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
