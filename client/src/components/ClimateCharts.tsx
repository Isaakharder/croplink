import { useState } from 'react';
import type { VpdBandDefinition, VpdBandKey } from '../types';

// Shared SVG chart primitives for the Climate Analysis / Crop Exposure tabs.
// Same hand-rolled-SVG approach as the existing ClimateChart in
// ClimatePage.tsx (no chart library in this app) — these just generalize it
// to cover bars, a min-max ribbon, background bands, and x-axis shading.
// Every number rendered here comes from a prop; nothing here computes an
// agronomic value.

export interface ChartPoint {
  x: string;
  value: number | null;
}

export interface ChartRangePoint {
  x: string;
  min: number | null;
  max: number | null;
}

/** Closed polygon path for a min–max ribbon: forward along the max values, back along the min values. Gaps (nulls) simply break the ribbon into segments via moveTo. */
function ribbonPath(range: ChartRangePoint[], xFor: (i: number) => number, yFor: (v: number) => number): string {
  const withIdx = range.map((r, i) => ({ ...r, i })).filter((r) => r.min != null && r.max != null);
  if (withIdx.length === 0) return '';
  const top = withIdx.map((r, idx) => `${idx === 0 ? 'M' : 'L'} ${xFor(r.i).toFixed(1)} ${yFor(r.max as number).toFixed(1)}`);
  const bottom = [...withIdx].reverse().map((r) => `L ${xFor(r.i).toFixed(1)} ${yFor(r.min as number).toFixed(1)}`);
  return [...top, ...bottom, 'Z'].join(' ');
}

interface LineChartProps {
  points: ChartPoint[];
  unit: string;
  mode?: 'line' | 'bar';
  color?: string;
  height?: number;
  /** Optional min–max ribbon behind the main series. Must be the same length/order as `points` (index-aligned), e.g. VPD or EC/pH range. */
  range?: ChartRangePoint[];
  /** Optional fixed-order background bands (VPD exposure bands). Rendered behind everything else. */
  bands?: { key: string; label: string; minKpa: number | null; maxKpa: number | null; color: string }[];
  /** Highlights a bar/point differently (e.g. a radiation-reset hour with a negative raw delta). */
  isFlagged?: (p: ChartPoint, i: number) => boolean;
  /** Shades the plot background for points where this is true (e.g. daylight hours). */
  isShaded?: (p: ChartPoint, i: number) => boolean;
  emptyMessage?: string;
}

const DEFAULT_COLOR = 'var(--gray-800)';

