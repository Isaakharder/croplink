import { Router, Request, Response, NextFunction } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { chunkArray } from '../lib/chunkArray';
import { fetchAllRows } from '../lib/paginatedFetch';
import { greenhouseIsoWeek } from '../lib/isoWeek';

const router = Router();

const OFFSETS = [4, 5, 6, 7, 8, 9, 10];
const MIN_SAMPLE_SIZE_FOR_LEARNED_PROFILE = 5;
// Breaker-to-harvest buckets, in weeks since first BreakerFruit observation.
const BUCKET_KEYS = ['same', 'plus1', 'plus2', 'plus3', 'later'] as const;
type BucketKey = (typeof BUCKET_KEYS)[number];
type Profile = Record<BucketKey, number>; // fractions 0..1, sums to 1

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10
    : sorted[mid];
}

function mode(values: number[]): number | null {
  if (values.length === 0) return null;
  const freq: Record<number, number> = {};
  for (const v of values) freq[v] = (freq[v] ?? 0) + 1;
  let best: number | null = null;
  let bestCount = 0;
  for (const [k, count] of Object.entries(freq)) {
    if (count > bestCount) {
      bestCount = count;
      best = Number(k);
    }
  }
  return best;
}

function bucketKeyForOffset(offset: number): BucketKey {
  if (offset <= 0) return 'same';
  if (offset === 1) return 'plus1';
  if (offset === 2) return 'plus2';
  if (offset === 3) return 'plus3';
  return 'later';
}

const FALLBACK_PROFILE: Profile = { same: 0, plus1: 1, plus2: 0, plus3: 0, later: 0 };

/**
 * Distributes one currently-breaker fruit instance's harvest probability
 * across future weeks using a breaker-to-harvest profile, conditioned on the
 * fruit still being unharvested as of "today" — no probability is ever
 * placed in a week that has already elapsed. Buckets 'same'..'plus3' resolve
 * to a concrete absolute week; 'later' is inherently open-ended and has no
 * single week, so its mass is returned separately.
 *
 * If conditioning eliminates every bucket's probability (the fruit has
 * already outlasted everything the profile has ever observed), all mass
 * falls back to a single concrete forecast of "next week" — the same rule
 * used when there isn't enough history to learn a profile at all, which is
 * what keeps low-sample-size behavior identical to the simple fallback.
 */
function distributeBreakerInstance(
  breakerAbsWeek: number,
  todayAbsWeek: number,
  profile: Profile
): { weekContributions: { absoluteWeek: number; fraction: number }[]; laterFraction: number } {
  const elapsed = Math.max(0, todayAbsWeek - breakerAbsWeek);
  const minValidBucketIndex = elapsed + 1; // 0=same,1=plus1,2=plus2,3=plus3 — index below this has already passed

  const bucketWeight: Record<BucketKey, number> = { ...profile };
  const validWeight: Record<BucketKey, number> = { same: 0, plus1: 0, plus2: 0, plus3: 0, later: 0 };
  const bucketIndex: Record<Exclude<BucketKey, 'later'>, number> = { same: 0, plus1: 1, plus2: 2, plus3: 3 };
  for (const key of (['same', 'plus1', 'plus2', 'plus3'] as const)) {
    validWeight[key] = bucketIndex[key] >= minValidBucketIndex ? bucketWeight[key] : 0;
  }
  // 'later' is open-ended (any week 4+), so it can never be fully "in the
  // past" — it always remains a valid (if imprecise) bucket.
  validWeight.later = bucketWeight.later;

  const sumValid = BUCKET_KEYS.reduce((s, k) => s + validWeight[k], 0);

  if (sumValid <= 0) {
    return { weekContributions: [{ absoluteWeek: todayAbsWeek + 1, fraction: 1 }], laterFraction: 0 };
  }

  const weekContributions: { absoluteWeek: number; fraction: number }[] = [];
  for (const key of (['same', 'plus1', 'plus2', 'plus3'] as const)) {
    if (validWeight[key] <= 0) continue;
    weekContributions.push({
      absoluteWeek: breakerAbsWeek + bucketIndex[key],
      fraction: validWeight[key] / sumValid,
    });
  }
  const laterFraction = validWeight.later / sumValid;

  return { weekContributions, laterFraction };
}

