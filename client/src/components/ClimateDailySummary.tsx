import { useEffect, useMemo, useState } from 'react';
import type { Variety, VarietyClimateHourlyRow } from '../types';
import { varietyClimateHourlyApi } from '../services/api';
import { LineChart, type ChartPoint } from './ClimateCharts';
import {
  SUMMARY_METRICS,
  TIMELINE_METRIC_KEYS,
  loadTargetConfig,
  saveTargetConfig,
  buildClimateSummary,
  resolveSummaryWindow,
  splitByWindow,
  readValue,
  type SummaryMetricKey,
  type TargetConfig,
  type TargetRange,
  type MetricSummaryStat,
} from '../utils/climateSummary';

const METRIC_COLORS: Record<SummaryMetricKey, string> = {
  air_temperature: 'var(--gray-800)',
  relative_humidity: 'var(--blue-500)',
  co2: 'var(--green-600)',
  ec: 'var(--yellow-500)',
  ph: 'var(--red-500)',
  radiation_interval: 'var(--blue-500)',
};

function fmtStat(v: number | null, digits: number, unit: string): string {
  return v == null ? '—' : `${v.toFixed(digits)}${unit}`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

interface ClimateDailySummaryProps {
  variety: Variety | null;
  /** The page's currently-selected metric filter — used only to choose which metric the plain-language overview leads with. */
  headlineMetricKey: SummaryMetricKey;
  onViewFullChart: () => void;
}

export function ClimateDailySummary({ variety, headlineMetricKey, onViewFullChart }: ClimateDailySummaryProps) {
  const [rows, setRows] = useState<VarietyClimateHourlyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState<TargetConfig>(() => loadTargetConfig());
  const [editingTargets, setEditingTargets] = useState(false);

  useEffect(() => {
    if (!variety?.id) { setRows([]); return; }
    setLoading(true);
    setError(null);
    // Deliberately no start/end — this is the EXACT SAME query the full chart
    // issues (GET /variety-hourly for this variety_id, see
    // server/src/routes/varietyClimateHourly.ts), just without the chart's
    // date-range filter. That's what guarantees "does any data exist for
    // this variety" can never disagree between the two: both read
    // variety_climate_hourly, unfiltered by ingestion source (manual CSV
    // batch, Synopta Agent, or anything else) — there is no separate,
    // source-scoped query here to go out of sync with the chart's.
    varietyClimateHourlyApi.get(variety.id, 'hourly')
      .then((result) => setRows(result.rows as VarietyClimateHourlyRow[]))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [variety?.id]);

  const now = useMemo(() => new Date(), [variety?.id, rows]);

  // Anchored to the NEWEST row actually present, not assumed to be "now" —
  // if the freshest available measurement is older than now (e.g. the
  // rollup that populates variety_climate_hourly hasn't caught up with a
  // more recent ingestion yet), this still finds and summarizes the latest
  // real 24-hour window rather than reporting "no data" against an empty
  // real-time window. Null only when `rows` is empty — the same condition
  // under which the full chart would show nothing for this variety.
  const summaryWindow = useMemo(() => resolveSummaryWindow(rows, now), [rows, now]);

  const { currentRows, previousRows } = useMemo(
    () => (summaryWindow ? splitByWindow(rows, summaryWindow) : { currentRows: [], previousRows: [] }),
    [rows, summaryWindow]
  );

  const summary = useMemo(
    () => buildClimateSummary(variety?.name ?? 'this variety', headlineMetricKey, currentRows, previousRows, targets, summaryWindow?.isLive ?? false),
    [variety?.name, headlineMetricKey, currentRows, previousRows, targets, summaryWindow]
  );

  function updateTarget(key: SummaryMetricKey, patch: Partial<TargetRange>) {
    setTargets((prev) => {
      const next: TargetConfig = { ...prev, [key]: { ...(prev[key] ?? { min: null, max: null }), ...patch } };
      saveTargetConfig(next);
      return next;
    });
  }

  if (!variety) {
    return <div className="empty-state">Select a variety to view the climate summary.</div>;
  }
  if (loading) {
    return <div className="card mb-4"><div className="loading">Loading summary…</div></div>;
  }
  if (error) {
    return <div className="card mb-4"><div className="error-state">Failed to load summary: {error}</div></div>;
  }

  // No summaryWindow means resolveSummaryWindow got zero rows — since rows
  // came from the exact same unbounded variety_climate_hourly query the full
  // chart uses, this is precisely the condition under which the chart would
  // also show nothing for this variety.
  if (!summaryWindow) {
    return (
      <div className="card mb-4">
        <div className="card-title">Past 24 Hours Climate Summary</div>
        <div className="empty-state">No climate data recorded for {variety.name}.</div>
        <button type="button" className="btn btn-secondary mt-2" onClick={onViewFullChart}>View full chart</button>
      </div>
    );
  }

  return (
    <div className="card mb-4 climate-summary-card">
      <div className="climate-summary-header">
        <div>
          <div className="card-title" style={{ marginBottom: 2 }}>
            {summaryWindow.isLive ? 'Past 24 Hours Climate Summary' : 'Climate Summary'}
          </div>
          {/* Always shown (not just when stale) — the grower should always be able to
              see exactly which local-time window every card below represents, radiation
              in particular since "24-hour total" is meaningless without knowing the period. */}
          <div className={summaryWindow.isLive ? 'climate-summary-window-label' : 'climate-summary-stale-label'}>
            {summaryWindow.isLive ? 'Window: ' : 'Latest 24 hours available: '}
            {fmtTime(summaryWindow.windowStartIso)} to {fmtTime(summaryWindow.windowEndIso)}
          </div>
          <span className="climate-summary-source-tag">Calculated directly from stored readings — no AI interpretation</span>
        </div>
        <button type="button" className="btn btn-secondary" onClick={onViewFullChart}>View full chart</button>
      </div>

      <p className="climate-summary-overview">{summary.overview}</p>

      {summary.notableEvents.length > 0 && (
        <div className="warning-banner climate-summary-events">
          <div className="climate-info-banner-title">Notable events</div>
          <ul className="climate-warning-file-list">
            {summary.notableEvents.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      <div className="climate-summary-metric-grid">
        {summary.metrics.map((m) => (
          <MetricTile key={m.key} stat={m} highlighted={m.key === headlineMetricKey} />
        ))}
      </div>

      <div className="climate-summary-targets">
        <button type="button" className="climate-expand-toggle" onClick={() => setEditingTargets((v) => !v)}>
          {editingTargets ? 'Hide target settings' : 'Set targets'}
        </button>
        {editingTargets && (
          <div className="climate-summary-target-editor">
            {SUMMARY_METRICS.filter((d) => d.supportsTarget).map((d) => {
              const t = targets[d.key] ?? { min: null, max: null };
              return (
                <div key={d.key} className="climate-summary-target-row">
                  <span>{d.label} ({d.unit || 'unitless'})</span>
                  <label>
                    Min
                    <input
                      type="number"
                      className="form-control"
                      style={{ width: 80 }}
                      value={t.min ?? ''}
                      onChange={(e) => updateTarget(d.key, { min: e.target.value === '' ? null : Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    Max
                    <input
                      type="number"
                      className="form-control"
                      style={{ width: 80 }}
                      value={t.max ?? ''}
                      onChange={(e) => updateTarget(d.key, { max: e.target.value === '' ? null : Number(e.target.value) })}
                    />
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="climate-summary-timelines">
        {TIMELINE_METRIC_KEYS.map((key) => {
          const def = SUMMARY_METRICS.find((d) => d.key === key)!;
          const points: ChartPoint[] = currentRows.map((r) => ({ x: fmtTime(r.measured_at), value: readValue(r, def) }));
          const hasData = points.some((p) => p.value != null);
          if (!hasData) return null;
          return (
            <div key={key} className="climate-summary-timeline-panel">
              <div className="climate-small-multiple-title">{def.label}</div>
              <LineChart points={points} unit={def.unit} color={METRIC_COLORS[key]} height={90} mode={key === 'radiation_interval' ? 'bar' : 'line'} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MetricTile({ stat, highlighted }: { stat: MetricSummaryStat; highlighted: boolean }) {
  if (stat.isAccumulator) return <AccumulatorMetricTile stat={stat} highlighted={highlighted} />;

  if (stat.hoursObserved === 0) {
    return (
      <div className={`climate-summary-tile${highlighted ? ' climate-summary-tile-highlighted' : ''}`}>
        <div className="climate-summary-tile-title">{stat.shortLabel}</div>
        <div className="empty-state" style={{ padding: 8 }}>No valid reading</div>
      </div>
    );
  }

  return (
    <div className={`climate-summary-tile${highlighted ? ' climate-summary-tile-highlighted' : ''}`}>
      <div className="climate-summary-tile-title">{stat.shortLabel}</div>
      <div className="climate-summary-tile-current">
        {stat.current != null ? fmtStat(stat.current.value, stat.digits, stat.unit) : 'No valid reading'}
      </div>
      {stat.deltaFromPrevious != null && (
        <span className={stat.deltaFromPrevious >= 0 ? 'climate-summary-delta-up' : 'climate-summary-delta-down'}>
          {stat.deltaFromPrevious >= 0 ? '▲' : '▼'} {Math.abs(stat.deltaFromPrevious).toFixed(stat.digits)}{stat.unit} vs prior 24h
        </span>
      )}
      <div className="climate-summary-tile-row"><span>Avg</span><strong>{fmtStat(stat.avg, stat.digits, stat.unit)}</strong></div>
      <div className="climate-summary-tile-row"><span>Min</span><strong>{fmtStat(stat.min?.value ?? null, stat.digits, stat.unit)}</strong><span className="climate-summary-tile-time">{fmtTime(stat.min?.at ?? null)}</span></div>
      <div className="climate-summary-tile-row"><span>Max</span><strong>{fmtStat(stat.max?.value ?? null, stat.digits, stat.unit)}</strong><span className="climate-summary-tile-time">{fmtTime(stat.max?.at ?? null)}</span></div>
      {stat.largestRise && (
        <div className="climate-summary-tile-row"><span>Largest rise</span><strong>+{stat.largestRise.delta.toFixed(stat.digits)}{stat.unit}</strong><span className="climate-summary-tile-time">{fmtTime(stat.largestRise.toAt)}</span></div>
      )}
      {stat.largestFall && (
        <div className="climate-summary-tile-row"><span>Largest fall</span><strong>{stat.largestFall.delta.toFixed(stat.digits)}{stat.unit}</strong><span className="climate-summary-tile-time">{fmtTime(stat.largestFall.toAt)}</span></div>
      )}
      {stat.target && (
        <div className="climate-summary-tile-row">
          <span>Target {stat.target.min ?? '—'}–{stat.target.max ?? '—'}{stat.unit}</span>
          <strong>{stat.hoursAboveTarget + stat.hoursBelowTarget}h outside</strong>
        </div>
      )}
    </div>
  );
}

// Radiation (and any future cumulative-flow metric): the headline number is
// the window's SUM, never the latest hour's delta — see
// SummaryMetricDef.isAccumulator. Deliberately excludes "Largest fall" (a
// drop in the raw hourly delta is definitionally a counter reset, already
// surfaced as its own "resets detected" row, not a real environmental swing
// worth highlighting) and "current" (a single hour's delta is exactly the
// misleading figure this fix replaces).
function AccumulatorMetricTile({ stat, highlighted }: { stat: MetricSummaryStat; highlighted: boolean }) {
  if (stat.hoursObserved === 0) {
    return (
      <div className={`climate-summary-tile${highlighted ? ' climate-summary-tile-highlighted' : ''}`}>
        <div className="climate-summary-tile-title">{stat.shortLabel}</div>
        <div className="empty-state" style={{ padding: 8 }}>No valid reading</div>
      </div>
    );
  }

  return (
    <div className={`climate-summary-tile${highlighted ? ' climate-summary-tile-highlighted' : ''}`}>
      <div className="climate-summary-tile-title">{stat.shortLabel} — 24-hour total</div>
      <div className="climate-summary-tile-current">{fmtStat(stat.accumulatedTotal, stat.digits, stat.unit)}</div>
      {stat.deltaAccumulatedFromPrevious != null && (
        <span className={stat.deltaAccumulatedFromPrevious >= 0 ? 'climate-summary-delta-up' : 'climate-summary-delta-down'}>
          {stat.deltaAccumulatedFromPrevious >= 0 ? '▲' : '▼'} {Math.abs(stat.deltaAccumulatedFromPrevious).toFixed(stat.digits)}{stat.unit} vs prior 24h total
        </span>
      )}
      <div className="climate-summary-tile-row"><span>Min hourly contribution</span><strong>{fmtStat(stat.min?.value ?? null, stat.digits, stat.unit)}</strong><span className="climate-summary-tile-time">{fmtTime(stat.min?.at ?? null)}</span></div>
      <div className="climate-summary-tile-row"><span>Max hourly contribution</span><strong>{fmtStat(stat.max?.value ?? null, stat.digits, stat.unit)}</strong><span className="climate-summary-tile-time">{fmtTime(stat.max?.at ?? null)}</span></div>
      {stat.largestRise && (
        <div className="climate-summary-tile-row"><span>Largest hourly rise</span><strong>+{stat.largestRise.delta.toFixed(stat.digits)}{stat.unit}</strong><span className="climate-summary-tile-time">{fmtTime(stat.largestRise.toAt)}</span></div>
      )}
      {stat.excludedNegativeCount > 0 && (
        <div className="climate-summary-tile-row">
          <span>Counter resets detected</span>
          <strong>{stat.excludedNegativeCount}</strong>
        </div>
      )}
    </div>
  );
}
