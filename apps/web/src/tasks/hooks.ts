import type {
  AcceptTaskRequest,
  ApplyTaskRequest,
  CloseTaskRequest,
  CreateTaskRequest,
  Id,
  MergePullRequestRequest,
  OpenPullRequestRequest,
  PutTaskScheduleRequest,
  RepositoryInfo,
  ReviewTaskRequest,
  StartWorkRequest,
  Task,
  TaskDeliverable,
  TaskSchedule,
  UpdateTaskRequest,
} from '@ace/contracts';
import { AceApiError, type TaskListFilter } from '@ace/sdk';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api } from '../app/api';
import { normalizeTaskFilter, taskKeys } from './keys';
import { removeTask, writeTask } from './task-cache';

/**
 * Engine data for the task screens (ACE parity P0, design §8). Reads are queries keyed by
 * `taskKeys`; every action answers the task, which is written into the caches at once, and then the
 * project's lists and the task's detail are invalidated so executions, checks and the rest follow.
 * Live changes arrive as `task.updated` / `task.deleted` on the engine subscription (`app/socket`).
 */

/** `GET /projects/:id/tasks` — the board, or one filtered view of it. */
export function useTasks(projectId: Id, filter: TaskListFilter = {}) {
  return useQuery({
    queryKey: taskKeys.list(projectId, filter),
    queryFn: async () => (await api().listTasks(projectId, normalizeTaskFilter(filter))).items,
    enabled: projectId !== '',
    // typing in the search box keeps the last answer on screen instead of a loading line
    placeholderData: (previous) => previous,
  });
}

/**
 * `GET /tasks/:id` — the task with its workspace, schedule, preview, executions, checks, reviews
 * and deliveries. `refetchInterval` is for a view that must follow what no frame announces — a
 * running preview's output (D278).
 */
export function useTask(id: Id, options: { refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: taskKeys.detail(id),
    queryFn: () => api().getTask(id),
    enabled: id !== '',
    ...(options.refetchInterval === undefined ? {} : { refetchInterval: options.refetchInterval }),
  });
}

export function useTaskActivity(id: Id) {
  return useQuery({
    queryKey: taskKeys.activity(id),
    queryFn: () => api().listTaskActivity(id),
    enabled: id !== '',
  });
}

/** `GET /tasks/:id/changes`; only asked for once the task has a workspace (404 `no_workspace`). */
export function useTaskChanges(id: Id, enabled = true) {
  return useQuery({
    queryKey: taskKeys.changes(id),
    queryFn: () => api().getTaskChanges(id),
    enabled: id !== '' && enabled,
  });
}

export function useTaskFileDiff(id: Id, path: string | undefined) {
  return useQuery({
    queryKey: taskKeys.fileDiff(id, path ?? ''),
    queryFn: () => api().getTaskFileDiff(id, path ?? ''),
    enabled: id !== '' && path !== undefined,
  });
}

/** `GET /projects/:id/repository` — what Apply shows and Project settings reports. */
export function useRepository(projectId: Id) {
  return useQuery({
    queryKey: taskKeys.repository(projectId),
    queryFn: () => api().getRepository(projectId),
    enabled: projectId !== '',
  });
}

/** `POST /projects/:id/repository/init` — Initialize Git (409 `already_repository`). */
export function useInitRepository(projectId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<RepositoryInfo> => api().initRepository(projectId),
    onSuccess: (repository) => queryClient.setQueryData(taskKeys.repository(projectId), repository),
    onSettled: () => queryClient.invalidateQueries({ queryKey: taskKeys.repository(projectId) }),
  });
}

/** An answered task: into every cache, then the lists and the detail follow the engine. */
function settleTask(queryClient: QueryClient, task: Task): void {
  writeTask(queryClient, task);
  void queryClient.invalidateQueries({ queryKey: taskKeys.lists(task.projectId) });
  void queryClient.invalidateQueries({ queryKey: taskKeys.detail(task.id) });
}

/**
 * A refused action (409 `invalid_transition`, `stale_review`, `destination_changed`…) also
 * refetches: the screen was showing a state the engine no longer holds.
 */
function refetchAfterRefusal(queryClient: QueryClient, id: Id, error: unknown): void {
  if (AceApiError.is(error) && error.status >= 400 && error.status < 500) {
    void queryClient.invalidateQueries({ queryKey: taskKeys.detail(id) });
  }
}

/**
 * `POST /projects/:id/tasks` — into the Inbox, started at once (`start: 'now'`), or scheduled
 * (`trigger`). The engine creates the task before it checks a trigger, so a refused one can still
 * leave the task in the Inbox: a refusal refetches the board too.
 */
