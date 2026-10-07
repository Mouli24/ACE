/**
 * Five-field cron in an IANA time zone, read the way the engine reads a recurring task trigger
 * (D277): `minute hour day-of-month month day-of-week`; `*`, numbers, ranges, steps and comma lists;
 * month and weekday names; weekday 0 and 7 are Sunday; when both day fields are restricted a day
 * matches if either does. The Timing control uses it to say what is wrong before anything is sent,
 * and the mock engine to compute `nextRunAt` with the engine's own messages. The engine stays the
 * judge: what it answers is what the page shows.
 */

export class CronError extends Error {
  override readonly name = 'CronError';
}

interface Field {
  values: ReadonlySet<number>;
  /** `*` (or `*\/1`): restricts nothing — what the day-of-month / weekday rule needs. */
  any: boolean;
}

export interface CronSchedule {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseValue(text: string, names: string[] | undefined, offset: number): number {
  if (names !== undefined) {
    const index = names.indexOf(text.toLowerCase());
    if (index >= 0) return index + offset;
  }
  if (!/^\d+$/.test(text)) throw new CronError(`"${text}" is not a number.`);
  return Number(text);
}

function parseField(
  text: string,
  min: number,
  max: number,
  label: string,
  names?: string[],
  nameOffset = 0,
): Field {
  const values = new Set<number>();
  let any = false;
  for (const part of text.split(',')) {
    if (part === '') throw new CronError(`The ${label} field has an empty item.`);
    const [range = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : parseValue(stepText, undefined, 0);
    if (step < 1) throw new CronError(`The ${label} step must be at least 1.`);
    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
      if (step === 1) any = true;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      if (a === undefined || b === undefined || a === '' || b === '') {
        throw new CronError(`"${range}" is not a range.`);
      }
      from = parseValue(a, names, nameOffset);
      to = parseValue(b, names, nameOffset);
    } else {
      from = parseValue(range, names, nameOffset);
      to = stepText === undefined ? from : max;
    }
    if (from < min || to > max || from > to) {
      throw new CronError(`The ${label} field allows ${min}-${max}; "${part}" is outside it.`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return { values, any };
}

/** Parses five cron fields; throws a `CronError` naming the field that is wrong. */
export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError('A cron expression has five fields: minute hour day month weekday.');
  }
  const [minute = '', hour = '', dayOfMonth = '', month = '', dayOfWeek = ''] = fields;
  const weekday = parseField(dayOfWeek, 0, 7, 'day-of-week', WEEKDAYS, 0);
  return {
    minute: parseField(minute, 0, 59, 'minute'),
    hour: parseField(hour, 0, 23, 'hour'),
    dayOfMonth: parseField(dayOfMonth, 1, 31, 'day-of-month'),
    month: parseField(month, 1, 12, 'month', MONTHS, 1),
    // 7 is Sunday too
    dayOfWeek: {
      values: new Set([...weekday.values].map((value) => (value === 7 ? 0 : value))),
      any: weekday.any,
    },
  };
}

/** Throws a `CronError` if the zone is not one this runtime knows. */
export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new CronError(`"${timeZone}" is not a known time zone, such as Europe/London or UTC.`);
  }
}

interface WallClock {
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(instant: number, timeZone: string): WallClock {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, format);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(instant))) parts[part.type] = part.value;
  return {
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
    weekday: WEEKDAYS.indexOf((parts['weekday'] ?? '').toLowerCase().slice(0, 3)),
  };
}

function dayMatches(schedule: CronSchedule, clock: WallClock): boolean {
  if (!schedule.month.values.has(clock.month)) return false;
  const byDate = schedule.dayOfMonth.values.has(clock.day);
  const byWeekday = schedule.dayOfWeek.values.has(clock.weekday);
  if (schedule.dayOfMonth.any && schedule.dayOfWeek.any) return true;
  if (schedule.dayOfMonth.any) return byWeekday;
  if (schedule.dayOfWeek.any) return byDate;
  return byDate || byWeekday;
}

const MINUTE = 60_000;
/** A schedule that matches nothing in this long (e.g. 30 February) never fires. */
const HORIZON_MS = 4 * 366 * 24 * 60 * MINUTE;

/** The first instant strictly after `after` whose wall clock in `timeZone` matches, or undefined. */
export function nextCronTime(
  schedule: CronSchedule,
  timeZone: string,
  after: number,
): number | undefined {
  let candidate = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  const limit = after + HORIZON_MS;
  while (candidate <= limit) {
    const clock = wallClock(candidate, timeZone);
    if (!dayMatches(schedule, clock)) {
      candidate += ((24 - clock.hour) * 60 - clock.minute) * MINUTE;
      continue;
    }
    if (!schedule.hour.values.has(clock.hour)) {
      candidate += (60 - clock.minute) * MINUTE;
      continue;
    }
    if (!schedule.minute.values.has(clock.minute)) {
      candidate += MINUTE;
      continue;
    }
    return candidate;
  }
  return undefined;
}

/** Parses and finds the next time in one step. */
export function nextOccurrence(cron: string, timeZone: string, after: number): number | undefined {
  assertTimeZone(timeZone);
  return nextCronTime(parseCron(cron), timeZone, after);
}

/**
 * What is wrong with a recurring trigger, in the engine's words, or undefined when it fires:
 * a malformed expression, an unknown zone, or one that never matches.
 */
export function cronProblem(
  cron: string,
  timeZone: string,
  after = Date.now(),
): string | undefined {
  try {
    return nextOccurrence(cron, timeZone, after) === undefined
      ? 'That cron expression never matches.'
      : undefined;
  } catch (error) {
    if (error instanceof CronError) return error.message;
    throw error;
  }
}
