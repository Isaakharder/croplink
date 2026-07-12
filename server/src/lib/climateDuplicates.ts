// Collapses same-batch duplicate readings (multiple staged files resolving
// to the same zone + metric + timestamp) into exactly one canonical row per
// destination key — required because Postgres's `ON CONFLICT DO UPDATE`
// cannot affect the same target row twice within a single statement, and
// because silently picking an arbitrary duplicate for averaging would be
// non-deterministic. Values that agree (after rounding to climate_readings'
// column precision) are auto-collapsed; values that disagree are surfaced
// as a conflict requiring an explicit decision, never chosen arbitrarily.

// climate_readings.value is numeric(10,4) — round to this precision before
// comparing, so two readings that are the same to the column's precision
// aren't treated as "different" just because of extra float noise upstream.
const READING_VALUE_DECIMALS = 4;

function roundValue(v: number): number {
  const f = 10 ** READING_VALUE_DECIMALS;
  return Math.round(v * f) / f;
}

export interface StagedReadingLike {
  id: string;
  staged_file_id: string;
  organization_id: string | null;
  zone_label: string;
  measured_at: string;
  metric_name: string;
  value: number;
  unit: string | null;
}

export interface StagedFileLike {
  id: string;
  filename: string;
  filename_timestamp: string | null;
}

export interface BatchDuplicateGroup {
  conflictId: string;
  zoneLabel: string;
  metricName: string;
  measuredAt: string;
  isConflict: boolean;
  canonicalStagedFileId: string;
  candidates: { stagedFileId: string; filename: string; value: number }[];
}

// Deterministic tie-break for which duplicate "wins" by default: earliest
// filename timestamp, then filename ascending, then staged file id ascending
// — the same batch always produces the same result.
function compareStagedFiles(a: StagedFileLike, b: StagedFileLike): number {
  const ta = a.filename_timestamp ?? '';
  const tb = b.filename_timestamp ?? '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.filename !== b.filename) return a.filename < b.filename ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface CanonicalizeResult {
  /** Exactly one reading per (zone_label, metric_name, measured_at) — safe to feed straight into the rest of the pipeline. */
  canonicalReadings: StagedReadingLike[];
  /** Every duplicate-key group found, identical or conflicting, for reporting/preview. */
  groups: BatchDuplicateGroup[];
  /** Count of duplicate rows dropped because they were identical to the canonical one (not conflicts). */
  skippedIdenticalCount: number;
}

/**
 * `resolutions` (optional): conflictId -> chosen stagedFileId, for conflicts
 * the caller has already resolved. Unresolved conflicts still use the
 * deterministic default as their `canonicalStagedFileId` in the output, but
 * remain flagged `isConflict: true` so the caller can refuse to commit them.
 */
export function canonicalizeStagedReadings(
  readings: StagedReadingLike[],
  fileById: Map<string, StagedFileLike>,
  resolutions: Record<string, string> = {}
): CanonicalizeResult {
  const byKey = new Map<string, StagedReadingLike[]>();
  for (const r of readings) {
    const key = `${r.zone_label}|${r.metric_name}|${r.measured_at}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }

  const canonicalReadings: StagedReadingLike[] = [];
  const groups: BatchDuplicateGroup[] = [];
  let skippedIdenticalCount = 0;

  for (const [key, group] of byKey) {
    if (group.length === 1) {
      canonicalReadings.push(group[0]);
      continue;
    }

    const ranked = [...group].sort((a, b) => {
      const fa = fileById.get(a.staged_file_id);
      const fb = fileById.get(b.staged_file_id);
      if (!fa || !fb) return 0;
      return compareStagedFiles(fa, fb);
    });

    const roundedValues = ranked.map((r) => roundValue(r.value));
    const isConflict = !roundedValues.every((v) => v === roundedValues[0]);
    const conflictId = `batchdup:${key}`;

    let winner = ranked[0];
    if (isConflict) {
      const resolvedFileId = resolutions[conflictId];
      const resolvedReading = resolvedFileId ? ranked.find((r) => r.staged_file_id === resolvedFileId) : undefined;
      if (resolvedReading) winner = resolvedReading;
    } else {
      skippedIdenticalCount += ranked.length - 1;
    }

    canonicalReadings.push(winner);
    groups.push({
      conflictId,
      zoneLabel: ranked[0].zone_label,
      metricName: ranked[0].metric_name,
      measuredAt: ranked[0].measured_at,
      isConflict,
      canonicalStagedFileId: winner.staged_file_id,
      candidates: ranked.map((r) => ({
        stagedFileId: r.staged_file_id,
        filename: fileById.get(r.staged_file_id)?.filename ?? '?',
        value: r.value,
      })),
    });
  }

  return { canonicalReadings, groups, skippedIdenticalCount };
}
