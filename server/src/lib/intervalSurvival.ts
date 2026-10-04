// Interval-censored competing-risk survival for tracked fruit (research).
//
// Surveyors visit every tracked stem weekly but record a node only when its
// status changes, and in some weeks (2026: W35, W37) harvested fruit was not
// marked at all — those fruit show up as "Harvested" at the next survey. So
// the survey week a harvest is recorded in is only an upper bound: the true
// harvest happened somewhere in (last survey that would have caught it,
// recording survey]. Treating the recording week as the harvest week is what
// produced the alternating 0 / ~100 harvested-fruit weeks.
//
// This module:
//  - infers which survey weeks actually checked harvest status;
//  - turns each fruit into an interval-censored observation (harvest or
//    loss in ages (l, u]) or a right-censored one (still open through age c),
//    using every cohort — recent, immature ones included — with censoring
//    rather than a maturity cut;
//  - fits discrete-time hazards by fruit age for harvest and for loss
//    (abort + prune) with an EM (Turnbull-style) algorithm;
//  - forecasts future harvests from still-open fruit;
//  - gives stem-bootstrap prediction intervals.
//
// Breaker / MatureGreen statuses only narrow the interval (they prove the
// fruit was still on the plant); they never add fruit.
import { StatusEvent, KnowledgeCutoff, MAX_AGE, MIN_SAMPLE } from './harvestForecast';
import { harvestWindowFraction } from './cropWindow';
import { isoWeekIndex } from './isoWeek';

/** A survey week counts as having checked harvest when harvested ≥ this share of fruit that were ripening (MatureGreen/Breaker) at the previous survey. 2026 data: unchecked weeks ≤ 0.01, checked weeks ≥ 0.17. */
export const HARVEST_CHECK_MIN_RATIO = 0.1;
/** Below this many ripening candidates a week can't be judged and is treated as checked. */
export const HARVEST_CHECK_MIN_CANDIDATES = 10;
const RIPENING = new Set(['MatureGreen', 'BreakerFruit']);

export interface FruitObservation {
  nodeId: string;
  stemId: string;
  setIndex: number;
  outcome: 'open' | 'harvested' | 'lost';
  /** Event happened in survey weeks (lo, hi]. For open fruit: known still on the plant through lo, hi = null. */
  lo: number;
  hi: number | null;
}

function visible(events: StatusEvent[], cutoff?: KnowledgeCutoff): StatusEvent[] {
  const ordered = cutoff
    ? events.filter((e) => isoWeekIndex(e.year, e.week) <= cutoff.asOfIndex && new Date(e.createdAt) <= cutoff.enteredBy)
    : [...events];
  return ordered.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || isoWeekIndex(a.year, a.week) - isoWeekIndex(b.year, b.week)
  );
}

export function inferHarvestCheckWeeks(events: StatusEvent[], cutoff?: KnowledgeCutoff): Set<number> {
  const byWeek = new Map<number, StatusEvent[]>();
  for (const e of visible(events, cutoff)) {
    const i = isoWeekIndex(e.year, e.week);
    if (!byWeek.has(i)) byWeek.set(i, []);
    byWeek.get(i)!.push(e);
  }
  const latest = new Map<string, string>();
  const checked = new Set<number>();
  for (const w of [...byWeek.keys()].sort((a, b) => a - b)) {
    const rows = byWeek.get(w)!;
    let candidates = 0;
    for (const s of latest.values()) if (RIPENING.has(s)) candidates++;
    const harvested = rows.filter((r) => r.status === 'Harvested').length;
    if (candidates < HARVEST_CHECK_MIN_CANDIDATES || harvested / candidates >= HARVEST_CHECK_MIN_RATIO) checked.add(w);
    for (const r of rows) latest.set(r.plantNodeId, r.status);
  }
  return checked;
}

