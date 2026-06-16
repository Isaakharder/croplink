import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MeasurementSummaryRecord, MeasurementSummaryResponse, Season, Variety } from '../types';
import { measurementSummaryApi, varietiesApi, yearsApi } from '../services/api';
import { defaultYear, getIsoWeek, isoWeeksInYear, uniqueYears, yearNumbers } from '../utils/years';

const EMPTY_SUMMARY: MeasurementSummaryResponse = {
  summary: {
    totalMeasuredRows: 0,
    totalMeasuredStems: 0,
    totalNodesRecorded: 0,
    statusCounts: {
      Aborted: 0,
      Pruned: 0,
      Flower: 0,
      SetFruit: 0,
      MatureGreen: 0,
      BreakerFruit: 0,
      Harvested: 0,
    },
    measuredStemCount: 0,
    varietyAreaM2: 0,
    varietyTotalStemCount: 0,
    perM2ByStatus: {
      Aborted: 0,
      Pruned: 0,
      Flower: 0,
      SetFruit: 0,
      MatureGreen: 0,
      BreakerFruit: 0,
      Harvested: 0,
    },
  },
  records: [],
};

const PER_M2_CARDS: { key: keyof MeasurementSummaryResponse['summary']['perM2ByStatus']; label: string }[] = [
  { key: 'Flower',       label: 'Flower / m²' },
  { key: 'SetFruit',     label: 'Set Fruit / m²' },
  { key: 'MatureGreen',  label: 'Mature Green / m²' },
  { key: 'BreakerFruit', label: 'Breaker Fruit / m²' },
  { key: 'Harvested',    label: 'Harvested / m²' },
  { key: 'Pruned',       label: 'Pruned / m²' },
  { key: 'Aborted',      label: 'Aborted / m²' },
];

function statusClass(status: string): string {
  if (status === 'GolfBall' || status === 'Harvestable' || status === 'Missing' || status === 'Empty') return 'status-legacy';
  const normalized = status.replace(/\s+/g, '').toLowerCase();
  return `status-${normalized}`;
}

function statusLabel(status: string): string {
  if (status === 'GolfBall') return 'Legacy: Golf Ball';
  if (status === 'Harvestable') return 'Legacy: Harvestable';
  if (status === 'Missing') return 'Legacy: Missing';
  if (status === 'Empty') return 'Legacy: Empty';
  return status;
}

