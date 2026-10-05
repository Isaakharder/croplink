import { describe, it, expect } from 'vitest';
import { greenhouseIsoWeek } from './years';

const wk = (t: string) => { const w = greenhouseIsoWeek(new Date(t)); return `${w.year}-W${String(w.week).padStart(2, '0')}`; };

// Same cases as the server's greenhouse-time.test.ts: Sunday 7:59 PM, 8:00 PM, 11:59 PM and Monday 12:00 AM Toronto time.
describe('greenhouseIsoWeek (America/Toronto, independent of the device time zone)', () => {
  it.each([
    ['EDT, Sun Oct 4 2026', '2026-10-04T23:59:00Z', '2026-10-05T00:00:00Z', '2026-10-05T03:59:00Z', '2026-10-05T04:00:00Z', '2026-W40', '2026-W41'],
    ['EST, Sun Dec 6 2026', '2026-12-07T00:59:00Z', '2026-12-07T01:00:00Z', '2026-12-07T04:59:00Z', '2026-12-07T05:00:00Z', '2026-W49', '2026-W50'],
    ['DST start, Sun Mar 8 2026', '2026-03-08T23:59:00Z', '2026-03-09T00:00:00Z', '2026-03-09T03:59:00Z', '2026-03-09T04:00:00Z', '2026-W10', '2026-W11'],
    ['DST end, Sun Nov 1 2026', '2026-11-02T00:59:00Z', '2026-11-02T01:00:00Z', '2026-11-02T04:59:00Z', '2026-11-02T05:00:00Z', '2026-W44', '2026-W45'],
    ['W53 → 2027-W01, Sun Jan 3 2027', '2027-01-04T00:59:00Z', '2027-01-04T01:00:00Z', '2027-01-04T04:59:00Z', '2027-01-04T05:00:00Z', '2026-W53', '2027-W01'],
  ])('%s: Sunday evening stays in the prior week until Monday 12:00 AM', (_l, t759, t800, t1159, tMon, before, after) => {
    expect([wk(t759), wk(t800), wk(t1159), wk(tMon)]).toEqual([before, before, before, after]);
  });
});
