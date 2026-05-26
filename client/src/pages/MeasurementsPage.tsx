import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MeasurementSummaryResponse, Season, Variety } from '../types';
import { measurementSummaryApi, varietiesApi, yearsApi } from '../services/api';
import { defaultYear, uniqueYears, yearNumbers } from '../utils/years';

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
  },
  records: [],
};

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

export function MeasurementsPage() {
  const [years, setYears] = useState<Season[]>([]);
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [selectedYear, setSelectedYear] = useState(0);
  const [selectedVariety, setSelectedVariety] = useState('');
  const [selectedWeek, setSelectedWeek] = useState(1);
  const [summaryData, setSummaryData] = useState<MeasurementSummaryResponse>(EMPTY_SUMMARY);
  const [loadingSummary, setLoadingSummary] = useState(false);

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
          {Array.from({ length: 52 }, (_, i) => i + 1).map(w => (
            <option key={w} value={w}>Wk {w}</option>
          ))}
        </select>
      </div>

      <div className="page-body">
        {!selectedVariety ? (
          <div className="empty-state">Select a year, variety, and week to view the measurements report.</div>
        ) : (
          <>
            <div className="grid-4 mb-4">
              <div className="stat-card">
                <div className="stat-label">Total Measured Rows</div>
                <div className="stat-value">{summaryData.summary.totalMeasuredRows}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Total Measured Stems</div>
                <div className="stat-value">{summaryData.summary.totalMeasuredStems}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Total Nodes Recorded</div>
                <div className="stat-value">{summaryData.summary.totalNodesRecorded}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Set Fruit</div>
                <div className="stat-value">{summaryData.summary.statusCounts.SetFruit}</div>
              </div>
            </div>

            <div className="grid-4 mb-4">
              <div className="stat-card">
                <div className="stat-label">Breaker Fruit</div>
                <div className="stat-value">{summaryData.summary.statusCounts.BreakerFruit}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Harvested</div>
                <div className="stat-value">{summaryData.summary.statusCounts.Harvested}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Legacy: Missing</div>
                <div className="stat-value">{summaryData.summary.statusCounts.Missing ?? 0}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Aborted</div>
                <div className="stat-value">{summaryData.summary.statusCounts.Aborted}</div>
              </div>
            </div>

            <div className="grid-4 mb-4">
              <div className="stat-card">
                <div className="stat-label">Pruned</div>
                <div className="stat-value">{summaryData.summary.statusCounts.Pruned}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Legacy: Empty</div>
                <div className="stat-value">{summaryData.summary.statusCounts.Empty ?? 0}</div>
              </div>
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
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Stem</th>
                        <th>Node</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((record, index) => {
                        const prev = index > 0 ? visibleRows[index - 1] : null;
                        const showRow = !prev || prev.rowId !== record.rowId;
                        const showStem = !prev || prev.stemId !== record.stemId;
                        return (
                          <tr key={record.nodeId} className={!record.isActive ? 'inactive' : ''}>
                            <td>{showRow ? record.rowName : ''}</td>
                            <td>{showStem ? record.stemName : ''}</td>
                            <td>Node {record.nodeNumber}</td>
                            <td className={record.status === 'Not Recorded' ? '' : statusClass(record.status)}>{statusLabel(record.status)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
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
