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

function NodeStatusGrid({ records, harvestedLabel = false }: { records: MeasurementSummaryRecord[]; harvestedLabel?: boolean }) {
  const stems = useMemo(() => {
    const map = new Map<string, { stemId: string; stemName: string; num: number }>();
    for (const r of records) {
      if (!map.has(r.stemId)) {
        const num = parseInt(r.stemName.replace(/\D+/g, ''), 10) || 0;
        map.set(r.stemId, { stemId: r.stemId, stemName: r.stemName, num });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.num - b.num);
  }, [records]);

  const nodeNumbers = useMemo(() => {
    const nums = new Set(records.map(r => r.nodeNumber));
    return Array.from(nums).sort((a, b) => b - a);
  }, [records]);

  const lookup = useMemo(() => {
    const map = new Map<string, Map<number, MeasurementSummaryRecord>>();
    for (const r of records) {
      if (!map.has(r.stemId)) map.set(r.stemId, new Map());
      map.get(r.stemId)!.set(r.nodeNumber, r);
    }
    return map;
  }, [records]);

  return (
    <div className="node-grid-wrap">
      <table className="node-grid">
        <thead>
          <tr>
            <th className="node-grid__node-col">Node</th>
            {stems.map(s => (
              <th key={s.stemId} className="node-grid__stem-col">{s.stemName}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nodeNumbers.map(nodeNum => (
            <tr key={nodeNum}>
              <td className="node-grid__node-col">{nodeNum}</td>
              {stems.map(s => {
                const record = lookup.get(s.stemId)?.get(nodeNum);
                // Recently-harvested section: render as Harvested (last week's confirmed status)
                if (harvestedLabel && record?.recentlyHarvested) {
                  return (
                    <td key={s.stemId} className="node-grid__cell status-harvested">
                      {statusLabel('Harvested')}
                    </td>
                  );
                }
                if (!record || record.status === 'Not Recorded') {
                  return <td key={s.stemId} className="node-grid__cell node-grid__cell--empty">—</td>;
                }
                return (
                  <td key={s.stemId} className={`node-grid__cell ${statusClass(record.status)}`}>
                    {statusLabel(record.status)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
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
  const [expandedHarvested, setExpandedHarvested] = useState<Record<string, boolean>>({});

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
        const gridCounts: Record<string, number> = {};
        for (const r of data.records) {
          if (r.status !== 'Not Recorded' && !r.recentlyHarvested) {
            gridCounts[r.status] = (gridCounts[r.status] ?? 0) + 1;
          }
        }
        console.log('[MeasurementsPage] year=%d week=%d visible grid counts:', selectedYear, selectedWeek, gridCounts);
        console.log('[MeasurementsPage] summary card perM2ByStatus:', data.summary.perM2ByStatus);
        console.log('[MeasurementsPage] divisor measuredStemCount=%d totalStemCount=%d areaM2=%d',
          data.summary.measuredStemCount, data.summary.varietyTotalStemCount, data.summary.varietyAreaM2);
        setSummaryData(data);
      })
      .catch((e: Error) => setSummaryError(e.message))
      .finally(() => setLoadingSummary(false));
  }, [selectedYear, selectedVariety, selectedWeek]);

  const allRecords = summaryData.records;

  // A row group holds the records for one measurement row, split by whether they are
  // active this week or were harvested last week (shown in a collapsed sub-section).
  const rowGroups = useMemo(() => {
    const groups = new Map<string, {
      rowId: string;
      rowName: string;
      mainRecords: MeasurementSummaryRecord[];      // active + plain-dash nodes
      harvestedRecords: MeasurementSummaryRecord[]; // harvested last week, empty this week
    }>();

    for (const record of allRecords) {
      if (!groups.has(record.rowId)) {
        groups.set(record.rowId, {
          rowId: record.rowId,
          rowName: record.rowName,
          mainRecords: [],
          harvestedRecords: [],
        });
      }
      const group = groups.get(record.rowId)!;
      if (record.recentlyHarvested) {
        group.harvestedRecords.push(record);
      } else {
        group.mainRecords.push(record);
      }
    }

    return Array.from(groups.values()).map(group => ({
      ...group,
      stemCount: new Set(
        group.mainRecords.filter(r => r.status !== 'Not Recorded').map(r => r.stemId)
      ).size,
      recordedCount: group.mainRecords.filter(r => r.status !== 'Not Recorded').length,
    }));
  }, [allRecords]);

  // Any records at all (active or recently harvested) → show the grid, not the empty state
  const hasContent = allRecords.some(r => r.status !== 'Not Recorded' || r.recentlyHarvested);

  useEffect(() => {
    setCollapsedRows(Object.fromEntries(rowGroups.map(g => [g.rowId, false])));
    setExpandedHarvested({});
  }, [rowGroups]);

  function toggleRow(rowId: string) {
    setCollapsedRows(prev => ({ ...prev, [rowId]: !prev[rowId] }));
  }

  function toggleHarvested(rowId: string) {
    setExpandedHarvested(prev => ({ ...prev, [rowId]: !prev[rowId] }));
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
                <div className="empty-state">No row/stem/node structure found for this variety.</div>
              ) : (
                <div className="table-wrap">
                  <table>
                    {rowGroups.map(group => {
                      const isCollapsed = collapsedRows[group.rowId] ?? false;
                      const harvestedExpanded = expandedHarvested[group.rowId] ?? false;
                      const rowLabel = /^row\s/i.test(group.rowName) ? group.rowName : `Row ${group.rowName}`;
                      const harvestedCount = group.harvestedRecords.length;

                      return (
                        <tbody key={group.rowId}>
                          <tr className="report-group__header-row">
                            <td colSpan={4}>
                              <button
                                type="button"
                                className="report-group__toggle"
                                aria-expanded={!isCollapsed}
                                onClick={() => toggleRow(group.rowId)}
                              >
                                <span className="report-group__indicator" aria-hidden="true">{isCollapsed ? '+' : '-'}</span>
                                <span className="report-group__summary">
                                  {rowLabel} — {group.stemCount} stems / {group.recordedCount} recorded
                                  {harvestedCount > 0 && ` / ${harvestedCount} recently harvested`}
                                </span>
                              </button>
                            </td>
                          </tr>
                          {!isCollapsed && (
                            <>
                              <tr>
                                <td colSpan={4} style={{ padding: 0 }}>
                                  <NodeStatusGrid records={group.mainRecords} />
                                </td>
                              </tr>
                              {harvestedCount > 0 && (
                                <tr>
                                  <td colSpan={4} style={{ padding: 0 }}>
                                    <div className="report-group__sub">
                                      <button
                                        type="button"
                                        className="report-group__toggle report-group__toggle--sub"
                                        aria-expanded={harvestedExpanded}
                                        onClick={() => toggleHarvested(group.rowId)}
                                      >
                                        <span className="report-group__indicator" aria-hidden="true">{harvestedExpanded ? '−' : '+'}</span>
                                        <span className="report-group__summary">Harvested last week — {harvestedCount} node{harvestedCount !== 1 ? 's' : ''}</span>
                                      </button>
                                      {harvestedExpanded && (
                                        <NodeStatusGrid records={group.harvestedRecords} harvestedLabel />
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </>
                          )}
                        </tbody>
                      );
                    })}
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
