import {
  TaskActivitySchema,
  TaskCheckSchema,
  TaskDeliverySchema,
  TaskExecutionSchema,
  TaskReviewSchema,
  TaskScheduleSchema,
  TaskSchema,
  TaskWorkspaceSchema,
  type Id,
  type TaskActivity,
  type TaskCheck,
  type TaskDelivery,
  type TaskExecution,
  type TaskReview,
  type TaskSchedule,
  type TaskState,
  type TaskWorkspace,
} from '@ace/contracts';
import type {
  Scope,
  TaskActivityRepository,
  TaskCheckRepository,
  TaskDeliveryRepository,
  TaskExecutionRepository,
  TaskListFilter,
  TaskRecord,
  TaskRepository,
  TaskReviewRepository,
  TaskScheduleRepository,
  TaskWorkspaceRepository,
} from '@ace/engine';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type * as schema from './schema.js';
import {
  taskActivity,
  taskChecks,
  taskDeliveries,
  taskExecutions,
  taskReviews,
  tasks,
  taskSchedules,
  taskWorkspaces,
} from './schema.js';
import { assertNoSecrets, toJsonColumn } from './secret-guard.js';

type Db = BetterSQLite3Database<typeof schema>;

/**
 * The ACE parity P0 repositories (D267–D271): tasks, and the workspace, executions, checks,
 * reviews, deliveries and activity that belong to each — and, from P1 (D277), its schedule.
 *
 * Split out of `repository.ts` so one file stays one feature's worth of tables; `SqliteRepository`
 * composes them. Every row is parsed through its contract on the way out, so a row that drifted
 * fails on read rather than later. Every record is walked by the secret guard on the way in: a
 * task's brief and plan, a run's summary and a check's output are text a person or a model wrote,
 * and a credential in any of them is refused, as everywhere else in the store (BR-07).
 *
 * A task's rows go with it through the foreign keys (`ON DELETE CASCADE`), and a task goes with its
 * project, so no delete here has to remember the tables below it.
 */

/** A task as stored — `allowedActions` is the engine's to compute on every read. */
const TaskRecordSchema = TaskSchema.omit({ allowedActions: true });

/* -------------------------------------------------------------------------- */
/* Row <-> domain                                                              */
/* -------------------------------------------------------------------------- */

type TaskRow = typeof tasks.$inferSelect;
type TaskWorkspaceRow = typeof taskWorkspaces.$inferSelect;
type TaskExecutionRow = typeof taskExecutions.$inferSelect;
type TaskCheckRow = typeof taskChecks.$inferSelect;
type TaskReviewRow = typeof taskReviews.$inferSelect;
type TaskDeliveryRow = typeof taskDeliveries.$inferSelect;
type TaskActivityRow = typeof taskActivity.$inferSelect;
type TaskScheduleRow = typeof taskSchedules.$inferSelect;

