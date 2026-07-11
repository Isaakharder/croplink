import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { MeasurementStem, NodeStatus, PlantNode, StemGrowthMeasurement, WeeklyNodeStatus } from '../types';
import { nodesApi, stemGrowthApi, stemsApi, weeklyStatusesApi, yearsApi } from '../services/api';
import { OfflineBanner } from '../components/OfflineBanner';
import { onRemap } from '../services/optimisticStore';
import { getIsoWeek } from '../utils/years';

// Load all crop status icons eagerly; presence in the map determines whether to show an icon.
const _statusIconModules = import.meta.glob<string>(
  '../assets/crop-status-icons/*.svg',
  { eager: true, import: 'default' }
);

// Explicit mapping from DB status value → SVG filename stem (no lowercasing assumed).
const STATUS_TO_ICON_FILE: Record<string, string> = {
  Aborted:      'aborted',
  Pruned:       'pruned',
  Flower:       'flower',
  SetFruit:     'set-fruit',
  MatureGreen:  'mature-green',
  BreakerFruit: 'breaker-fruit',
  Harvested:    'harvested',
};

function statusToIconFileKey(status: string): string | undefined {
  return STATUS_TO_ICON_FILE[status];
}

function getStatusIcon(status: string): string | undefined {
  const fileKey = statusToIconFileKey(status);
  if (!fileKey) return undefined;
  return _statusIconModules[`../assets/crop-status-icons/${fileKey}.svg`] as string | undefined;
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

const SHORT_STATUS_LABEL: Record<string, string> = {
  Aborted:      'Aborted',
  Pruned:       'Pruned',
  Flower:       'Flower',
  SetFruit:     'Set',
  MatureGreen:  'Mature',
  BreakerFruit: 'Breaker',
  Harvested:    'Harvested',
};

function shortStatusLabel(status: string): string {
  return SHORT_STATUS_LABEL[status] ?? statusLabel(status);
}

// Side-shoot display notation: "<parent node number>+<order>", e.g. "5+1", "5+2".
// `order` currently counts shoots on the same parent; a future secondary-branch
// dimension can extend this (e.g. an extra "+level" segment) without touching callers.
function formatShootLabel(parentNodeNumber: number, order: number): string {
  return `${parentNodeNumber}+${order}`;
}

// Normalise the status string out of a record regardless of which field name the
// backend used — old records may arrive as status_key, status_type, or crop_status.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRecordStatus(rec: any): string | null {
  if (!rec) return null;
  return rec.status || rec.status_key || rec.status_type || rec.crop_status || null;
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
  const [statusPickerCtx, setStatusPickerCtx] = useState<{ stem: MeasurementStem; node: PlantNode; isNew?: boolean } | null>(null);
  const [saving,   setSaving]   = useState(false);
  const [message,  setMessage]  = useState('');

  const [growthByStem, setGrowthByStem] = useState<Record<string, StemGrowthMeasurement | null>>({});
  const [vegHistoryByStem, setVegHistoryByStem] = useState<Record<string, StemGrowthMeasurement[]>>({});
  const [vegModal,     setVegModal]     = useState(false);
  const [vegGrowthCm,  setVegGrowthCm]  = useState('');
  const [vegNotes,     setVegNotes]     = useState('');
  const [vegSaving,    setVegSaving]    = useState(false);
  const [vegError,     setVegError]     = useState('');

  const canvasRef = useRef<HTMLDivElement>(null);

  const safeIndex  = stems.length === 0 ? 0 : Math.min(activeStemIndex, stems.length - 1);
  const activeStem = stems[safeIndex] ?? null;

  useEffect(() => {
    yearsApi.getOrCreate(currentYear).then(s => setSeasonId(s.id));
  }, [currentYear]);

  useEffect(() => {
    if (!rowId || !seasonId) return;
    stemsApi.list(rowId).then(data => {
      const active = data
        .filter(s => s.is_active)
        .sort((a, b) => a.sort_order - b.sort_order);
      setStems(active);
      active.forEach(stem => loadStemData(stem.id));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId, seasonId, currentYear, currentWeek]);

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
    const [nodes, statuses, growth, vegHistory] = await Promise.all([
      nodesApi.list(stemId),
      weeklyStatusesApi.list(stemId, currentYear, currentWeek, {
        seasonId,
        latestPerNode: true,
      }),
      stemGrowthApi.get(stemId, currentYear, currentWeek),
      stemGrowthApi.history(stemId),
    ]);
    setNodesByStem(prev => ({
      ...prev,
      [stemId]: nodes
        .filter(n => n.is_active)
        .sort((a, b) => a.sort_order - b.sort_order || a.node_number - b.node_number),
    }));
    setStatusesByStem(prev => ({ ...prev, [stemId]: statuses }));
    setGrowthByStem(prev => ({ ...prev, [stemId]: growth }));
    setVegHistoryByStem(prev => ({ ...prev, [stemId]: vegHistory }));
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

  async function handleAddNode(stem: MeasurementStem, nodeNum?: number) {
    const num = nodeNum ?? addNodeNumber;
    const existing = (nodesByStem[stem.id] ?? []).find(
      n => !n.is_side_shoot && n.node_number === num,
    );
    if (existing) {
      setAddNodeContext(null);
      setStatusPickerCtx({ stem, node: existing, isNew: false });
      return;
    }
    const created = await nodesApi.create({
      measurement_stem_id: stem.id,
      node_number: num,
      sort_order: num,
    });
    setNodesByStem(prev => {
      const list = [...(prev[stem.id] ?? []), created];
      return {
        ...prev,
        [stem.id]: list.sort((a, b) => a.sort_order - b.sort_order || a.node_number - b.node_number),
      };
    });
    setAddNodeContext(null);
    setStatusPickerCtx({ stem, node: created, isNew: true });
    canvasRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleAddShoot(parentNode: PlantNode, side: 'left' | 'right') {
    if (!activeStem) return;
    const stemNodes = nodesByStem[activeStem.id] ?? [];
    const existingCount = stemNodes.filter(
      n => n.is_side_shoot && n.parent_node_id === parentNode.id,
    ).length;
    const label = formatShootLabel(parentNode.node_number, existingCount + 1);
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
    setStatusPickerCtx({ stem: activeStem, node: created, isNew: true });
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

  async function handleCancelStatusPicker() {
    if (!statusPickerCtx) return;
    if (statusPickerCtx.isNew) {
      const { stem, node } = statusPickerCtx;
      setNodesByStem(prev => ({
        ...prev,
        [stem.id]: (prev[stem.id] ?? []).filter(n => n.id !== node.id),
      }));
      try { await nodesApi.setActive(node.id, false); } catch { /* best effort */ }
    }
    setStatusPickerCtx(null);
  }

  function openVegModal() {
    const existing = activeStem ? growthByStem[activeStem.id] : null;
    setVegGrowthCm(existing ? String(existing.growth_cm) : '');
    setVegNotes(existing?.notes ?? '');
    setVegError('');
    setVegModal(true);
  }

  async function handleSaveVeg(e: React.FormEvent) {
    e.preventDefault();
    if (!activeStem || !seasonId) return;
    const cm = parseFloat(vegGrowthCm);
    if (!vegGrowthCm.trim() || isNaN(cm) || cm <= 0) {
      setVegError('Enter a valid growth in cm (must be > 0)');
      return;
    }
    setVegSaving(true);
    setVegError('');
    try {
      const saved = await stemGrowthApi.upsert({
        stemId: activeStem.id,
        seasonId,
        year: currentYear,
        weekNumber: currentWeek,
        growthCm: cm,
        notes: vegNotes.trim() || null,
      });
      setGrowthByStem(prev => ({ ...prev, [activeStem.id]: saved }));
      if (saved.top_node_number != null) {
        setVegHistoryByStem(prev => {
          const existing = prev[activeStem.id] ?? [];
          const withoutSaved = existing.filter(
            g => !(g.year === saved.year && g.week_number === saved.week_number)
          );
          const next = [...withoutSaved, saved].sort(
            (a, b) => a.year - b.year || a.week_number - b.week_number
          );
          return { ...prev, [activeStem.id]: next };
        });
      }
      setMessage(`Growth: ${saved.growth_cm} cm saved`);
      setVegModal(false);
    } catch (err: unknown) {
      setVegError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setVegSaving(false);
    }
  }

  async function handlePickerNodeSwitch(nodeNum: number) {
    if (!statusPickerCtx || saving) return;
    const stem = statusPickerCtx.stem;
    const existing = (nodesByStem[stem.id] ?? []).find(
      n => !n.is_side_shoot && n.node_number === nodeNum,
    );
    if (existing) {
      setStatusPickerCtx({ stem, node: existing });
      return;
    }
    setSaving(true);
    try {
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
      setStatusPickerCtx({ stem, node: created });
    } finally {
      setSaving(false);
    }
  }

  // ── Derived values for the active stem ──────────────────────────────
  const allNodes     = activeStem ? (nodesByStem[activeStem.id]    ?? []) : [];
  const activeStatuses = activeStem ? (statusesByStem[activeStem.id] ?? []) : [];

  const mainNodes = allNodes.filter(n => !n.is_side_shoot);

  // ── Veg Measurement Stem (secondary, node-aligned growth readings) ──────
  // Each reading's top_node_number is "the highest active main-stem node at
  // save time" — visually that places the reading in the gap directly below
  // that node (i.e. between it and the node one lower), so a chip is emitted
  // right before its matching node as we walk mainNodes bottom-to-top.
  const vegHistory = activeStem ? (vegHistoryByStem[activeStem.id] ?? []) : [];
  const vegByTopNode: Record<number, StemGrowthMeasurement[]> = {};
  vegHistory.forEach(g => {
    if (g.top_node_number == null) return;
    (vegByTopNode[g.top_node_number] ??= []).push(g);
  });
  type VegRow =
    | { kind: 'node'; node: PlantNode }
    | { kind: 'growth'; growth: StemGrowthMeasurement };
  const vegRows: VegRow[] = [];
  mainNodes.forEach(node => {
    (vegByTopNode[node.node_number] ?? []).forEach(growth => {
      vegRows.push({ kind: 'growth', growth });
    });
    vegRows.push({ kind: 'node', node });
  });
  const hasVegStem = vegHistory.length > 0 && vegRows.some(r => r.kind === 'node');

  // Group ALL side shoots by parent node id (not just one per side)
  const shootsByParentNode: Record<string, PlantNode[]> = {};
  allNodes
    .filter(n => n.is_side_shoot && n.parent_node_id)
    .forEach(n => {
      const pid = n.parent_node_id!;
      if (!shootsByParentNode[pid]) shootsByParentNode[pid] = [];
      shootsByParentNode[pid].push(n);
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
            <div className="stem-tip-actions">
              <button
                className="stem-add-node-btn"
                onClick={() => { handleAddNode(activeStem!, mainNodes.length + 1 || 1); }}
              >
                + Node
              </button>
              <button
                className="stem-veg-btn"
                onClick={openVegModal}
              >
                + Veg
              </button>
            </div>
            {activeStem && growthByStem[activeStem.id] != null && (
              <div className="stem-growth-chip">
                &#8593; {growthByStem[activeStem.id]!.growth_cm} cm
              </div>
            )}

            <div className="stem-canvas-row">
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
                const statusRec  = activeStatuses.find(s => s.plant_node_id === node.id);
                const nodeStatus = getRecordStatus(statusRec) as NodeStatus | null;
                const cfg = nodeStatus
                  ? (STATUS_CONFIG[nodeStatus] ?? LEGACY_STATUS_CONFIG)
                  : null;

                // Odd node_number → shoot on right, badge on left
                // Even node_number → shoot on left, badge on right
                const shootSide: 'left' | 'right' = node.node_number % 2 !== 0 ? 'right' : 'left';
                // All shoots for this node, ordered by label suffix (1+1, 1+2, …)
                const nodeShoots = (shootsByParentNode[node.id] ?? [])
                  .slice()
                  .sort((a, b) => {
                    const nA = parseInt(a.node_label?.match(/\+(\d+)$/)?.[1] ?? '0', 10);
                    const nB = parseInt(b.node_label?.match(/\+(\d+)$/)?.[1] ?? '0', 10);
                    return nA - nB;
                  });

                const mainIcon = nodeStatus ? getStatusIcon(nodeStatus) : undefined;

                // Shoot zone: one icon-circle per shoot + always-visible add button.
                // DOM order is [connector?, …icons, +btn]; shoot-zone--left reverses via
                // row-reverse so the connector always sits closest to the main stem.
                const MAX_VISIBLE = 3;
                const visibleShoots = nodeShoots.slice(0, MAX_VISIBLE);
                const hiddenCount   = nodeShoots.length - MAX_VISIBLE;
                const shootZone = (
                  <div className={`shoot-zone shoot-zone--${shootSide}`}>
                    {nodeShoots.length > 0 && <div className="shoot-connector" />}
                    {visibleShoots.map((shoot, shootIdx) => {
                      const sr        = activeStatuses.find(s => s.plant_node_id === shoot.id);
                      const srStatus  = getRecordStatus(sr) as NodeStatus | null;
                      const sc        = srStatus ? (STATUS_CONFIG[srStatus] ?? LEGACY_STATUS_CONFIG) : null;
                      const shootIcon = srStatus ? getStatusIcon(srStatus) : undefined;
                      const cellLabel = srStatus ? shortStatusLabel(srStatus) : (shoot.node_label ?? '?');
                      const shootNumberLabel = shoot.node_label ?? formatShootLabel(node.node_number, shootIdx + 1);
                      return (
                        <div key={shoot.id} className="shoot-node-cell">
                          <span className="shoot-number-label">{shootNumberLabel}</span>
                          <button
                            type="button"
                            className="shoot-icon-btn"
                            style={{
                              borderColor: sc?.color ?? 'var(--gray-300)',
                              background:  sc?.bg    ?? 'var(--white)',
                              color:       sc?.color ?? 'var(--gray-500)',
                            }}
                            title={shoot.node_label ?? 'Tap to set status'}
                            onClick={e => { e.stopPropagation(); setStatusPickerCtx({ stem: activeStem!, node: shoot }); }}
                          >
                            {shootIcon
                              ? <img src={shootIcon} alt="" width={20} height={20} />
                              : srStatus
                                ? <span style={{ fontSize: 9, fontWeight: 700, lineHeight: 1 }}>
                                    {shortStatusLabel(srStatus).slice(0, 3)}
                                  </span>
                                : <span style={{ fontSize: 9, color: 'var(--gray-400)', lineHeight: 1 }}>
                                    {shoot.node_label ?? '?'}
                                  </span>}
                          </button>
                          <span className="shoot-node-cell-label">{cellLabel}</span>
                        </div>
                      );
                    })}
                    {hiddenCount > 0 && (
                      <span className="shoot-overflow-badge">+{hiddenCount}</span>
                    )}
                    <button
                      type="button"
                      className="stem-side-add-btn"
                      onClick={e => { e.stopPropagation(); handleAddShoot(node, shootSide); }}
                    >+</button>
                  </div>
                );

                return (
                  <div key={node.id} className="stem-node-section">

                    {/* Left zone: shoots (even node) on the left; otherwise the node number */}
                    <div className="stem-side-zone stem-side-zone--left">
                      {shootSide === 'left'
                        ? shootZone
                        : <span className="stem-node-number-label">{node.node_number}</span>}
                    </div>

                    {/* Main zone: status icon inside circle + short label below */}
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
                        {mainIcon
                          ? <img src={mainIcon} alt="" width={24} height={24} />
                          : nodeStatus
                            ? <span style={{ fontSize: 9, fontWeight: 700, lineHeight: 1 }}>
                                {shortStatusLabel(nodeStatus).slice(0, 3)}
                              </span>
                            : node.node_number}
                      </button>
                      {nodeStatus && (
                        <span className="stem-node-status-label">
                          {shortStatusLabel(nodeStatus)}
                        </span>
                      )}
                    </div>

                    {/* Right zone: shoots (odd node) on the right; otherwise the node number */}
                    <div className="stem-side-zone stem-side-zone--right">
                      {shootSide === 'right'
                        ? shootZone
                        : <span className="stem-node-number-label">{node.node_number}</span>}
                    </div>

                  </div>
                );
              })}
            </div>

            {/*
             * Secondary, node-aligned Veg Measurement Stem. Not a weekly
             * timeline — no week labels. Same node numbers as the main
             * stem above; growth_cm values sit in the gap below the node
             * that was the top of the stem when each reading was saved.
             */}
            {hasVegStem && (
              <div className="veg-stem-column">
                <div className="veg-stem-label">Veg</div>
                <div className="veg-stem-visual">
                  <div className="veg-stem-line" />
                  {vegRows.map(row => row.kind === 'node' ? (
                    <div key={`vn-${row.node.id}`} className="veg-stem-node-row">
                      <span className="veg-stem-node-dot" />
                      <span className="veg-stem-node-number">{row.node.node_number}</span>
                    </div>
                  ) : (
                    <div key={`vg-${row.growth.id}`} className="veg-stem-growth-row">
                      <span className="veg-stem-growth-value">{row.growth.growth_cm} cm</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
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

      {/* ── Veg growth modal ── */}
      {vegModal && (
        <div className="modal-overlay" onClick={() => setVegModal(false)}>
          <div className="modal" style={{ maxWidth: 380 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">
              Vegetative Growth
              {activeStem && (
                <span style={{ fontWeight: 400, color: 'var(--gray-500)', marginLeft: 8 }}>
                  {activeStem.stem_name}
                </span>
              )}
            </div>
            {vegError && <div className="alert alert-error">{vegError}</div>}
            <form onSubmit={handleSaveVeg}>
              <div className="form-group">
                <label className="form-label">Growth (cm)</label>
                <input
                  className="form-control mobile-control"
                  type="number"
                  step="0.1"
                  min="0.1"
                  placeholder="e.g. 8.5"
                  value={vegGrowthCm}
                  onChange={e => setVegGrowthCm(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label className="form-label">Notes (optional)</label>
                <input
                  className="form-control"
                  type="text"
                  value={vegNotes}
                  onChange={e => setVegNotes(e.target.value)}
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setVegModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={vegSaving}>
                  {vegSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Status picker ── */}
      {statusPickerCtx && (
        <div className="modal-overlay" onClick={() => handleCancelStatusPicker()}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">
              {pickerNodeLabel}
              <span style={{ fontWeight: 400, color: 'var(--gray-500)', marginLeft: 8 }}>
                {statusPickerCtx.stem.stem_name}
              </span>
            </div>
            {!statusPickerCtx.node.is_side_shoot && (
              <div className="form-group" style={{ marginBottom: 12 }}>
                <label className="form-label">Node Number</label>
                <select
                  className="form-control mobile-control"
                  value={statusPickerCtx.node.node_number}
                  onChange={e => handlePickerNodeSwitch(Number(e.target.value))}
                  disabled={saving}
                >
                  {Array.from({ length: 100 }, (_, i) => i + 1).map(n => (
                    <option key={n} value={n}>Node {n}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="status-picker-grid">
              {STATUS_OPTIONS.map(opt => {
                const cfg = STATUS_CONFIG[opt.value];
                const currentRec = (statusesByStem[statusPickerCtx.stem.id] ?? []).find(
                  s => s.plant_node_id === statusPickerCtx.node.id,
                );
                const isActive = getRecordStatus(currentRec) === opt.value;
                const icon = getStatusIcon(opt.value);
                return (
                  <button
                    key={opt.value}
                    className={`status-picker-btn${isActive ? ' active' : ''}`}
                    style={isActive ? { borderColor: cfg.color, background: cfg.bg, color: cfg.color } : {}}
                    onClick={() => !saving && handleSaveStatus(opt.value)}
                    disabled={saving}
                  >
                    {icon && <img src={icon} alt="" width={32} height={32} style={{ flexShrink: 0 }} />}
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => handleCancelStatusPicker()}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