function CompactStemStatusList({ records }: { records: MeasurementSummaryRecord[] }) {
  const stems = useMemo(() => {
    const stemMap = new Map<string, { stemId: string; stemName: string; nodes: MeasurementSummaryRecord[] }>();

    for (const record of records) {
      if (!stemMap.has(record.stemId)) {
        stemMap.set(record.stemId, { stemId: record.stemId, stemName: record.stemName, nodes: [] });
      }
      stemMap.get(record.stemId)!.nodes.push(record);
    }

    return Array.from(stemMap.values())
      .map(stem => ({
        ...stem,
        nodes: stem.nodes.sort((a, b) => a.nodeNumber - b.nodeNumber),
      }))
      .sort((a, b) => {
        const aStemNum = parseInt(a.stemName.replace(/\D+/g, ''), 10) || 0;
        const bStemNum = parseInt(b.stemName.replace(/\D+/g, ''), 10) || 0;
        if (aStemNum !== bStemNum) return aStemNum - bStemNum;
        return a.stemName.localeCompare(b.stemName);
      });
  }, [records]);

  return (
    <div className="compact-stem-list">
      {stems.map(stem => (
        <div key={stem.stemId} className="compact-stem-line">
          <div className="compact-stem-line__name">{stem.stemName}</div>
          <div className="compact-stem-line__nodes">
            {stem.nodes.map(node => (
              <span key={node.nodeId} className={`compact-node-pill ${statusClass(node.status)}`}>
                <span className="compact-node-pill__node">N{node.nodeNumber}</span>
                <span>{statusLabel(node.status)}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function MeasurementsPage() {
  const [years, setYears] = useState<Season[]>([]);
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [selectedYear, setSelectedYear] = useState(0);
  const [selectedVariety, setSelectedVariety] = useState('');
  const [selectedWeek, setSelectedWeek] = useState(() => getIsoWeek(new Date()));
  const [summaryData, setSummaryData] = useState<MeasurementSummaryResponse>(EMPTY_SUMMARY);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [collapsedRows, setCollapsedRows] = useState<Record<string, boolean>>({});

  useEffect(() => {
    yearsApi.list().then(data => {
      setYears(prev => uniqueYears([...data, ...prev]));
      setSelectedYear(prev => prev || defaultYear(data));
    });
  }, []);

  useEffect(() => {
    if (!selectedYear) return;
    yearsApi.getOrCreate(selectedYear).then(season => {
      setYears(prev => uniqueYears([season, ...prev]));
    });
    varietiesApi.list(undefined, selectedYear).then(data => {
      const active = data.filter(v => v.is_active);
      setVarieties(active);
      setSelectedVariety(prev => (prev && active.some(v => v.id === prev) ? prev : active[0]?.id ?? ''));
    });
  }, [selectedYear]);

  useEffect(() => {
    if (!selectedYear || !selectedVariety || !selectedWeek) {
      setSummaryData(EMPTY_SUMMARY);
      setSummaryError(null);
      return;
    }

    setSummaryError(null);
    setLoadingSummary(true);
    measurementSummaryApi.get(selectedYear, selectedVariety, selectedWeek)
      .then(data => {
        const weekOnlyRecords = data.records.filter(r => r.status !== 'Not Recorded' && !r.recentlyHarvested);
        const gridCounts: Record<string, number> = {};
        for (const r of weekOnlyRecords) {
          gridCounts[r.status] = (gridCounts[r.status] ?? 0) + 1;
        }
        console.log('[MeasurementsPage] year=%d week=%d visible grid counts:', selectedYear, selectedWeek, gridCounts);
        console.log('[MeasurementsPage] summary card perM2ByStatus:', data.summary.perM2ByStatus);
        console.log('[MeasurementsPage] divisor measuredStemCount=%d totalStemCount=%d areaM2=%d',
          data.summary.measuredStemCount, data.summary.varietyTotalStemCount, data.summary.varietyAreaM2);
        setSummaryData({ ...data, records: weekOnlyRecords });
      })
      .catch((e: Error) => setSummaryError(e.message))
      .finally(() => setLoadingSummary(false));
  }, [selectedYear, selectedVariety, selectedWeek]);

  const allRecords = summaryData.records;

  const rowGroups = useMemo(() => {
    const groups = new Map<string, {
      rowId: string;
      rowName: string;
      records: MeasurementSummaryRecord[];
    }>();

    for (const record of allRecords) {
      if (!groups.has(record.rowId)) {
        groups.set(record.rowId, {
          rowId: record.rowId,
          rowName: record.rowName,
          records: [],
        });
      }
      groups.get(record.rowId)!.records.push(record);
    }

    return Array.from(groups.values()).map(group => ({
      ...group,
      stemCount: new Set(
        group.records.map(r => r.stemId)
      ).size,
      recordedCount: group.records.length,
    }));
  }, [allRecords]);

  const hasContent = allRecords.length > 0;

  useEffect(() => {
    setCollapsedRows(Object.fromEntries(rowGroups.map(g => [g.rowId, false])));
  }, [rowGroups]);

  function toggleRow(rowId: string) {
    setCollapsedRows(prev => ({ ...prev, [rowId]: !prev[rowId] }));
  }

  return (
    <>
      <div className="page-header">
        <h2>Measurements</h2>
        <Link className="btn btn-primary" to="/mobile">Open Mobile Entry</Link>
      </div>

      <div className="selector-bar">
        <label>Year</label>
        <select className="form-control" style={{ width: 170 }} value={selectedYear} onChange={e => setSelectedYear(Number(e.target.value))}>
          {yearNumbers(years).map(year => <option key={year} value={year}>{year}</option>)}
        </select>
        <label>Variety</label>
        <select className="form-control" style={{ width: 180 }} value={selectedVariety} onChange={e => setSelectedVariety(e.target.value)}>
          <option value="">- select -</option>
          {varieties.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <label>Week</label>
        <select className="form-control" style={{ width: 90 }} value={selectedWeek} onChange={e => setSelectedWeek(Number(e.target.value))}>
          {Array.from({ length: isoWeeksInYear(selectedYear || new Date().getFullYear()) }, (_, i) => i + 1).map(w => (
            <option key={w} value={w}>Wk {w}</option>
          ))}
        </select>
      </div>

      <div className="page-body">
        {!selectedVariety ? (
          <div className="empty-state">Select a year, variety, and week to view the measurements report.</div>
        ) : (
          <>
            <div className="grid-7 mb-4">
              {PER_M2_CARDS.map(({ key, label }) => (
                <div key={key} className="stat-card">
                  <div className="stat-label">{label}</div>
                  <div className="stat-value">{summaryData.summary.perM2ByStatus[key].toFixed(2)}</div>
                </div>
              ))}
            </div>

            <div className="card">
              <div className="card-title">Week {selectedWeek} Node Status Report</div>
              {loadingSummary ? (
                <div className="loading">Loading...</div>
              ) : summaryError ? (
                <div className="error-state">Failed to load measurement data: {summaryError}</div>
              ) : !hasContent ? (
                <div className="empty-state">No node statuses were recorded for this week.</div>
              ) : (
                <div className="report-groups">
                  {rowGroups.map(group => {
                    const isCollapsed = collapsedRows[group.rowId] ?? false;
                    const rowLabel = /^row\s/i.test(group.rowName) ? group.rowName : `Row ${group.rowName}`;

                    return (
                      <section key={group.rowId} className="report-group-card">
                        <button
                          type="button"
                          className="report-group__toggle"
                          aria-expanded={!isCollapsed}
                          onClick={() => toggleRow(group.rowId)}
                        >
                          <span className="report-group__indicator" aria-hidden="true">{isCollapsed ? '+' : '-'}</span>
                          <span className="report-group__summary">
                            {rowLabel} — {group.stemCount} stems / {group.recordedCount} recorded
                          </span>
                        </button>
                        {!isCollapsed && (
                          <CompactStemStatusList records={group.records} />
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
