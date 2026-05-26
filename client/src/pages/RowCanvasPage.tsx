import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { MeasurementStem, NodeStatus, PlantNode, WeeklyNodeStatus } from '../types';
import { nodesApi, stemsApi, weeklyStatusesApi, yearsApi } from '../services/api';
import { OfflineBanner } from '../components/OfflineBanner';
import { onRemap } from '../services/optimisticStore';

function getIsoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

const STATUS_OPTIONS: { value: NodeStatus; label: string }[] = [
  { value: 'Aborted',      label: 'Aborted' },
  { value: 'Pruned',       label: 'Pruned' },
  { value: 'Flower',       label: 'Flower' },
  { value: 'SetFruit',     label: 'Set Fruit' },
  { value: 'MatureGreen',  label: 'Mature Green' },
  { value: 'BreakerFruit', label: 'Breaker Fruit' },
  { value: 'Harvested',    label: 'Harvested' },
];

const STATUS_CONFIG: Record<NodeStatus, { color: string; bg: string; label: string }> = {
  Aborted:      { color: '#ef4444', bg: '#fee2e2', label: 'Aborted' },
  Pruned:       { color: '#6b7280', bg: '#f3f4f6', label: 'Pruned' },
  Flower:       { color: '#ec4899', bg: '#fdf2f8', label: 'Flower' },
  SetFruit:     { color: '#8b5cf6', bg: '#f5f3ff', label: 'Set Fruit' },
  MatureGreen:  { color: '#16a34a', bg: '#dcfce7', label: 'Mature Green' },
  BreakerFruit: { color: '#f97316', bg: '#fff7ed', label: 'Breaker Fruit' },
  Harvested:    { color: '#1d4ed8', bg: '#dbeafe', label: 'Harvested' },
};

const LEGACY_STATUS_CONFIG = { color: '#6b7280', bg: '#f3f4f6' };

function statusLabel(status: string): string {
  if (status === 'GolfBall') return 'Legacy: Golf Ball';
  if (status === 'Harvestable') return 'Legacy: Harvestable';
  if (status === 'Missing') return 'Legacy: Missing';
  if (status === 'Empty') return 'Legacy: Empty';
  return STATUS_CONFIG[status as NodeStatus]?.label ?? status;
}

