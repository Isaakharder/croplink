import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Variety, Season, SetWeekCohortClimateRow, ExposureWindowFeatures, ExposureWindowKey, ClimateFeatureConfig } from '../types';
import { yearsApi, climateTrainingDatasetApi, climateFeatureConfigApi } from '../services/api';
import { CoverageBanner, CoverageMuted, VpdBandBar } from './ClimateCharts';

const WINDOW_OPTIONS: { key: ExposureWindowKey; label: string }[] = [
  { key: 'setToCurrent', label: 'Set → Current' },
  { key: 'setToBreaker', label: 'Set → Breaker' },
  { key: 'breakerToHarvest', label: 'Breaker → Harvest' },
  { key: 'setToHarvest', label: 'Set → Harvest' },
];
const WINDOW_KEYS = WINDOW_OPTIONS.map((w) => w.key) as string[];

function fmt(v: number | null | undefined, digits = 1): string {
  return v == null ? '—' : v.toFixed(digits);
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function ClimateExposureTab({ varieties }: { varieties: Variety[] }) {
  const todayYear = useMemo(() => new Date().getFullYear(), []);
  // Deep-link seeding (e.g. from the Calculator page's "Open in Climate
  // Analysis" link): /climate?tab=exposure&varietyId=&year=&setWeek=&window=.
  // Read once as initial state only — invalid/missing values keep today's
  // defaults, and each is still re-validated against loaded data below
  // exactly like a manual selection would be.
  const [searchParams] = useSearchParams();
  const urlVarietyId = searchParams.get('varietyId');
  const urlYear = Number(searchParams.get('year'));
  const urlSetWeek = Number(searchParams.get('setWeek'));
  const urlWindow = searchParams.get('window');

  const [years, setYears] = useState<Season[]>([]);
  const [varietyId, setVarietyId] = useState(urlVarietyId ?? '');
  const [year, setYear] = useState(Number.isFinite(urlYear) && urlYear > 0 ? urlYear : todayYear);
  const [setWeekNumber, setSetWeekNumber] = useState<number | null>(Number.isFinite(urlSetWeek) && urlSetWeek > 0 ? urlSetWeek : null);
  const [windowKey, setWindowKey] = useState<ExposureWindowKey>(
    urlWindow && WINDOW_KEYS.includes(urlWindow) ? (urlWindow as ExposureWindowKey) : 'setToHarvest'
  );
  const [config, setConfig] = useState<ClimateFeatureConfig | null>(null);
  const [cohorts, setCohorts] = useState<SetWeekCohortClimateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    yearsApi.list().then((data) => {
      setYears(data);
      if (data.length > 0) setYear((prev) => (data.some((y) => y.year === prev) ? prev : data[0].year));
    }).catch(() => {});
    climateFeatureConfigApi.get().then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    if (!varietyId) setVarietyId(varieties.find((v) => v.is_active)?.id || varieties[0]?.id || '');
  }, [varieties, varietyId]);

  useEffect(() => {
    if (!varietyId || !year) return;
    setLoading(true);
    setError(null);
    climateTrainingDatasetApi.get(varietyId, year, 'cohort')
      .then((result) => {
        const rows = result.rows as SetWeekCohortClimateRow[];
        setCohorts(rows);
        setSetWeekNumber((prev) => (prev != null && rows.some((r) => r.setWeekNumber === prev) ? prev : rows[0]?.setWeekNumber ?? null));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [varietyId, year]);

  const cohort = cohorts.find((c) => c.setWeekNumber === setWeekNumber) ?? null;
  const selectedWindow: ExposureWindowFeatures | null = cohort ? cohort[windowKey] : null;

  // If the currently-selected window isn't available on this cohort, fall back to the first one that is.
  useEffect(() => {
    if (!cohort) return;
    if (cohort[windowKey] != null) return;
    const firstAvailable = WINDOW_OPTIONS.find((w) => cohort[w.key] != null);
    if (firstAvailable) setWindowKey(firstAvailable.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cohort]);

  return (
    <>
      <div className="selector-bar">
        <label>Variety</label>
        <select className="form-control" style={{ width: 180 }} value={varietyId} onChange={(e) => setVarietyId(e.target.value)}>
          <option value="">- select -</option>
          {varieties.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <label>Year</label>
        <select className="form-control" style={{ width: 100 }} value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.length === 0 && <option value={year}>{year}</option>}
          {years.map((y) => <option key={y.id} value={y.year}>{y.year}</option>)}
        </select>
        <label>Set week / cohort</label>
        <select className="form-control" style={{ width: 220 }} value={setWeekNumber ?? ''} onChange={(e) => setSetWeekNumber(Number(e.target.value))}>
          {cohorts.length === 0 && <option value="">- none -</option>}
          {cohorts.map((c) => <option key={c.setWeekNumber} value={c.setWeekNumber}>Week {c.setWeekNumber} ({c.instanceCount} instance{c.instanceCount === 1 ? '' : 's'})</option>)}
        </select>
        <label>Exposure window</label>
        <select className="form-control" style={{ width: 180 }} value={windowKey} onChange={(e) => setWindowKey(e.target.value as ExposureWindowKey)}>
          {WINDOW_OPTIONS.map((w) => (
            <option key={w.key} value={w.key} disabled={cohort ? cohort[w.key] == null : false}>
              {w.label}{cohort && cohort[w.key] == null ? ' (not available)' : ''}
            </option>
          ))}
        </select>
      </div>

      {!varietyId ? (
        <div className="empty-state">Select a variety to view crop climate exposure.</div>
      ) : loading ? (
        <div className="loading">Loading...</div>
      ) : error ? (
        <div className="error-state">Failed to load: {error}</div>
      ) : !cohort ? (
        <div className="empty-state">No fruit instances found for this variety/year — nothing to show climate exposure for.</div>
      ) : !selectedWindow ? (
        <div className="empty-state">The selected exposure window has no data for this cohort yet (e.g. no completed harvests).</div>
      ) : (
        <>
          <CoverageBanner coveragePct={selectedWindow.coveragePct} hoursObserved={selectedWindow.hoursObserved} hoursExpected={selectedWindow.hoursExpected} />

          <div className="climate-cohort-summary">
            <span>Instances: <strong>{cohort.instanceCount}</strong></span>
            <span>Harvested: <strong>{cohort.harvestedCount}</strong></span>
            <span>Currently open: <strong>{cohort.openCount}</strong></span>
            <span>Aborted: <strong>{cohort.abortedCount}</strong></span>
            <span>Pruned: <strong>{cohort.prunedCount}</strong></span>
            {cohort.avgWeeksToBreaker != null && <span>Avg weeks to breaker: <strong>{cohort.avgWeeksToBreaker.toFixed(1)}</strong></span>}
            {cohort.avgWeeksSetToHarvest != null && <span>Avg weeks set→harvest: <strong>{cohort.avgWeeksSetToHarvest.toFixed(1)}</strong></span>}
          </div>

          <CoverageMuted coveragePct={selectedWindow.coveragePct}>
            <div className="grid-7 mb-4">
              <StatCard label="Degree-hours" value={fmt(selectedWindow.accumulatedDegreeHours)} sub={selectedWindow.accumulatedDegreeHours != null ? `${(selectedWindow.accumulatedDegreeHours / 24).toFixed(2)} °C·day` : undefined} />
              <StatCard label="Radiation" value={`${fmt(selectedWindow.accumulatedRadiationJCm2)} J/cm²`} />
              <StatCard label="VPD avg" value={`${fmt(selectedWindow.vpdAvgKpa, 2)} kPa`} sub={`min ${fmt(selectedWindow.vpdMinKpa, 2)} / max ${fmt(selectedWindow.vpdMaxKpa, 2)}`} />
              <StatCard label="CO2 (daylight)" value={`${fmt(selectedWindow.co2AvgDaylightPpm, 0)} ppm`} sub={`night ${fmt(selectedWindow.co2AvgNightPpm, 0)} / rad-wtd ${fmt(selectedWindow.radiationWeightedCo2Ppm, 0)}`} />
              <StatCard label="Irrigation total" value={`${fmt(selectedWindow.irrigationTotalMl, 0)} ml`} sub={`${selectedWindow.irrigationEventCount} events, avg ${fmt(selectedWindow.irrigationAvgIntervalMinutes, 0)} min`} />
              <StatCard label="EC avg" value={`${fmt(selectedWindow.ecAvg, 2)} mS/cm`} sub={`± ${fmt(selectedWindow.ecStdDev, 2)} (${fmt(selectedWindow.ecMin, 2)}–${fmt(selectedWindow.ecMax, 2)})`} />
              <StatCard label="pH avg" value={fmt(selectedWindow.phAvg, 2)} sub={`± ${fmt(selectedWindow.phStdDev, 2)} (${fmt(selectedWindow.phMin, 2)}–${fmt(selectedWindow.phMax, 2)})`} />
            </div>

            <div className="card">
              <div className="card-title">Hours in each VPD band</div>
              {config ? <VpdBandBar hours={selectedWindow.vpdBandHours} bands={config.vpdBands} /> : <div className="empty-state">Loading band config…</div>}
              <div className="stat-sub mt-2">{selectedWindow.hoursObserved} / {selectedWindow.hoursExpected} hours observed for this window ({fmt(selectedWindow.coveragePct)}% coverage)</div>
            </div>
          </CoverageMuted>
        </>
      )}
    </>
  );
}