/**
 * Same lifecycle rules as replayFruitLifecycles (one open fruit per node,
 * earlier SetFruit moves the set week back, Harvested/Aborted/Pruned close
 * it), additionally tracking the last week each fruit was seen on the
 * plant. `checkWeeks` = 'all' reproduces the naive "recorded week = harvest
 * week" reading.
 */
export function buildFruitObservations(events: StatusEvent[], cutoff?: KnowledgeCutoff, checkWeeks: Set<number> | 'all' = 'all'): FruitObservation[] {
  const rows = visible(events, cutoff);
  const asOf = cutoff?.asOfIndex ?? Math.max(...rows.map((e) => isoWeekIndex(e.year, e.week)));
  const checks = checkWeeks === 'all' ? null : [...checkWeeks].sort((a, b) => a - b);
  const lastCheckBefore = (limit: number, floor: number) => {
    if (!checks) return limit - 1;
    let best = floor;
    for (const c of checks) { if (c < limit && c > best) best = c; }
    return best;
  };

  type Open = FruitObservation & { lastSeen: number };
  const out: FruitObservation[] = [];
  const openByNode = new Map<string, Open>();
  for (const e of rows) {
    const idx = isoWeekIndex(e.year, e.week);
    const open = openByNode.get(e.plantNodeId);
    if (e.status === 'SetFruit') {
      if (open) {
        if (idx < open.setIndex) open.setIndex = idx;
        open.lastSeen = Math.max(open.lastSeen, idx);
      } else {
        const f: Open = { nodeId: e.plantNodeId, stemId: e.stemId, setIndex: idx, outcome: 'open', lo: idx, hi: null, lastSeen: idx };
        out.push(f);
        openByNode.set(e.plantNodeId, f);
      }
    } else if (!open) {
      continue;
    } else if (e.status === 'Harvested') {
      open.outcome = 'harvested';
      open.lo = Math.max(open.lastSeen, lastCheckBefore(idx, open.setIndex));
      open.hi = idx;
      openByNode.delete(e.plantNodeId);
    } else if (e.status === 'Aborted' || e.status === 'Pruned') {
      // Losses were recorded every survey week (incl. weeks harvest wasn't checked).
      open.outcome = 'lost';
      open.lo = Math.max(open.lastSeen, idx - 1);
      open.hi = idx;
      openByNode.delete(e.plantNodeId);
    } else {
      open.lastSeen = Math.max(open.lastSeen, idx);
    }
  }
  for (const f of openByNode.values()) {
    // Known not harvested through the last harvest-checked survey (or its own last status).
    f.lo = Math.max(f.lastSeen, checks ? lastCheckBefore(asOf + 1, f.setIndex) : asOf);
  }
  return out.map(({ ...f }) => { delete (f as Partial<Open>).lastSeen; return f; });
}

export interface HazardFit {
  /** Index = fruit age in weeks (1..MAX_AGE); [0] unused. */
  harvest: number[];
  loss: number[];
  atRisk: number[];
  tailPooledFromAge: number | null;
  /** Ages whose hazard came from the recent period window (rest fell back to all periods). */
  agesFromRecentPeriod: number;
  iterations: number;
}

/**
 * EM for discrete-time competing risks with interval-censored events and
 * right-censoring. With `periodWeeks`, the final hazards for each age use
 * only exposure falling in the last `periodWeeks` calendar weeks before
 * asOf (a period life table — tracks a changing season), falling back to all
 * periods where that window has fewer than MIN_SAMPLE fruit at risk.
 */
