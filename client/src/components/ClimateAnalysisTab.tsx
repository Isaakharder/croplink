import { useEffect, useMemo, useState } from 'react';
import type {
  Variety,
  ClimateGranularity,
  VarietyClimateHourlyRow,
  VarietyClimateHourlyFeatureRow,
  VarietyClimateFeatureBucketRow,
  ClimateFeatureConfig,
  VarietyClimateExposureResult,
} from '../types';
import { varietyClimateHourlyApi, varietyClimateFeaturesApi, climateFeatureConfigApi } from '../services/api';
import { LineChart, SmallMultiple, VpdBandBar, CoverageBanner, CoverageMuted, VPD_BAND_COLORS, type ChartPoint, type ChartRangePoint } from './ClimateCharts';

function defaultStartDate() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}
function defaultEndDate() {
  return new Date().toISOString().slice(0, 10);
}

/** Every top-of-hour ISO timestamp in [startIso, endIso) — used only to find gaps in what the server returned, not to compute anything. */
function hourSequence(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  let t = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  while (t < end) {
    out.push(new Date(t).toISOString());
    t += 3600000;
  }
  return out;
}

interface MergedHourlyRow {
  measuredAt: string;
  airTemperatureAvgC: number | null;
  relativeHumidityAvgPct: number | null;
  ecAvg: number | null;
  phAvg: number | null;
  degreeHours: number | null;
  vpdKpa: number | null;
  isDaylight: boolean;
  co2AvgPpm: number | null;
  radiationIntervalDeltaJCm2: number | null;
  irrigationIntervalDeltaMl: number | null;
}