export function LineChart({
  points,
  unit,
  mode = 'line',
  color = DEFAULT_COLOR,
  height = 260,
  range,
  bands,
  isFlagged,
  isShaded,
  emptyMessage = 'No data for this range.',
}: LineChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const valid = points.filter((p) => p.value != null);
  if (valid.length === 0) return <div className="empty-state">{emptyMessage}</div>;

  const width = 760;
  const padding = { top: 16, right: 16, bottom: 28, left: 56 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const values = valid.map((p) => p.value as number);
  const rangeValues = (range ?? []).flatMap((r) => [r.min, r.max]).filter((v): v is number => v != null);
  const bandValues = (bands ?? []).flatMap((b) => [b.minKpa, b.maxKpa]).filter((v): v is number => v != null);

  let dataMin = Math.min(...values, ...rangeValues);
  let dataMax = Math.max(...values, ...rangeValues);
  if (mode === 'bar') dataMin = Math.min(0, dataMin); // bars always show a zero baseline
  if (bandValues.length > 0) {
    // Bands may be open-ended at the extremes (e.g. VPD "high >1.5") — give
    // them visible room above/below the data instead of clipping.
    dataMin = Math.min(dataMin, ...bandValues, 0);
    dataMax = Math.max(dataMax, ...bandValues, dataMax * 1.15);
  }
  const domainRange = dataMax - dataMin || 1;

  const n = points.length;
  const xFor = (i: number) => padding.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yFor = (v: number) => padding.top + plotH - ((v - dataMin) / domainRange) * plotH;

  const linePoints = points
    .map((p, i) => (p.value == null ? null : { i, x: xFor(i), y: yFor(p.value) }))
    .filter((p): p is { i: number; x: number; y: number } => p != null);
  const pathD = linePoints.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const last = linePoints[linePoints.length - 1];

  const rangeByX = new Map((range ?? []).map((r) => [r.x, r]));
  const barWidth = n > 0 ? Math.max(2, (plotW / n) * 0.6) : 4;

  return (
    <div className="climate-chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="climate-chart-svg"
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const svg = (e.target as SVGElement).closest('svg');
          if (!svg) return;
          const rect = svg.getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * width;
          const idx = Math.round(((relX - padding.left) / plotW) * (n - 1));
          if (idx >= 0 && idx < n) setHoverIdx(idx);
        }}
      >
        {bands && bands.length > 0 && (
          <g className="climate-band-group">
            {bands.map((b) => {
              const top = yFor(b.maxKpa ?? dataMax);
              const bottom = yFor(b.minKpa ?? dataMin);
              return (
                <rect
                  key={b.key}
                  x={padding.left}
                  y={Math.min(top, bottom)}
                  width={plotW}
                  height={Math.max(0, Math.abs(bottom - top))}
                  fill={b.color}
                  fillOpacity={0.14}
                />
              );
            })}
          </g>
        )}

        {isShaded && (
          <g className="climate-shade-group">
            {points.map((p, i) =>
              isShaded(p, i) ? (
                <rect key={i} x={xFor(i) - plotW / Math.max(n, 1) / 2} y={padding.top} width={plotW / Math.max(n, 1)} height={plotH} className="climate-chart-shade" />
              ) : null
            )}
          </g>
        )}

        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={padding.left} x2={width - padding.right} y1={padding.top + plotH * f} y2={padding.top + plotH * f} className="climate-chart-grid" />
        ))}

        {mode === 'bar' ? (
          <g>
            {points.map((p, i) => {
              if (p.value == null) return null;
              const zeroY = yFor(0);
              const y = yFor(p.value);
              const barTop = Math.min(y, zeroY);
              const flagged = isFlagged?.(p, i);
              return (
                <rect
                  key={i}
                  x={xFor(i) - barWidth / 2}
                  y={barTop}
                  width={barWidth}
                  height={Math.max(0.5, Math.abs(zeroY - y))}
                  className="climate-lc-bar"
                  style={{ fill: flagged ? 'var(--red-500)' : color }}
                />
              );
            })}
          </g>
        ) : (
          <>
            {range && ribbonPath(range, xFor, yFor) && (
              <path d={ribbonPath(range, xFor, yFor)} style={{ fill: color, fillOpacity: 0.12 }} stroke="none" />
            )}
            {linePoints.length > 0 && <path d={pathD} className="climate-lc-line" fill="none" style={{ stroke: color }} />}
            {points.map((p, i) => (isFlagged?.(p, i) && p.value != null ? <circle key={i} cx={xFor(i)} cy={yFor(p.value)} r={4} style={{ fill: 'var(--red-500)' }} /> : null))}
            {last && <circle cx={last.x} cy={last.y} r={4} className="climate-lc-dot" style={{ fill: color }} />}
          </>
        )}

        <text x={4} y={padding.top + 4} className="climate-chart-axis-label">{dataMax.toFixed(1)}{unit}</text>
        <text x={4} y={padding.top + plotH} className="climate-chart-axis-label">{dataMin.toFixed(1)}{unit}</text>

        {hoverIdx != null && (
          <>
            <line x1={xFor(hoverIdx)} x2={xFor(hoverIdx)} y1={padding.top} y2={padding.top + plotH} className="climate-chart-crosshair" />
            {points[hoverIdx]?.value != null && <circle cx={xFor(hoverIdx)} cy={yFor(points[hoverIdx].value as number)} r={4} className="climate-chart-hover-dot" />}
          </>
        )}
      </svg>
      <div className="climate-chart-tooltip">
        {hoverIdx != null ? (
          <>
            {points[hoverIdx].x}: {points[hoverIdx].value != null ? `${points[hoverIdx].value}${unit}` : 'no data'}
            {rangeByX.get(points[hoverIdx].x) && ` (range ${fmtNum(rangeByX.get(points[hoverIdx].x)!.min)}–${fmtNum(rangeByX.get(points[hoverIdx].x)!.max)}${unit})`}
          </>
        ) : (
          'Hover the chart to inspect a point'
        )}
      </div>
    </div>
  );
}