export function fitIntervalHazards(obs: FruitObservation[], asOfIndex: number, periodWeeks?: number, maxIter = 200): HazardFit | null {
  const A = MAX_AGE;
  let hH = new Array(A + 1).fill(0.05);
  let hL = new Array(A + 1).fill(0.05);
  hH[0] = 0; hL[0] = 0;
  const ageOf = (week: number, set: number) => Math.min(A, Math.max(0, week - set));

  // Expected counts by (age, calendar week) from the latest E-step.
  let evH = new Map<string, number>(), evL = new Map<string, number>(), risk = new Map<string, number>();
  const add = (m: Map<string, number>, a: number, cal: number, v: number) => { const k = `${a}:${cal}`; m.set(k, (m.get(k) ?? 0) + v); };

  let iter = 0;
  for (; iter < maxIter; iter++) {
    evH = new Map(); evL = new Map(); risk = new Map();
    for (const f of obs) {
      const l = ageOf(f.lo, f.setIndex);
      for (let a = 1; a <= l; a++) add(risk, a, f.setIndex + a, 1);
      if (f.outcome === 'open' || f.hi == null) continue;
      const u = Math.max(l + 1, ageOf(f.hi, f.setIndex));
      const h = f.outcome === 'harvested' ? hH : hL;
      const w: number[] = [];
      let surv = 1;
      for (let a = l + 1; a <= u; a++) { w.push(surv * h[a]); surv *= 1 - hH[a] - hL[a]; }
      let total = w.reduce((s, x) => s + x, 0);
      if (!(total > 0)) { w.fill(1); total = w.length; }
      let remaining = 1;
      for (let i = 0, a = l + 1; a <= u; a++, i++) {
        const r = w[i] / total;
        add(risk, a, f.setIndex + a, remaining);
        add(f.outcome === 'harvested' ? evH : evL, a, f.setIndex + a, r);
        remaining -= r;
      }
    }
    const sumAge = (m: Map<string, number>, a: number) => { let s = 0; for (const [k, v] of m) if (Number(k.split(':')[0]) === a) s += v; return s; };
    const nH = new Array(A + 1).fill(0), nL = new Array(A + 1).fill(0);
    let delta = 0;
    for (let a = 1; a <= A; a++) {
      const r = sumAge(risk, a);
      nH[a] = r > 0 ? sumAge(evH, a) / r : 0;
      nL[a] = r > 0 ? sumAge(evL, a) / r : 0;
      delta = Math.max(delta, Math.abs(nH[a] - hH[a]), Math.abs(nL[a] - hL[a]));
    }
    hH = nH; hL = nL;
    if (delta < 1e-7) break;
  }

  // Final hazards: recent period window where it has enough exposure, all periods otherwise; tail-pool thin ages.
  const inWindow = (cal: number) => periodWeeks == null || (cal > asOfIndex - periodWeeks && cal <= asOfIndex);
  const sum = (m: Map<string, number>, a: number, windowed: boolean) => {
    let s = 0;
    for (const [k, v] of m) {
      const [ka, kc] = k.split(':').map(Number);
      if (ka === a && (!windowed || inWindow(kc))) s += v;
    }
    return s;
  };
  const fit: HazardFit = { harvest: [0], loss: [0], atRisk: [0], tailPooledFromAge: null, agesFromRecentPeriod: 0, iterations: iter };
  if (sum(risk, 1, false) < MIN_SAMPLE) return null;
  for (let a = 1; a <= A; a++) {
    const rw = periodWeeks != null ? sum(risk, a, true) : 0;
    const useWindow = periodWeeks != null && rw >= MIN_SAMPLE;
    const r = useWindow ? rw : sum(risk, a, false);
    if (r >= MIN_SAMPLE) {
      fit.harvest[a] = sum(evH, a, useWindow) / r;
      fit.loss[a] = sum(evL, a, useWindow) / r;
      fit.atRisk[a] = r;
      if (useWindow) fit.agesFromRecentPeriod++;
      continue;
    }
    let R = 0, EH = 0, EL = 0;
    for (let b = a; b <= A; b++) { R += sum(risk, b, false); EH += sum(evH, b, false); EL += sum(evL, b, false); }
    fit.tailPooledFromAge = a;
    for (let b = a; b <= A; b++) {
      fit.harvest[b] = R >= MIN_SAMPLE ? EH / R : 0;
      fit.loss[b] = R >= MIN_SAMPLE ? EL / R : 0;
      fit.atRisk[b] = sum(risk, b, false);
    }
    break;
  }
  return fit;
}

