import { useEffect, useState } from 'react';
import { Block, BlockClimateSummary } from '../types';
import { blocksApi, blockClimateSummaryApi } from '../services/api';

function defaultStartDate() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

function defaultEndDate() {
  return new Date().toISOString().slice(0, 10);
}

export function ClimatePage() {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [selectedBlockId, setSelectedBlockId] = useState('');
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(defaultEndDate);
  const [readings, setReadings] = useState<BlockClimateSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    blocksApi.list().then(data => {
      setBlocks(data);
      setSelectedBlockId(prev => prev || data[0]?.id || '');
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedBlockId) {
      setReadings([]);
      return;
    }
    setLoading(true);
    setError(null);
    const start = `${startDate}T00:00:00.000Z`;
    const end = `${endDate}T23:59:59.999Z`;
    blockClimateSummaryApi.list(selectedBlockId, start, end)
      .then(setReadings)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [selectedBlockId, startDate, endDate]);

  return (
    <>
      <div className="page-header">
        <h2>Climate</h2>
      </div>

      <div className="selector-bar">
        <label>Block</label>
        <select
          className="form-control"
          style={{ width: 200 }}
          value={selectedBlockId}
          onChange={e => setSelectedBlockId(e.target.value)}
        >
          <option value="">- select -</option>
          {blocks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <label>From</label>
        <input
          className="form-control"
          style={{ width: 150 }}
          type="date"
          value={startDate}
          onChange={e => setStartDate(e.target.value)}
        />
        <label>To</label>
        <input
          className="form-control"
          style={{ width: 150 }}
          type="date"
          value={endDate}
          onChange={e => setEndDate(e.target.value)}
        />
      </div>

      <div className="page-body">
        {blocks.length === 0 ? (
          <div className="empty-state">No blocks reported yet. Blocks are created automatically once the Climate Agent sends data.</div>
        ) : !selectedBlockId ? (
          <div className="empty-state">Select a block to view climate readings.</div>
        ) : (
          <div className="card">
            <div className="card-title">Block Climate Readings</div>
            {loading ? (
              <div className="loading">Loading...</div>
            ) : error ? (
              <div className="error-state">Failed to load climate data: {error}</div>
            ) : readings.length === 0 ? (
              <div className="empty-state">No climate readings in this date range.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Measured At</th>
                      <th>Air Temp (°C)</th>
                      <th>RH (%)</th>
                      <th>Heating Setpoint (°C)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {readings.map(r => (
                      <tr key={r.id}>
                        <td>{new Date(r.measured_at).toLocaleString()}</td>
                        <td>{r.air_temperature_c ?? '—'}</td>
                        <td>{r.relative_humidity_pct ?? '—'}</td>
                        <td>{r.heating_setpoint_c ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
