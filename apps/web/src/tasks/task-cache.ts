import type {
  Task,
  TaskActivity,
  TaskActivityKind,
  TaskActivityListResponse,
  TaskDeletedPayload,
  TaskDetail,
  TaskUpdatedPayload,
} from '@ace/contracts';
import type { TaskListFilter } from '@ace/sdk';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

import { isUnfilteredTaskList, taskKeys } from './keys';

/**
 * Folding task changes into the query cache (ACE parity P0, design §8). The engine owns the truth
 * (BR-01): a `task.updated` frame or an action's answer patches the cached rows, so the board, the
 * task page and the top bar read one cache and cannot disagree.
 */

const filterOf = (key: QueryKey): TaskListFilter => (key[2] ?? {}) as TaskListFilter;

/** Newer wins: a frame that arrives after a fresher answer never rolls a card back. */
const isNewer = (incoming: Task, cached: Task | undefined): boolean =>
  cached === undefined || incoming.updatedAt >= cached.updatedAt;

function upsert(tasks: Task[] | undefined, task: Task): Task[] | undefined {
  if (tasks === undefined) return tasks;
  const index = tasks.findIndex((candidate) => candidate.id === task.id);
  if (index === -1) return [task, ...tasks];
  if (!isNewer(task, tasks[index])) return tasks;
  const next = [...tasks];
  next[index] = task;
  return next;
}

/**
 * Write one task into every cache that shows it: the project's unfiltered list (insert or replace
 * by id), each filtered list (invalidated — only the engine knows whether it still matches), and the
 * detail's `task`.
 */
export function writeTask(queryClient: QueryClient, task: Task): void {
  for (const [key] of queryClient.getQueriesData<Task[]>({
    queryKey: taskKeys.lists(task.projectId),
  })) {
    if (isUnfilteredTaskList(filterOf(key))) {
      queryClient.setQueryData<Task[]>(key, (tasks) => upsert(tasks, task));
    } else {
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    }
  }
  queryClient.setQueryData<TaskDetail>(taskKeys.detail(task.id), (detail) =>
    detail === undefined || !isNewer(task, detail.task) ? detail : { ...detail, task },
  );
}

/**
 * The activity kinds that mean the detail's other rows moved — a new execution, check, review,
 * delivery or workspace commit — so the detail (and its changes) refetch. A plain edit, stage move
 * or pause carries everything it changed on the task itself.
 */
const REFRESHING_KINDS: ReadonlySet<TaskActivityKind> = new Set<TaskActivityKind>([
  'workspace_ready',
  'workspace_failed',
  'run_started',
  'run_completed',
  'run_failed',
  'run_stopped',
  'committed',
  'checks_started',
  'checks_passed',
  'checks_failed',
  'approved',
  'changes_requested',
  'delivered',
  'delivery_failed',
  'retried',
  'error',
]);

export function activityRefreshesDetail(kind: TaskActivityKind): boolean {
  return REFRESHING_KINDS.has(kind);
}

function appendActivity(queryClient: QueryClient, activity: TaskActivity): void {
  queryClient.setQueryData<TaskActivityListResponse>(taskKeys.activity(activity.taskId), (list) =>
    list === undefined || list.items.some((row) => row.id === activity.id)
      ? list
      : { items: [...list.items, activity] },
  );
}

/** A `task.updated` frame (engine scope, design §6). */
export function patchTaskUpdated(queryClient: QueryClient, payload: TaskUpdatedPayload): void {
  const { task, activity } = payload;
  writeTask(queryClient, task);
  if (activity === undefined) return;
  appendActivity(queryClient, activity);
  if (activityRefreshesDetail(activity.kind)) {
    void queryClient.invalidateQueries({ queryKey: taskKeys.detail(task.id), exact: true });
    void queryClient.invalidateQueries({ queryKey: taskKeys.changes(task.id) });
  }
}

/**
 * A task is gone (a `task.deleted` frame, or our own delete): its card leaves every list. An open
 * detail is invalidated rather than dropped, so its page refetches and says the task is gone.
 */
export function removeTask(
  queryClient: QueryClient,
  payload: TaskDeletedPayload,
  options: { refetchDetail?: boolean } = {},
): void {
  for (const [key] of queryClient.getQueriesData<Task[]>({
    queryKey: taskKeys.lists(payload.projectId),
  })) {
    queryClient.setQueryData<Task[]>(key, (tasks) =>
      tasks?.filter((task) => task.id !== payload.taskId),
    );
  }
  if (options.refetchDetail === false) return;
  void queryClient.invalidateQueries({ queryKey: taskKeys.detail(payload.taskId), exact: true });
}