export function useCreateTask(projectId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTaskRequest): Promise<Task> => api().createTask(projectId, body),
    onSuccess: (task) => settleTask(queryClient, task),
    onError: (_error, body) => {
      if (body.trigger !== undefined) {
        void queryClient.invalidateQueries({ queryKey: taskKeys.lists(projectId) });
      }
    },
  });
}

/** `PATCH /tasks/:id`. */
export function useUpdateTask(id: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateTaskRequest): Promise<Task> => api().updateTask(id, body),
    onSuccess: (task) => settleTask(queryClient, task),
    onError: (error) => refetchAfterRefusal(queryClient, id, error),
  });
}

/** `DELETE /tasks/:id` — the card leaves every list; the caller navigates away from the page. */
export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (task: Pick<Task, 'id' | 'projectId'>): Promise<void> => api().deleteTask(task.id),
    onSuccess: (_void, task) => {
      removeTask(
        queryClient,
        { taskId: task.id, projectId: task.projectId },
        { refetchDetail: false },
      );
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists(task.projectId) });
    },
    onError: (error, task) => refetchAfterRefusal(queryClient, task.id, error),
  });
}

/** One task action: its call, the task written back, a refusal refetched. */
function useTaskAction<V>(id: Id, call: (id: Id, variables: V) => Promise<Task>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: V): Promise<Task> => call(id, variables),
    onSuccess: (task) => settleTask(queryClient, task),
    onError: (error) => refetchAfterRefusal(queryClient, id, error),
  });
}

export const useStartTask = (id: Id) =>
  useTaskAction<void>(id, (taskId) => api().startTask(taskId));
export const usePlanTask = (id: Id) => useTaskAction<void>(id, (taskId) => api().planTask(taskId));
export const useStopTask = (id: Id) => useTaskAction<void>(id, (taskId) => api().stopTask(taskId));
export const useRetryTask = (id: Id) =>
  useTaskAction<void>(id, (taskId) => api().retryTask(taskId));
export const useRunTaskChecks = (id: Id) =>
  useTaskAction<void>(id, (taskId) => api().runTaskChecks(taskId));
export const useWorkTask = (id: Id) =>
  useTaskAction<StartWorkRequest>(id, (taskId, body) => api().workTask(taskId, body));
export const useReviewTask = (id: Id) =>
  useTaskAction<ReviewTaskRequest>(id, (taskId, body) => api().reviewTask(taskId, body));
export const useApplyTask = (id: Id) =>
  useTaskAction<ApplyTaskRequest>(id, (taskId, body) => api().applyTask(taskId, body));
export const useCloseTask = (id: Id) =>
  useTaskAction<CloseTaskRequest>(id, (taskId, body) => api().closeTask(taskId, body));
export const usePauseTask = (id: Id) =>
  useTaskAction<boolean>(id, (taskId, paused) => api().pauseTask(taskId, { paused }));

/* ACE parity P1 (D275–D278) */

/** `PUT /tasks/:id/deliverable` — the edited Document or Email draft. */
export const usePutDeliverable = (id: Id) =>
  useTaskAction<TaskDeliverable>(id, (taskId, deliverable) =>
    api().putTaskDeliverable(taskId, { deliverable }),
  );
export const useAcceptTask = (id: Id) =>
  useTaskAction<AcceptTaskRequest>(id, (taskId, body) => api().acceptTask(taskId, body));
export const useSendTask = (id: Id) => useTaskAction<void>(id, (taskId) => api().sendTask(taskId));
export const useOpenPullRequest = (id: Id) =>
  useTaskAction<OpenPullRequestRequest>(id, (taskId, body) =>
    api().openTaskPullRequest(taskId, body),
  );
export const useMergePullRequest = (id: Id) =>
  useTaskAction<MergePullRequestRequest>(id, (taskId, body) =>
    api().mergeTaskPullRequest(taskId, body),
  );
export const useStartPreview = (id: Id) =>
  useTaskAction<void>(id, (taskId) => api().startTaskPreview(taskId));
export const useStopPreview = (id: Id) =>
  useTaskAction<void>(id, (taskId) => api().stopTaskPreview(taskId));

/**
 * `PUT /tasks/:id/schedule` — answers the schedule, not the task: the task's reason line changed
 * too, so the detail and the board follow the engine.
 */
export function usePutSchedule(task: Pick<Task, 'id' | 'projectId'>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PutTaskScheduleRequest): Promise<TaskSchedule> =>
      api().putTaskSchedule(task.id, body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.detail(task.id) });
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists(task.projectId) });
    },
  });
}

/** `DELETE /tasks/:id/schedule` — the task stays in the Inbox, unscheduled. */
export function useDeleteSchedule(task: Pick<Task, 'id' | 'projectId'>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<void> => api().deleteTaskSchedule(task.id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.detail(task.id) });
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists(task.projectId) });
    },
  });
}
