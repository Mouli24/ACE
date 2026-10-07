import { describe, expect, it } from 'vitest';

import { CronError, assertTimeZone, nextOccurrence, parseCron } from '../cron.js';

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number | undefined): string | undefined =>
  ms === undefined ? undefined : new Date(ms).toISOString();

describe('D277 cron parsing', () => {
  it('reads lists, ranges, steps and names', () => {
    const schedule = parseCron('*/15 9-17 * jan,mar MON-FRI');
    expect([...schedule.minute.values]).toEqual([0, 15, 30, 45]);
    expect([...schedule.hour.values]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...schedule.month.values]).toEqual([1, 3]);
    expect([...schedule.dayOfWeek.values]).toEqual([1, 2, 3, 4, 5]);
    expect(schedule.dayOfMonth.any).toBe(true);
  });

  it('treats 7 as Sunday', () => {
    expect([...parseCron('0 0 * * 7').dayOfWeek.values]).toEqual([0]);
  });

  it('refuses malformed expressions and names the field', () => {
    expect(() => parseCron('0 9 * *')).toThrow(CronError);
    expect(() => parseCron('61 9 * * *')).toThrow(/minute/);
    expect(() => parseCron('0 9 * * 1-x')).toThrow(CronError);
    expect(() => parseCron('0 9 */0 * *')).toThrow(/step/);
    expect(() => parseCron('0 9 ,1 * *')).toThrow(/empty/);
  });

  it('refuses an unknown time zone', () => {
    expect(() => assertTimeZone('Mars/Olympus')).toThrow(CronError);
    expect(() => assertTimeZone('Europe/London')).not.toThrow();
  });
});

describe('D277 next occurrence', () => {
  it('finds the next weekday 09:00 in UTC', () => {
    // 2026-10-09 is a Friday.
    expect(iso(nextOccurrence('0 9 * * 1-5', 'UTC', at('2026-10-09T09:00:00Z')))).toBe(
      '2026-10-12T09:00:00.000Z',
    );
    expect(iso(nextOccurrence('0 9 * * 1-5', 'UTC', at('2026-10-09T08:59:30Z')))).toBe(
      '2026-10-09T09:00:00.000Z',
    );
  });

  it('matches the wall clock of the zone across a daylight-saving change', () => {
    // London leaves summer time on 2026-10-25: 09:00 BST is 08:00Z, 09:00 GMT is 09:00Z.
    expect(iso(nextOccurrence('0 9 * * *', 'Europe/London', at('2026-10-24T09:00:00Z')))).toBe(
      '2026-10-25T09:00:00.000Z',
    );
    expect(iso(nextOccurrence('0 9 * * *', 'Europe/London', at('2026-10-23T12:00:00Z')))).toBe(
      '2026-10-24T08:00:00.000Z',
    );
  });

  it('follows the classic rule when both day fields are restricted', () => {
    // The 1st of the month OR a Monday: from Friday 2026-10-09 the next is Monday the 12th.
    expect(iso(nextOccurrence('0 0 1 * 1', 'UTC', at('2026-10-09T00:00:00Z')))).toBe(
      '2026-10-12T00:00:00.000Z',
    );
  });

  it('finds a sparse schedule quickly and gives up on an impossible one', () => {
    const started = Date.now();
    expect(iso(nextOccurrence('30 6 29 2 *', 'UTC', at('2026-10-09T00:00:00Z')))).toBe(
      '2028-02-29T06:30:00.000Z',
    );
    expect(nextOccurrence('0 0 31 2 *', 'UTC', at('2026-10-09T00:00:00Z'))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