function TextPromptModal({
  title, label, defaultValue, onClose, onSave,
}: {
  title: string; label: string; defaultValue?: string;
  onClose: () => void; onSave: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(defaultValue ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) { setError(`${label} is required`); return; }
    setSaving(true);
    try { await onSave(value.trim()); onClose(); }
    catch (err: unknown) { setError(err instanceof Error ? err.message : 'Save failed'); }
    finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">{label}</label>
            <input className="form-control" value={value} onChange={e => setValue(e.target.value)} autoFocus />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface CanvasState {
  rowName: string;
  varietyId: string;
  varietyName: string;
  varietyColor: string | null;
}

export function RowCanvasPage() {
  const { rowId } = useParams<{ rowId: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const ctx = (location.state ?? {}) as Partial<CanvasState>;
  const rowName     = ctx.rowName     ?? 'Row';
  const varietyName = ctx.varietyName ?? 'Variety';
  const varietyColor = ctx.varietyColor ?? null;

  const today = useMemo(() => new Date(), []);
  const currentYear = today.getFullYear();
  const currentWeek = getIsoWeek(today);

  const [seasonId,        setSeasonId]        = useState('');
  const [stems,           setStems]           = useState<MeasurementStem[]>([]);
  const [activeStemIndex, setActiveStemIndex] = useState(0);
  const [nodesByStem,     setNodesByStem]     = useState<Record<string, PlantNode[]>>({});
  const [statusesByStem,  setStatusesByStem]  = useState<Record<string, WeeklyNodeStatus[]>>({});

  const [addStemModal,    setAddStemModal]    = useState(false);
  const [addNodeContext,  setAddNodeContext]  = useState<MeasurementStem | null>(null);
  const [addNodeNumber,   setAddNodeNumber]   = useState(1);
  const [statusPickerCtx, setStatusPickerCtx] = useState<{ stem: MeasurementStem; node: PlantNode } | null>(null);
  const [saving,   setSaving]   = useState(false);
  const [message,  setMessage]  = useState('');

  const canvasRef = useRef<HTMLDivElement>(null);

  const safeIndex  = stems.length === 0 ? 0 : Math.min(activeStemIndex, stems.length - 1);
  const activeStem = stems[safeIndex] ?? null;

  useEffect(() => {
    yearsApi.getOrCreate(currentYear).then(s => setSeasonId(s.id));
  }, [currentYear]);

  useEffect(() => {
    if (!rowId) return;
    stemsApi.list(rowId).then(data => {
      const active = data
        .filter(s => s.is_active)
        .sort((a, b) => a.sort_order - b.sort_order);
      setStems(active);
      active.forEach(stem => loadStemData(stem.id));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId, currentYear, currentWeek]);

  useEffect(() => {
    return onRemap((tempId, realId, type) => {
      if (type === 'row') {
        if (rowId === tempId) {
          navigate(`/mobile/row/${realId}`, { replace: true, state: location.state });
        }
        return;
      }
      if (type === 'stem') {
        setStems(prev => prev.map(s => s.id === tempId ? { ...s, id: realId } : s));
        setNodesByStem(prev => {
          if (!(tempId in prev)) return prev;
          const { [tempId]: nodes, ...rest } = prev;
          return { ...rest, [realId]: nodes };
        });
        setStatusesByStem(prev => {
          if (!(tempId in prev)) return prev;
          const { [tempId]: statuses, ...rest } = prev;
          return { ...rest, [realId]: statuses };
        });
        setStatusPickerCtx(prev => prev?.stem.id === tempId ? { ...prev, stem: { ...prev.stem, id: realId } } : prev);
        return;
      }
      // type === 'node'
      setNodesByStem(prev => {
        const next: Record<string, PlantNode[]> = {};
        for (const [sid, nodes] of Object.entries(prev)) {
          next[sid] = nodes.map(n => {
            if (n.id === tempId) return { ...n, id: realId };
            if (n.parent_node_id === tempId) return { ...n, parent_node_id: realId };
            return n;
          });
        }
        return next;
      });
      setStatusesByStem(prev => {
        const next: Record<string, WeeklyNodeStatus[]> = {};
        for (const [sid, statuses] of Object.entries(prev)) {
          next[sid] = statuses.map(s => s.plant_node_id === tempId ? { ...s, plant_node_id: realId } : s);
        }
        return next;
      });
      setStatusPickerCtx(prev => prev?.node.id === tempId ? { ...prev, node: { ...prev.node, id: realId } } : prev);
    });
  }, [rowId, navigate, location.state]);

  async function loadStemData(stemId: string) {
    const [nodes, statuses] = await Promise.all([
      nodesApi.list(stemId),
      weeklyStatusesApi.list(stemId, currentYear, currentWeek),
    ]);
    setNodesByStem(prev => ({
      ...prev,
      [stemId]: nodes
        .filter(n => n.is_active)
        .sort((a, b) => a.sort_order - b.sort_order || a.node_number - b.node_number),
    }));
    setStatusesByStem(prev => ({ ...prev, [stemId]: statuses }));
  }

  async function handleAddStem(name: string) {
    if (!rowId) return;
    const newIndex = stems.length;
    const created = await stemsApi.create({
      measurement_row_id: rowId,
      stem_name: name,
      sort_order: stems.length + 1,
    });
    setStems(prev => [...prev, created]);
    setNodesByStem(prev => ({ ...prev, [created.id]: [] }));
    setStatusesByStem(prev => ({ ...prev, [created.id]: [] }));
    setActiveStemIndex(newIndex);
    canvasRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleAddNode(stem: MeasurementStem) {
    const nodeNum = addNodeNumber;
    const existing = (nodesByStem[stem.id] ?? []).find(
      n => !n.is_side_shoot && n.node_number === nodeNum,
    );
    if (existing) {
      setAddNodeContext(null);
      setStatusPickerCtx({ stem, node: existing });
      return;
    }
    const created = await nodesApi.create({
      measurement_stem_id: stem.id,
      node_number: nodeNum,
      sort_order: nodeNum,
    });
    setNodesByStem(prev => {
      const list = [...(prev[stem.id] ?? []), created];
      return {
        ...prev,
        [stem.id]: list.sort((a, b) => a.sort_order - b.sort_order || a.node_number - b.node_number),
      };
    });
    setAddNodeContext(null);
    setStatusPickerCtx({ stem, node: created });
    canvasRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleAddShoot(parentNode: PlantNode, side: 'left' | 'right') {
    if (!activeStem) return;
    const stemNodes = nodesByStem[activeStem.id] ?? [];
    const existingCount = stemNodes.filter(
      n => n.is_side_shoot && n.parent_node_id === parentNode.id,
    ).length;
    const label = `${parentNode.node_number}+${existingCount + 1}`;
    const created = await nodesApi.create({
      measurement_stem_id: activeStem.id,
      node_number: parentNode.node_number,
      sort_order: parentNode.sort_order,
      node_label: label,
      parent_node_id: parentNode.id,
      side,
      is_side_shoot: true,
    });
    setNodesByStem(prev => {
      const list = [...(prev[activeStem.id] ?? []), created];
      return {
        ...prev,
        [activeStem.id]: list.sort((a, b) => a.sort_order - b.sort_order || a.node_number - b.node_number),
      };
    });
    setStatusPickerCtx({ stem: activeStem, node: created });
  }

  async function handleSaveStatus(status: NodeStatus) {
    if (!statusPickerCtx || !seasonId) return;
    setSaving(true);
    try {
      const saved = await weeklyStatusesApi.upsert({
        plantNodeId: statusPickerCtx.node.id,
        seasonId,
        year: currentYear,
        weekNumber: currentWeek,
        status,
      });
      const stemId = statusPickerCtx.stem.id;
      setStatusesByStem(prev => {
        const list = prev[stemId] ?? [];
        const exists = list.find(s => s.plant_node_id === statusPickerCtx.node.id);
        return {
          ...prev,
          [stemId]: exists
            ? list.map(s => s.plant_node_id === statusPickerCtx.node.id ? saved : s)
            : [...list, saved],
        };
      });
      const nodeLabel = statusPickerCtx.node.is_side_shoot
        ? (statusPickerCtx.node.node_label ?? 'Shoot')
        : `Node ${statusPickerCtx.node.node_number}`;
      setMessage(`${nodeLabel}: ${STATUS_CONFIG[status].label}`);
      setStatusPickerCtx(null);
    } finally {
      setSaving(false);
    }
  }

  // ── Derived values for the active stem ──────────────────────────────
  const allNodes     = activeStem ? (nodesByStem[activeStem.id]    ?? []) : [];
  const activeStatuses = activeStem ? (statusesByStem[activeStem.id] ?? []) : [];

  const mainNodes = allNodes.filter(n => !n.is_side_shoot);

  const shootsByParent: Record<string, { left?: PlantNode; right?: PlantNode }> = {};
  allNodes
    .filter(n => n.is_side_shoot && n.parent_node_id)
    .forEach(n => {
      const pid = n.parent_node_id!;
      if (!shootsByParent[pid]) shootsByParent[pid] = {};
      if (n.side === 'left')  shootsByParent[pid].left  = n;
      if (n.side === 'right') shootsByParent[pid].right = n;
    });

  const hasPrev = safeIndex > 0;
  const hasNext = safeIndex < stems.length - 1;

  const pickerNodeLabel = statusPickerCtx
    ? (statusPickerCtx.node.is_side_shoot
        ? (statusPickerCtx.node.node_label ?? 'Side Shoot')
        : `Node ${statusPickerCtx.node.node_number}`)
    : '';

  return (
    <div className="row-canvas-page">

      {/* ── Main header ── */}
      <header className="row-canvas-header">
        <button className="row-canvas-back" onClick={() => navigate('/mobile')}>
          ← Back
        </button>
        <div className="row-canvas-title">
          {varietyColor && (
            <span className="variety-color-dot" style={{ background: varietyColor }} />
          )}
          <span className="row-canvas-variety">{varietyName}</span>
          <span className="row-canvas-sep">/</span>
          <span className="row-canvas-rowname">{rowName}</span>
        </div>
        <div className="row-canvas-week">Wk {currentWeek}</div>
        <button
          className="btn btn-primary btn-sm"
          style={{ flexShrink: 0 }}
          onClick={() => setAddStemModal(true)}
        >
          + Stem
        </button>
      </header>

      <OfflineBanner />

      {/* ── Stem navigation bar ── */}
      {stems.length > 0 && (
        <div className="stem-nav-bar">
          <button
            className="stem-nav-arrow"
            aria-label="Previous stem"
            disabled={!hasPrev}
            onClick={() => setActiveStemIndex(i => i - 1)}
          >
            ←
          </button>
          <span className="stem-nav-name">
            {activeStem?.stem_name ?? ''}
            <span className="stem-nav-counter">
              &nbsp;{safeIndex + 1} / {stems.length}
            </span>
          </span>
          <button
            className="stem-nav-arrow"
            aria-label="Next stem"
            disabled={!hasNext}
            onClick={() => setActiveStemIndex(i => i + 1)}
          >
            →
          </button>
        </div>
      )}

      {/* ── Flash message ── */}
      {message && (
        <div className="row-canvas-message" onClick={() => setMessage('')}>
          {message} &times;
        </div>
      )}

      {/* ── Canvas area ── */}
      <div className="row-canvas-area" ref={canvasRef}>
        {stems.length === 0 ? (
          <div className="row-canvas-empty">
            <p>No stems yet.</p>
            <p style={{ fontSize: 13, color: 'var(--gray-400)', marginTop: 8 }}>
              Tap &ldquo;+ Stem&rdquo; in the header to add your first stem.
            </p>
          </div>
        ) : activeStem ? (
          <div className="stem-single">

            {/* Growing tip — always at the top */}
            <button
              className="stem-add-node-btn"
              onClick={() => {
                const mainCount = mainNodes.length;
                setAddNodeNumber(mainCount + 1 || 1);
                setAddNodeContext(activeStem);
              }}
            >
              + Node
            </button>

            {/*
             * column-reverse: first DOM child (N1) sits at the BOTTOM;
             * the highest node number is directly below "+ Node".
             */}
            <div className="stem-visual">
              {mainNodes.length > 0 && <div className="stem-line" />}
              {mainNodes.length === 0 && (
                <div className="stem-no-nodes">
                  Add the first<br />node above
                </div>
              )}

              {mainNodes.map(node => {
                const statusRec = activeStatuses.find(s => s.plant_node_id === node.id);
                const cfg = statusRec
                  ? (STATUS_CONFIG[statusRec.status as NodeStatus] ?? LEGACY_STATUS_CONFIG)
                  : null;

                // Odd node_number → shoot on right, badge on left
                // Even node_number → shoot on left, badge on right
                const shootSide: 'left' | 'right' = node.node_number % 2 !== 0 ? 'right' : 'left';
                const existingShoot = (shootsByParent[node.id] ?? {})[shootSide];

                const mainBadge = cfg ? (
                  <span className="stem-node-badge" style={{ background: cfg.bg, color: cfg.color }}>
                    {statusRec ? statusLabel(statusRec.status) : '—'}
                  </span>
                ) : (
                  <span className="stem-node-badge stem-node-badge--empty">—</span>
                );

                const shootElement = existingShoot ? (() => {
                  const sr = activeStatuses.find(s => s.plant_node_id === existingShoot.id);
                  const sc = sr ? (STATUS_CONFIG[sr.status as NodeStatus] ?? LEGACY_STATUS_CONFIG) : null;
                  const shootBadge = sc ? (
                    <span className="shoot-badge" style={{ background: sc.bg, color: sc.color }}>{statusLabel(sr!.status)}</span>
                  ) : (
                    <span className="shoot-badge shoot-badge--empty">—</span>
                  );
                  // Left:  [badge][connector][circle]
                  // Right: [connector][circle][badge]
                  return (
                    <div className={`shoot-item shoot-item--${shootSide}`}>
                      {shootSide === 'left' && shootBadge}
                      <div className="shoot-connector" />
                      <button
                        type="button"
                        className="shoot-node-btn"
                        style={{
                          borderColor: sc?.color ?? 'var(--gray-300)',
                          background:  sc?.bg    ?? 'var(--white)',
                          color:       sc?.color ?? 'var(--gray-600)',
                        }}
                        title={existingShoot.node_label ?? 'Tap to set status'}
                        onClick={e => { e.stopPropagation(); setStatusPickerCtx({ stem: activeStem!, node: existingShoot }); }}
                      >
                        {existingShoot.node_label}
                      </button>
                      {shootSide === 'right' && shootBadge}
                    </div>
                  );
                })() : (
                  <button
                    type="button"
                    className="stem-side-add-btn"
                    onClick={e => { e.stopPropagation(); handleAddShoot(node, shootSide); }}
                  >+</button>
                );

                return (
                  <div key={node.id} className="stem-node-section">

                    {/* Left zone: shoot/+ (even) or badge (odd) */}
                    <div className="stem-side-zone stem-side-zone--left">
                      {shootSide === 'left' ? shootElement : mainBadge}
                    </div>

                    {/* Main zone: node circle */}
                    <div className="stem-main-zone">
                      <button
                        type="button"
                        className="stem-node-btn"
                        style={{
                          borderColor: cfg?.color ?? 'var(--gray-300)',
                          background:  cfg?.bg    ?? 'var(--white)',
                          color:       cfg?.color ?? 'var(--gray-600)',
                        }}
                        title={cfg ? cfg.label : 'Tap to set status'}
                        onClick={() => setStatusPickerCtx({ stem: activeStem!, node })}
                      >
                        {node.node_number}
                      </button>
                    </div>

                    {/* Right zone: shoot/+ (odd) or badge (even) */}
                    <div className="stem-side-zone stem-side-zone--right">
                      {shootSide === 'right' ? shootElement : mainBadge}
                    </div>

                  </div>
                );
              })}
            </div>

          </div>
        ) : null}
      </div>

      {/* ── Add Stem modal ── */}
      {addStemModal && (
        <TextPromptModal
          title="Add Stem"
          label="Stem name or number"
          defaultValue={`Stem ${stems.length + 1}`}
          onClose={() => setAddStemModal(false)}
          onSave={handleAddStem}
        />
      )}

      {/* ── Add Node modal ── */}
      {addNodeContext && (
        <div className="modal-overlay" onClick={() => setAddNodeContext(null)}>
          <div className="modal" style={{ maxWidth: 340 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">Add Node — {addNodeContext.stem_name}</div>
            <div className="form-group">
              <label className="form-label">Node Number</label>
              <select
                className="form-control mobile-control"
                value={addNodeNumber}
                onChange={e => setAddNodeNumber(Number(e.target.value))}
              >
                {Array.from({ length: 100 }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>Node {n}</option>
                ))}
              </select>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setAddNodeContext(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => handleAddNode(addNodeContext)}>
                Add / Open
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Status picker ── */}
      {statusPickerCtx && (
        <div className="modal-overlay" onClick={() => setStatusPickerCtx(null)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">
              {pickerNodeLabel}
              <span style={{ fontWeight: 400, color: 'var(--gray-500)', marginLeft: 8 }}>
                {statusPickerCtx.stem.stem_name}
              </span>
            </div>
            <div className="status-picker-grid">
              {STATUS_OPTIONS.map(opt => {
                const cfg = STATUS_CONFIG[opt.value];
                const currentRec = (statusesByStem[statusPickerCtx.stem.id] ?? []).find(
                  s => s.plant_node_id === statusPickerCtx.node.id,
                );
                const isActive = currentRec?.status === opt.value;
                return (
                  <button
                    key={opt.value}
                    className={`status-picker-btn${isActive ? ' active' : ''}`}
                    style={isActive ? { borderColor: cfg.color, background: cfg.bg, color: cfg.color } : {}}
                    onClick={() => !saving && handleSaveStatus(opt.value)}
                    disabled={saving}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setStatusPickerCtx(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