export function ClimateAnalysisTab({ varieties }: { varieties: Variety[] }) {
  const [varietyId, setVarietyId] = useState('');
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(defaultEndDate);
  const [granularity, setGranularity] = useState<ClimateGranularity>('daily');

  const [config, setConfig] = useState<ClimateFeatureConfig | null>(null);
  const [exposure, setExposure] = useState<VarietyClimateExposureResult | null>(null);
  const [hourlyRaw, setHourlyRaw] = useState<VarietyClimateHourlyRow[]>([]);
  const [hourlyFeatures, setHourlyFeatures] = useState<VarietyClimateHourlyFeatureRow[]>([]);
  const [bucketRows, setBucketRows] = useState<VarietyClimateFeatureBucketRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    climateFeatureConfigApi.get().then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    if (!varietyId) { setVarietyId(varieties.find((v) => v.is_active)?.id || varieties[0]?.id || ''); }
  }, [varieties, varietyId]);

  const startIso = `${startDate}T00:00:00.000Z`;
  const endIso = `${endDate}T23:59:59.999Z`;

  useEffect(() => {
    if (!varietyId) return;
    setLoading(true);
    setError(null);
    const loads: Promise<unknown>[] = [
      varietyClimateFeaturesApi.exposure(varietyId, startIso, endIso).then(setExposure),
    ];
    if (granularity === 'hourly') {
      loads.push(varietyClimateHourlyApi.get(varietyId, 'hourly', startIso, endIso).then((r) => setHourlyRaw(r.rows as VarietyClimateHourlyRow[])));
      loads.push(varietyClimateFeaturesApi.get(varietyId, 'hourly', startIso, endIso).then((r) => setHourlyFeatures(r.rows as VarietyClimateHourlyFeatureRow[])));
      setBucketRows([]);
    } else {
      loads.push(varietyClimateFeaturesApi.get(varietyId, granularity, startIso, endIso).then((r) => setBucketRows(r.rows as VarietyClimateFeatureBucketRow[])));
      setHourlyRaw([]);
      setHourlyFeatures([]);
    }
    Promise.all(loads)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [varietyId, startDate, endDate, granularity]);

  const merged = useMemo<MergedHourlyRow[]>(() => {
    if (granularity !== 'hourly') return [];
    const rawByTs = new Map(hourlyRaw.map((r) => [r.measured_at, r]));
    return hourlyFeatures.map((f) => {
      const raw = rawByTs.get(f.measured_at);
      return {
        measuredAt: f.measured_at,
        airTemperatureAvgC: raw?.air_temperature_avg_c ?? null,
        relativeHumidityAvgPct: raw?.relative_humidity_avg_pct ?? null,
        ecAvg: raw?.ec_avg ?? null,
        phAvg: raw?.ph_avg ?? null,
        degreeHours: f.degree_hours,
        vpdKpa: f.vpd_kpa,
        isDaylight: f.is_daylight,
        co2AvgPpm: f.co2_avg_ppm,
        radiationIntervalDeltaJCm2: f.radiation_interval_delta_j_cm2,
        irrigationIntervalDeltaMl: f.irrigation_interval_delta_ml,
      };
    });
  }, [granularity, hourlyRaw, hourlyFeatures]);

  const missingHours = useMemo(() => {
    if (granularity !== 'hourly') return [];
    // Compare by instant, not raw string — the server returns
    // "+00:00"-suffixed timestamps while a freshly-built ISO string uses "Z",
    // so a string-equality Set lookup would (wrongly) call every hour missing.
    const present = new Set(hourlyFeatures.map((r) => new Date(r.measured_at).getTime()));
    return hourSequence(startIso, endIso).filter((h) => !present.has(new Date(h).getTime()));
  }, [granularity, hourlyFeatures, startIso, endIso]);

  const xLabels: string[] = granularity === 'hourly' ? merged.map((r) => new Date(r.measuredAt).toLocaleString()) : bucketRows.map((r) => r.bucket);

  function points(getter: (r: MergedHourlyRow) => number | null, bucketGetter: (r: VarietyClimateFeatureBucketRow) => number | null): ChartPoint[] {
    return granularity === 'hourly'
      ? merged.map((r, i) => ({ x: xLabels[i], value: getter(r) }))
      : bucketRows.map((r, i) => ({ x: xLabels[i], value: bucketGetter(r) }));
  }

  function rangePoints(min: (r: VarietyClimateFeatureBucketRow) => number | null, max: (r: VarietyClimateFeatureBucketRow) => number | null): ChartRangePoint[] | undefined {
    if (granularity === 'hourly') return undefined;
    return bucketRows.map((r, i) => ({ x: xLabels[i], min: min(r), max: max(r) }));
  }

  const vpdBands = (config?.vpdBands ?? []).map((b) => ({ key: b.key, label: b.label, minKpa: b.minKpa, maxKpa: b.maxKpa, color: VPD_BAND_COLORS[b.key] }));

  const totalDegreeHours = granularity === 'hourly'
    ? merged.reduce((a, r) => a + (r.degreeHours ?? 0), 0)
    : bucketRows.reduce((a, r) => a + (r.accumulatedDegreeHours ?? 0), 0);

  const bandHoursTotal = bucketRows.reduce<Record<string, number>>((acc, r) => {
    for (const [k, v] of Object.entries(r.vpdBandHours)) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  }, {});

  return (
    <>
      <div className="selector-bar">
        <label>Variety</label>
        <select className="form-control" style={{ width: 180 }} value={varietyId} onChange={(e) => setVarietyId(e.target.value)}>
          <option value="">- select -</option>
          {varieties.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <label>From</label>
        <input className="form-control" style={{ width: 150 }} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        <label>To</label>
        <input className="form-control" style={{ width: 150 }} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        <label>Granularity</label>
        <select className="form-control" style={{ width: 120 }} value={granularity} onChange={(e) => setGranularity(e.target.value as ClimateGranularity)}>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </div>

      {!varietyId ? (
        <div className="empty-state">Select a variety to view calculated climate features.</div>
      ) : loading ? (
        <div className="loading">Loading...</div>
      ) : error ? (
        <div className="error-state">Failed to load: {error}</div>
      ) : (
        <>
          {exposure && (
            <CoverageBanner
              coveragePct={exposure.coveragePct}
              hoursObserved={exposure.hoursObserved}
              hoursExpected={exposure.hoursExpected}
              missingHours={granularity === 'hourly' ? missingHours : undefined}
            />
          )}

          <CoverageMuted coveragePct={exposure?.coveragePct ?? null}>
            <div className="card mb-4">
              <div className="card-title">Degree-Hours {granularity !== 'hourly' && '/ Accumulated Degree-Days'}</div>
              <LineChart points={points((r) => r.degreeHours, (r) => r.accumulatedDegreeHours)} unit=" °C·h" mode="bar" color="var(--green-600)" />
              <div className="climate-chart-tooltip">
                Total across range: {totalDegreeHours.toFixed(1)} °C·h ({(totalDegreeHours / 24).toFixed(2)} °C·day)
                {config && ` — base ${config.degreeHourBaseTempC}°C, capped at ${config.degreeHourUpperCapC}°C`}
              </div>
            </div>

            <div className="card mb-4">
              <div className="card-title">Air Temperature</div>
              <LineChart points={points((r) => r.airTemperatureAvgC, (r) => r.airTemperatureAvgC)} unit="°C" color="var(--gray-800)" />
            </div>

            <div className="card mb-4">
              <div className="card-title">VPD (Vapor Pressure Deficit)</div>
              <LineChart
                points={points((r) => r.vpdKpa, (r) => r.vpdAvgKpa)}
                unit=" kPa"
                color="var(--gray-800)"
                bands={vpdBands}
                range={granularity !== 'hourly' ? rangePoints((r) => r.vpdMinKpa, (r) => r.vpdMaxKpa) : undefined}
              />
              {config && <VpdBandBar hours={granularity === 'hourly' ? {} as Record<import('../types').VpdBandKey, number> : (bandHoursTotal as Record<import('../types').VpdBandKey, number>)} bands={config.vpdBands} />}
            </div>

            <div className="card mb-4">
              <div className="card-title">Radiation {granularity === 'hourly' ? '(interval)' : '(accumulated, negative sensor resets excluded)'}</div>
              <LineChart
                points={points((r) => r.radiationIntervalDeltaJCm2, (r) => r.accumulatedRadiationJCm2)}
                unit=" J/cm²"
                mode="bar"
                color="var(--blue-500)"
                isFlagged={granularity === 'hourly' ? (p) => (p.value ?? 0) < 0 : undefined}
              />
              {granularity === 'hourly' && <div className="climate-chart-tooltip">Red bars mark a sensor/counter reset (negative raw delta) — excluded from any accumulated total, shown here for audit.</div>}
            </div>

            <div className="card mb-4">
              <div className="card-title">CO₂ (with radiation/light context)</div>
              <SmallMultiple
                top={{
                  title: granularity === 'hourly' ? 'CO2 — shaded background marks daylight hours' : 'CO2 (avg / daylight / night / radiation-weighted)',
                  chart: (
                    <LineChart
                      points={points((r) => r.co2AvgPpm, (r) => r.co2AvgPpm)}
                      unit=" ppm"
                      color="var(--green-600)"
                      isShaded={granularity === 'hourly' ? (_p, i) => merged[i]?.isDaylight === true : undefined}
                    />
                  ),
                }}
                bottom={{ title: 'Radiation', chart: <LineChart points={points((r) => r.radiationIntervalDeltaJCm2, (r) => r.accumulatedRadiationJCm2)} unit=" J/cm²" mode="bar" color="var(--blue-500)" height={160} /> }}
              />
              {granularity !== 'hourly' && bucketRows.length > 0 && (
                <div className="climate-chart-tooltip">
                  Latest bucket — daylight CO2: {fmt(bucketRows[bucketRows.length - 1].co2AvgDaylightPpm)} ppm, night CO2: {fmt(bucketRows[bucketRows.length - 1].co2AvgNightPpm)} ppm,
                  radiation-weighted: {fmt(bucketRows[bucketRows.length - 1].radiationWeightedCo2Ppm)} ppm
                </div>
              )}
            </div>

            <div className="card mb-4">
              <div className="card-title">Irrigation vs. Radiation</div>
              <SmallMultiple
                top={{ title: 'Irrigation (interval)', chart: <LineChart points={points((r) => r.irrigationIntervalDeltaMl, (r) => r.irrigationTotalMl)} unit=" ml" mode="bar" color="var(--green-700)" /> }}
                bottom={{ title: 'Radiation', chart: <LineChart points={points((r) => r.radiationIntervalDeltaJCm2, (r) => r.accumulatedRadiationJCm2)} unit=" J/cm²" mode="bar" color="var(--blue-500)" height={160} /> }}
              />
            </div>

            <div className="card mb-4">
              <div className="card-title">EC Stability</div>
              <LineChart points={points((r) => r.ecAvg, (r) => r.ecAvg)} unit=" mS/cm" color="var(--yellow-500)" range={rangePoints((r) => r.ecMin, (r) => r.ecMax)} />
              {granularity !== 'hourly' && bucketRows.length > 0 && <div className="climate-chart-tooltip">Latest bucket stdDev: {fmt(bucketRows[bucketRows.length - 1].ecStdDev)} mS/cm</div>}
            </div>

            <div className="card">
              <div className="card-title">pH Stability</div>
              <LineChart points={points((r) => r.phAvg, (r) => r.phAvg)} unit="" color="var(--red-500)" range={rangePoints((r) => r.phMin, (r) => r.phMax)} />
              {granularity !== 'hourly' && bucketRows.length > 0 && <div className="climate-chart-tooltip">Latest bucket stdDev: {fmt(bucketRows[bucketRows.length - 1].phStdDev)}</div>}
            </div>
          </CoverageMuted>
        </>
      )}
    </>
  );
}

function fmt(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(1);
}