interface FruitInstanceFull {
  id: string; plant_node_id: string; set_week_number: number; set_date: string; status: string;
  harvested_year: number | null; harvested_week_number: number | null;
  breaker_year: number | null; breaker_week_number: number | null; breaker_date: string | null;
  measurement_row_id: string; measurement_stem_id: string;
}

/**
 * Core calculation, extracted from the route handler for direct testing.
 *
 * Four fruit_instances/weekly_node_statuses queries here are now paginated
 * (were unbounded): the main set-year instance fetch, the row/stem/node
 * metadata lookups (bounded by DISTINCT ids appearing in the instance set,
 * which for nodes can approach the full paginated instance count), the
 * variety-wide "learned breaker-to-harvest profile" fetch (deliberately
 * all-years — preserved exactly, not scoped to `year`, matching
 * breakerLearning.ts's identical design), and the currently-breaking
 * candidates' status history (previously had NO year/week filter at all —
 * chunked by 100 nodes, but each chunk could return many weeks' worth of
 * history per node, unbounded within the chunk).
 *
 * None of this route's calculations depend on row order: offset grouping,
 * median/mode, and the "latest status per node" reduction (a max over
 * (year, week) pairs) are all order-independent as long as pagination
 * returns the complete set — which is exactly what fetchAllRows guarantees.
 * Default id-ASC ordering is sufficient; no chronological compound order
 * is required.
 *
 * `today` is injectable for deterministic testing.
 */
