import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { chunkArray } from '../lib/chunkArray';

const router = Router();

const OFFSETS = [4, 5, 6, 7, 8, 9, 10];
const MIN_SAMPLE_SIZE_FOR_LEARNED_PROFILE = 5;
// Breaker-to-harvest buckets, in weeks since first BreakerFruit observation.
const BUCKET_KEYS = ['same', 'plus1', 'plus2', 'plus3', 'later'] as const;
type BucketKey = (typeof BUCKET_KEYS)[number];
type Profile = Record<BucketKey, number>; // fractions 0..1, sums to 1

function getIsoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

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
    // Profile has no probability mass left anywhere for this instance —
    // degenerate case. Fall back to a single concrete "next week" forecast,
    // identical to the simple breaker_week+1-vs-today+1 rule.
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

// GET /ripening-actuals?varietyId=&year=
// Actual set→harvest timing grid + summary, derived entirely from fruit_instances
// (the real per-node status history), not manually-entered percentages. Also
// surfaces a provisional breaker-fruit forecast for the +4..+10 columns,
// distributed across weeks using a learned (or, below n=5, next-week-fallback)
// breaker-to-harvest timing profile — clearly separated from confirmed harvests.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { varietyId, year } = req.query;
    if (!varietyId || !year) {
      return res.status(400).json({ error: 'varietyId and year are required' });
    }
    const yearNum = Number(year);

    const { data: instances, error } = await supabase
      .from('fruit_instances')
      .select(
        'id, plant_node_id, set_week_number, set_date, status, harvested_year, harvested_week_number, breaker_year, breaker_week_number, breaker_date, measurement_row_id, measurement_stem_id'
      )
      .eq('variety_id', varietyId as string)
      .eq('set_year', yearNum);
    if (error) throw new Error(error.message);

    const all = instances ?? [];

    // Resolve row/stem/node labels for the sample tooltips and the
    // expandable instance-detail table (display only — not used in any
    // calculation).
    const rowIds = Array.from(new Set(all.map((i) => i.measurement_row_id)));
    const stemIds = Array.from(new Set(all.map((i) => i.measurement_stem_id)));
    const nodeIds = Array.from(new Set(all.map((i) => i.plant_node_id)));
    const [{ data: rowsMeta }, { data: stemsMeta }, { data: nodesMeta }] = await Promise.all([
      rowIds.length > 0
        ? supabase.from('measurement_rows').select('id, row_name').in('id', rowIds)
        : Promise.resolve({ data: [] as { id: string; row_name: string }[] }),
      stemIds.length > 0
        ? supabase.from('measurement_stems').select('id, stem_name').in('id', stemIds)
        : Promise.resolve({ data: [] as { id: string; stem_name: string }[] }),
      nodeIds.length > 0
        ? supabase.from('plant_nodes').select('id, node_number').in('id', nodeIds)
        : Promise.resolve({ data: [] as { id: string; node_number: number }[] }),
    ]);
    const rowNameById = new Map((rowsMeta ?? []).map((r) => [r.id, r.row_name]));
    const stemNameById = new Map((stemsMeta ?? []).map((s) => [s.id, s.stem_name]));
    const nodeNumberById = new Map((nodesMeta ?? []).map((n) => [n.id, n.node_number]));
    const stemLabel = (i: { measurement_row_id: string; measurement_stem_id: string }) =>
      `${rowNameById.get(i.measurement_row_id) ?? '?'} / ${stemNameById.get(i.measurement_stem_id) ?? '?'}`;

    // "Now" as an absolute week number (year*52 + week) using the same
    // 52-week-per-year convention used elsewhere in the app (breakerLearning,
    // harvestProjections), so offset windows that haven't happened yet can be
    // told apart from windows that happened with zero harvests.
    const today = new Date();
    const currentActualYear = today.getFullYear();
    const currentActualWeek = getIsoWeek(today);
    const nowAbsWeek =
      yearNum < currentActualYear
        ? yearNum * 52 + 52
        : yearNum > currentActualYear
          ? yearNum * 52
          : yearNum * 52 + currentActualWeek;
    // True "today", unscoped by the selected year — used to roll a breaker
    // forecast forward when its original predicted week has already elapsed.
    const todayAbsWeek = currentActualYear * 52 + currentActualWeek;

    // ── Learned breaker-to-harvest profile (variety-wide, all years) ────────
    // For every completed instance that has both a first-breaker week and a
    // harvest week, breaker_to_harvest_weeks tells us how the variety
    // actually converts. Below MIN_SAMPLE_SIZE_FOR_LEARNED_PROFILE
    // observations that's not trustworthy, so we fall back to the simple
    // "100% next week" assumption — identical to the single-bucket behavior
    // this replaces.
    const { data: learnedRows, error: learnedErr } = await supabase
      .from('fruit_instances')
      .select('breaker_year, breaker_week_number, harvested_year, harvested_week_number')
      .eq('variety_id', varietyId as string)
      .eq('status', 'harvested')
      .not('breaker_week_number', 'is', null)
      .not('breaker_year', 'is', null);
    if (learnedErr) throw new Error(learnedErr.message);

    const breakerToHarvestWeeks = (learnedRows ?? [])
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
    // fruit_instances.breaker_week_number is the FIRST week this fruit was ever
    // observed as BreakerFruit (handleBreaker() in weeklyStatuses.ts is
    // idempotent and never overwrites it), so it's already the correct anchor
    // — no drifting forward every week. status='set' excludes anything already
    // Harvested/Aborted/Pruned. What it does NOT guarantee is that the fruit is
    // *still* BreakerFruit today (it could have quietly progressed without a
    // fresh weekly_node_statuses row updating fruit_instances), so we also
    // cross-check each candidate node's latest recorded status below.
    const breakerCandidates = all.filter((i) => i.status === 'set' && i.breaker_week_number != null);

    const candidateNodeIds = Array.from(new Set(breakerCandidates.map((i) => i.plant_node_id)));
    const latestStatusByNode = new Map<string, { year: number; week_number: number; status: string }>();
    if (candidateNodeIds.length > 0) {
      const chunkResults = await Promise.all(
        chunkArray(candidateNodeIds, 100).map((ids) =>
          supabase
            .from('weekly_node_statuses')
            .select('plant_node_id, year, week_number, status')
            .in('plant_node_id', ids)
        )
      );
      for (const { data } of chunkResults) {
        for (const row of data ?? []) {
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

    // Split candidates: currently BreakerFruit (drives the live forecast) vs
    // "unreconciled" — status='set' with breaker history, but the latest
    // recorded status no longer corroborates BreakerFruit (and no
    // Harvested/Aborted/Pruned sync has resolved it either). A data-quality
    // signal, not a forecast input.
    const currentBreakers = breakerCandidates.filter(
      (i) => latestStatusByNode.get(i.plant_node_id)?.status === 'BreakerFruit'
    );
    const unreconciled = breakerCandidates.filter(
      (i) => latestStatusByNode.get(i.plant_node_id)?.status !== 'BreakerFruit'
    );

    type BreakerInst = (typeof currentBreakers)[number];
    const breakerBySetWeek = new Map<number, BreakerInst[]>();
    for (const b of currentBreakers) {
      const sw = b.set_week_number as number;
      if (!breakerBySetWeek.has(sw)) breakerBySetWeek.set(sw, []);
      breakerBySetWeek.get(sw)!.push(b);
    }
    const unreconciledBySetWeek = new Map<number, number>();
    for (const u of unreconciled) {
      const sw = u.set_week_number as number;
      unreconciledBySetWeek.set(sw, (unreconciledBySetWeek.get(sw) ?? 0) + 1);
    }

    type Inst = (typeof all)[number];
    const bySetWeek = new Map<number, Inst[]>();
    for (const inst of all) {
      const sw = inst.set_week_number as number;
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

        const harvestedOffsetGroups = new Map<number, Inst[]>();
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

        // ── Breaker forecast: distribute each currently-breaker instance's
        // probability mass across future weeks using the learned/fallback
        // profile, conditioned on it still being unharvested (never placing
        // any mass in an elapsed week). Also keep the simple single-bucket
        // "original vs live" prediction per instance for the detail table and
        // rolled-forward accuracy tracking — independent of the distribution.
        const breakerGroup = breakerBySetWeek.get(setWeekNumber) ?? [];
        const breakerOffsetExpected = new Map<number, number>(); // setOffset -> fractional expected count
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

          // Simple single-bucket prediction (audit/accuracy tracking only).
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

          // Probabilistic distribution (drives the grid's expected counts).
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

        // Compact detail table for the expandable row — every instance in
        // this set week, so the underlying fruit can be inspected without a
        // database query.
        const instanceDetails = group.map((inst) => {
          const forecast = instanceForecasts.get(inst.id);
          const latest = latestStatusByNode.get(inst.plant_node_id);
          // Same definition used for row.unreconciledCount above: a breaker
          // anchor was recorded, the fruit hasn't resolved to
          // Harvested/Aborted/Pruned, but the latest recorded status no
          // longer confirms BreakerFruit. This does NOT rewrite or clear
          // breaker_week_number — it's surfaced for review, not corrected
          // automatically, since we can't tell from the data alone whether
          // the original BreakerFruit entry was a genuine (if brief)
          // biological transition or a same-week data-entry correction.
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

    // ── Summary (aggregated across all set weeks for this variety/year) ─────
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

    // Cumulative — "% harvested BY +N weeks" (offset <= N), not exact-offset —
    // that's what the per-row grid columns already show.
    const cumulativePercentByOffset: Record<string, number> = {};
    for (const offset of [6, 7, 8, 9, 10]) {
      const count = weeksToHarvestList.filter((w) => w <= offset).length;
      cumulativePercentByOffset[`week${offset}`] =
        completed.length > 0 ? Math.round((count / completed.length) * 1000) / 10 : 0;
    }

    res.json({
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
    });
  } catch (e) {
    next(e);
  }
});

export default router;
