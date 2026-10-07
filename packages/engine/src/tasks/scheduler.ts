import type {
  CreateTaskRequest,
  Id,
  PutTaskScheduleRequest,
  TaskSchedule,
  TaskTrigger,
} from '@ace/contracts';
import { isVerifiedOutcome } from '@ace/contracts';

import { HttpError, validationFailed } from '../gateway/errors.js';
import type { TaskRecord, TaskScheduleRepository } from '../ports/index.js';
import { CronError, nextOccurrence } from './cron.js';
import type { TaskKernel } from './kernel.js';

/**
 * Task schedules (ACE parity P1, D277). A schedule belongs to one Inbox task:
 *
 * - `once` starts that task at a time;
 * - `recurring` treats it as a template — each occurrence is a new task made from it and started,
 *   and an occurrence is skipped while the previous one is not Done;
 * - `after_task` starts it when another task of the project reaches a verified outcome.
 *
 * The engine ticks every 30 s while it runs. Occurrences missed while it was stopped are skipped and
 * counted, never run late in a burst. A paused task or project takes no scheduled step.
 */
export interface TaskScheduler {
  /**
   * Refuses a trigger `put` would refuse for a task of this project (400 `validation_failed`,
   * `invalid_schedule`), so a task created with one is never left behind unscheduled.
   */
  check(projectId: Id, trigger: TaskTrigger): Promise<void>;
  put(taskId: Id, body: PutTaskScheduleRequest): Promise<TaskSchedule>;
  remove(taskId: Id): Promise<void>;
  get(taskId: Id): Promise<TaskSchedule | undefined>;
  /** One pass over the due schedules (what the timer runs; exposed for tests). */
  tick(): Promise<void>;
  /** Skips what was missed while the engine was stopped, then starts the timer. */
  start(intervalMs?: number): Promise<() => void>;
  /** A task reached Done: start the tasks waiting on its verified outcome. */
  taskDone(task: TaskRecord): Promise<void>;
}

const DEFAULT_TICK_MS = 30_000;
/** A schedule this late at start-up was missed while the engine was stopped. */
const MISSED_AFTER_MS = 60_000;

const describe = (trigger: TaskTrigger, nextRunAt: string | undefined): string => {
  switch (trigger.kind) {
    case 'once':
      return `Scheduled for ${trigger.at}.`;
    case 'recurring':
      return `Repeats "${trigger.cron}" (${trigger.timezone})${nextRunAt === undefined ? '' : ` — next ${nextRunAt}`}.`;
    case 'after_task':
      return 'Starts when the task it waits on reaches its finish line.';
  }
};

