import { useState, useEffect } from 'react';
import { Season, Variety, HarvestedEntry, ProjectionResult } from '../types';
import { seasonsApi, varietiesApi, harvestedApi, projectionApi } from '../services/api';

export function DashboardPage() {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [activeSeason, setActiveSeason] = useState<Season | null>(null);
  const [projections, setProjections] = useState<Map<string, ProjectionResult>>(new Map());
  const [harvested, setHarvested] = useState<Map<string, HarvestedEntry[]>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [sData, vData] = await Promise.all([seasonsApi.list(), varietiesApi.list()]);
        setSeasons(sData);
        setVarieties(vData);
        const season = sData.find(s => s.is_active) ?? sData[0] ?? null;
        setActiveSeason(season);

        if (!season) return;

        const seasonVarieties = vData.filter(v => sData.find(s => s.id === v.season_id)?.year === season.year && v.is_active);

        // Load projections and harvested for active varieties
        const [projResults, harvResults] = await Promise.all([
          Promise.all(
            seasonVarieties.map(v =>
              projectionApi.get(v.id, season.year)
                .then(p => ({ id: v.id, proj: p }))
                .catch(() => null)
            )
          ),
          Promise.all(
            seasonVarieties.map(v =>
              harvestedApi.list(v.id, season.year)
                .then(h => ({ id: v.id, entries: h }))
                .catch(() => null)
            )
          ),
        ]);

        const projMap = new Map<string, ProjectionResult>();
        for (const r of projResults) {
          if (r) projMap.set(r.id, r.proj);
        }

        const harvMap = new Map<string, HarvestedEntry[]>();
        for (const r of harvResults) {
          if (r) harvMap.set(r.id, r.entries);
        }

        setProjections(projMap);
        setHarvested(harvMap);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const activeVarieties = varieties.filter(v => v.is_active && seasons.find(s => s.id === v.season_id)?.year === activeSeason?.year);

  const totalProjected = [...projections.values()].reduce((s, p) => s + p.total_projected, 0);
  const totalHarvestedKg = [...harvested.values()].flatMap(e => e).reduce((s, e) => s + Number(e.kg), 0);

  // Aggregate projection by week across varieties
  const projByWeek: Record<number, number> = {};
  for (const proj of projections.values()) {
    for (const w of proj.weeks) {
      projByWeek[w.week] = (projByWeek[w.week] ?? 0) + w.projected_fruit_per_m2;
    }
  }

  // Aggregate harvested kg by week across varieties
  const harvByWeek: Record<number, number> = {};
  for (const entries of harvested.values()) {
    for (const e of entries) {
      harvByWeek[e.week_number] = (harvByWeek[e.week_number] ?? 0) + Number(e.kg);
    }
  }

  const peakProjWeek = Object.entries(projByWeek).sort((a, b) => b[1] - a[1])[0];

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
                <div className="stat-label">Total Projected Fruit / m²</div>
                <div className="stat-value">{totalProjected.toFixed(1)}</div>
                {peakProjWeek && (
                  <div className="stat-sub">Peak: Wk {peakProjWeek[0]} @ {Number(peakProjWeek[1]).toFixed(2)}/m²</div>
                )}
              </div>
              <div className="stat-card">
                <div className="stat-label">Total Harvested</div>
                <div className="stat-value">{totalHarvestedKg.toFixed(1)} kg</div>
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
                          <th>Total Proj.</th>
                          <th>Harvested kg</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeVarieties.map(v => {
                          const proj = projections.get(v.id);
                          const harvEntries = harvested.get(v.id) ?? [];
                          const harvKg = harvEntries.reduce((s, e) => s + Number(e.kg), 0);
                          return (
                            <tr key={v.id}>
                              <td style={{ fontWeight: 600 }}>{v.name}</td>
                              <td>{v.color ?? '—'}</td>
                              <td>{v.area_m2 ?? '—'}</td>
                              <td>{v.total_stem_count ?? '—'}</td>
                              <td>{proj ? proj.total_projected.toFixed(2) : '—'}</td>
                              <td>{harvKg > 0 ? harvKg.toFixed(1) : '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Projected vs Actual */}
              <div className="card">
                <div className="card-title">Projected vs Actual by Week</div>
                {Object.keys(projByWeek).length === 0 && Object.keys(harvByWeek).length === 0 ? (
                  <div className="empty-state" style={{ padding: 20 }}>No data yet. Enter fruit development data in Calculator.</div>
                ) : (
                  <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Week</th>
                          <th>Proj. Fruit/m²</th>
                          <th>Actual kg</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: 52 }, (_, i) => i + 1)
                          .filter(w => projByWeek[w] > 0 || harvByWeek[w] > 0)
                          .map(w => (
                            <tr key={w}>
                              <td>Week {w}</td>
                              <td>{projByWeek[w] ? projByWeek[w].toFixed(3) : '—'}</td>
                              <td>{harvByWeek[w] ? harvByWeek[w].toFixed(1) + ' kg' : '—'}</td>
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
                  <div style={{ fontWeight: 600, marginTop: 4 }}>{totalHarvestedKg.toFixed(1)} kg</div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
