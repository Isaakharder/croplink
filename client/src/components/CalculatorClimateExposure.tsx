import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SetWeekCohortClimateRow, ExposureWindowFeatures, ExposureWindowKey, ClimateFeatureConfig } from '../types';
import { climateFeatureConfigApi } from '../services/api';
import { VpdBandBar, CoverageCaution } from './ClimateCharts';

const WINDOWS: { key: ExposureWindowKey; label: string }[] = [
  { key: 'setToCurrent', label: 'Set → Current' },
  { key: 'setToBreaker', label: 'Set → Breaker' },
  { key: 'breakerToHarvest', label: 'Breaker → Harvest' },
  { key: 'setToHarvest', label: 'Set → Harvest' },
];

function fmt(v: number | null | undefined, digits = 1): string {
  return v == null ? '—' : v.toFixed(digits);
}

function climateAnalysisHref(varietyId: string, year: number, setWeekNumber: number, windowKey: ExposureWindowKey): string {
  const params = new URLSearchParams({ tab: 'exposure', varietyId, year: String(year), setWeek: String(setWeekNumber), window: windowKey });
  return `/climate?${params.toString()}`;
}

function ExposureWindowSection({
  label,
  window,
  varietyId,
  year,
  setWeekNumber,
  windowKey,
  config,
}: {
  label: string;
  window: ExposureWindowFeatures;
  varietyId: string;
  year: number;
  setWeekNumber: number;
  windowKey: ExposureWindowKey;
  config: ClimateFeatureConfig | null;
}) {
  return (
    <div className="climate-exposure-window-section">
      <div className="card-title climate-exposure-window-title">
        {label}
        <Link className="climate-exposure-open-link" to={climateAnalysisHref(varietyId, year, setWeekNumber, windowKey)}>
          Open in Climate Analysis ↗
        </Link>
      </div>
      <CoverageCaution coveragePct={window.coveragePct} />
      <div className="row-detail-summary">
        <div><span>Degree-hours</span><strong>{fmt(window.accumulatedDegreeHours)} °C·h</strong></div>
        <div><span>Degree-days</span><strong>{window.accumulatedDegreeHours != null ? (window.accumulatedDegreeHours / 24).toFixed(2) : '—'} °C·d</strong></div>
        <div><span>Radiation</span><strong>{fmt(window.accumulatedRadiationJCm2)} J/cm²</strong></div>
        <div><span>Temperature</span><strong>{fmt(window.tempAvgC)}°C</strong><span> (min {fmt(window.tempMinC)} / max {fmt(window.tempMaxC)})</span></div>
        <div><span>VPD</span><strong>{fmt(window.vpdAvgKpa, 2)} kPa</strong><span> (min {fmt(window.vpdMinKpa, 2)} / max {fmt(window.vpdMaxKpa, 2)})</span></div>
        <div><span>CO2 (daylight)</span><strong>{fmt(window.co2AvgDaylightPpm, 0)} ppm</strong><span> night {fmt(window.co2AvgNightPpm, 0)} / rad-wtd {fmt(window.radiationWeightedCo2Ppm, 0)}</span></div>
        <div><span>Irrigation total</span><strong>{fmt(window.irrigationTotalMl, 0)} ml</strong><span> {window.irrigationEventCount} events</span></div>
        <div><span>EC avg</span><strong>{fmt(window.ecAvg, 2)} mS/cm</strong><span> ± {fmt(window.ecStdDev, 2)}</span></div>
        <div><span>pH avg</span><strong>{fmt(window.phAvg, 2)}</strong><span> ± {fmt(window.phStdDev, 2)}</span></div>
        <div><span>Coverage</span><strong>{fmt(window.coveragePct)}%</strong><span> ({window.hoursObserved} / {window.hoursExpected} hours)</span></div>
      </div>
      {config && <VpdBandBar hours={window.vpdBandHours} bands={config.vpdBands} />}
    </div>
  );
}

export function CalculatorClimateExposure({ cohort, varietyId, year }: { cohort: SetWeekCohortClimateRow; varietyId: string; year: number }) {
  const [config, setConfig] = useState<ClimateFeatureConfig | null>(null);

  useEffect(() => {
    climateFeatureConfigApi.get().then(setConfig).catch(() => {});
  }, []);

  const availableWindows = WINDOWS.filter((w) => cohort[w.key] != null);

  if (availableWindows.length === 0) {
    return <div className="empty-state">No climate history overlaps this set week yet.</div>;
  }

  return (
    <div className="climate-exposure-windows">
      {availableWindows.map((w) => (
        <ExposureWindowSection
          key={w.key}
          label={w.label}
          window={cohort[w.key] as ExposureWindowFeatures}
          varietyId={varietyId}
          year={year}
          setWeekNumber={cohort.setWeekNumber}
          windowKey={w.key}
          config={config}
        />
      ))}
    </div>
  );
}
