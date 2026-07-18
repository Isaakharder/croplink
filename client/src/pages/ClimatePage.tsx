import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Variety, ClimateImportPreview, ClimateImportBatch, ClimateImportConfirmResult, ClimateGranularity, VarietyClimateHourlyRow, VarietyClimateHourlyAggregatedRow, SynoptaAgentImport } from '../types';
import { varietiesApi, climateImportBatchesApi, synoptaAgentImportsApi, varietyClimateHourlyApi } from '../services/api';
import { ClimateAnalysisTab } from '../components/ClimateAnalysisTab';
import { ClimateExposureTab } from '../components/ClimateExposureTab';
import { ClimateDailySummary } from '../components/ClimateDailySummary';
import type { SummaryMetricKey } from '../utils/climateSummary';

type ClimatePageTab = 'import' | 'analysis' | 'exposure';

function defaultStartDate() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}
function defaultEndDate() {
  return new Date().toISOString().slice(0, 10);
}

type MetricKey = 'air_temperature' | 'relative_humidity' | 'co2' | 'ec' | 'ph' | 'irrigation_interval' | 'irrigation_cumulative' | 'radiation_interval' | 'radiation_cumulative';

const METRICS: { key: MetricKey; label: string; unit: string; hourlyField: keyof VarietyClimateHourlyRow; aggField: keyof VarietyClimateHourlyAggregatedRow }[] = [
  { key: 'air_temperature', label: 'Air Temperature', unit: '°C', hourlyField: 'air_temperature_avg_c', aggField: 'airTemperatureAvgC' },
  { key: 'relative_humidity', label: 'RH', unit: '%', hourlyField: 'relative_humidity_avg_pct', aggField: 'relativeHumidityAvgPct' },
  { key: 'co2', label: 'CO2', unit: 'ppm', hourlyField: 'co2_avg_ppm', aggField: 'co2AvgPpm' },
  { key: 'ec', label: 'EC', unit: 'mS/cm', hourlyField: 'ec_avg', aggField: 'ecAvg' },
  { key: 'ph', label: 'pH', unit: '', hourlyField: 'ph_avg', aggField: 'phAvg' },
  { key: 'irrigation_interval', label: 'Irrigation (interval)', unit: 'ml', hourlyField: 'irrigation_interval_delta_ml', aggField: 'irrigationIntervalTotalMl' },
  { key: 'irrigation_cumulative', label: 'Irrigation (cumulative)', unit: 'ml', hourlyField: 'irrigation_cumulative_avg_ml', aggField: 'irrigationCumulativeEndOfPeriodMl' },
  // "Radiation (interval)" is the true accumulated total once daily/weekly
  // (negative sensor-reset deltas excluded) — use it for actual radiation
  // totals. "Radiation (raw sensor total)" is the sensor's own cumulative
  // counter, which can reset mid-day and read lower than the period's real
  // total; kept for diagnostics/audit, not accumulation.
  { key: 'radiation_interval', label: 'Radiation (interval)', unit: 'J/cm²', hourlyField: 'radiation_interval_delta_j_cm2', aggField: 'radiationIntervalTotalJCm2' },
  { key: 'radiation_cumulative', label: 'Radiation (raw sensor total)', unit: 'J/cm²', hourlyField: 'radiation_cumulative_j_cm2', aggField: 'radiationCumulativeEndOfPeriodJCm2' },
];

function fmt(v: number | null | undefined, digits = 1): string {
  return v == null ? '—' : v.toFixed(digits);
}

const SYNOPTA_STALE_WARNING_HOURS = 2;

// "3h 42m ago" / "just now" — used for "Time since last import".
function timeSince(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours === 0) return `${remMins}m ago`;
  return `${hours}h ${remMins}m ago`;
}

// "Zone 1", "Zone 2", ... "Zone 14" -> "Zones 1–14" (falls back to a plain
// join for labels that don't match the "Zone N" pattern).
function zoneRangeLabel(zoneLabels: string[]): string {
  const nums = zoneLabels
    .map((z) => { const m = z.match(/^Zone\s*(\d+)$/i); return m ? parseInt(m[1], 10) : null; })
    .filter((n): n is number => n != null)
    .sort((a, b) => a - b);
  if (nums.length === 0) return zoneLabels.length > 0 ? zoneLabels.join(', ') : 'none';
  const ranges: string[] = [];
  let start = nums[0], prev = nums[0];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === prev + 1) { prev = nums[i]; continue; }
    ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = nums[i]; prev = nums[i];
  }
  ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
  return `Zone${nums.length > 1 ? 's' : ''} ${ranges.join(', ')}`;
}