export function createTaskScheduler(
  kernel: TaskKernel,
  schedules: TaskScheduleRepository,
): TaskScheduler {
  const nowMs = (): number => Date.parse(kernel.now());

  function nextRun(trigger: TaskTrigger, afterMs: number): string | undefined {
    if (trigger.kind === 'once') return trigger.at;
    if (trigger.kind === 'after_task') return undefined;
    const next = nextOccurrence(trigger.cron, trigger.timezone, afterMs);
    return next === undefined ? undefined : new Date(next).toISOString();
  }

  /** Writes the schedule and the template task's reason in one locked step. */
  async function saveWithReason(
    taskId: Id,
    schedule: TaskSchedule,
    reason?: string,
  ): Promise<void> {
    await schedules.save(kernel.scope, schedule);
    await kernel.withLock(taskId, async () => {
      const task = await kernel.repos().tasks.get(kernel.scope, taskId);
      if (task === null || task.stage !== 'inbox' || task.state !== 'idle') return;
      await kernel.commit(kernel.set(task, { stateReason: reason }));
    });
  }

  async function occurrence(template: TaskRecord): Promise<Id> {
    const deliverable = template.deliverable;
    const body: CreateTaskRequest = {
      title: `${template.title} · ${kernel.now().slice(0, 10)}`.slice(0, 200),
      brief: template.brief,
      type: template.type,
      finishLine: template.finishLine,
      automation: template.automation,
      priority: template.priority,
      labels: template.labels,
      acceptance: template.acceptance,
      runChecks: template.runChecks,
      ...(template.workflowId === undefined ? {} : { workflowId: template.workflowId }),
      ...(template.plannerWorkflowId === undefined
        ? {}
        : { plannerWorkflowId: template.plannerWorkflowId }),
      ...(deliverable?.kind === 'document' ? { documentPath: deliverable.path } : {}),
      ...(deliverable?.kind === 'email' ? { emailTo: deliverable.to } : {}),
      source: { kind: 'schedule', refId: template.id, label: template.title },
      start: 'now',
    };
    const created = await kernel.createTask(template.projectId, body);
    return created.id;
  }

  async function fire(schedule: TaskSchedule): Promise<void> {
    const at = kernel.now();
    const task = await kernel.repos().tasks.get(kernel.scope, schedule.taskId);
    if (task === null) {
      await schedules.delete(kernel.scope, schedule.id);
      return;
    }
    const advance = (changes: Partial<TaskSchedule>): TaskSchedule => {
      const next: TaskSchedule = { ...schedule, ...changes, updatedAt: at };
      if (next.nextRunAt === undefined) delete next.nextRunAt;
      return next;
    };

    if (await kernel.isPaused(task)) {
      const nextRunAt =
        schedule.trigger.kind === 'recurring' ? nextRun(schedule.trigger, nowMs()) : undefined;
      const skipped = advance({
        skipped: schedule.skipped + 1,
        enabled: schedule.trigger.kind === 'recurring',
        nextRunAt,
      });
      await saveWithReason(
        task.id,
        skipped,
        `Skipped an occurrence: the task or project is paused.`,
      );
      return;
    }

    if (schedule.trigger.kind === 'once') {
      await schedules.save(
        kernel.scope,
        advance({ enabled: false, lastRunAt: at, nextRunAt: undefined }),
      );
      if (task.stage === 'inbox' && task.state === 'idle') await kernel.startTask(task.id);
      return;
    }

    if (schedule.trigger.kind === 'recurring') {
      const nextRunAt = nextRun(schedule.trigger, nowMs());
      if (schedule.lastTaskId !== undefined) {
        const previous = await kernel.repos().tasks.get(kernel.scope, schedule.lastTaskId);
        if (previous !== null && previous.stage !== 'done') {
          const skipped = advance({ skipped: schedule.skipped + 1, nextRunAt });
          await saveWithReason(
            task.id,
            skipped,
            `Skipped an occurrence: task #${previous.number} is not Done yet. ${describe(schedule.trigger, nextRunAt)}`,
          );
          return;
        }
      }
      const lastTaskId = await occurrence(task);
      await saveWithReason(
        task.id,
        advance({ lastRunAt: at, lastTaskId, nextRunAt }),
        describe(schedule.trigger, nextRunAt),
      );
    }
  }

  /**
   * The trigger's next run, and whether it is an after-task trigger already satisfied — or a 400
   * naming what is wrong with it. `selfId` is the task being scheduled, when it exists yet.
   */
  async function validated(
    projectId: Id,
    trigger: TaskTrigger,
    selfId?: Id,
  ): Promise<{ nextRunAt: string | undefined; waitsOnDone: boolean }> {
    let nextRunAt: string | undefined;
    try {
      nextRunAt = nextRun(trigger, nowMs());
    } catch (error) {
      if (error instanceof CronError) {
        throw validationFailed(error.message, [
          { severity: 'error', code: 'invalid_schedule', message: error.message },
        ]);
      }
      throw error;
    }
    if (trigger.kind === 'once' && Date.parse(trigger.at) <= nowMs()) {
      throw validationFailed('The time must be in the future.', [
        {
          severity: 'error',
          code: 'invalid_schedule',
          message: 'The time must be in the future.',
        },
      ]);
    }
    if (trigger.kind === 'recurring' && nextRunAt === undefined) {
      throw validationFailed('That cron expression never matches.', [
        {
          severity: 'error',
          code: 'invalid_schedule',
          message: 'That cron expression never matches.',
        },
      ]);
    }
    let waitsOnDone = false;
    if (trigger.kind === 'after_task') {
      const other = await kernel.repos().tasks.get(kernel.scope, trigger.taskId);
      if (other === null || other.projectId !== projectId || other.id === selfId) {
        throw validationFailed('The task to wait on must be another task of this project.', [
          {
            severity: 'error',
            code: 'invalid_schedule',
            message: 'The task to wait on must be another task of this project.',
          },
        ]);
      }
      waitsOnDone = isVerifiedOutcome(other.outcome);
    }
    return { nextRunAt, waitsOnDone };
  }

  const scheduler: TaskScheduler = {
    async check(projectId, trigger) {
      await validated(projectId, trigger);
    },

    async put(taskId, body) {
      const task = await kernel.load(taskId);
      if (task.stage !== 'inbox' || (task.state !== 'idle' && task.state !== 'failed')) {
        throw new HttpError(
          'workflow',
          'invalid_task_state',
          `Task #${task.number} is ${task.stage} / ${task.state}; only an Inbox task can be scheduled.`,
        );
      }
      const trigger = body.trigger;
      const { nextRunAt, waitsOnDone } = await validated(task.projectId, trigger, task.id);

      const at = kernel.now();
      const existing = await schedules.getByTask(kernel.scope, taskId);
      const schedule: TaskSchedule = {
        id: existing?.id ?? kernel.nextId(),
        taskId,
        trigger,
        enabled: body.enabled ?? true,
        ...(nextRunAt === undefined ? {} : { nextRunAt }),
        skipped: existing?.skipped ?? 0,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
      const saved =
        existing === null
          ? await schedules.create(kernel.scope, schedule)
          : await schedules.save(kernel.scope, schedule);
      await kernel.withLock(taskId, async () => {
        const current = await kernel.load(taskId);
        await kernel.commit(kernel.set(current, { stateReason: describe(trigger, nextRunAt) }), {
          kind: 'edited',
          message: describe(trigger, nextRunAt),
        });
      });
      // Already satisfied: an after-task trigger whose task is done starts now.
      if (waitsOnDone && saved.enabled) {
        await schedules.save(kernel.scope, { ...saved, enabled: false, lastRunAt: at });
        await kernel.startTask(taskId);
      }
      return (await schedules.getByTask(kernel.scope, taskId)) ?? saved;
    },

    async remove(taskId) {
      const schedule = await schedules.getByTask(kernel.scope, taskId);
      if (schedule === null) return;
      await schedules.delete(kernel.scope, schedule.id);
      await kernel.withLock(taskId, async () => {
        const task = await kernel.load(taskId);
        await kernel.commit(kernel.set(task, { stateReason: undefined }), {
          kind: 'edited',
          message: 'Schedule removed.',
        });
      });
    },

    async get(taskId) {
      return (await schedules.getByTask(kernel.scope, taskId)) ?? undefined;
    },

    async tick() {
      const due = (await schedules.listEnabled(kernel.scope)).filter(
        (schedule) => schedule.nextRunAt !== undefined && Date.parse(schedule.nextRunAt) <= nowMs(),
      );
      for (const schedule of due) {
        try {
          await fire(schedule);
        } catch (error) {
          kernel.logger.error(
            { subsystem: 'tasks', err: error, scheduleId: schedule.id },
            'scheduled task could not start',
          );
        }
      }
    },

    async start(intervalMs = DEFAULT_TICK_MS) {
      // Missed while stopped: skipped and counted, never run late (D277).
      for (const schedule of await schedules.listEnabled(kernel.scope)) {
        if (schedule.nextRunAt === undefined) continue;
        if (Date.parse(schedule.nextRunAt) > nowMs() - MISSED_AFTER_MS) continue;
        const nextRunAt =
          schedule.trigger.kind === 'recurring' ? nextRun(schedule.trigger, nowMs()) : undefined;
        const missed: TaskSchedule = {
          ...schedule,
          skipped: schedule.skipped + 1,
          enabled: schedule.trigger.kind === 'recurring',
          updatedAt: kernel.now(),
        };
        if (nextRunAt === undefined) delete missed.nextRunAt;
        else missed.nextRunAt = nextRunAt;
        await saveWithReason(
          schedule.taskId,
          missed,
          schedule.trigger.kind === 'once'
            ? 'Missed while ACE was closed. Schedule it again or start it now.'
            : `Missed an occurrence while ACE was closed. ${describe(schedule.trigger, nextRunAt)}`,
        );
      }
      const timer = setInterval(() => kernel.track(() => scheduler.tick()), intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },

    async taskDone(task) {
      if (!isVerifiedOutcome(task.outcome)) return;
      for (const schedule of await schedules.listAfterTask(kernel.scope, task.id)) {
        if (!schedule.enabled) continue;
        const waiting = await kernel.repos().tasks.get(kernel.scope, schedule.taskId);
        await schedules.save(kernel.scope, {
          ...schedule,
          enabled: false,
          lastRunAt: kernel.now(),
          updatedAt: kernel.now(),
        });
        if (waiting === null || waiting.stage !== 'inbox' || waiting.state !== 'idle') continue;
        if (await kernel.isPaused(waiting)) continue;
        await kernel.startTask(waiting.id);
      }
    },
  };
  return scheduler;
}
