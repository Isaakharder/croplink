import {
  enqueue,
  newTempId,
  type ActionType,
} from './offlineQueue';
import {
  addRow,
  addStem,
  addNode,
  addStatus,
  getStemsForRow,
  getNodesForStem,
  getStatusesForNodes,
  isTempId,
} from './optimisticStore';
import type {
  MeasurementRow,
  MeasurementStem,
  PlantNode,
  WeeklyNodeStatus,
} from '../types';

const BASE = '/api/projection';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// Seasons
export const seasonsApi = {
  list: () => request<import('../types').Season[]>('/seasons'),
  create: (data: Record<string, unknown>) =>
    request<import('../types').Season>('/seasons', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Record<string, unknown>) =>
    request<import('../types').Season>(`/seasons/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
};

export const yearsApi = {
  list: () => request<import('../types').Season[]>('/years'),
  getOrCreate: (year: number, organization_id?: string | null) =>
    request<import('../types').Season>('/years', {
      method: 'POST',
      body: JSON.stringify({ year, organization_id }),
    }),
};

// Varieties
export const varietiesApi = {
  list: (seasonId?: string, year?: number) =>
    request<import('../types').Variety[]>(
      `/varieties${year != null ? `?year=${year}` : seasonId ? `?seasonId=${seasonId}` : ''}`
    ),
  create: (data: Record<string, unknown>) =>
    request<import('../types').Variety>('/varieties', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Record<string, unknown>) =>
    request<import('../types').Variety>(`/varieties/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  setActive: (id: string, is_active: boolean) =>
    request<import('../types').Variety>(`/varieties/${id}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active }),
    }),
};

// Rows
export const rowsApi = {
  list: (varietyId: string) => request<MeasurementRow[]>(`/rows?varietyId=${varietyId}`),
  create: async (data: Record<string, unknown>): Promise<MeasurementRow> => {
    if (navigator.onLine) return request<MeasurementRow>('/rows', { method: 'POST', body: JSON.stringify(data) });
    const tempId = newTempId();
    await enqueue({ type: 'create_row' as ActionType, payload: data, tempId, tempIdFields: [] });
    const optimistic: MeasurementRow = {
      id: tempId,
      organization_id: null,
      variety_id: data.variety_id as string,
      row_name: data.row_name as string,
      sort_order: (data.sort_order as number) ?? 0,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    addRow(optimistic);
    return optimistic;
  },
  update: (id: string, data: Record<string, unknown>) =>
    request<MeasurementRow>(`/rows/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  setActive: (id: string, is_active: boolean) =>
    request<MeasurementRow>(`/rows/${id}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active }),
    }),
};

// Stems
export const stemsApi = {
  list: async (rowId: string): Promise<MeasurementStem[]> => {
    const optStems = getStemsForRow(rowId);
    if (isTempId(rowId)) return optStems;
    const serverStems = await request<MeasurementStem[]>(`/stems?rowId=${rowId}`);
    const serverIds = new Set(serverStems.map(s => s.id));
    return [...serverStems, ...optStems.filter(s => !serverIds.has(s.id))];
  },
  create: async (data: Record<string, unknown>): Promise<MeasurementStem> => {
    if (navigator.onLine) return request<MeasurementStem>('/stems', { method: 'POST', body: JSON.stringify(data) });
    const tempId = newTempId();
    await enqueue({ type: 'create_stem' as ActionType, payload: data, tempId, tempIdFields: ['measurement_row_id'] });
    const optimistic: MeasurementStem = {
      id: tempId,
      organization_id: null,
      measurement_row_id: data.measurement_row_id as string,
      stem_name: data.stem_name as string,
      sort_order: (data.sort_order as number) ?? 0,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    addStem(optimistic);
    return optimistic;
  },
  update: (id: string, data: Record<string, unknown>) =>
    request<MeasurementStem>(`/stems/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  setActive: (id: string, is_active: boolean) =>
    request<MeasurementStem>(`/stems/${id}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active }),
    }),
};

// Nodes
export const nodesApi = {
  list: async (stemId: string): Promise<PlantNode[]> => {
    const optNodes = getNodesForStem(stemId);
    if (isTempId(stemId)) return optNodes;
    const serverNodes = await request<PlantNode[]>(`/nodes?stemId=${stemId}`);
    const serverIds = new Set(serverNodes.map(n => n.id));
    return [...serverNodes, ...optNodes.filter(n => !serverIds.has(n.id))];
  },
  create: async (data: Record<string, unknown>): Promise<PlantNode> => {
    if (navigator.onLine) return request<PlantNode>('/nodes', { method: 'POST', body: JSON.stringify(data) });
    const tempId = newTempId();
    await enqueue({
      type: 'create_node' as ActionType,
      payload: data,
      tempId,
      tempIdFields: ['measurement_stem_id', 'parent_node_id'],
    });
    const optimistic: PlantNode = {
      id: tempId,
      organization_id: null,
      measurement_stem_id: data.measurement_stem_id as string,
      node_number: data.node_number as number,
      sort_order: (data.sort_order as number) ?? (data.node_number as number),
      is_active: true,
      node_label: (data.node_label as string | null | undefined) ?? null,
      parent_node_id: (data.parent_node_id as string | null | undefined) ?? null,
      side: (data.side as 'left' | 'right' | null | undefined) ?? null,
      is_side_shoot: (data.is_side_shoot as boolean | undefined) ?? false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    addNode(optimistic);
    return optimistic;
  },
  update: (id: string, data: Record<string, unknown>) =>
    request<PlantNode>(`/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  setActive: (id: string, is_active: boolean) =>
    request<PlantNode>(`/nodes/${id}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active }),
    }),
};

// Weekly statuses
export const weeklyStatusesApi = {
  list: async (stemId: string, year: number, weekNumber: number): Promise<WeeklyNodeStatus[]> => {
    const optNodes = getNodesForStem(stemId);
    const optStatuses = getStatusesForNodes(optNodes.map(n => n.id), year, weekNumber);
    if (isTempId(stemId)) return optStatuses;
    const serverStatuses = await request<WeeklyNodeStatus[]>(
      `/weekly-statuses?stemId=${stemId}&year=${year}&weekNumber=${weekNumber}`
    );
    const serverNodeIds = new Set(serverStatuses.map(s => s.plant_node_id));
    return [...serverStatuses, ...optStatuses.filter(s => !serverNodeIds.has(s.plant_node_id))];
  },
  upsert: async (data: Record<string, unknown>): Promise<WeeklyNodeStatus> => {
    if (navigator.onLine) {
      return request<WeeklyNodeStatus>('/weekly-statuses/upsert', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    }
    await enqueue({
      type: 'upsert_status' as ActionType,
      payload: data,
      tempId: null,
      tempIdFields: ['plantNodeId'],
    });
    const optimistic: WeeklyNodeStatus = {
      id: newTempId(),
      organization_id: null,
      plant_node_id: data.plantNodeId as string,
      season_id: (data.seasonId as string | null | undefined) ?? null,
      year: data.year as number,
      week_number: data.weekNumber as number,
      status: data.status as import('../types').NodeStatus,
      notes: null,
      recorded_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    addStatus(optimistic);
    return optimistic;
  },
};

export const measurementSummaryApi = {
  get: (year: number, varietyId: string, weekNumber: number) =>
    request<import('../types').MeasurementSummaryResponse>(
      `/measurement-summary?year=${year}&varietyId=${varietyId}&weekNumber=${weekNumber}`
    ),
};

// Harvest timing
export const harvestTimingApi = {
  list: (varietyId: string, year: number) =>
    request<import('../types').HarvestTimingProfile[]>(`/harvest-timing?varietyId=${varietyId}&year=${year}`),
  upsertMany: (rows: Record<string, unknown>[]) =>
    request<import('../types').HarvestTimingProfile[]>('/harvest-timing/upsert-many', {
      method: 'POST',
      body: JSON.stringify({ rows }),
    }),
};

// Fruit weights
export const fruitWeightsApi = {
  list: (varietyId: string, year: number) =>
    request<import('../types').FruitWeightByWeek[]>(`/fruit-weights?varietyId=${varietyId}&year=${year}`),
  upsertMany: (rows: Record<string, unknown>[]) =>
    request<import('../types').FruitWeightByWeek[]>('/fruit-weights/upsert-many', {
      method: 'POST',
      body: JSON.stringify({ rows }),
    }),
};

// Harvested
export const harvestedApi = {
  list: (varietyId: string, year: number) =>
    request<import('../types').HarvestedEntry[]>(`/harvested?varietyId=${varietyId}&year=${year}`),
  create: (data: Record<string, unknown>) =>
    request<import('../types').HarvestedEntry>('/harvested', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Record<string, unknown>) =>
    request<import('../types').HarvestedEntry>(`/harvested/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/harvested/${id}`, { method: 'DELETE' }),
};

// Fruit set per m² calculated from mobile measurements
export const fruitSetByWeekApi = {
  get: (varietyId: string, year: number) =>
    request<import('../types').FruitSetByWeekEntry[]>(
      `/fruit-set-by-week?varietyId=${varietyId}&year=${year}`
    ),
};

// Mobile row cards (with stem count + last updated)
export const mobileRowsApi = {
  list: (varietyId: string) =>
    request<import('../types').MobileRowCard[]>(`/mobile/rows?varietyId=${varietyId}`),
};

// Breaker learning (short-term next-week adjustment from BreakerFruit data)
export const breakerLearningApi = {
  get: (year: number, varietyId: string) =>
    request<import('../types').BreakerLearningResult>(
      `/breaker-learning?year=${year}&varietyId=${varietyId}`
    ),
};

// Ripening actuals (actual set→harvest timing from fruit_instances)
export const ripeningActualsApi = {
  get: (varietyId: string, year: number) =>
    request<import('../types').RipeningActualsRow[]>(
      `/ripening-actuals?varietyId=${varietyId}&year=${year}`
    ),
};

// Harvest projections (multi-variety weekly kg forecast)
export const harvestProjectionsApi = {
  get: (year: number, varietyId?: string) =>
    request<import('../types').HarvestProjectionsResult>(
      `/harvest-projections?year=${year}${varietyId ? `&varietyId=${varietyId}` : ''}`
    ),
};

// Projection
export const projectionApi = {
  get: (varietyId: string, year: number) =>
    request<import('../types').ProjectionResult>(`/projection?varietyId=${varietyId}&year=${year}`),
};
