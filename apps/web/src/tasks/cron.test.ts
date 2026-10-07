import { cronProblem, nextOccurrence, parseCron } from './cron';

/** D277: the web reads a recurring trigger as the engine's `cron.ts` does. */
describe('ACE-P1 D277 cron, read as the engine reads it', () => {
  const at = Date.parse('2026-10-07T08:00:00.000Z'); // a Wednesday

  it('finds the next weekday, daily and Monday 09:00 in a time zone', () => {
    const iso = (cron: string, zone: string) =>
      new Date(nextOccurrence(cron, zone, at) ?? 0).toISOString();
    expect(iso('0 9 * * 1-5', 'UTC')).toBe('2026-10-07T09:00:00.000Z');
    expect(iso('0 9 * * *', 'Europe/London')).toBe('2026-10-08T08:00:00.000Z');
    expect(iso('0 9 * * 1', 'UTC')).toBe('2026-10-12T09:00:00.000Z');
    expect(iso('*/15 8 * * wed', 'UTC')).toBe('2026-10-07T08:15:00.000Z');
    expect(iso('30 9 1,15 jan-dec *', 'UTC')).toBe('2026-10-15T09:30:00.000Z');
  });

  it('reads 7 as Sunday and either day field when both are restricted', () => {
    expect([...parseCron('0 0 * * 7').dayOfWeek.values]).toEqual([0]);
    // the 1st of the month or any Monday, whichever comes first
    expect(new Date(nextOccurrence('0 9 1 * 1', 'UTC', at) ?? 0).toISOString()).toBe(
      '2026-10-12T09:00:00.000Z',
    );
  });

  it('says what is wrong in the engine’s words', () => {
    expect(cronProblem('0 9 * *', 'UTC')).toBe(
      'A cron expression has five fields: minute hour day month weekday.',
    );
    expect(cronProblem('0 9 31 2 *', 'UTC', at)).toBe('That cron expression never matches.');
    expect(cronProblem('0 9 * * *', 'Mars/Base')).toBe(
      '"Mars/Base" is not a known time zone, such as Europe/London or UTC.',
    );
    expect(cronProblem('x 9 * * *', 'UTC')).toBe('"x" is not a number.');
    expect(cronProblem('0 9-x * * *', 'UTC')).toBe('"x" is not a number.');
    expect(cronProblem('0 -9 * * *', 'UTC')).toBe('"-9" is not a range.');
    expect(cronProblem('*/0 9 * * *', 'UTC')).toBe('The minute step must be at least 1.');
    expect(cronProblem('0,,5 9 * * *', 'UTC')).toBe('The minute field has an empty item.');
    expect(cronProblem('0 9 * 13 *', 'UTC')).toBe(
      'The month field allows 1-12; "13" is outside it.',
    );
    expect(cronProblem('0 9 * * 1-5', 'UTC')).toBeUndefined();
  });
});
