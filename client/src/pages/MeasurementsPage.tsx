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

function NodeStatusGrid({ records }: { records: MeasurementSummaryRecord[] }) {
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
      setVarieties(data);
      setSelectedVariety(prev => (prev && data.some(v => v.id === prev) ? prev : data[0]?.id ?? ''));
    });
  }, [selectedYear]);

  useEffect(() => {
    if (!selectedYear || !selectedVariety || !selectedWeek) {
      setSummaryData(EMPTY_SUMMARY);
      return;
    }

    setLoadingSummary(true);
    measurementSummaryApi.get(selectedYear, selectedVariety, selectedWeek)
      .then(data => setSummaryData(data))
      .finally(() => setLoadingSummary(false));
  }, [selectedYear, selectedVariety, selectedWeek]);

  const rows = summaryData.records;
  const visibleRows = useMemo(
    () => rows,
    [rows]
  );
  const rowGroups = useMemo(() => {
    const groups = new Map<string, {
      rowId: string;
      rowName: string;
      records: typeof visibleRows;
      stemCount: number;
      recordedCount: number;
    }>();

    for (const record of visibleRows) {
      const existing = groups.get(record.rowId);
      if (existing) {
        existing.records.push(record);
        continue;
      }

      groups.set(record.rowId, {
        rowId: record.rowId,
        rowName: record.rowName,
        records: [record],
        stemCount: 0,
        recordedCount: 0,
      });
    }

    return Array.from(groups.values()).map(group => ({
      ...group,
      stemCount: new Set(group.records.map(record => record.stemId)).size,
      recordedCount: group.records.filter(record => record.status !== 'Not Recorded').length,
    }));
  }, [visibleRows]);

  useEffect(() => {
    setCollapsedRows(Object.fromEntries(rowGroups.map(group => [group.rowId, false])));
  }, [rowGroups]);

  function toggleRow(rowId: string) {
    setCollapsedRows(prev => ({
      ...prev,
      [rowId]: !prev[rowId],
    }));
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
              ) : visibleRows.length === 0 ? (
                <div className="empty-state">No row/stem/node structure found for this variety.</div>
              ) : (
                <div className="table-wrap">
                  <table>
                    {rowGroups.map(group => {
                      const isCollapsed = collapsedRows[group.rowId] ?? false;
                      const rowLabel = /^row\s/i.test(group.rowName) ? group.rowName : `Row ${group.rowName}`;

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
                                <span className="report-group__summary">{rowLabel} - {group.stemCount} stems / {group.recordedCount} recorded</span>
                              </button>
                            </td>
                          </tr>
                          {!isCollapsed && (
                            <tr>
                              <td colSpan={4} style={{ padding: 0 }}>
                                <NodeStatusGrid records={group.records} />
                              </td>
                            </tr>
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