/** Probability a fruit known on the plant at the end of age c is harvested at each later age. */
export function harvestProbabilities(fit: HazardFit, c: number): Map<number, number> {
  const out = new Map<number, number>();
  let surv = 1;
  for (let a = c + 1; a <= MAX_AGE; a++) {
    out.set(a, surv * fit.harvest[a]);
    surv *= 1 - fit.harvest[a] - fit.loss[a];
    if (surv <= 0) break;
  }
  return out;
}

/**
 * Expected harvested fruit/m² by calendar week (> asOf) from fruit still
 * open at asOf. `packShift` moves that share of each survey-week's harvest
 * into the previous ISO week: a survey on Friday of week w covers harvests
 * from Saturday of w-1, which GrowLink packs into week w-1 (2/7 under a
 * uniform-daily-harvest assumption).
 */
export function forecastOpenFruit(
  obs: FruitObservation[],
  fit: HazardFit,
  asOfIndex: number,
  perFruitM2: (setIndex: number) => number,
  packShift = 0,
  horizon = MAX_AGE,
  pullOutDate: string | null = null
): Map<number, number> {
  const out = new Map<number, number>();
  const put = (cal: number, v: number) => { if (cal > asOfIndex && cal <= asOfIndex + horizon) out.set(cal, (out.get(cal) ?? 0) + v * harvestWindowFraction(cal, pullOutDate)); };
  for (const f of obs) {
    if (f.outcome !== 'open') continue;
    const c = Math.max(0, f.lo - f.setIndex);
    if (c >= MAX_AGE) continue;
    const scale = perFruitM2(f.setIndex);
    for (const [a, p] of harvestProbabilities(fit, c)) {
      const cal = f.setIndex + a;
      put(cal, p * scale * (1 - packShift));
      put(cal - 1, p * scale * packShift);
    }
  }
  return out;
}

/** Each harvested fruit's mass spread over its censoring interval in proportion to the fitted hazards — the estimated true harvest week distribution. */
export function redistributeHarvests(obs: FruitObservation[], fit: HazardFit): Map<number, Map<number, number>> {
  const bySet = new Map<number, Map<number, number>>(); // setIndex → calendar week → fruit
  for (const f of obs) {
    if (f.outcome !== 'harvested' || f.hi == null) continue;
    const l = Math.max(0, f.lo - f.setIndex);
    const u = Math.max(l + 1, Math.min(MAX_AGE, f.hi - f.setIndex));
    const w: number[] = [];
    let surv = 1;
    for (let a = l + 1; a <= u; a++) { w.push(surv * fit.harvest[a]); surv *= 1 - fit.harvest[a] - fit.loss[a]; }
    let total = w.reduce((s, x) => s + x, 0);
    if (!(total > 0)) { w.fill(1); total = w.length; }
    if (!bySet.has(f.setIndex)) bySet.set(f.setIndex, new Map());
    const m = bySet.get(f.setIndex)!;
    for (let i = 0, a = l + 1; a <= u; a++, i++) m.set(f.setIndex + a, (m.get(f.setIndex + a) ?? 0) + w[i] / total);
  }
  return bySet;
}

/** Deterministic PRNG so bootstrap intervals are reproducible. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resample tracked stems with replacement (the sampling unit), keeping each stem's fruit together. */
export function resampleStems(obs: FruitObservation[], rand: () => number): FruitObservation[] {
  const byStem = new Map<string, FruitObservation[]>();
  for (const f of obs) { if (!byStem.has(f.stemId)) byStem.set(f.stemId, []); byStem.get(f.stemId)!.push(f); }
  const stems = [...byStem.keys()];
  const out: FruitObservation[] = [];
  for (let i = 0; i < stems.length; i++) out.push(...byStem.get(stems[Math.floor(rand() * stems.length)])!);
  return out;
}
