import type { VarietyClimateExposureResult, ClimateFeatureConfig } from '../types';
import { VpdBandBar, CoverageCaution } from './ClimateCharts';

function fmt(v: number | null | undefined, digits = 1): string {
  return v == null ? '—' : v.toFixed(digits);
}

/** % change vs. previous — meaningful only for zero-based accumulating totals (degree-hours, radiation, irrigation). */
function pctDelta(current: number | null, previous: number | null): string {
  if (current == null || previous == null || previous === 0) return '';
  const pct = ((current - previous) / previous) * 100;
  return ` (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% vs prior 7d)`;
}

/** Absolute delta — used for VPD (kPa), where a % change on a non-zero-based unit isn't meaningful. */
function absDelta(current: number | null, previous: number | null, digits = 2): string {
  if (current == null || previous == null) return '';
  const delta = current - previous;
  return ` (${delta >= 0 ? '+' : ''}${delta.toFixed(digits)} kPa vs prior 7d)`;
}

export function ProjectionsClimateContext({
  current,
  previous,
  config,
}: {
  current: VarietyClimateExposureResult;
  previous: VarietyClimateExposureResult;
  config: ClimateFeatureConfig | null;
}) {
  // The more conservative (lower) of the two windows drives the caution —
  // a strong current window next to a sparse comparison window is still an
  // unreliable comparison.
  const lowerCoverage = [current.coveragePct, previous.coveragePct]
    .filter((v): v is number => v != null)
    .reduce((min, v) => Math.min(min, v), 100);
  const coveragePctForCaution = current.coveragePct == null && previous.coveragePct == null ? null : lowerCoverage;

  return (
    <div className="projections-card projections-card--full climate-context-card">
      <div className="climate-context-header">
        <h3 className="projections-card-title" style={{ marginBottom: 0 }}>Climate Context</h3>
        <span className="breaker-harvested-note">Observational only — not yet used to alter projections</span>
      </div>

      <CoverageCaution coveragePct={coveragePctForCaution} />

      <div className="row-detail-summary">
        <div>
          <span>Degree-hours (7d)</span>
          <strong>{fmt(current.accumulatedDegreeHours)} °C·h{pctDelta(current.accumulatedDegreeHours, previous.accumulatedDegreeHours)}</strong>
        </div>
        <div>
          <span>Radiation (7d)</span>
          <strong>{fmt(current.accumulatedRadiationJCm2)} J/cm²{pctDelta(current.accumulatedRadiationJCm2, previous.accumulatedRadiationJCm2)}</strong>
        </div>
        <div>
          <span>Average VPD</span>
          <strong>{fmt(current.vpdAvgKpa, 2)} kPa{absDelta(current.vpdAvgKpa, previous.vpdAvgKpa)}</strong>
        </div>
        <div>
          <span>VPD range</span>
          <strong>min {fmt(current.vpdMinKpa, 2)} / max {fmt(current.vpdMaxKpa, 2)} kPa</strong>
        </div>
        <div>
          <span>Irrigation total (7d)</span>
          <strong>{fmt(current.irrigationTotalMl, 0)} ml{pctDelta(current.irrigationTotalMl, previous.irrigationTotalMl)}</strong>
        </div>
        <div>
          <span>Coverage (current / prior 7d)</span>
          <strong>{fmt(current.coveragePct)}% / {fmt(previous.coveragePct)}%</strong>
        </div>
      </div>

      {config && (
        <div className="climate-context-band-bar">
          <div className="stat-sub" style={{ marginBottom: 4 }}>Hours in each VPD band (last 7 days)</div>
          <VpdBandBar hours={current.vpdBandHours} bands={config.vpdBands} />
        </div>
      )}
    </div>
  );
}
