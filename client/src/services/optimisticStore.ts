// In-memory cache for offline-created entities.
// Allows reading temp-ID rows/stems/nodes/statuses before sync maps them to real IDs.

import type { MeasurementRow, MeasurementStem, PlantNode, WeeklyNodeStatus } from '../types';

export function isTempId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith('temp_');
}

const rowMap        = new Map<string, MeasurementRow>();
const stemMap       = new Map<string, MeasurementStem>();
const stemsByRowId  = new Map<string, MeasurementStem[]>();
const nodeMap       = new Map<string, PlantNode>();
const nodesByStemId = new Map<string, PlantNode[]>();
// key: `${nodeId}:${year}:${weekNumber}`
const statusMap     = new Map<string, WeeklyNodeStatus>();

export function addRow(row: MeasurementRow): void {
  rowMap.set(row.id, row);
}

export function addStem(stem: MeasurementStem): void {
  stemMap.set(stem.id, stem);
  const list = stemsByRowId.get(stem.measurement_row_id) ?? [];
  if (!list.find(s => s.id === stem.id)) {
    stemsByRowId.set(stem.measurement_row_id, [...list, stem]);
  }
}

export function addNode(node: PlantNode): void {
  nodeMap.set(node.id, node);
  const list = nodesByStemId.get(node.measurement_stem_id) ?? [];
  if (!list.find(n => n.id === node.id)) {
    nodesByStemId.set(node.measurement_stem_id, [...list, node]);
  }
}

export function addStatus(status: WeeklyNodeStatus): void {
  statusMap.set(`${status.plant_node_id}:${status.year}:${status.week_number}`, status);
}

export function getStemsForRow(rowId: string): MeasurementStem[] {
  return stemsByRowId.get(rowId) ?? [];
}

export function getNodesForStem(stemId: string): PlantNode[] {
  return nodesByStemId.get(stemId) ?? [];
}

export function getStatusesForNodes(nodeIds: string[], year: number, week: number): WeeklyNodeStatus[] {
  return nodeIds.flatMap(nodeId => {
    const s = statusMap.get(`${nodeId}:${year}:${week}`);
    return s ? [s] : [];
  });
}

type RemapListener = (tempId: string, realId: string, type: 'row' | 'stem' | 'node') => void;
const remapListeners = new Set<RemapListener>();

export function onRemap(fn: RemapListener): () => void {
  remapListeners.add(fn);
  return () => remapListeners.delete(fn);
}

export function remapId(tempId: string, realId: string, type: 'row' | 'stem' | 'node'): void {
  if (type === 'row') {
    const row = rowMap.get(tempId);
    if (row) {
      rowMap.set(realId, { ...row, id: realId });
      rowMap.delete(tempId);
    }
    const stems = stemsByRowId.get(tempId);
    if (stems) {
      stemsByRowId.set(realId, stems);
      stemsByRowId.delete(tempId);
    }
  } else if (type === 'stem') {
    const stem = stemMap.get(tempId);
    if (stem) {
      const updated = { ...stem, id: realId };
      stemMap.set(realId, updated);
      stemMap.delete(tempId);
      const siblings = stemsByRowId.get(stem.measurement_row_id);
      if (siblings) {
        stemsByRowId.set(stem.measurement_row_id, siblings.map(s => s.id === tempId ? updated : s));
      }
    }
    const nodes = nodesByStemId.get(tempId);
    if (nodes) {
      nodesByStemId.set(realId, nodes);
      nodesByStemId.delete(tempId);
    }
  } else {
    // node
    const node = nodeMap.get(tempId);
    if (node) {
      const updated = { ...node, id: realId };
      nodeMap.set(realId, updated);
      nodeMap.delete(tempId);
      const siblings = nodesByStemId.get(node.measurement_stem_id);
      if (siblings) {
        nodesByStemId.set(node.measurement_stem_id, siblings.map(n => n.id === tempId ? updated : n));
      }
    }
    // Migrate status keys and parent_node_id refs
    for (const [key, status] of Array.from(statusMap.entries())) {
      if (status.plant_node_id === tempId) {
        const newKey = `${realId}:${status.year}:${status.week_number}`;
        statusMap.set(newKey, { ...status, plant_node_id: realId });
        statusMap.delete(key);
      }
    }
    for (const [id, n] of Array.from(nodeMap.entries())) {
      if (n.parent_node_id === tempId) {
        const updatedNode = { ...n, parent_node_id: realId };
        nodeMap.set(id, updatedNode);
        const stemNodes = nodesByStemId.get(n.measurement_stem_id);
        if (stemNodes) {
          nodesByStemId.set(n.measurement_stem_id, stemNodes.map(sn => sn.id === id ? updatedNode : sn));
        }
      }
    }
  }
  remapListeners.forEach(fn => fn(tempId, realId, type));
}