export async function computeRipeningActuals(
  supabaseClient: SupabaseClient,
  varietyId: string,
  yearNum: number,
  today: Date = new Date()
) {
  const all = await fetchAllRows<FruitInstanceFull>(() =>
    supabaseClient
      .from('fruit_instances')
      .select(
        'id, plant_node_id, set_week_number, set_date, status, harvested_year, harvested_week_number, breaker_year, breaker_week_number, breaker_date, measurement_row_id, measurement_stem_id'
      )
      .eq('variety_id', varietyId)
      .eq('set_year', yearNum)
  );

  // Resolve row/stem/node labels for the sample tooltips and the
  // expandable instance-detail table (display only — not used in any
  // calculation). Node count can approach the full instance count for a
  // variety with mostly-distinct nodes per fruit (confirmed live: ~1,300
  // distinct node IDs), so `.in('id', nodeIds)` alone can exceed the
  // URL/header size limit (same reason chunkArray exists elsewhere in this
  // codebase) — chunk by ID batch AND paginate each chunk, since the two
  // limits (request size, response row count) are independent.
  const rowIds = Array.from(new Set(all.map((i) => i.measurement_row_id)));
  const stemIds = Array.from(new Set(all.map((i) => i.measurement_stem_id)));
  const nodeIds = Array.from(new Set(all.map((i) => i.plant_node_id)));
  const [rowsMeta, stemsMeta, nodesMeta] = await Promise.all([
    rowIds.length > 0
      ? fetchAllRows<{ id: string; row_name: string }>(() => supabaseClient.from('measurement_rows').select('id, row_name').in('id', rowIds))
      : Promise.resolve([]),
    stemIds.length > 0
      ? fetchAllRows<{ id: string; stem_name: string }>(() => supabaseClient.from('measurement_stems').select('id, stem_name').in('id', stemIds))
      : Promise.resolve([]),
    nodeIds.length > 0
      ? Promise.all(
          chunkArray(nodeIds, 100).map((ids) =>
            fetchAllRows<{ id: string; node_number: number }>(() => supabaseClient.from('plant_nodes').select('id, node_number').in('id', ids))
          )
        ).then((chunks) => chunks.flat())
      : Promise.resolve([]),
  ]);
  const rowNameById = new Map(rowsMeta.map((r) => [r.id, r.row_name]));
  const stemNameById = new Map(stemsMeta.map((s) => [s.id, s.stem_name]));
  const nodeNumberById = new Map(nodesMeta.map((n) => [n.id, n.node_number]));
  const stemLabel = (i: { measurement_row_id: string; measurement_stem_id: string }) =>
    `${rowNameById.get(i.measurement_row_id) ?? '?'} / ${stemNameById.get(i.measurement_stem_id) ?? '?'}`;

  // Greenhouse week (America/Toronto), not the server's UTC clock.
  const { year: currentActualYear, week: currentActualWeek } = greenhouseIsoWeek(today);
  const nowAbsWeek =
    yearNum < currentActualYear
      ? yearNum * 52 + 52
      : yearNum > currentActualYear
        ? yearNum * 52
        : yearNum * 52 + currentActualWeek;
  const todayAbsWeek = currentActualYear * 52 + currentActualWeek;

  // ── Learned breaker-to-harvest profile (variety-wide, all years) ────────
  // Paginated — was unbounded. Intentionally NOT scoped to `year` (matches
  // breakerLearning.ts's identical "all years" design), only the pagination
  // is new.
  const learnedRows = await fetchAllRows<{
    breaker_year: number | null; breaker_week_number: number | null;
    harvested_year: number | null; harvested_week_number: number | null;
  }>(() =>
    supabaseClient
      .from('fruit_instances')
      .select('breaker_year, breaker_week_number, harvested_year, harvested_week_number')
      .eq('variety_id', varietyId)
      .eq('status', 'harvested')
      .not('breaker_week_number', 'is', null)
      .not('breaker_year', 'is', null)
  );

  const breakerToHarvestWeeks = learnedRows
    .filter((r) => r.harvested_week_number != null && r.harvested_year != null)
    .map((r) => (r.harvested_year! - r.breaker_year!) * 52 + r.harvested_week_number! - r.breaker_week_number!);

  const learnedSampleSize = breakerToHarvestWeeks.length;
  const usingLearnedProfile = learnedSampleSize >= MIN_SAMPLE_SIZE_FOR_LEARNED_PROFILE;

  let profile: Profile;
  if (usingLearnedProfile) {
    const bucketCounts: Record<BucketKey, number> = { same: 0, plus1: 0, plus2: 0, plus3: 0, later: 0 };
    for (const w of breakerToHarvestWeeks) bucketCounts[bucketKeyForOffset(w)]++;
    profile = {
      same: bucketCounts.same / learnedSampleSize,
      plus1: bucketCounts.plus1 / learnedSampleSize,
      plus2: bucketCounts.plus2 / learnedSampleSize,
      plus3: bucketCounts.plus3 / learnedSampleSize,
      later: bucketCounts.later / learnedSampleSize,
    };
  } else {
    profile = FALLBACK_PROFILE;
  }

  const pct1 = (v: number) => Math.round(v * 1000) / 10; // fraction -> % to 1 decimal

  // ── Breaker forecast candidates ──────────────────────────────────────────
  const breakerCandidates = all.filter((i) => i.status === 'set' && i.breaker_week_number != null);

  const candidateNodeIds = Array.from(new Set(breakerCandidates.map((i) => i.plant_node_id)));
  const latestStatusByNode = new Map<string, { year: number; week_number: number; status: string }>();
  if (candidateNodeIds.length > 0) {
    // Paginated per chunk — was unbounded within each 100-node chunk (no
    // year/week filter at all, so a chunk could return many weeks' worth
    // of history per node).
    const chunkResults = await Promise.all(
      chunkArray(candidateNodeIds, 100).map((ids) =>
        fetchAllRows<{ plant_node_id: string; year: number; week_number: number; status: string }>(() =>
          supabaseClient
            .from('weekly_node_statuses')
            .select('plant_node_id, year, week_number, status')
            .in('plant_node_id', ids)
        )
      )
    );
    for (const data of chunkResults) {
      for (const row of data) {
        const existing = latestStatusByNode.get(row.plant_node_id);
        const isNewer =
          !existing || row.year > existing.year || (row.year === existing.year && row.week_number > existing.week_number);
        if (isNewer) {
          latestStatusByNode.set(row.plant_node_id, {
            year: row.year,
            week_number: row.week_number,
            status: row.status,
          });
        }
      }
    }
  }

  const currentBreakers = breakerCandidates.filter(
    (i) => latestStatusByNode.get(i.plant_node_id)?.status === 'BreakerFruit'
  );
  const unreconciled = breakerCandidates.filter(
    (i) => latestStatusByNode.get(i.plant_node_id)?.status !== 'BreakerFruit'
  );

  type BreakerInst = (typeof currentBreakers)[number];
  const breakerBySetWeek = new Map<number, BreakerInst[]>();
  for (const b of currentBreakers) {
    const sw = b.set_week_number;
    if (!breakerBySetWeek.has(sw)) breakerBySetWeek.set(sw, []);
    breakerBySetWeek.get(sw)!.push(b);
  }
  const unreconciledBySetWeek = new Map<number, number>();
  for (const u of unreconciled) {
    const sw = u.set_week_number;
    unreconciledBySetWeek.set(sw, (unreconciledBySetWeek.get(sw) ?? 0) + 1);
  }

  const bySetWeek = new Map<number, FruitInstanceFull[]>();
  for (const inst of all) {
    const sw = inst.set_week_number;
    if (!bySetWeek.has(sw)) bySetWeek.set(sw, []);
    bySetWeek.get(sw)!.push(inst);
  }

  const rows = Array.from(bySetWeek.entries())
    .sort(([a], [b]) => a - b)
    .map(([setWeekNumber, group]) => {
      const setCount = group.length;
      const harvested = group.filter((i) => i.status === 'harvested');
      const aborted = group.filter((i) => i.status === 'aborted');
      const pruned = group.filter((i) => i.status === 'pruned');
      const setAbsWeek = yearNum * 52 + setWeekNumber;

      const harvestedOffsetGroups = new Map<number, FruitInstanceFull[]>();
      let outsideWindowHarvestedCount = 0;
      for (const h of harvested) {
        if (h.harvested_week_number == null || h.harvested_year == null) continue;
        const offset = (h.harvested_year - yearNum) * 52 + h.harvested_week_number - setWeekNumber;
        if (OFFSETS.includes(offset)) {
          if (!harvestedOffsetGroups.has(offset)) harvestedOffsetGroups.set(offset, []);
          harvestedOffsetGroups.get(offset)!.push(h);
        } else {
          outsideWindowHarvestedCount++;
        }
      }

      const breakerGroup = breakerBySetWeek.get(setWeekNumber) ?? [];
      const breakerOffsetExpected = new Map<number, number>();
      const breakerOffsetSamples = new Map<number, BreakerInst[]>();
      let breakerEarlierExpectedCount = 0;
      let breakerLaterExpectedCount = 0;
      let rolledForwardCount = 0;

      const instanceForecasts = new Map<
        string,
        { originalExpectedWeek: number; liveExpectedWeek: number; originalOffset: number; liveOffset: number; rolledForward: boolean }
      >();

      for (const b of breakerGroup) {
        const breakerAbsWeek = b.breaker_year! * 52 + b.breaker_week_number!;

        const originalExpectedAbsWeek = breakerAbsWeek + 1;
        const liveExpectedAbsWeek = Math.max(originalExpectedAbsWeek, todayAbsWeek + 1);
        const rolledForward = liveExpectedAbsWeek !== originalExpectedAbsWeek;
        if (rolledForward) rolledForwardCount++;
        instanceForecasts.set(b.id, {
          originalExpectedWeek: originalExpectedAbsWeek - yearNum * 52,
          liveExpectedWeek: liveExpectedAbsWeek - yearNum * 52,
          originalOffset: originalExpectedAbsWeek - setAbsWeek,
          liveOffset: liveExpectedAbsWeek - setAbsWeek,
          rolledForward,
        });

        const { weekContributions, laterFraction } = distributeBreakerInstance(breakerAbsWeek, todayAbsWeek, profile);
        for (const { absoluteWeek, fraction } of weekContributions) {
          const setOffset = absoluteWeek - setAbsWeek;
          if (OFFSETS.includes(setOffset)) {
            breakerOffsetExpected.set(setOffset, (breakerOffsetExpected.get(setOffset) ?? 0) + fraction);
            if (!breakerOffsetSamples.has(setOffset)) breakerOffsetSamples.set(setOffset, []);
            if (breakerOffsetSamples.get(setOffset)!.length < 5) breakerOffsetSamples.get(setOffset)!.push(b);
          } else if (setOffset < OFFSETS[0]) {
            breakerEarlierExpectedCount += fraction;
          } else {
            breakerLaterExpectedCount += fraction;
          }
        }
        breakerLaterExpectedCount += laterFraction;
      }

      const offsets = OFFSETS.map((offset) => {
        const targetAbsWeek = yearNum * 52 + setWeekNumber + offset;
        const hasOccurred = nowAbsWeek >= targetAbsWeek;

        const harvestedCells = harvestedOffsetGroups.get(offset) ?? [];
        const harvestedCount = harvestedCells.length;
        const harvestedPercent = setCount > 0 ? Math.round((harvestedCount / setCount) * 1000) / 10 : 0;

        const breakerExpectedCount = Math.round((breakerOffsetExpected.get(offset) ?? 0) * 100) / 100;
        const breakerExpectedPercent = setCount > 0 ? pct1((breakerOffsetExpected.get(offset) ?? 0) / setCount) : 0;
        const breakerSamples = breakerOffsetSamples.get(offset) ?? [];

        return {
          offset,
          hasOccurred,
          harvestedCount,
          harvestedPercent,
          harvestedSampleStems: harvestedCells.slice(0, 5).map(stemLabel),
          breakerExpectedCount,
          breakerExpectedPercent,
          breakerSampleStems: breakerSamples.map(stemLabel),
        };
      });

      const harvestedPercent = setCount > 0 ? Math.round((harvested.length / setCount) * 1000) / 10 : 0;
      const breakerTotalCount = breakerGroup.length;
      const breakerPercent = setCount > 0 ? Math.round((breakerTotalCount / setCount) * 1000) / 10 : 0;
      const unreconciledCount = unreconciledBySetWeek.get(setWeekNumber) ?? 0;
      const otherOutstandingCount = setCount - harvested.length - aborted.length - pruned.length - breakerTotalCount - unreconciledCount;

      const instanceDetails = group.map((inst) => {
        const forecast = instanceForecasts.get(inst.id);
        const latest = latestStatusByNode.get(inst.plant_node_id);
        const needsReview = inst.status === 'set' && inst.breaker_week_number != null && latest?.status !== 'BreakerFruit';
        const needsReviewReason = needsReview
          ? [
              `Breaker recorded: Week ${inst.breaker_week_number}`,
              `Latest status: ${latest?.status ?? 'unknown'}${latest?.week_number != null ? `, Week ${latest.week_number}` : ''}`,
              'Reason: breaker anchor exists but latest status is not BreakerFruit or Harvested',
            ].join('\n')
          : null;
        return {
          id: inst.id,
          row: rowNameById.get(inst.measurement_row_id) ?? '?',
          stem: stemNameById.get(inst.measurement_stem_id) ?? '?',
          node: nodeNumberById.get(inst.plant_node_id) ?? null,
          setWeek: inst.set_week_number,
          setDate: inst.set_date,
          status: inst.status,
          firstBreakerWeek: inst.breaker_week_number ?? null,
          breakerDate: inst.breaker_date ?? null,
          latestStatus: latest?.status ?? null,
          latestStatusWeek: latest?.week_number ?? null,
          actualHarvestWeek: inst.harvested_week_number ?? null,
          originalExpectedHarvestWeek: forecast?.originalExpectedWeek ?? null,
          currentExpectedHarvestWeek: forecast?.liveExpectedWeek ?? null,
          rolledForward: forecast?.rolledForward ?? false,
          needsReview,
          needsReviewReason,
        };
      });

      return {
        setWeekNumber,
        setCount,
        harvestedCount: harvested.length,
        harvestedPercent,
        abortedCount: aborted.length,
        prunedCount: pruned.length,
        otherOutstandingCount,
        unreconciledCount,
        outsideWindowHarvestedCount,
        breakerCount: breakerTotalCount,
        breakerPercent,
        breakerEarlierExpectedCount: Math.round(breakerEarlierExpectedCount * 100) / 100,
        breakerLaterExpectedCount: Math.round(breakerLaterExpectedCount * 100) / 100,
        breakerRolledForwardCount: rolledForwardCount,
        offsets,
        instances: instanceDetails,
      };
    });

  const totalSetInstances = all.length;
  const completed = all.filter((i) => i.status === 'harvested');
  const totalOutstanding = all.filter((i) => i.status === 'set').length;
  const totalAborted = all.filter((i) => i.status === 'aborted').length;
  const totalPruned = all.filter((i) => i.status === 'pruned').length;

  const weeksToHarvestList = completed
    .filter((i) => i.harvested_week_number != null && i.harvested_year != null)
    .map((i) => (i.harvested_year! - yearNum) * 52 + i.harvested_week_number! - i.set_week_number);

  const avgWeeksToHarvest =
    weeksToHarvestList.length > 0
      ? Math.round((weeksToHarvestList.reduce((a, b) => a + b, 0) / weeksToHarvestList.length) * 10) / 10
      : null;

  const cumulativePercentByOffset: Record<string, number> = {};
  for (const offset of [6, 7, 8, 9, 10]) {
    const count = weeksToHarvestList.filter((w) => w <= offset).length;
    cumulativePercentByOffset[`week${offset}`] =
      completed.length > 0 ? Math.round((count / completed.length) * 1000) / 10 : 0;
  }

  return {
    rows,
    summary: {
      totalSetInstances,
      totalCompleted: completed.length,
      totalOutstanding,
      totalAborted,
      totalPruned,
      totalCurrentBreakers: currentBreakers.length,
      totalUnreconciled: unreconciled.length,
      totalBreakerRolledForward: rows.reduce((sum, r) => sum + r.breakerRolledForwardCount, 0),
      sampleSize: completed.length,
      avgWeeksToHarvest,
      medianWeeksToHarvest: median(weeksToHarvestList),
      modeWeeksToHarvest: mode(weeksToHarvestList),
      cumulativePercentByOffset,
    },
    breakerForecast: {
      method: usingLearnedProfile ? 'learned' : 'fallback',
      sampleSize: learnedSampleSize,
      minSampleSize: MIN_SAMPLE_SIZE_FOR_LEARNED_PROFILE,
      profilePercent: {
        same: pct1(profile.same),
        plus1: pct1(profile.plus1),
        plus2: pct1(profile.plus2),
        plus3: pct1(profile.plus3),
        later: pct1(profile.later),
      },
    },
    currentWeek: yearNum === currentActualYear ? currentActualWeek : null,
  };
}

// GET /ripening-actuals?varietyId=&year=
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, year } = req.query;
    if (!varietyId || !year) {
      return res.status(400).json({ error: 'varietyId and year are required' });
    }
    const result = await computeRipeningActuals(supabase, varietyId as string, Number(year));
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