function fmtNum(v: number | null | undefined): string {
  return v == null ? '—' : String(v);
}

/** Two mini charts stacked on a shared x-axis — the single-axis alternative to a dual-axis chart for "X vs radiation." */
export function SmallMultiple({
  top,
  bottom,
}: {
  top: { title: string; chart: React.ReactNode };
  bottom: { title: string; chart: React.ReactNode };
}) {
  return (
    <div className="climate-small-multiple">
      <div className="climate-small-multiple-panel">
        <div className="climate-small-multiple-title">{top.title}</div>
        {top.chart}
      </div>
      <div className="climate-small-multiple-panel">
        <div className="climate-small-multiple-title">{bottom.title}</div>
        {bottom.chart}
      </div>
    </div>
  );
}

const VPD_BAND_ORDER: VpdBandKey[] = ['very_low', 'low', 'target', 'elevated', 'high'];

export const VPD_BAND_COLORS: Record<VpdBandKey, string> = {
  very_low: '#2563eb',
  low: '#3b82f6',
  target: '#16a34a',
  elevated: '#d97706',
  high: '#ef4444',
};

/** Fixed-order 5-segment horizontal bar showing hours spent in each VPD band. Colors validated with the dataviz palette checker. */
export function VpdBandBar({ hours, bands }: { hours: Record<VpdBandKey, number>; bands: VpdBandDefinition[] }) {
  const total = VPD_BAND_ORDER.reduce((sum, k) => sum + (hours[k] ?? 0), 0);
  const labelByKey = new Map(bands.map((b) => [b.key, b.label]));

  return (
    <div className="vpd-band-bar-wrap">
      <div className="vpd-band-bar">
        {total === 0 ? (
          <div className="vpd-band-bar-empty" />
        ) : (
          VPD_BAND_ORDER.map((key) => {
            const h = hours[key] ?? 0;
            if (h === 0) return null;
            return <div key={key} className="vpd-band-bar-segment" style={{ width: `${(h / total) * 100}%`, background: VPD_BAND_COLORS[key] }} title={`${labelByKey.get(key) ?? key}: ${h}h`} />;
          })
        )}
      </div>
      <div className="vpd-band-bar-legend">
        {VPD_BAND_ORDER.map((key) => (
          <span key={key} className="vpd-band-bar-legend-item">
            <span className="vpd-band-bar-legend-swatch" style={{ background: VPD_BAND_COLORS[key] }} />
            {labelByKey.get(key) ?? key}: <strong>{hours[key] ?? 0}h</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

export type CoverageTier = 'low' | 'partial' | 'good';

export function coverageTier(coveragePct: number | null): CoverageTier {
  if (coveragePct == null || coveragePct < 25) return 'low';
  if (coveragePct < 70) return 'partial';
  return 'good';
}

const TIER_LABEL: Record<CoverageTier, string> = {
  low: 'Low confidence',
  partial: 'Partial coverage',
  good: 'Good coverage',
};

const TIER_BADGE_CLASS: Record<CoverageTier, string> = {
  low: 'badge badge-red',
  partial: 'badge badge-yellow',
  good: 'badge badge-green',
};

/** A coverage badge alone — for compact placement (e.g. inside a stat-card grid header). */
export function CoverageBadge({ coveragePct }: { coveragePct: number | null }) {
  const tier = coverageTier(coveragePct);
  return (
    <span className={TIER_BADGE_CLASS[tier]}>
      {TIER_LABEL[tier]} {coveragePct != null ? `(${coveragePct.toFixed(1)}%)` : '(no data)'}
    </span>
  );
}

/**
 * The prominent, can't-miss version — a full banner used above any exposure
 * result. Deliberately louder than CoverageBadge: a 'low' result renders
 * with the same alert styling as a blocking error elsewhere in the app, not
 * just a colored label, so it can't be skimmed past as equivalent to a
 * trustworthy result.
 */
export function CoverageBanner({ coveragePct, hoursObserved, hoursExpected, missingHours }: { coveragePct: number | null; hoursObserved: number; hoursExpected: number; missingHours?: string[] }) {
  const tier = coverageTier(coveragePct);
  const bannerClass = tier === 'low' ? 'alert alert-error' : tier === 'partial' ? 'warning-banner' : 'climate-info-banner';
  return (
    <div className={`${bannerClass} climate-coverage-banner`}>
      <div className="climate-coverage-banner-header">
        <span className={TIER_BADGE_CLASS[tier]}>{TIER_LABEL[tier]}</span>
        <strong>{coveragePct != null ? `${coveragePct.toFixed(1)}%` : '—'} climate data coverage</strong>
        <span className="climate-coverage-banner-hours">({hoursObserved} / {hoursExpected} hours observed)</span>
      </div>
      {tier === 'low' && (
        <p>
          Fewer than a quarter of the expected hours have climate data — treat every number below as illustrative only, not a
          reliable exposure measurement.
        </p>
      )}
      {tier === 'partial' && <p>Coverage is partial — numbers below are directionally useful but incomplete.</p>}
      {missingHours && missingHours.length > 0 && (
        <details className="climate-coverage-missing-hours">
          <summary>{missingHours.length} missing hour{missingHours.length === 1 ? '' : 's'} in this range</summary>
          <div className="climate-warning-file-list-scroll">
            <ul className="climate-warning-file-list">
              {missingHours.map((h) => (
                <li key={h}>{new Date(h).toLocaleString()}</li>
              ))}
            </ul>
          </div>
        </details>
      )}
    </div>
  );
}

/** Wraps content that should be visually de-emphasized when the backing exposure data has low coverage. */
export function CoverageMuted({ coveragePct, children }: { coveragePct: number | null; children: React.ReactNode }) {
  const tier = coverageTier(coveragePct);
  return <div className={tier === 'low' ? 'climate-coverage-muted' : undefined}>{children}</div>;
}

/**
 * Separate, stricter coverage thresholds for climate context placed beside
 * *other* evidence (Calculator's set-week rows, Projections' weekly
 * forecast) — not the Analysis/Exposure tabs' own 25%/70% tiers above, which
 * are unrelated and untouched. These are UI presentation cutoffs only (how
 * hard to caution a reader that the comparison numbers are thin), not a
 * claim about any biological/agronomic significance of 50% or 80% coverage.
 * Kept deliberately out of climateFeatures.ts for that reason. Adjust freely.
 */
export const PROJECTION_CONTEXT_COVERAGE_THRESHOLDS = { caution: 80, insufficient: 50 };

export type ProjectionContextCoverageTier = 'insufficient' | 'caution' | 'ok';

export function projectionContextCoverageTier(coveragePct: number | null): ProjectionContextCoverageTier {
  if (coveragePct == null || coveragePct < PROJECTION_CONTEXT_COVERAGE_THRESHOLDS.insufficient) return 'insufficient';
  if (coveragePct < PROJECTION_CONTEXT_COVERAGE_THRESHOLDS.caution) return 'caution';
  return 'ok';
}

/**
 * The caution line for climate context shown beside Calculator/Projections
 * evidence. Below `insufficient` (50%) shows the exact required label;
 * between `insufficient` and `caution` (80%) shows a lighter warning; at or
 * above `caution` renders nothing.
 */
export function CoverageCaution({ coveragePct }: { coveragePct: number | null }) {
  const tier = projectionContextCoverageTier(coveragePct);
  if (tier === 'ok') return null;
  const pctLabel = coveragePct != null ? `${coveragePct.toFixed(1)}%` : 'unknown';
  return (
    <div className={tier === 'insufficient' ? 'alert alert-error climate-coverage-caution' : 'warning-banner climate-coverage-caution'}>
      {tier === 'insufficient' ? (
        <strong>Insufficient climate coverage for reliable comparison</strong>
      ) : (
        <strong>Low climate data coverage — treat this comparison with caution</strong>
      )}
      <span className="climate-coverage-caution-pct"> ({pctLabel} coverage)</span>
    </div>
  );
}
