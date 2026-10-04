import { useState, useEffect, useMemo } from 'react';
import { Season, Variety, HarvestedEntry, HarvestProjectionVariety, GrowlinkHarvestActual } from '../types';
import { seasonsApi, varietiesApi, harvestedApi, harvestProjectionsApi, growlinkHarvestActualsApi } from '../services/api';
import { resolveWeeklyActuals, sumActualKg, buildDashboardComparison, type ActualSource } from '../utils/dashboardHarvest';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtKg(v: number): string {
  return v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function fmtSignedKg(v: number | null): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${fmtKg(v)}`;
}

function fmtSignedPct(v: number | null): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

const SOURCE_LABEL: Record<ActualSource, string> = {
  growlink: 'GrowLink',
  'manual-fallback': 'Manual (no GrowLink row)',
};

export function DashboardPage() {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [activeSeason, setActiveSeason] = useState<Season | null>(null);
  const [projections, setProjections] = useState<Map<string, HarvestProjectionVariety>>(new Map());
  // null = the GrowLink fetch failed — actuals are then unknown, never 0.
  const [growlinkActuals, setGrowlinkActuals] = useState<GrowlinkHarvestActual[] | null>([]);
  const [manualEntries, setManualEntries] = useState<HarvestedEntry[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const failures: string[] = [];
      try {
        const [sData, vData] = await Promise.all([seasonsApi.list(), varietiesApi.list()]);
        setSeasons(sData);
        setVarieties(vData);
        const season = sData.find(s => s.is_active) ?? sData[0] ?? null;
        setActiveSeason(season);

        if (!season) return;

        const seasonVarieties = vData.filter(v => sData.find(s => s.id === v.season_id)?.year === season.year && v.is_active);

        // Projected kg comes from /harvest-projections — the same server-side
        // fruit/m² × area × harvest-week AFW calculation the Projections page uses.
        const [projResults, growlinkResult, manualResults] = await Promise.all([
          Promise.allSettled(seasonVarieties.map(v => harvestProjectionsApi.get(season.year, v.id))),
          growlinkHarvestActualsApi.list({ year: season.year, matched: true }).then(
            rows => ({ ok: true as const, rows }),
            (e: unknown) => ({ ok: false as const, error: e })
          ),
          Promise.allSettled(seasonVarieties.map(v => harvestedApi.list(v.id, season.year))),
        ]);

        const projMap = new Map<string, HarvestProjectionVariety>();
        projResults.forEach((r, i) => {
          const v = seasonVarieties[i];
          if (r.status === 'rejected') {
            failures.push(`Projection for ${v.name} failed to load: ${errorMessage(r.reason)}`);
            return;
          }
          const proj = r.value.varieties.find(p => p.id === v.id);
          if (proj) projMap.set(v.id, proj);
        });
        setProjections(projMap);

        if (growlinkResult.ok) {
          setGrowlinkActuals(growlinkResult.rows);
        } else {
          setGrowlinkActuals(null);
          failures.push(`GrowLink harvest actuals failed to load: ${errorMessage(growlinkResult.error)}`);
        }

        const manual: HarvestedEntry[] = [];
        manualResults.forEach((r, i) => {
          if (r.status === 'fulfilled') manual.push(...r.value);
          else failures.push(`Manual harvested entries for ${seasonVarieties[i].name} failed to load (manual fallback unavailable): ${errorMessage(r.reason)}`);
        });
        setManualEntries(manual);
      } catch (e) {
        failures.push(`Dashboard failed to load: ${errorMessage(e)}`);
      } finally {
        setErrors(failures);
        setLoading(false);
      }
    }
    load();
  }, []);

  const activeVarieties = varieties.filter(v => v.is_active && seasons.find(s => s.id === v.season_id)?.year === activeSeason?.year);
  const actualsAvailable = growlinkActuals != null;

  // GrowLink-first, manual-fallback per variety/week. Not resolved at all
  // when GrowLink failed: manual rows would otherwise stand in for weeks
  // GrowLink actually covers.
  const resolvedActuals = useMemo(() => {
    if (!activeSeason || growlinkActuals == null) return [];
    const ids = new Set(varieties.filter(v => v.is_active && seasons.find(s => s.id === v.season_id)?.year === activeSeason.year).map(v => v.id));
    return resolveWeeklyActuals(growlinkActuals, manualEntries, activeSeason.year, ids);
  }, [activeSeason, seasons, varieties, growlinkActuals, manualEntries]);

  const comparison = useMemo(
    () => buildDashboardComparison([...projections.values()], resolvedActuals),
    [projections, resolvedActuals]
  );

  useEffect(() => {
    if (resolvedActuals.length === 0) return;
    if (!new URLSearchParams(window.location.search).has('debug')) return;
    const nameById = new Map(varieties.map(v => [v.id, v.name]));
    console.debug('[Dashboard] resolved harvest actuals (variety/week → source)');
    console.table(resolvedActuals.map(r => ({ variety: nameById.get(r.varietyId) ?? r.varietyId, week: r.week, kg: r.kg, source: r.source, rows: r.rowCount })));
  }, [resolvedActuals, varieties]);

  const totalProjectedKg = [...projections.values()].reduce((s, p) => s + p.totalKg, 0);
  const totalProjectedFruit = [...projections.values()].reduce((s, p) => s + p.weeks.reduce((ws, w) => ws + w.projectedFruitPerM2, 0), 0);
  const peakProjWeek = comparison
    .filter(r => r.projectedKg != null && r.projectedKg > 0)
    .sort((a, b) => (b.projectedKg as number) - (a.projectedKg as number))[0];
  const totalActualKg = sumActualKg(resolvedActuals);
  const actualWeeks = resolvedActuals.filter(r => r.kg != null).map(r => r.week);
  const manualFallbackWeeks = new Set(resolvedActuals.filter(r => r.source === 'manual-fallback').map(r => r.week)).size;

  function totalHarvestedLabel(): string {
    if (!actualsAvailable) return 'Unavailable';
    return totalActualKg == null ? 'No actuals' : `${fmtKg(totalActualKg)} kg`;
  }

  function totalHarvestedSub(): string | null {
    if (!actualsAvailable || totalActualKg == null) return null;
    const range = `W${Math.min(...actualWeeks)}–W${Math.max(...actualWeeks)}`;
    return manualFallbackWeeks > 0 ? `${range} · GrowLink + ${manualFallbackWeeks} manual-fallback wk` : `${range} · GrowLink`;
  }

  function varietyActualKg(varietyId: string): string {
    if (!actualsAvailable) return 'Unavailable';
    const kg = sumActualKg(resolvedActuals.filter(r => r.varietyId === varietyId));
    return kg == null ? '—' : fmtKg(kg);
  }

  if (loading) return <div className="loading">Loading dashboard…</div>;

  return (
    <>
      <div className="page-header">
        <h2>Dashboard</h2>
        {activeSeason && (
          <span className="badge badge-green">{activeSeason.year}</span>
        )}
      </div>

      <div className="page-body">
        {errors.map(msg => <div key={msg} className="error-banner">{msg}</div>)}

        {!activeSeason ? (
          <div className="empty-state">
            <p>No year found.</p>
            <p style={{ marginTop: 8, fontSize: 13 }}>Go to Setup to add a year and varieties.</p>
          </div>
        ) : (
          <>
            {/* Stat Cards */}
            <div className="grid-4 mb-4">
              <div className="stat-card">
                <div className="stat-label">Active Year</div>
                <div className="stat-value" style={{ fontSize: 18 }}>{activeSeason.year}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Active Varieties</div>
                <div className="stat-value">{activeVarieties.length}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Total Projected</div>
                <div className="stat-value">{projections.size > 0 ? `${fmtKg(totalProjectedKg)} kg` : '—'}</div>
                {projections.size > 0 && (
                  <div className="stat-sub">
                    {totalProjectedFruit.toFixed(1)} fruit/m²
                    {peakProjWeek && <> · Peak: Wk {peakProjWeek.week} @ {fmtKg(peakProjWeek.projectedKg as number)} kg</>}
                  </div>
                )}
              </div>
              <div className="stat-card">
                <div className="stat-label">Total Harvested</div>
                <div className="stat-value">{totalHarvestedLabel()}</div>
                {totalHarvestedSub() && <div className="stat-sub">{totalHarvestedSub()}</div>}
              </div>
            </div>

            <div className="grid-2 mb-4">
              {/* Variety summary */}
              <div className="card">
                <div className="card-title">Varieties</div>
                {activeVarieties.length === 0 ? (
                  <div className="empty-state" style={{ padding: 20 }}>No active varieties.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Color</th>
                          <th>Area m²</th>
                          <th>Stems</th>
                          <th>Proj. fruit/m²</th>
                          <th>Proj. kg</th>
                          <th>Harvested kg</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeVarieties.map(v => {
                          const proj = projections.get(v.id);
                          const fruit = proj?.weeks.reduce((s, w) => s + w.projectedFruitPerM2, 0);
                          return (
                            <tr key={v.id}>
                              <td style={{ fontWeight: 600 }}>{v.name}</td>
                              <td>{v.color ?? '—'}</td>
                              <td>{v.area_m2 ?? '—'}</td>
                              <td>{v.total_stem_count ?? '—'}</td>
                              <td>{proj ? fruit!.toFixed(2) : '—'}</td>
                              <td>{proj ? fmtKg(proj.totalKg) : '—'}</td>
                              <td>{varietyActualKg(v.id)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Projected vs Actual — kg on both sides */}
              <div className="card">
                <div className="card-title">Projected vs Actual by Week (kg)</div>
                {comparison.some(r => r.missingAfw) && (
                  <div className="warning-banner">
                    Weeks marked * have projected fruit but no known AFW, so projected kg is incomplete and no variance is shown — enter Actual harvested AFW/g in the Calculator.
                  </div>
                )}
                {comparison.length === 0 ? (
                  <div className="empty-state" style={{ padding: 20 }}>
                    {actualsAvailable ? 'No data yet. Enter fruit development data in Calculator.' : 'No projections, and actuals are unavailable.'}
                  </div>
                ) : (
                  <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Week</th>
                          <th>Proj. kg</th>
                          <th>Actual kg</th>
                          <th>Variance kg</th>
                          <th>Variance %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparison.map(r => (
                          <tr key={r.week}>
                            <td>Week {r.week}</td>
                            <td>
                              {r.projectedKg == null ? '—' : fmtKg(r.projectedKg)}
                              {r.missingAfw && '*'}
                            </td>
                            <td title={r.sources.length ? `Source: ${r.sources.map(s => SOURCE_LABEL[s]).join(' + ')}` : undefined}>
                              {!actualsAvailable ? 'Unavailable' : r.actualKg == null ? '—' : fmtKg(r.actualKg)}
                              {r.sources.includes('manual-fallback') && ' (manual)'}
                            </td>
                            <td>{fmtSignedKg(r.varianceKg)}</td>
                            <td>{fmtSignedPct(r.variancePct)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* Year info */}
            <div className="card">
              <div className="card-title">Year Info</div>
              <div className="grid-4">
                <div>
                  <div style={{ fontSize: 12, color: 'var(--gray-500)', textTransform: 'uppercase', fontWeight: 600 }}>Year</div>
                  <div style={{ fontWeight: 600, marginTop: 4 }}>{activeSeason.year}</div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--gray-500)', textTransform: 'uppercase', fontWeight: 600 }}>Years Available</div>
                  <div style={{ fontWeight: 600, marginTop: 4 }}>{new Set(seasons.map(s => s.year)).size}</div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--gray-500)', textTransform: 'uppercase', fontWeight: 600 }}>All Varieties</div>
                  <div style={{ fontWeight: 600, marginTop: 4 }}>{varieties.length}</div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--gray-500)', textTransform: 'uppercase', fontWeight: 600 }}>Total Harvested</div>
                  <div style={{ fontWeight: 600, marginTop: 4 }}>{totalHarvestedLabel()}</div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
