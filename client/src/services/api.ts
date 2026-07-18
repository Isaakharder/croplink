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
import { apiUrl } from './apiBase';

const BASE = apiUrl('/api/projection');
const CLIMATE_BASE = apiUrl('/api/climate');
const CLIMATE_V1_BASE = apiUrl('/api/v1/climate');
const SETUP_BASE = apiUrl('/api/setup');
const GROWLINK_BASE = apiUrl('/api/growlink');

async function requestFrom<T>(base: string, path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  return requestFrom<T>(BASE, path, options);
}

async function climateRequest<T>(path: string, options?: RequestInit): Promise<T> {
  return requestFrom<T>(CLIMATE_BASE, path, options);
}

async function climateV1Request<T>(path: string, options?: RequestInit): Promise<T> {
  return requestFrom<T>(CLIMATE_V1_BASE, path, options);
}

async function setupRequest<T>(path: string, options?: RequestInit): Promise<T> {
  return requestFrom<T>(SETUP_BASE, path, options);
}

async function growlinkRequest<T>(path: string, options?: RequestInit): Promise<T> {
  return requestFrom<T>(GROWLINK_BASE, path, options);
}

function compareWeeklyStatusRecency(a: WeeklyNodeStatus, b: WeeklyNodeStatus): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.week_number !== b.week_number) return a.week_number - b.week_number;
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
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
  list: async (
    stemId: string,
    year: number,
    weekNumber: number,
    options?: { seasonId?: string; latestPerNode?: boolean }
  ): Promise<WeeklyNodeStatus[]> => {
    const optNodes = getNodesForStem(stemId);
    const optStatuses = getStatusesForNodes(optNodes.map(n => n.id), year, weekNumber);
    if (isTempId(stemId)) return optStatuses;

    const params = new URLSearchParams({ stemId });
    if (options?.latestPerNode) {
      params.set('latest', 'true');
      if (options.seasonId) params.set('seasonId', options.seasonId);
    } else {
      params.set('year', String(year));
      params.set('weekNumber', String(weekNumber));
    }

    const serverStatuses = await request<WeeklyNodeStatus[]>(`/weekly-statuses?${params.toString()}`);
    const mergedByNode = new Map(serverStatuses.map(status => [status.plant_node_id, status]));

    for (const optimisticStatus of optStatuses) {
      const existing = mergedByNode.get(optimisticStatus.plant_node_id);
      if (!existing || compareWeeklyStatusRecency(optimisticStatus, existing) >= 0) {
        mergedByNode.set(optimisticStatus.plant_node_id, optimisticStatus);
      }
    }

    return Array.from(mergedByNode.values());
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
    request<import('../types').RipeningActualsResult>(
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

// Stem vegetative growth measurements
export const stemGrowthApi = {
  get: (stemId: string, year: number, weekNumber: number) =>
    request<import('../types').StemGrowthMeasurement | null>(
      `/stem-growth-measurements?stemId=${stemId}&year=${year}&weekNumber=${weekNumber}`
    ),
  history: (stemId: string) =>
    request<import('../types').StemGrowthMeasurement[]>(
      `/stem-growth-measurements/history?stemId=${stemId}`
    ),
  upsert: (data: Record<string, unknown>) =>
    request<import('../types').StemGrowthMeasurement>('/stem-growth-measurements/upsert', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Phases
export const phasesApi = {
  list: () => setupRequest<import('../types').Phase[]>('/phases'),
  create: (data: { name: string; sort_order?: number }) =>
    setupRequest<import('../types').Phase>('/phases', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: { name?: string; sort_order?: number }) =>
    setupRequest<import('../types').Phase>(`/phases/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => setupRequest<void>(`/phases/${id}`, { method: 'DELETE' }),
};

// Zones
export const zonesApi = {
  list: (phaseId?: string) =>
    setupRequest<import('../types').Zone[]>(`/zones${phaseId ? `?phaseId=${phaseId}` : ''}`),
  create: (data: { phase_id: string; name: string; import_key: string; sort_order?: number }) =>
    setupRequest<import('../types').Zone>('/zones', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: { name?: string; import_key?: string; sort_order?: number }) =>
    setupRequest<import('../types').Zone>(`/zones/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => setupRequest<void>(`/zones/${id}`, { method: 'DELETE' }),
};

// Variety-Zone assignments
export const varietyZonesApi = {
  list: () => setupRequest<import('../types').VarietyZone[]>('/variety-zones'),
  assign: (data: { variety_id: string; zone_id: string }) =>
    setupRequest<import('../types').VarietyZone>('/variety-zones', { method: 'POST', body: JSON.stringify(data) }),
  unassign: (zoneId: string) => setupRequest<void>(`/variety-zones/${zoneId}`, { method: 'DELETE' }),
};

// Blocks (Climate Agent — Block Summary climate data)
export const blocksApi = {
  list: () => climateRequest<import('../types').Block[]>('/blocks'),
};

export const blockClimateSummaryApi = {
  list: (blockId: string, start?: string, end?: string) => {
    const params = new URLSearchParams({ blockId });
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    return climateRequest<import('../types').BlockClimateSummary[]>(`/block-summary?${params.toString()}`);
  },
};

// Multipart upload — must NOT set a JSON content-type (the browser sets its
// own multipart boundary), so this bypasses the shared `climateRequest` helper.
async function climateUploadRequest<T>(path: string, body: FormData): Promise<T> {
  const res = await fetch(`${CLIMATE_BASE}${path}`, { method: 'POST', body });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

// Climate CSV import batches (manual multi-file upload → preview → confirm)
export const climateImportBatchesApi = {
  upload: (files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    return climateUploadRequest<import('../types').ClimateImportPreview>('/import-batches', form);
  },
  preview: (batchId: string) =>
    climateRequest<import('../types').ClimateImportPreview>(`/import-batches/${batchId}/preview`),
  confirm: (batchId: string, resolutions?: Record<string, string>) =>
    climateRequest<import('../types').ClimateImportConfirmResult>(`/import-batches/${batchId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ resolutions: resolutions ?? {} }),
    }),
  history: () => climateRequest<import('../types').ClimateImportBatch[]>('/import-batches'),
  cancel: (batchId: string) => climateRequest<void>(`/import-batches/${batchId}`, { method: 'DELETE' }),
};

// Synopta Agent imports (climate_imports/climate_readings) — the automated pipeline
// GrowLinkAgent POSTs to. Read-only from the client; organization scoping is enforced
// server-side.
export const synoptaAgentImportsApi = {
  list: () => climateV1Request<{ organization_id: string | null; imports: import('../types').SynoptaAgentImport[] }>('/imports'),
};

// Corrections for already-committed imports (e.g. a timestamp-resolution fix
// discovered after commit) — dry-run preview, then an explicit apply.
export const climateCorrectionsApi = {
  preview: (filename: string) =>
    climateRequest<import('../types').ClimateTimestampCorrectionPreview>('/import-batches/corrections/preview', {
      method: 'POST',
      body: JSON.stringify({ filename }),
    }),
  apply: (filename: string) =>
    climateRequest<import('../types').ClimateTimestampCorrectionResult>('/import-batches/corrections/apply', {
      method: 'POST',
      body: JSON.stringify({ filename }),
    }),
};

export const varietyClimateHourlyApi = {
  get: (varietyId: string, granularity: import('../types').ClimateGranularity, start?: string, end?: string) => {
    const params = new URLSearchParams({ varietyId, granularity });
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    return climateRequest<import('../types').VarietyClimateHourlyResult>(`/variety-hourly?${params.toString()}`);
  },
};

// Deterministic climate feature engine (degree-hours, VPD, radiation, CO2/light
// context, irrigation, EC/pH) — derived from variety_climate_hourly, never
// recomputed on the client.
export const varietyClimateFeaturesApi = {
  get: (varietyId: string, granularity: import('../types').ClimateGranularity, start?: string, end?: string) => {
    const params = new URLSearchParams({ varietyId, granularity });
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    return climateRequest<import('../types').VarietyClimateFeatureResult>(`/variety-features?${params.toString()}`);
  },
  exposure: (varietyId: string, start: string, end: string) => {
    const params = new URLSearchParams({ varietyId, start, end });
    return climateRequest<import('../types').VarietyClimateExposureResult>(`/variety-features/exposure?${params.toString()}`);
  },
};

// Feature-engine config (VPD band thresholds, degree-hour base/cap) — fetched
// so the UI never hardcodes a second copy of these agronomy constants.
export const climateFeatureConfigApi = {
  get: () => climateRequest<import('../types').ClimateFeatureConfig>('/feature-config'),
};

// Phase 2 training dataset (fruit-instance / set-week-cohort climate exposure) — read-only, not consumed by any model yet.
export const climateTrainingDatasetApi = {
  get: (varietyId: string, year: number, grain: import('../types').ClimateTrainingDatasetGrain) =>
    request<import('../types').ClimateTrainingDatasetResult>(
      `/climate-training-dataset?varietyId=${varietyId}&year=${year}&grain=${grain}`
    ),
};

// GrowLink Connection — base URL + integration key used to call GrowLink's API.
// The secret key is write-only from the client's perspective: save/test send it,
// but get() never receives it back (only has_key/masked_key).
export const growlinkConnectionApi = {
  get: () => growlinkRequest<import('../types').GrowlinkConnection>('/connection'),
  save: (data: { base_url: string; secret_key?: string }) =>
    growlinkRequest<import('../types').GrowlinkConnection>('/connection', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  test: (data?: { base_url?: string; secret_key?: string }) =>
    growlinkRequest<import('../types').GrowlinkConnectionTestResult>('/connection/test', {
      method: 'POST',
      body: JSON.stringify(data ?? {}),
    }),
};

// GrowLink Variety Links — maps a local variety to GrowLink's external variety key
export const growlinkVarietyLinksApi = {
  list: (status?: import('../types').GrowlinkLinkStatus) =>
    growlinkRequest<import('../types').GrowlinkVarietyLink[]>(
      `/variety-links${status ? `?status=${status}` : ''}`
    ),
  create: (data: {
    variety_id: string;
    growlink_variety_key: string;
    link_status?: import('../types').GrowlinkLinkStatus;
    notes?: string | null;
  }) =>
    growlinkRequest<import('../types').GrowlinkVarietyLink>('/variety-links', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (
    id: string,
    data: { growlink_variety_key?: string; link_status?: import('../types').GrowlinkLinkStatus; notes?: string | null }
  ) =>
    growlinkRequest<import('../types').GrowlinkVarietyLink>(`/variety-links/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  setStatus: (id: string, link_status: import('../types').GrowlinkLinkStatus) =>
    growlinkRequest<import('../types').GrowlinkVarietyLink>(`/variety-links/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ link_status }),
    }),
  delete: (id: string) => growlinkRequest<void>(`/variety-links/${id}`, { method: 'DELETE' }),
};

// GrowLink Harvest Actuals — read-only; populated by the future GrowLink sync service
export const growlinkHarvestActualsApi = {
  list: (params?: { varietyId?: string; year?: number; matched?: boolean }) => {
    const q = new URLSearchParams();
    if (params?.varietyId) q.set('varietyId', params.varietyId);
    if (params?.year != null) q.set('year', String(params.year));
    if (params?.matched !== undefined) q.set('matched', String(params.matched));
    const qs = q.toString();
    return growlinkRequest<import('../types').GrowlinkHarvestActual[]>(`/harvest-actuals${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => growlinkRequest<import('../types').GrowlinkHarvestActual>(`/harvest-actuals/${id}`),
};

// Projection
export const projectionApi = {
  get: (varietyId: string, year: number) =>
    request<import('../types').ProjectionResult>(`/projection?varietyId=${varietyId}&year=${year}`),
};
