/**
 * Five-field cron in an IANA time zone, for recurring task schedules (D277).
 *
 * `minute hour day-of-month month day-of-week`, each field `*`, a number, a range `a-b`, a step
 * (`*\/n`, `a-b/n`, `a/n`) or a comma list of those; months and weekdays also by their English
 * three-letter names; day-of-week 0 and 7 are both Sunday. As in classic cron, when both
 * day-of-month and day-of-week are restricted a day matches if either does.
 *
 * Times are matched on the wall clock of the schedule's time zone, so "0 9 * * 1-5" in
 * Europe/London fires at 09:00 London time through daylight-saving changes. A wall-clock minute that
 * does not exist (skipped by a spring-forward) is skipped; one that happens twice fires once.
 */

export class CronError extends Error {
  override readonly name = 'CronError';
}

interface Field {
  values: ReadonlySet<number>;
  /** The field was `*` (or `*\/1`): it restricts nothing — what the day-of-month/weekday rule needs. */
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
  const lower = text.toLowerCase();
  if (names !== undefined) {
    const index = names.indexOf(lower);
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
    const [range, stepText] = part.split('/');
    if (range === undefined) throw new CronError(`The ${label} field is empty.`);
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
      if (a === undefined || b === undefined) throw new CronError(`"${range}" is not a range.`);
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
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const weekday = parseField(dayOfWeek, 0, 7, 'day-of-week', WEEKDAYS, 0);
  // 7 is Sunday too.
  const weekdays = new Set([...weekday.values].map((value) => (value === 7 ? 0 : value)));
  return {
    minute: parseField(minute, 0, 59, 'minute'),
    hour: parseField(hour, 0, 23, 'hour'),
    dayOfMonth: parseField(dayOfMonth, 1, 31, 'day-of-month'),
    month: parseField(month, 1, 12, 'month', MONTHS, 1),
    dayOfWeek: { values: weekdays, any: weekday.any },
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
  year: number;
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
      year: 'numeric',
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
    year: Number(parts['year']),
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
/** A schedule that matches nothing in this long (e.g. 30 February) is refused. */
const HORIZON_MS = 4 * 366 * 24 * 60 * MINUTE;

/**
 * The first instant strictly after `after` (ms since the epoch) whose wall clock in `timeZone`
 * matches, or `undefined` when nothing matches within four years. Jumps a day or an hour at a time
 * when the day or hour cannot match, so a sparse schedule is found quickly.
 */
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
      // To the start of the next wall-clock day (a few minutes past is fine; minutes are rechecked).
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

/** Parses and finds the next time in one step, for callers that hold the raw trigger. */
export function nextOccurrence(cron: string, timeZone: string, after: number): number | undefined {
  assertTimeZone(timeZone);
  return nextCronTime(parseCron(cron), timeZone, after);
}