function toTaskRecord(row: TaskRow): TaskRecord {
  return TaskRecordSchema.parse({
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    title: row.title,
    brief: row.brief,
    type: row.type,
    stage: row.stage,
    state: row.state,
    ...(row.stateReason === null ? {} : { stateReason: row.stateReason }),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    finishLine: row.finishLine,
    automation: row.automation,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    ...(row.workflowId === null ? {} : { workflowId: row.workflowId }),
    ...(row.plannerWorkflowId === null ? {} : { plannerWorkflowId: row.plannerWorkflowId }),
    plan: row.plan,
    acceptance: row.acceptance,
    runChecks: row.runChecks,
    paused: row.paused,
    ...(row.pendingRequest === null ? {} : { pendingRequest: row.pendingRequest }),
    // ACE parity P1 (D275): JSON, checked against the contract by the parse around this.
    ...(row.deliverable === null ? {} : { deliverable: JSON.parse(row.deliverable) }),
    ...(row.source === null ? {} : { source: JSON.parse(row.source) }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
  });
}

function toTaskWorkspace(row: TaskWorkspaceRow): TaskWorkspace {
  return TaskWorkspaceSchema.parse({
    id: row.id,
    taskId: row.taskId,
    repoPath: row.repoPath,
    path: row.path,
    branch: row.branch,
    baseBranch: row.baseBranch,
    baseSha: row.baseSha,
    headSha: row.headSha,
    status: row.status,
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.pullRequest === null ? {} : { pullRequest: JSON.parse(row.pullRequest) }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toTaskExecution(row: TaskExecutionRow): TaskExecution {
  return TaskExecutionSchema.parse({
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    sequence: row.sequence,
    workflowId: row.workflowId,
    ...(row.runId === null ? {} : { runId: row.runId }),
    status: row.status,
    request: row.request,
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.commitSha === null ? {} : { commitSha: row.commitSha }),
    ...(row.changedFiles === null ? {} : { changedFiles: row.changedFiles }),
    ...(row.error === null ? {} : { error: row.error }),
    startedAt: row.startedAt,
    ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
  });
}

function toTaskCheck(row: TaskCheckRow): TaskCheck {
  return TaskCheckSchema.parse({
    id: row.id,
    taskId: row.taskId,
    ...(row.executionId === null ? {} : { executionId: row.executionId }),
    name: row.name,
    command: row.command,
    status: row.status,
    ...(row.exitCode === null ? {} : { exitCode: row.exitCode }),
    output: row.output,
    durationMs: row.durationMs,
    headSha: row.headSha,
    at: row.at,
  });
}

function toTaskReview(row: TaskReviewRow): TaskReview {
  return TaskReviewSchema.parse({
    id: row.id,
    taskId: row.taskId,
    decision: row.decision,
    ...(row.note === null ? {} : { note: row.note }),
    ...(row.headSha === null ? {} : { headSha: row.headSha }),
    at: row.at,
  });
}

function toTaskDelivery(row: TaskDeliveryRow): TaskDelivery {
  return TaskDeliverySchema.parse({
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    status: row.status,
    destination: row.destination,
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.sha === null ? {} : { sha: row.sha }),
    ...(row.url === null ? {} : { url: row.url }),
    at: row.at,
  });
}

function toTaskSchedule(row: TaskScheduleRow): TaskSchedule {
  return TaskScheduleSchema.parse({
    id: row.id,
    taskId: row.taskId,
    trigger: JSON.parse(row.trigger),
    enabled: row.enabled,
    ...(row.nextRunAt === null ? {} : { nextRunAt: row.nextRunAt }),
    ...(row.lastRunAt === null ? {} : { lastRunAt: row.lastRunAt }),
    ...(row.lastTaskId === null ? {} : { lastTaskId: row.lastTaskId }),
    skipped: row.skipped,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toTaskActivity(row: TaskActivityRow): TaskActivity {
  return TaskActivitySchema.parse({
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    message: row.message,
    ...(row.executionId === null ? {} : { executionId: row.executionId }),
    ...(row.runId === null ? {} : { runId: row.runId }),
    at: row.at,
  });
}

/** Every column but the id and the workspace — what a `save` replaces. */
function taskColumns(task: TaskRecord) {
  assertNoSecrets(task, `task(${task.id})`);
  return {
    projectId: task.projectId,
    number: task.number,
    title: task.title,
    brief: task.brief,
    type: task.type,
    stage: task.stage,
    state: task.state,
    stateReason: task.stateReason ?? null,
    outcome: task.outcome ?? null,
    finishLine: task.finishLine,
    automation: task.automation,
    priority: task.priority,
    labels: toJsonColumn(task.labels, `task(${task.id}).labels`),
    workflowId: task.workflowId ?? null,
    plannerWorkflowId: task.plannerWorkflowId ?? null,
    plan: task.plan,
    acceptance: task.acceptance,
    runChecks: task.runChecks,
    paused: task.paused,
    pendingRequest: task.pendingRequest ?? null,
    deliverable:
      task.deliverable === undefined
        ? null
        : toJsonColumn(task.deliverable, `task(${task.id}).deliverable`),
    source: task.source === undefined ? null : toJsonColumn(task.source, `task(${task.id}).source`),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null,
  };
}

function workspaceColumns(workspace: TaskWorkspace) {
  assertNoSecrets(workspace, `taskWorkspace(${workspace.id})`);
  return {
    taskId: workspace.taskId,
    repoPath: workspace.repoPath,
    path: workspace.path,
    branch: workspace.branch,
    baseBranch: workspace.baseBranch,
    baseSha: workspace.baseSha,
    headSha: workspace.headSha,
    status: workspace.status,
    error: workspace.error ?? null,
    pullRequest:
      workspace.pullRequest === undefined
        ? null
        : toJsonColumn(workspace.pullRequest, `taskWorkspace(${workspace.id}).pullRequest`),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

function executionColumns(execution: TaskExecution) {
  assertNoSecrets(execution, `taskExecution(${execution.id})`);
  return {
    taskId: execution.taskId,
    kind: execution.kind,
    sequence: execution.sequence,
    workflowId: execution.workflowId,
    runId: execution.runId ?? null,
    status: execution.status,
    request: execution.request,
    summary: execution.summary ?? null,
    commitSha: execution.commitSha ?? null,
    changedFiles: execution.changedFiles ?? null,
    error: execution.error ?? null,
    startedAt: execution.startedAt,
    endedAt: execution.endedAt ?? null,
  };
}

/**
 * Every column of a schedule but the id and the workspace. The trigger's kind, and the task an
 * `after_task` trigger waits on, are repeated as columns for the scheduler's two queries.
 */
function scheduleColumns(schedule: TaskSchedule) {
  assertNoSecrets(schedule, `taskSchedule(${schedule.id})`);
  const { trigger } = schedule;
  return {
    taskId: schedule.taskId,
    trigger: toJsonColumn(trigger, `taskSchedule(${schedule.id}).trigger`),
    kind: trigger.kind,
    afterTaskId: trigger.kind === 'after_task' ? trigger.taskId : null,
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt ?? null,
    lastRunAt: schedule.lastRunAt ?? null,
    lastTaskId: schedule.lastTaskId ?? null,
    skipped: schedule.skipped,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

/** `save` replaces a row that exists; a missing one is a caller's bug, not a silent no-op. */
function assertSaved(changes: number, what: string, id: Id): void {
  if (changes === 0) throw new Error(`${what} ${id} is not stored, so it cannot be saved`);
}

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

export function createTaskRepository(db: Db): TaskRepository {
  const inScope = (scope: Scope, ...conditions: (SQL | undefined)[]) =>
    and(eq(tasks.workspaceId, scope.workspaceId), ...conditions);

  return {
    create: async (scope: Scope, task: TaskRecord) => {
      db.insert(tasks)
        .values({ id: task.id, workspaceId: scope.workspaceId, ...taskColumns(task) })
        .run();
      return task;
    },

    get: async (scope: Scope, id: Id) => {
      const row = db
        .select()
        .from(tasks)
        .where(inScope(scope, eq(tasks.id, id)))
        .get();
      return row === undefined ? null : toTaskRecord(row);
    },

    /** Newest number first. An empty `states` list matches nothing, as an empty filter should. */
    listByProject: async (scope: Scope, projectId: Id, filter: TaskListFilter = {}) => {
      if (filter.states?.length === 0) return [];
      return db
        .select()
        .from(tasks)
        .where(
          inScope(
            scope,
            eq(tasks.projectId, projectId),
            filter.stage === undefined ? undefined : eq(tasks.stage, filter.stage),
            filter.states === undefined ? undefined : inArray(tasks.state, [...filter.states]),
          ),
        )
        .orderBy(desc(tasks.number))
        .all()
        .map(toTaskRecord);
    },

    /** Oldest task first (ids are monotonic), across every project of the workspace. */
    listByStates: async (scope: Scope, states: readonly TaskState[]) => {
      if (states.length === 0) return [];
      return db
        .select()
        .from(tasks)
        .where(inScope(scope, inArray(tasks.state, [...states])))
        .orderBy(asc(tasks.id))
        .all()
        .map(toTaskRecord);
    },

    save: async (scope: Scope, task: TaskRecord) => {
      const { changes } = db
        .update(tasks)
        .set(taskColumns(task))
        .where(inScope(scope, eq(tasks.id, task.id)))
        .run();
      assertSaved(changes, 'Task', task.id);
      return task;
    },

    /** The foreign keys take the workspace, executions, checks, reviews, deliveries and activity. */
    delete: async (scope: Scope, id: Id) =>
      db
        .delete(tasks)
        .where(inScope(scope, eq(tasks.id, id)))
        .run().changes > 0,

    nextNumber: async (scope: Scope, projectId: Id) => {
      const row = db
        .select({ max: sql<number | null>`MAX(${tasks.number})` })
        .from(tasks)
        .where(inScope(scope, eq(tasks.projectId, projectId)))
        .get();
      return (row?.max ?? 0) + 1;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Workspaces (D269)                                                           */
/* -------------------------------------------------------------------------- */

export function createTaskWorkspaceRepository(db: Db): TaskWorkspaceRepository {
  return {
    create: async (scope: Scope, workspace: TaskWorkspace) => {
      db.insert(taskWorkspaces)
        .values({
          id: workspace.id,
          workspaceId: scope.workspaceId,
          ...workspaceColumns(workspace),
        })
        .run();
      return workspace;
    },

    getByTask: async (scope: Scope, taskId: Id) => {
      const row = db
        .select()
        .from(taskWorkspaces)
        .where(
          and(eq(taskWorkspaces.workspaceId, scope.workspaceId), eq(taskWorkspaces.taskId, taskId)),
        )
        .get();
      return row === undefined ? null : toTaskWorkspace(row);
    },

    save: async (scope: Scope, workspace: TaskWorkspace) => {
      const { changes } = db
        .update(taskWorkspaces)
        .set(workspaceColumns(workspace))
        .where(
          and(
            eq(taskWorkspaces.workspaceId, scope.workspaceId),
            eq(taskWorkspaces.id, workspace.id),
          ),
        )
        .run();
      assertSaved(changes, 'Task workspace', workspace.id);
      return workspace;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Executions                                                                  */
/* -------------------------------------------------------------------------- */

export function createTaskExecutionRepository(db: Db): TaskExecutionRepository {
  return {
    create: async (scope: Scope, execution: TaskExecution) => {
      db.insert(taskExecutions)
        .values({
          id: execution.id,
          workspaceId: scope.workspaceId,
          ...executionColumns(execution),
        })
        .run();
      return execution;
    },

    get: async (scope: Scope, id: Id) => {
      const row = db
        .select()
        .from(taskExecutions)
        .where(and(eq(taskExecutions.workspaceId, scope.workspaceId), eq(taskExecutions.id, id)))
        .get();
      return row === undefined ? null : toTaskExecution(row);
    },

    getByRun: async (scope: Scope, runId: Id) => {
      const row = db
        .select()
        .from(taskExecutions)
        .where(
          and(eq(taskExecutions.workspaceId, scope.workspaceId), eq(taskExecutions.runId, runId)),
        )
        .get();
      return row === undefined ? null : toTaskExecution(row);
    },

    listByTask: async (scope: Scope, taskId: Id) =>
      db
        .select()
        .from(taskExecutions)
        .where(
          and(eq(taskExecutions.workspaceId, scope.workspaceId), eq(taskExecutions.taskId, taskId)),
        )
        .orderBy(asc(taskExecutions.sequence))
        .all()
        .map(toTaskExecution),

    save: async (scope: Scope, execution: TaskExecution) => {
      const { changes } = db
        .update(taskExecutions)
        .set(executionColumns(execution))
        .where(
          and(
            eq(taskExecutions.workspaceId, scope.workspaceId),
            eq(taskExecutions.id, execution.id),
          ),
        )
        .run();
      assertSaved(changes, 'Task execution', execution.id);
      return execution;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Checks, reviews, deliveries — append and list, oldest first                 */
/* -------------------------------------------------------------------------- */

export function createTaskCheckRepository(db: Db): TaskCheckRepository {
  return {
    create: async (scope: Scope, check: TaskCheck) => {
      assertNoSecrets(check, `taskCheck(${check.id})`);
      db.insert(taskChecks)
        .values({
          id: check.id,
          workspaceId: scope.workspaceId,
          taskId: check.taskId,
          executionId: check.executionId ?? null,
          name: check.name,
          command: check.command,
          status: check.status,
          exitCode: check.exitCode ?? null,
          output: check.output,
          durationMs: check.durationMs,
          headSha: check.headSha,
          at: check.at,
        })
        .run();
      return check;
    },

    // `at`, then the id: ids are monotonic, so two checks of one instant keep the order they ran.
    listByTask: async (scope: Scope, taskId: Id) =>
      db
        .select()
        .from(taskChecks)
        .where(and(eq(taskChecks.workspaceId, scope.workspaceId), eq(taskChecks.taskId, taskId)))
        .orderBy(asc(taskChecks.at), asc(taskChecks.id))
        .all()
        .map(toTaskCheck),
  };
}

export function createTaskReviewRepository(db: Db): TaskReviewRepository {
  return {
    create: async (scope: Scope, review: TaskReview) => {
      assertNoSecrets(review, `taskReview(${review.id})`);
      db.insert(taskReviews)
        .values({
          id: review.id,
          workspaceId: scope.workspaceId,
          taskId: review.taskId,
          decision: review.decision,
          note: review.note ?? null,
          headSha: review.headSha ?? null,
          at: review.at,
        })
        .run();
      return review;
    },

    listByTask: async (scope: Scope, taskId: Id) =>
      db
        .select()
        .from(taskReviews)
        .where(and(eq(taskReviews.workspaceId, scope.workspaceId), eq(taskReviews.taskId, taskId)))
        .orderBy(asc(taskReviews.at), asc(taskReviews.id))
        .all()
        .map(toTaskReview),
  };
}

export function createTaskDeliveryRepository(db: Db): TaskDeliveryRepository {
  return {
    create: async (scope: Scope, delivery: TaskDelivery) => {
      assertNoSecrets(delivery, `taskDelivery(${delivery.id})`);
      db.insert(taskDeliveries)
        .values({
          id: delivery.id,
          workspaceId: scope.workspaceId,
          taskId: delivery.taskId,
          kind: delivery.kind,
          status: delivery.status,
          destination: delivery.destination,
          detail: delivery.detail ?? null,
          sha: delivery.sha ?? null,
          url: delivery.url ?? null,
          at: delivery.at,
        })
        .run();
      return delivery;
    },

    listByTask: async (scope: Scope, taskId: Id) =>
      db
        .select()
        .from(taskDeliveries)
        .where(
          and(eq(taskDeliveries.workspaceId, scope.workspaceId), eq(taskDeliveries.taskId, taskId)),
        )
        .orderBy(asc(taskDeliveries.at), asc(taskDeliveries.id))
        .all()
        .map(toTaskDelivery),
  };
}

/* -------------------------------------------------------------------------- */
/* Schedules (ACE parity P1, D277) — at most one per task                      */
/* -------------------------------------------------------------------------- */

export function createTaskScheduleRepository(db: Db): TaskScheduleRepository {
  const inScope = (scope: Scope, ...conditions: (SQL | undefined)[]) =>
    and(eq(taskSchedules.workspaceId, scope.workspaceId), ...conditions);

  return {
    create: async (scope: Scope, schedule: TaskSchedule) => {
      db.insert(taskSchedules)
        .values({ id: schedule.id, workspaceId: scope.workspaceId, ...scheduleColumns(schedule) })
        .run();
      return schedule;
    },

    getByTask: async (scope: Scope, taskId: Id) => {
      const row = db
        .select()
        .from(taskSchedules)
        .where(inScope(scope, eq(taskSchedules.taskId, taskId)))
        .get();
      return row === undefined ? null : toTaskSchedule(row);
    },

    /** Oldest schedule first (ids are monotonic), across every project of the workspace. */
    listEnabled: async (scope: Scope) =>
      db
        .select()
        .from(taskSchedules)
        .where(inScope(scope, eq(taskSchedules.enabled, true)))
        .orderBy(asc(taskSchedules.id))
        .all()
        .map(toTaskSchedule),

    /**
     * Every `after_task` schedule whose trigger names this task, oldest first — enabled or not:
     * whether a disabled one may fire is the scheduler's to decide.
     */
    listAfterTask: async (scope: Scope, taskId: Id) =>
      db
        .select()
        .from(taskSchedules)
        .where(inScope(scope, eq(taskSchedules.afterTaskId, taskId)))
        .orderBy(asc(taskSchedules.id))
        .all()
        .map(toTaskSchedule),

    save: async (scope: Scope, schedule: TaskSchedule) => {
      const { changes } = db
        .update(taskSchedules)
        .set(scheduleColumns(schedule))
        .where(inScope(scope, eq(taskSchedules.id, schedule.id)))
        .run();
      assertSaved(changes, 'Task schedule', schedule.id);
      return schedule;
    },

    delete: async (scope: Scope, id: Id) =>
      db
        .delete(taskSchedules)
        .where(inScope(scope, eq(taskSchedules.id, id)))
        .run().changes > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Activity — append-only, in insertion order                                  */
/* -------------------------------------------------------------------------- */

export function createTaskActivityRepository(db: Db): TaskActivityRepository {
  return {
    append: async (scope: Scope, activity: TaskActivity) => {
      assertNoSecrets(activity, `taskActivity(${activity.id})`);
      db.insert(taskActivity)
        .values({
          id: activity.id,
          workspaceId: scope.workspaceId,
          taskId: activity.taskId,
          kind: activity.kind,
          message: activity.message,
          executionId: activity.executionId ?? null,
          runId: activity.runId ?? null,
          at: activity.at,
        })
        .run();
      return activity;
    },

    /**
     * Oldest first, by the order they were appended (`seq`). With a limit, the newest `limit` rows
     * — still oldest first — which is what a feed that shows the latest entries wants.
     */
    listByTask: async (scope: Scope, taskId: Id, limit?: number) => {
      if (limit !== undefined && limit <= 0) return [];
      const where = and(
        eq(taskActivity.workspaceId, scope.workspaceId),
        eq(taskActivity.taskId, taskId),
      );
      if (limit === undefined) {
        return db
          .select()
          .from(taskActivity)
          .where(where)
          .orderBy(asc(taskActivity.seq))
          .all()
          .map(toTaskActivity);
      }
      return db
        .select()
        .from(taskActivity)
        .where(where)
        .orderBy(desc(taskActivity.seq))
        .limit(limit)
        .all()
        .reverse()
        .map(toTaskActivity);
    },
  };
}