interface TimestampWarningGroup {
  key: string;
  isKnownRidderDateQuirk: boolean;
  files: { filename: string; resolvedMeasuredAt: string | null; warning: string | null }[];
}

// Groups files that hit the SAME timestamp-resolution situation so the
// preview shows one summarized card instead of one line per file. Any file
// that reaches this point (status='parsed' + timestampConflict) was
// resolved successfully — a genuinely unresolvable timestamp fails parsing
// instead (status='error'), so nothing grouped here is ever blocking.
function groupTimestampWarnings(files: ClimateImportPreview['files']): TimestampWarningGroup[] {
  const groups = new Map<string, TimestampWarningGroup>();
  for (const f of files) {
    if (f.status !== 'parsed' || !f.timestampConflict) continue;
    const isKnownRidderDateQuirk = !!f.timestampWarning && /accepted filename/i.test(f.timestampWarning) && /date-row-as-dd\/mm\/yyyy/i.test(f.timestampWarning);
    const key = isKnownRidderDateQuirk ? 'ridder_date_format' : (f.timestampWarning ?? 'unresolved-warning-text');
    if (!groups.has(key)) groups.set(key, { key, isKnownRidderDateQuirk, files: [] });
    groups.get(key)!.files.push({ filename: f.filename, resolvedMeasuredAt: f.resolvedMeasuredAt, warning: f.timestampWarning });
  }
  return Array.from(groups.values());
}

function ClimateChart({ points, unit }: { points: { x: string; value: number | null }[]; unit: string }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const valid = points.filter((p) => p.value != null);
  if (valid.length === 0) return <div className="empty-state">No data for this metric in range.</div>;

  const width = 760, height = 260;
  const padding = { top: 16, right: 16, bottom: 28, left: 56 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const values = valid.map((p) => p.value as number);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV || 1;
  const n = points.length;
  const xFor = (i: number) => padding.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yFor = (v: number) => padding.top + plotH - ((v - minV) / range) * plotH;

  const linePoints = points
    .map((p, i) => (p.value == null ? null : { i, x: xFor(i), y: yFor(p.value) }))
    .filter((p): p is { i: number; x: number; y: number } => p != null);
  const pathD = linePoints.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const last = linePoints[linePoints.length - 1];

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
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={padding.left} x2={width - padding.right} y1={padding.top + plotH * f} y2={padding.top + plotH * f} className="climate-chart-grid" />
        ))}
        <text x={4} y={padding.top + 4} className="climate-chart-axis-label">{maxV.toFixed(1)}{unit}</text>
        <text x={4} y={padding.top + plotH} className="climate-chart-axis-label">{minV.toFixed(1)}{unit}</text>
        {linePoints.length > 0 && <path d={pathD} className="climate-chart-line" fill="none" />}
        {last && <circle cx={last.x} cy={last.y} r={4} className="climate-chart-dot" />}
        {hoverIdx != null && points[hoverIdx]?.value != null && (
          <>
            <line x1={xFor(hoverIdx)} x2={xFor(hoverIdx)} y1={padding.top} y2={padding.top + plotH} className="climate-chart-crosshair" />
            <circle cx={xFor(hoverIdx)} cy={yFor(points[hoverIdx].value as number)} r={4} className="climate-chart-hover-dot" />
          </>
        )}
      </svg>
      <div className="climate-chart-tooltip">
        {hoverIdx != null
          ? `${points[hoverIdx].x}: ${points[hoverIdx].value != null ? `${points[hoverIdx].value}${unit}` : 'no data'}`
          : 'Hover the chart to inspect a point'}
      </div>
    </div>
  );
}

