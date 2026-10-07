import {
  TaskTriggerSchema,
  type Id,
  type Task,
  type TaskStartMode,
  type TaskTrigger,
  type TaskTriggerKind,
} from '@ace/contracts';

import { cronProblem } from './cron';
import { formatWhen } from './meta';

/**
 * When a task starts (ACE parity P1, D277), as the Timing control holds it: now, in the Inbox, or
 * one of the three triggers. The control keeps every field's text so switching kinds loses nothing;
 * `triggerFromDraft` turns it into what the engine takes.
 */
export type TimingKind = TaskStartMode | TaskTriggerKind;

export interface TimingDraft {
  kind: TimingKind;
  /** A `datetime-local` value, read in the viewer's clock. */
  at: string;
  cron: string;
  timezone: string;
  afterTaskId: Id | '';
}

export const TIMING_LABEL: Readonly<Record<TimingKind, string>> = {
  now: 'Start now',
  inbox: 'Add to Inbox',
  once: 'At a time',
  recurring: 'Repeat',
  after_task: 'After another task',
};

export const TIMING_HINT: Readonly<Record<TimingKind, string>> = {
  now: 'It starts as soon as it is created.',
  inbox: 'It waits in the Inbox until you start it.',
  once: 'It waits in the Inbox and starts by itself at that time.',
  recurring:
    'This task becomes a template: each time it fires, a new task is made from it and started.',
  after_task: 'It starts when the other task reaches its finish line.',
};

export const CRON_PRESETS: readonly { label: string; cron: string; words: string }[] = [
  { label: 'Weekdays 09:00', cron: '0 9 * * 1-5', words: 'on weekdays at 09:00' },
  { label: 'Daily 09:00', cron: '0 9 * * *', words: 'every day at 09:00' },
  { label: 'Every Monday 09:00', cron: '0 9 * * 1', words: 'every Monday at 09:00' },
];

/** The viewer's own IANA time zone — what a new recurring trigger defaults to. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Every zone this runtime knows, with `include` (the current choice) never left out. */
export function timeZones(include: string): string[] {
  const zones = knownTimeZones();
  // some runtimes list only region zones; UTC is always worth offering
  const withUtc = zones.includes('UTC') ? zones : ['UTC', ...zones];
  return withUtc.includes(include) ? withUtc : [include, ...withUtc];
}

function knownTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    // a runtime without the list still offers the common zones
    return ['UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata'];
  }
}

/** An ISO timestamp as a `datetime-local` value in the viewer's clock (minutes, no seconds). */
export function toDatetimeLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function emptyTiming(kind: TimingKind = 'inbox'): TimingDraft {
  return {
    kind,
    at: '',
    cron: CRON_PRESETS[0]?.cron ?? '0 9 * * 1-5',
    timezone: localTimeZone(),
    afterTaskId: '',
  };
}

/** The draft that shows an existing trigger, for the schedule card's Edit. */
export function draftFromTrigger(trigger: TaskTrigger): TimingDraft {
  const draft = emptyTiming(trigger.kind);
  if (trigger.kind === 'once') return { ...draft, at: toDatetimeLocal(trigger.at) };
  if (trigger.kind === 'recurring') {
    return { ...draft, cron: trigger.cron, timezone: trigger.timezone };
  }
  return { ...draft, afterTaskId: trigger.taskId };
}

export type TimingResult =
  | { ok: true; start: TaskStartMode; trigger?: TaskTrigger }
  | { ok: false; field: 'at' | 'cron' | 'timezone' | 'afterTaskId'; message: string };

/**
 * The draft as the engine takes it: a start mode, and a trigger when it is scheduled — in which
 * case the task waits in the Inbox (`start: 'inbox'`, the contract's rule). What the engine would
 * refuse is said here first, in its words: a time that is not in the future, a cron expression
 * that is malformed or never matches, an unknown zone, no task to wait on.
 */
export function triggerFromDraft(draft: TimingDraft, nowMs: number = Date.now()): TimingResult {
  switch (draft.kind) {
    case 'now':
    case 'inbox':
      return { ok: true, start: draft.kind };
    case 'once': {
      const at = new Date(draft.at);
      if (draft.at === '' || Number.isNaN(at.getTime())) {
        return { ok: false, field: 'at', message: 'Pick the day and time it starts.' };
      }
      if (at.getTime() <= nowMs) {
        return { ok: false, field: 'at', message: 'The time must be in the future.' };
      }
      return { ok: true, start: 'inbox', trigger: { kind: 'once', at: at.toISOString() } };
    }
    case 'recurring': {
      const cron = draft.cron.trim().replace(/\s+/g, ' ');
      const problem = cronProblem(cron, draft.timezone, nowMs);
      if (problem !== undefined) {
        const field = problem.includes('time zone') ? 'timezone' : 'cron';
        return { ok: false, field, message: problem };
      }
      const trigger = TaskTriggerSchema.safeParse({
        kind: 'recurring',
        cron,
        timezone: draft.timezone,
      });
      if (!trigger.success) {
        return {
          ok: false,
          field: 'cron',
          message: 'Must be five cron fields, like "0 9 * * 1-5".',
        };
      }
      return { ok: true, start: 'inbox', trigger: trigger.data };
    }
    case 'after_task':
      if (draft.afterTaskId === '') {
        return { ok: false, field: 'afterTaskId', message: 'Pick the task to wait on.' };
      }
      return {
        ok: true,
        start: 'inbox',
        trigger: { kind: 'after_task', taskId: draft.afterTaskId },
      };
  }
}

/**
 * A trigger in words, e.g. "Repeats on weekdays at 09:00 (Europe/London)" or "After #3 Fix search
 * reaches its finish line".
 */
export function describeTrigger(
  trigger: TaskTrigger,
  tasks: readonly Pick<Task, 'id' | 'number' | 'title'>[] = [],
): string {
  switch (trigger.kind) {
    case 'once':
      return `Once, on ${formatWhen(trigger.at)}`;
    case 'recurring': {
      const preset = CRON_PRESETS.find((each) => each.cron === trigger.cron);
      const what = preset === undefined ? `on the cron schedule “${trigger.cron}”` : preset.words;
      return `Repeats ${what} (${trigger.timezone})`;
    }
    case 'after_task': {
      const other = tasks.find((task) => task.id === trigger.taskId);
      return other === undefined
        ? 'After another task reaches its finish line'
        : `After #${other.number} ${other.title} reaches its finish line`;
    }
  }
}
