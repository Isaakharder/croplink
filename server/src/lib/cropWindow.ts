// Crop pull-out truncation for harvest forecasts: no harvest is expected after
// a variety's pull_out_date. A forecast week keeps the share of its days
// (Mon–Sun, ISO) that fall on or before the pull-out date, assuming harvest
// is spread evenly across the week. E.g. pull-out Thu 2026-12-31 → 2026-W53
// (Mon Dec 28 – Sun Jan 3) keeps 4/7; every 2027 week keeps 0.
import { fromIsoWeekIndex, isoWeekMonday } from './isoWeek';

export function harvestWindowFraction(isoWeekIndexValue: number, pullOutDate: string | null | undefined): number {
  if (!pullOutDate) return 1;
  const end = Date.parse(`${pullOutDate}T00:00:00Z`);
  if (isNaN(end)) return 1;
  const w = fromIsoWeekIndex(isoWeekIndexValue);
  const monday = isoWeekMonday(w.year, w.week).getTime();
  const days = Math.floor((end - monday) / 86_400_000) + 1;
  return Math.max(0, Math.min(7, days)) / 7;
}