function TimestampWarningGroupCard({ group, expanded, onToggle }: { group: TimestampWarningGroup; expanded: boolean; onToggle: () => void }) {
  const count = group.files.length;
  const plural = count === 1 ? 'file' : 'files';

  return (
    <div className={group.isKnownRidderDateQuirk ? 'climate-info-banner' : 'warning-banner'}>
      {group.isKnownRidderDateQuirk ? (
        <>
          <div className="climate-info-banner-title">Date format adjusted for {count} {plural}</div>
          <p>
            Ridder's System Date label says dd/mm/yyyy, but the values in these files are consistent with mm/dd/yyyy.
            Filename timestamps and Ridder week numbers agreed, so the timestamps were resolved automatically.
          </p>
          <p className="climate-info-banner-resolved">Resolved automatically — import can proceed.</p>
        </>
      ) : (
        <div>{count} {plural} needed a timestamp resolution: {group.files[0].warning}</div>
      )}
      <button type="button" className="climate-expand-toggle" onClick={onToggle}>
        {expanded ? 'Hide affected files' : 'View affected files'}
      </button>
      {expanded && (
        <ul className="climate-warning-file-list">
          {group.files.map((f) => (
            <li key={f.filename}>
              {f.filename}{f.resolvedMeasuredAt ? ` — ${new Date(f.resolvedMeasuredAt).toLocaleString()}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const VALID_TABS: ClimatePageTab[] = ['import', 'analysis', 'exposure'];

export function ClimatePage() {
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [tab, setTab] = useState<ClimatePageTab>(
    (VALID_TABS as string[]).includes(tabParam ?? '') ? (tabParam as ClimatePageTab) : 'import'
  );
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [selectedVarietyId, setSelectedVarietyId] = useState('');
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(defaultEndDate);
  const [granularity, setGranularity] = useState<ClimateGranularity>('hourly');
  const [metricKey, setMetricKey] = useState<MetricKey>('air_temperature');
  const [climateView, setClimateView] = useState<'summary' | 'chart'>('summary');
  const [hourlyRows, setHourlyRows] = useState<VarietyClimateHourlyRow[]>([]);
  const [aggRows, setAggRows] = useState<VarietyClimateHourlyAggregatedRow[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ClimateImportPreview | null>(null);
  const [expandedWarningGroups, setExpandedWarningGroups] = useState<Set<string>>(new Set());
  const [confirmResult, setConfirmResult] = useState<ClimateImportConfirmResult | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [expandedDuplicateTimestamps, setExpandedDuplicateTimestamps] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [history, setHistory] = useState<ClimateImportBatch[]>([]);
  const [importSourceTab, setImportSourceTab] = useState<'synopta' | 'manual'>('synopta');
  const [synoptaImports, setSynoptaImports] = useState<SynoptaAgentImport[]>([]);
  const [synoptaError, setSynoptaError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    varietiesApi.list().then((data) => {
      setVarieties(data);
      setSelectedVarietyId((prev) => prev || data.find((v) => v.is_active)?.id || data[0]?.id || '');
    }).catch(() => {});
    refreshHistory();
    refreshSynoptaImports();
  }, []);

  // Keeps "Time since last import" live without a full refetch.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  function refreshHistory() {
    climateImportBatchesApi.history().then(setHistory).catch(() => {});
  }

  function refreshSynoptaImports() {
    synoptaAgentImportsApi.list()
      .then((result) => { setSynoptaImports(result.imports); setSynoptaError(null); })
      .catch((e: Error) => setSynoptaError(e.message));
  }

  const lastSynoptaImport = synoptaImports[0] ?? null;
  const synoptaStale = lastSynoptaImport != null &&
    (now.getTime() - new Date(lastSynoptaImport.created_at).getTime()) > SYNOPTA_STALE_WARNING_HOURS * 60 * 60 * 1000;

  useEffect(() => {
    if (!selectedVarietyId) { setHourlyRows([]); setAggRows([]); return; }
    setDataLoading(true);
    setDataError(null);
    const start = `${startDate}T00:00:00.000Z`;
    const end = `${endDate}T23:59:59.999Z`;
    varietyClimateHourlyApi.get(selectedVarietyId, granularity, start, end)
      .then((result) => {
        if (result.granularity === 'hourly') { setHourlyRows(result.rows as VarietyClimateHourlyRow[]); setAggRows([]); }
        else { setAggRows(result.rows as VarietyClimateHourlyAggregatedRow[]); setHourlyRows([]); }
      })
      .catch((e: Error) => setDataError(e.message))
      .finally(() => setDataLoading(false));
  }, [selectedVarietyId, startDate, endDate, granularity]);

  async function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    setConfirmResult(null);
    setResolutions({});
    setExpandedWarningGroups(new Set());
    setExpandedDuplicateTimestamps(new Set());
    try {
      const result = await climateImportBatchesApi.upload(files);
      setPreview(result);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleConfirm() {
    if (!preview) return;
    setConfirming(true);
    try {
      const result = await climateImportBatchesApi.confirm(preview.batchId, resolutions);
      setConfirmResult(result);
      if (result.status === 'committed') {
        setPreview(null);
        refreshHistory();
      }
    } catch (err) {
      setConfirmResult({ status: 'failed', error: err instanceof Error ? err.message : 'Confirm failed' });
    } finally {
      setConfirming(false);
    }
  }

  async function handleCancelBatch() {
    if (!preview) return;
    try { await climateImportBatchesApi.cancel(preview.batchId); } catch { /* best-effort */ }
    setPreview(null);
    setConfirmResult(null);
    setResolutions({});
  }

  const SUMMARY_COMPATIBLE_KEYS: SummaryMetricKey[] = ['air_temperature', 'relative_humidity', 'co2', 'ec', 'ph', 'radiation_interval'];
  const summaryHeadlineKey: SummaryMetricKey = (SUMMARY_COMPATIBLE_KEYS as string[]).includes(metricKey)
    ? (metricKey as SummaryMetricKey)
    : 'air_temperature';
  const selectedVariety = varieties.find((v) => v.id === selectedVarietyId) ?? null;

  const metric = METRICS.find((m) => m.key === metricKey)!;
  const chartPoints = granularity === 'hourly'
    ? hourlyRows.map((r) => ({ x: new Date(r.measured_at).toLocaleString(), value: (r[metric.hourlyField] as number | null) ?? null }))
    : aggRows.map((r) => ({ x: r.bucket, value: (r[metric.aggField] as number | null) ?? null }));

  return (
    <>
      <div className="page-header">
        <h2>Climate</h2>
        {tab === 'import' && (
          <div>
            <input ref={fileInputRef} type="file" accept=".csv" multiple style={{ display: 'none' }} onChange={handleFilesSelected} />
            <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Import Climate CSVs'}
            </button>
          </div>
        )}
      </div>

      <div className="page-body">
        <div className="page-tabs">
          <button type="button" className={tab === 'import' ? 'page-tab active' : 'page-tab'} onClick={() => setTab('import')}>Import</button>
          <button type="button" className={tab === 'analysis' ? 'page-tab active' : 'page-tab'} onClick={() => setTab('analysis')}>Analysis</button>
          <button type="button" className={tab === 'exposure' ? 'page-tab active' : 'page-tab'} onClick={() => setTab('exposure')}>Crop Exposure</button>
        </div>

        {tab === 'analysis' && <ClimateAnalysisTab varieties={varieties} />}
        {tab === 'exposure' && <ClimateExposureTab varieties={varieties} />}

        {tab === 'import' && (
        <>
        {uploadError && <div className="alert alert-error mb-4">{uploadError}</div>}

        {preview && (
          <div className="card climate-preview-card mb-4">
            <div className="card-title">Import Preview — {preview.files.length} file(s) selected</div>

            <div className="climate-preview-stats">
              <div><span>Files parsed</span><strong>{preview.filesParsed}</strong></div>
              <div><span>Files failed</span><strong>{preview.filesFailed}</strong></div>
              <div><span>Duplicate files</span><strong>{preview.filesDuplicate}</strong></div>
              <div><span>Unique timestamps</span><strong>{preview.uniqueTimestampCount}</strong></div>
              <div><span>Duplicate timestamps</span><strong>{preview.duplicateTimestamps.length}</strong></div>
              <div><span>Missing hours</span><strong>{preview.missingHours}</strong></div>
              <div><span>Historical repair files</span><strong>{preview.filesRepair}</strong></div>
              <div><span>Expected variety-hour rows</span><strong>{preview.expectedVarietyHourRows}</strong></div>
              <div><span>Expected phase-hour rows</span><strong>{preview.expectedPhaseHourRows}</strong></div>
            </div>

            {preview.timestampRange && (
              <p className="climate-preview-range">
                Range: {new Date(preview.timestampRange.start).toLocaleString()} → {new Date(preview.timestampRange.end).toLocaleString()}
              </p>
            )}

            {preview.files.some((f) => f.status === 'error') && (
              <div className="alert alert-error mb-2">
                <strong>{preview.files.filter((f) => f.status === 'error').length} file(s) failed to parse — these need your attention before import:</strong>
                <ul className="climate-warning-file-list">
                  {preview.files.filter((f) => f.status === 'error').map((f) => (
                    <li key={f.filename}>{f.filename}: {f.errorMessage}</li>
                  ))}
                </ul>
              </div>
            )}

            {preview.repairDetails.length > 0 && (
              <div className="climate-info-banner mb-2">
                <div className="climate-info-banner-title">Historical repair import</div>
                <p>This file fills a missing hour caused by the previous timestamp-resolution rule.</p>
                <ul className="climate-warning-file-list">
                  {preview.repairDetails.map((r) => (
                    <li key={r.filename}>
                      {r.filename}: previously stored under {r.previousWrongMeasuredAt ? new Date(r.previousWrongMeasuredAt).toLocaleString() : 'an unknown hour'}
                      {' → '}will now store under {r.correctedMeasuredAt ? new Date(r.correctedMeasuredAt).toLocaleString() : 'the corrected hour'}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {preview.hourWarnings.length > 0 && (
              <div className={preview.hasUnresolvedHourConflicts ? 'alert alert-error mb-2' : 'climate-info-banner'}>
                <div className="climate-info-banner-title">Ridder System Time vs. filename hour: {preview.hourWarnings.length} file(s) flagged</div>
                {preview.hasUnresolvedHourConflicts ? (
                  <p><strong>Resolution required before import.</strong> One or more files disagree by more than 1 hour — confirm each one below before continuing.</p>
                ) : (
                  <p className="climate-info-banner-resolved">Only the known 1-hour staleness quirk — the filename hour was used automatically. Safe to proceed.</p>
                )}
                <ul className="climate-warning-file-list">
                  {preview.hourWarnings.map((w) => (
                    <li key={w.filename}>{w.filename}: {w.warning}</li>
                  ))}
                </ul>
              </div>
            )}

            {preview.duplicateTimestamps.length > 0 && (
              <div className={preview.conflictingDuplicateTimestampCount > 0 ? 'alert alert-error mb-2' : 'climate-info-banner'}>
                <div className="climate-info-banner-title">Duplicate timestamps: {preview.duplicateTimestamps.length}</div>
                <div>Identical duplicate timestamps: {preview.identicalDuplicateTimestampCount}</div>
                <div>Conflicting duplicate timestamps: {preview.conflictingDuplicateTimestampCount}</div>
                {preview.conflictingDuplicateTimestampCount > 0 ? (
                  <p><strong>Resolution required before import.</strong> Files disagree on the value for the same zone/metric/timestamp — pick which one wins when you confirm.</p>
                ) : (
                  <p className="climate-info-banner-resolved">Safe to proceed — duplicate readings will be deduplicated.</p>
                )}
                {preview.duplicateTimestampDetails.map((d) => {
                  const expanded = expandedDuplicateTimestamps.has(d.measuredAt);
                  return (
                    <div key={d.measuredAt} className="climate-duplicate-timestamp-row">
                      <div>
                        {new Date(d.measuredAt).toLocaleString()} — files: {d.files.join(', ')} — {d.identicalReadingCount} identical reading(s), {d.conflictingReadingCount} conflicting reading(s)
                      </div>
                      <button
                        type="button"
                        className="climate-expand-toggle"
                        onClick={() => setExpandedDuplicateTimestamps((prev) => {
                          const next = new Set(prev);
                          if (next.has(d.measuredAt)) next.delete(d.measuredAt); else next.add(d.measuredAt);
                          return next;
                        })}
                      >
                        {expanded ? 'Hide details' : 'Show details'}
                      </button>
                      {expanded && d.conflictingMetricsZones.length > 0 && (
                        <ul className="climate-warning-file-list">
                          {d.conflictingMetricsZones.map((cz) => (
                            <li key={`${cz.zoneLabel}|${cz.metricName}`}>
                              {cz.zoneLabel} / {cz.metricName}: {cz.candidates.map((c) => `${c.filename}=${c.value}`).join(' vs ')}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {groupTimestampWarnings(preview.files).map((group) => (
              <TimestampWarningGroupCard
                key={group.key}
                group={group}
                expanded={expandedWarningGroups.has(group.key)}
                onToggle={() => setExpandedWarningGroups((prev) => {
                  const next = new Set(prev);
                  if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
                  return next;
                })}
              />
            ))}

            {preview.unmatchedZones.length > 0 && (() => {
              const configuredZoneLabels = Array.from(new Set(preview.varietyMappings.flatMap((v) => v.zoneLabels)));
              const blockingZones = preview.unmatchedZones.filter((z) => configuredZoneLabels.includes(z));
              return (
                <div className={blockingZones.length > 0 ? 'alert alert-error mb-2' : 'warning-banner'}>
                  <div>
                    {zoneRangeLabel(preview.unmatchedZones)} {preview.unmatchedZones.length > 1 ? 'are' : 'is'} present in the CSV but{' '}
                    {preview.unmatchedZones.length > 1 ? "aren't" : "isn't"} configured in GrowLink. Data from{' '}
                    {preview.unmatchedZones.length > 1 ? 'these zones' : 'this zone'} will not be used for variety averages until{' '}
                    {preview.unmatchedZones.length > 1 ? 'they are' : 'it is'} configured and assigned.
                  </div>
                  {blockingZones.length > 0 ? (
                    <div className="mt-2">
                      <strong>Needs attention:</strong> {zoneRangeLabel(blockingZones)} {blockingZones.length > 1 ? 'are' : 'is'} required
                      by a configured variety — that variety's average will be incomplete until {blockingZones.length > 1 ? 'these zones are' : 'this zone is'} configured.
                    </div>
                  ) : (
                    <div className="mt-2">Safe to proceed: configured varieties use {zoneRangeLabel(configuredZoneLabels)} only.</div>
                  )}
                </div>
              );
            })()}
            {preview.zonesWithoutVariety.length > 0 && (
              <div className="warning-banner">Zones with no variety link (won't contribute to any variety average): {preview.zonesWithoutVariety.join(', ')}</div>
            )}

            <div className="climate-preview-section-title">Variety mappings (edit in Setup → Zones if needed)</div>
            <table className="climate-preview-table">
              <thead><tr><th>Variety</th><th>Assigned zones</th></tr></thead>
              <tbody>
                {preview.varietyMappings.map((v) => (
                  <tr key={v.varietyName}><td>{v.varietyName}</td><td>{v.zoneLabels.join(', ')}</td></tr>
                ))}
              </tbody>
            </table>

            <div className="climate-preview-section-title">Files</div>
            <div className="climate-preview-files-scroll">
              <table className="climate-preview-table">
                <thead><tr><th>Filename</th><th>Status</th><th>Resolved timestamp</th><th>Week</th><th>Note</th></tr></thead>
                <tbody>
                  {preview.files.map((f) => (
                    <tr key={f.filename}>
                      <td>{f.filename}</td>
                      <td>{f.status}</td>
                      <td>{f.resolvedMeasuredAt ? new Date(f.resolvedMeasuredAt).toLocaleString() : '—'}</td>
                      <td>{f.weekNumber ?? '—'}</td>
                      <td>{f.errorMessage ?? [f.timestampConflict ? f.timestampWarning : null, f.hourWarning].filter(Boolean).join(' | ') ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {confirmResult?.status === 'conflicts' && confirmResult.conflicts && (
              <div className="climate-conflicts">
                <div className="climate-preview-section-title">Conflicts — explicit decision required</div>
                {confirmResult.conflicts.map((c) => (
                  <div className="climate-conflict-row" key={c.conflictId}>
                    <div>{c.description}</div>
                    {c.kind === 'hour_discrepancy' ? (
                      <label>
                        <input
                          type="checkbox"
                          checked={resolutions[c.conflictId] === 'confirm_filename_hour'}
                          onChange={(e) => setResolutions((r) => ({ ...r, [c.conflictId]: e.target.checked ? 'confirm_filename_hour' : '' }))}
                        />{' '}
                        Confirm: use the filename hour for this file anyway
                      </label>
                    ) : c.kind === 'batch_duplicate' && c.candidates ? (
                      <>
                        <div className="climate-conflict-values">Files disagree — pick which value wins:</div>
                        {c.candidates.map((cand) => (
                          <label key={cand.stagedFileId}>
                            <input
                              type="radio"
                              name={c.conflictId}
                              checked={resolutions[c.conflictId] === cand.stagedFileId}
                              onChange={() => setResolutions((r) => ({ ...r, [c.conflictId]: cand.stagedFileId }))}
                            />{' '}
                            Use {cand.filename} ({cand.value})
                          </label>
                        ))}
                      </>
                    ) : (
                      <>
                        <div className="climate-conflict-values">existing: {JSON.stringify(c.existingValue)} → new: {JSON.stringify(c.newValue)}</div>
                        <label><input type="radio" name={c.conflictId} checked={resolutions[c.conflictId] === 'skip'} onChange={() => setResolutions((r) => ({ ...r, [c.conflictId]: 'skip' }))} /> Skip (keep existing)</label>
                        <label><input type="radio" name={c.conflictId} checked={resolutions[c.conflictId] === 'overwrite'} onChange={() => setResolutions((r) => ({ ...r, [c.conflictId]: 'overwrite' }))} /> Overwrite with new value</label>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            {confirmResult?.status === 'failed' && <div className="alert alert-error mt-2">{confirmResult.error}</div>}

            <div className="climate-preview-actions">
              <button className="btn btn-secondary" onClick={handleCancelBatch}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={handleConfirm}
                disabled={confirming || (
                  confirmResult?.status === 'conflicts' &&
                  !!confirmResult.conflicts?.some((c) => !resolutions[c.conflictId])
                )}
                title={
                  confirmResult?.status === 'conflicts' && confirmResult.conflicts?.some((c) => !resolutions[c.conflictId])
                    ? 'Resolve all conflicts above before continuing'
                    : undefined
                }
              >
                {confirming ? 'Confirming…' : confirmResult?.status === 'conflicts' ? 'Apply Resolutions & Retry' : 'Confirm Import'}
              </button>
            </div>
          </div>
        )}

        <h3 className="climate-page-section-heading climate-page-section-heading-primary">Climate Summary</h3>

        <div className="selector-bar">
          <label>Variety</label>
          <select className="form-control" style={{ width: 180 }} value={selectedVarietyId} onChange={(e) => setSelectedVarietyId(e.target.value)}>
            <option value="">- select -</option>
            {varieties.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <label>From</label>
          <input className="form-control" style={{ width: 150 }} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <label>To</label>
          <input className="form-control" style={{ width: 150 }} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          <label>View</label>
          <select className="form-control" style={{ width: 120 }} value={granularity} onChange={(e) => setGranularity(e.target.value as ClimateGranularity)}>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
          <label>Metric</label>
          <select className="form-control" style={{ width: 200 }} value={metricKey} onChange={(e) => setMetricKey(e.target.value as MetricKey)}>
            {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>

        {selectedVarietyId && (
          <div className="climate-view-toggle mb-4">
            <button type="button" className={climateView === 'summary' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setClimateView('summary')}>
              Past 24 Hours Summary
            </button>
            <button type="button" className={climateView === 'chart' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => setClimateView('chart')}>
              View full chart
            </button>
          </div>
        )}

        {!selectedVarietyId ? (
          <div className="empty-state">Select a variety to view climate data.</div>
        ) : climateView === 'summary' ? (
          <ClimateDailySummary variety={selectedVariety} headlineMetricKey={summaryHeadlineKey} onViewFullChart={() => setClimateView('chart')} />
        ) : dataLoading ? (
          <div className="loading">Loading...</div>
        ) : dataError ? (
          <div className="error-state">Failed to load climate data: {dataError}</div>
        ) : (hourlyRows.length === 0 && aggRows.length === 0) ? (
          <div className="empty-state">No climate data in this date range. Import CSVs or link this variety to zones in Setup.</div>
        ) : (
          <>
            <div className="card mb-4">
              <div className="card-title">{metric.label} ({granularity})</div>
              <ClimateChart points={chartPoints} unit={metric.unit} />
            </div>

            <div className="card">
              <div className="card-title">Data Table</div>
              <div className="table-wrap">
                {granularity === 'hourly' ? (
                  <table>
                    <thead>
                      <tr>
                        <th>Measured At</th><th>Air Temp</th><th>RH</th><th>CO2</th><th>EC</th><th>pH</th>
                        <th>Irrigation Δ</th><th>Irrigation cum.</th><th>Radiation Δ</th><th>Radiation cum.</th><th>Warnings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hourlyRows.map((r) => (
                        <tr key={r.id}>
                          <td>{new Date(r.measured_at).toLocaleString()}</td>
                          <td>{fmt(r.air_temperature_avg_c)} <span className="climate-zone-count">({r.air_temperature_zone_count}/{r.expected_zone_count})</span></td>
                          <td>{fmt(r.relative_humidity_avg_pct)} <span className="climate-zone-count">({r.relative_humidity_zone_count}/{r.expected_zone_count})</span></td>
                          <td>{fmt(r.co2_avg_ppm, 0)}</td>
                          <td>{fmt(r.ec_avg, 2)}</td>
                          <td>{fmt(r.ph_avg, 2)}</td>
                          <td>{fmt(r.irrigation_interval_delta_ml, 0)}{r.irrigation_quality_flag && r.irrigation_quality_flag !== 'ok' ? ` (${r.irrigation_quality_flag})` : ''}</td>
                          <td>{fmt(r.irrigation_cumulative_avg_ml, 0)}</td>
                          <td>{fmt(r.radiation_interval_delta_j_cm2, 1)}</td>
                          <td>{fmt(r.radiation_cumulative_j_cm2, 1)}</td>
                          <td className="climate-warnings-cell">{r.quality_warnings.join('; ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table>
                    <thead>
                      <tr><th>{granularity === 'daily' ? 'Date' : 'Week'}</th><th>Hours</th><th>Air Temp</th><th>RH</th><th>CO2</th><th>EC</th><th>pH</th><th>Irrigation total</th><th>Radiation total</th></tr>
                    </thead>
                    <tbody>
                      {aggRows.map((r) => (
                        <tr key={r.bucket}>
                          <td>{r.bucket}</td>
                          <td>{r.hourCount}</td>
                          <td>{fmt(r.airTemperatureAvgC)}</td>
                          <td>{fmt(r.relativeHumidityAvgPct)}</td>
                          <td>{fmt(r.co2AvgPpm, 0)}</td>
                          <td>{fmt(r.ecAvg, 2)}</td>
                          <td>{fmt(r.phAvg, 2)}</td>
                          <td>{fmt(r.irrigationIntervalTotalMl, 0)}</td>
                          <td>{fmt(r.radiationIntervalTotalJCm2, 1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </>
        )}

        <h3 className="climate-page-section-heading climate-page-section-heading-secondary">Synopta Import History</h3>

        <div className="card mb-4">
          <div className="card-title-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className={`btn ${importSourceTab === 'synopta' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setImportSourceTab('synopta')}
            >
              Synopta Agent Imports
            </button>
            <button
              className={`btn ${importSourceTab === 'manual' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setImportSourceTab('manual')}
            >
              Manual CSV Imports
            </button>
          </div>

          {importSourceTab === 'synopta' ? (
            <>
              {lastSynoptaImport && (
                <div className={`card mt-3 mb-3 ${synoptaStale ? 'alert-error' : ''}`}>
                  <div className="card-title">Last Synopta Import</div>
                  <div>Last measurement received: {lastSynoptaImport.latest_measured_at ? new Date(lastSynoptaImport.latest_measured_at).toLocaleString() : '—'}</div>
                  <div>Number of zones: {lastSynoptaImport.zones.length}</div>
                  <div>Number of readings: {lastSynoptaImport.readings_stored}</div>
                  <div>Time since last import: {timeSince(lastSynoptaImport.created_at, now)}</div>
                  {synoptaStale && (
                    <div className="alert alert-error mt-2">
                      No Synopta climate data received in the last {SYNOPTA_STALE_WARNING_HOURS} hours
                    </div>
                  )}
                </div>
              )}

              {synoptaError ? (
                <div className="alert alert-error mt-2">{synoptaError}</div>
              ) : synoptaImports.length === 0 ? (
                <div className="empty-state">No Synopta agent imports yet.</div>
              ) : (
                <table>
                  <thead><tr><th>Received</th><th>Measurement Time</th><th>Filename</th><th>Zones</th><th>Readings</th><th>Status</th></tr></thead>
                  <tbody>
                    {synoptaImports.map((imp) => (
                      <tr key={imp.import_id}>
                        <td>{new Date(imp.created_at).toLocaleString()}</td>
                        <td>{imp.earliest_measured_at ? new Date(imp.earliest_measured_at).toLocaleString() : '—'}</td>
                        <td>{imp.filename}</td>
                        <td>{zoneRangeLabel(imp.zones)}</td>
                        <td>{imp.readings_stored}</td>
                        <td>Imported</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : (
            <>
              {history.length === 0 ? (
                <div className="empty-state">No imports yet.</div>
              ) : (
                <table>
                  <thead><tr><th>Created</th><th>Status</th><th>Files</th><th>Committed</th><th>Error</th></tr></thead>
                  <tbody>
                    {history.map((b) => (
                      <tr key={b.id}>
                        <td>{new Date(b.created_at).toLocaleString()}</td>
                        <td>{b.status}</td>
                        <td>{b.file_count}</td>
                        <td>{b.committed_at ? new Date(b.committed_at).toLocaleString() : '—'}</td>
                        <td>{b.error_message ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
        </>
        )}
      </div>
    </>
  );
}
