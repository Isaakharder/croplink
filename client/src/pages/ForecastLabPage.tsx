import { useEffect, useState } from 'react';
import { Season, Variety, ForecastLabView, ForecastLabMetrics, ForecastLabModelId, ForecastLabCell, ForecastLabStat } from '../types';
import { yearsApi, varietiesApi, forecastLabApi } from '../services/api';
import { defaultYear, yearNumbers } from '../utils/years';

const EXPERIMENTAL: ForecastLabModelId[] = ['open-fruit-d', 'interval-censored-recent'];
const SHORT: Record<ForecastLabModelId, string> = { legacy: 'Legacy', 'open-fruit-d': 'Open-fruit D', 'interval-censored-recent': 'Interval-censored (recent)' };

const kg = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString());
const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const signedKg = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString()}`);
const plain = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v.toFixed(d)}%`);

function ExperimentalBadge() {
  return <span className="badge badge-yellow" title="Not validated. Shown for comparison only.">Experimental</span>;
}

function Cell({ c }: { c: ForecastLabCell | undefined }) {
  if (!c) return <td className="num-cell">—</td>;
  const tip = [
    `${c.version} · as of ${c.asOfWeek}${c.issuedAt ? ` · issued ${c.issuedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}`,
    c.kind === 'hindcast' ? 'Hindcast: reconstructed from data known at that week, issued later' : c.kind === 'current' ? 'Not locked yet — computed now' : 'Locked live forecast',
    c.afwG != null ? `AFW ${c.afwG.toFixed(1)} g (${c.afwSource}, ${c.afwWeek})` : 'No AFW',
    ...c.warnings,
  ].join('\n');
  return (
    <td className="num-cell" title={tip}>
      {kg(c.kg)}
      {c.low != null && c.high != null && <div style={{ fontSize: 11, color: 'var(--gray-500)' }}>{kg(c.low)}–{kg(c.high)}</div>}
      <div style={{ fontSize: 10, color: 'var(--gray-400)' }}>
        {c.kind === 'hindcast' ? 'hindcast' : c.kind === 'current' ? 'not locked' : 'locked'}
        {c.harvestWindow < 1 ? ` · pull-out ${Math.round(c.harvestWindow * 7)}/7` : ''}
        {c.warnings.some((w) => /fallback|stale|thin|insufficient|partial-coverage/.test(w)) ? ' · ⚠' : ''}
      </div>
    </td>
  );
}

function StatCells({ s }: { s: ForecastLabStat | undefined }) {
  return (
    <>
      <td className="num-cell">{s?.n ?? 0}</td>
      <td className="num-cell">{pct(s?.biasPct)}</td>
      <td className="num-cell">{plain(s?.wapePct)}</td>
      <td className="num-cell">{kg(s?.maeKg)}</td>
    </>
  );
}

export function ForecastLabPage() {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [varietyId, setVarietyId] = useState('');
  const [horizon, setHorizon] = useState(1);
  const [view, setView] = useState<ForecastLabView | null>(null);
  const [metrics, setMetrics] = useState<ForecastLabMetrics | null>(null);
  const [error, setError] = useState('');
  const [metricsError, setMetricsError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    yearsApi.list().then((s) => { setSeasons(s); setYear(defaultYear(s)); }).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load years'));
  }, []);

  useEffect(() => {
    varietiesApi.list(undefined, year)
      .then((vs) => { const active = vs.filter((v) => v.is_active); setVarieties(active); setVarietyId((cur) => (active.some((v) => v.id === cur) ? cur : active[0]?.id ?? '')); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load varieties'));
    forecastLabApi.metrics(year).then(setMetrics).catch((e) => setMetricsError(e instanceof Error ? e.message : 'Failed to load metrics'));
  }, [year]);

  useEffect(() => {
    if (!varietyId) return;
    setLoading(true);
    setError('');
    forecastLabApi.view(year, varietyId, horizon)
      .then(setView)
      .catch((e) => { setView(null); setError(e instanceof Error ? e.message : 'Failed to load the Forecast Lab'); })
      .finally(() => setLoading(false));
  }, [year, varietyId, horizon]);

  const live = metrics?.reports.find((r) => r.kind === 'live');
  const hindcast = metrics?.reports.find((r) => r.kind === 'hindcast');

  return (
    <>
      <div className="page-header">
        <h2>Forecast Lab <ExperimentalBadge /></h2>
      </div>
      <div className="page-body">
        <div className="warning-banner">
          Experimental forecasts are shown <strong>beside</strong> the legacy forecast for evaluation. They are not validated and do not replace the
          Projections page. A model is only marked as meeting recommendation criteria after enough settled, live (not reconstructed) weeks — and even then a person decides.
        </div>

        <div className="flex gap-2 items-center mb-4">
          <label>Year</label>
          <select className="form-control" style={{ width: 110 }} value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {yearNumbers(seasons).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <label>Variety</label>
          <select className="form-control" style={{ width: 200 }} value={varietyId} onChange={(e) => setVarietyId(e.target.value)}>
            {varieties.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <label title="For past weeks, show the forecast that was issued this many weeks before the week">Past weeks: forecast issued</label>
          <select className="form-control" style={{ width: 130 }} value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
            {[1, 2, 3, 4].map((h) => <option key={h} value={h}>{h} week{h > 1 ? 's' : ''} ahead</option>)}
          </select>
        </div>

        {error && <div className="alert alert-error mb-4">{error}</div>}
        {loading && <div className="loading">Computing forecasts…</div>}

        {view && !loading && (
          <>
            {view.warnings.map((w) => <div key={w} className="warning-banner">⚠ {w}</div>)}

            <div className="grid-4 mb-4">
              <div className="stat-card">
                <div className="stat-label">Forecast as of</div>
                <div className="stat-value" style={{ fontSize: 18 }}>{view.asOf.label}</div>
                <div className="stat-sub">Last survey entered {view.freshness.latestSurveyEnteredAt?.slice(0, 10) ?? '—'}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">AFW used (experimental)</div>
                <div className="stat-value" style={{ fontSize: 18 }}>{view.freshness.afw ? `${view.freshness.afw.grams.toFixed(1)} g` : '—'}</div>
                <div className="stat-sub">{view.freshness.afw ? `${view.freshness.afw.source} · ${view.freshness.afw.week} · ${view.freshness.afw.ageWeeks} wk old` : 'No fruit weight known'}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">GrowLink actuals</div>
                <div className="stat-value" style={{ fontSize: 18 }}>{view.freshness.latestActualWeek ?? '—'}</div>
                <div className="stat-sub">Latest settled {view.freshness.latestSettledWeek ?? '—'} · v1 sync {view.freshness.lastGrowlinkV1Sync?.slice(0, 10) ?? '—'} · v2 {view.freshness.lastGrowlinkV2Sync ? `${view.freshness.lastGrowlinkV2Sync.status} ${view.freshness.lastGrowlinkV2Sync.finishedAt?.slice(0, 10) ?? ''}` : 'not synced'}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Scaling inputs</div>
                <div className="stat-value" style={{ fontSize: 18 }}>{view.variety.areaM2.toLocaleString()} m²</div>
                <div className="stat-sub">{view.variety.totalStems.toLocaleString()} stems · pull-out {view.variety.pullOutDate ?? '—'} · config changed {view.variety.configUpdatedAt?.slice(0, 10) ?? '—'}</div>
              </div>
            </div>

            <div className="card mb-4">
              <div className="card-title">Forecast vs GrowLink packed kg — {view.variety.name}</div>
              <div style={{ fontSize: 12, color: 'var(--gray-500)', marginBottom: 8 }}>
                Past weeks show the forecast issued {view.horizon} week{view.horizon > 1 ? 's' : ''} earlier (locked snapshots; “hindcast” = reconstructed from data known then, issued later).
                Future weeks show the latest forecast. Ranges are p10–p90. Actuals are GrowLink <em>packing</em> weeks; forecasts are survey/harvest weeks
                (the interval-censored model maps harvest onto packing weeks with a recorded shift). Hover a value for version, AFW and warnings.
              </div>
              <div className="table-wrap" style={{ maxHeight: 560, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Week</th>
                      <th>Legacy kg</th>
                      {EXPERIMENTAL.map((m) => <th key={m}>{SHORT[m]} <ExperimentalBadge /></th>)}
                      <th>GrowLink actual kg</th>
                      <th>Δ Legacy</th>
                      {EXPERIMENTAL.map((m) => <th key={`d-${m}`}>Δ {SHORT[m]}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {view.weeks.map((w) => (
                      <tr key={w.index} style={w.past ? undefined : { background: 'var(--gray-50, #f9fafb)' }}>
                        <td>{w.label}{!w.past && <div style={{ fontSize: 10, color: 'var(--gray-400)' }}>future</div>}</td>
                        <td className="num-cell">{kg(w.legacyKg)}</td>
                        {EXPERIMENTAL.map((m) => <Cell key={m} c={w.models[m]} />)}
                        <td className="num-cell">
                          {w.actual ? kg(w.actual.kg) : '—'}
                          {w.actual && <div><span className={`badge ${w.actual.settlement === 'settled' ? 'badge-green' : 'badge-yellow'}`} title={`${w.actual.source}; settlement by ${w.actual.settlementSource}`}>{w.actual.settlement}</span></div>}
                        </td>
                        <td className="num-cell">{signedKg(w.legacyDiffKg)}<div style={{ fontSize: 11 }}>{pct(w.legacyDiffPct, 0)}</div></td>
                        {EXPERIMENTAL.map((m) => (
                          <td key={`d-${m}`} className="num-cell">{signedKg(w.models[m]?.diffKg)}<div style={{ fontSize: 11 }}>{pct(w.models[m]?.diffPct, 0)}</div></td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card mb-4">
              <div className="card-title">Current models</div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Model</th><th>Version</th><th>Input cutoff</th><th>AFW</th><th>Area / stems (measured)</th><th>Parameters</th><th>Warnings</th></tr></thead>
                  <tbody>
                    {view.current.map((c) => (
                      <tr key={c.modelId}>
                        <td>{SHORT[c.modelId]} {c.experimental && <ExperimentalBadge />}</td>
                        <td>{c.version}</td>
                        <td>{c.inputCutoff.slice(0, 16).replace('T', ' ')} UTC</td>
                        <td>{c.afw ? `${c.afw.grams.toFixed(1)} g · ${c.afw.source} · ${c.afw.ageWeeks} wk old` : c.modelId === 'legacy' ? 'CropLink manual (inside legacy)' : '—'}</td>
                        <td>{c.areaM2.toLocaleString()} m² / {c.totalStems.toLocaleString()} ({c.measuredStems})</td>
                        <td style={{ fontSize: 11 }}>{Object.entries(c.params).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')}</td>
                        <td style={{ fontSize: 11 }}>{c.warnings.length ? c.warnings.join(' | ') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {view.configHistory.length > 0 && (
              <div className="card mb-4">
                <div className="card-title">Configuration history (affects kg scaling)</div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Field</th><th>Old</th><th>New</th><th>Effective</th><th>Recorded</th><th>Source</th><th>Note</th></tr></thead>
                    <tbody>
                      {view.configHistory.map((h, i) => (
                        <tr key={i}><td>{h.field}</td><td>{JSON.stringify(h.old_value)}</td><td>{JSON.stringify(h.new_value)}</td><td>{h.effective_from}</td><td>{h.changed_at.slice(0, 10)}</td><td>{h.source}</td><td style={{ fontSize: 11 }}>{h.note ?? ''}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        <div className="card mb-4">
          <div className="card-title">Accuracy of locked forecasts (scored only against settled GrowLink weeks)</div>
          {metricsError && <div className="alert alert-error">{metricsError}</div>}
          {metrics && !metrics.snapshotsEnabled && <div className="warning-banner">Snapshots are not enabled yet — nothing has been locked or scored.</div>}
          {[live, hindcast].filter(Boolean).map((r) => (
            <div key={r!.kind} className="mb-4">
              <h4 style={{ margin: '8px 0' }}>{r!.kind === 'live' ? 'Live forecasts (genuinely out-of-sample)' : 'Hindcasts (reconstructed from data known at the time — never count toward a recommendation)'} · {r!.scored} scored</h4>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Model</th><th>n</th><th>Bias</th><th>WAPE</th><th>MAE kg</th>
                      <th>WAPE h1</th><th>h2</th><th>h3</th><th>h4</th><th>2-wk blocks WAPE</th><th>p10–p90 coverage</th>
                      <th>Ramp-up</th><th>Main</th><th>Late</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r!.models.map((m) => (
                      <tr key={m.modelId}>
                        <td>{SHORT[m.modelId]} {m.experimental && <ExperimentalBadge />}</td>
                        <StatCells s={m.overall} />
                        {[1, 2, 3, 4].map((h) => <td key={h} className="num-cell" title={`n=${m.byHorizon[h]?.n ?? 0}`}>{plain(m.byHorizon[h]?.wapePct)}</td>)}
                        <td className="num-cell">{plain(m.twoWeekBlocks.wapePct)}</td>
                        <td className="num-cell">{m.intervalCoverage.n ? `${((m.intervalCoverage.rate ?? 0) * 100).toFixed(0)}% (${m.intervalCoverage.inside}/${m.intervalCoverage.n})` : '—'}</td>
                        {(['ramp-up', 'main', 'late'] as const).map((st) => <td key={st} className="num-cell" title={`n=${m.byStage[st]?.n ?? 0}`}>{plain(m.byStage[st]?.wapePct)}</td>)}
                        <td style={{ fontSize: 11 }} title={m.recommendation.reasons.join('\n')}>
                          {m.recommendation.status === 'baseline' ? 'Baseline' : m.recommendation.status === 'meets-criteria-review-required' ? 'Meets criteria — needs human review' : 'Experimental'}
                          {m.recommendation.reasons.length > 0 && <div style={{ color: 'var(--gray-400)' }}>{m.recommendation.reasons[0]}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {r!.exclusions.length > 0 && (
                <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 6 }}>
                  Excluded from scoring: {r!.exclusions.map((e) => `${e.reason} (${e.count})`).join(' · ')}
                </div>
              )}
              {metrics?.varieties && (
                <div style={{ fontSize: 12, color: 'var(--gray-500)', marginTop: 4 }}>
                  By variety (WAPE): {r!.models.map((m) => `${SHORT[m.modelId]}: ${Object.entries(m.byVariety).map(([vid, s]) => `${metrics.varieties!.find((v) => v.id === vid)?.name ?? vid} ${plain(s.wapePct)} (n=${s.n})`).join(', ') || '—'}`).join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
