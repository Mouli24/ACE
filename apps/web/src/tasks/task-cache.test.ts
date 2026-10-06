import type { Task, TaskActivity, TaskActivityListResponse, TaskDetail } from '@ace/contracts';
import { QueryClient } from '@tanstack/react-query';

import { isUnfilteredTaskList, normalizeTaskFilter, taskKeys } from './keys';
import { activityRefreshesDetail, patchTaskUpdated, removeTask, writeTask } from './task-cache';

const P = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const A = '01ARZ3NDEKTSV4RRFFQ69G5FT0';
const B = '01ARZ3NDEKTSV4RRFFQ69G5FT1';

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  projectId: P,
  number: id === A ? 1 : 2,
  title: id === A ? 'Fix search' : 'Write docs',
  brief: '',
  type: 'app',
  stage: 'inbox',
  state: 'idle',
  finishLine: 'review',
  automation: 'assisted',
  priority: 'normal',
  labels: [],
  plan: '',
  acceptance: '',
  runChecks: true,
  paused: false,
  allowedActions: ['start'],
  createdAt: '2026-10-06T10:00:00.000Z',
  updatedAt: '2026-10-06T10:00:00.000Z',
  ...patch,
});

const activity = (kind: TaskActivity['kind'], id = '01ARZ3NDEKTSV4RRFFQ69G5FX0'): TaskActivity => ({
  id,
  taskId: A,
  kind,
  message: kind,
  at: '2026-10-06T10:00:01.000Z',
});

function cache() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(taskKeys.list(P), [task(A)]);
  queryClient.setQueryData(taskKeys.list(P, { label: 'ui' }), [task(A)]);
  const detail: TaskDetail = {
    task: task(A),
    executions: [],
    checks: [],
    reviews: [],
    deliveries: [],
  };
  queryClient.setQueryData(taskKeys.detail(A), detail);
  queryClient.setQueryData<TaskActivityListResponse>(taskKeys.activity(A), { items: [] });
  return queryClient;
}

const stale = (queryClient: QueryClient, key: readonly unknown[]) =>
  queryClient.getQueryState(key)?.isInvalidated;

describe('ACE-P0 task list filters as query keys', () => {
  it('drops blank and unset fields, so {} and { q: "  " } are the same list', () => {
    expect(normalizeTaskFilter({ q: '  ', label: '', attention: false })).toEqual({});
    expect(normalizeTaskFilter({ q: ' x ', stage: 'work', attention: true })).toEqual({
      stage: 'work',
      q: 'x',
      attention: true,
    });
    expect(taskKeys.list(P, { q: ' ' })).toEqual(taskKeys.list(P));
    expect(isUnfilteredTaskList({ q: '' })).toBe(true);
    expect(isUnfilteredTaskList({ label: 'ui' })).toBe(false);
  });
});

describe('ACE-P0 task.updated patches the caches (design §8)', () => {
  it('replaces the card in the unfiltered list, invalidates filtered lists, sets the detail task', () => {
    const queryClient = cache();
    const running = task(A, {
      stage: 'work',
      state: 'running',
      updatedAt: '2026-10-06T10:00:05.000Z',
    });

    patchTaskUpdated(queryClient, { task: running });

    expect(queryClient.getQueryData<Task[]>(taskKeys.list(P))?.[0]?.state).toBe('running');
    expect(stale(queryClient, taskKeys.list(P))).toBe(false);
    expect(stale(queryClient, taskKeys.list(P, { label: 'ui' }))).toBe(true);
    expect(queryClient.getQueryData<TaskDetail>(taskKeys.detail(A))?.task.state).toBe('running');
    // no activity: nothing else moved
    expect(stale(queryClient, taskKeys.detail(A))).toBe(false);
  });

  it('inserts a task the list has not seen, and never rolls a card back to an older answer', () => {
    const queryClient = cache();
    writeTask(queryClient, task(B));
    expect(queryClient.getQueryData<Task[]>(taskKeys.list(P))?.map((t) => t.id)).toEqual([B, A]);

    writeTask(queryClient, task(A, { title: 'Older', updatedAt: '2026-10-06T09:00:00.000Z' }));
    expect(queryClient.getQueryData<Task[]>(taskKeys.list(P))?.[1]?.title).toBe('Fix search');
    expect(queryClient.getQueryData<TaskDetail>(taskKeys.detail(A))?.task.title).toBe('Fix search');
  });

  it('appends the activity row once, and refetches the detail when rows behind it moved', () => {
    const queryClient = cache();
    const row = activity('run_completed');
    patchTaskUpdated(queryClient, { task: task(A), activity: row });
    patchTaskUpdated(queryClient, { task: task(A), activity: row });

    expect(queryClient.getQueryData<TaskActivityListResponse>(taskKeys.activity(A))?.items).toEqual(
      [row],
    );
    expect(stale(queryClient, taskKeys.detail(A))).toBe(true);

    const quiet = cache();
    patchTaskUpdated(quiet, { task: task(A), activity: activity('edited') });
    expect(stale(quiet, taskKeys.detail(A))).toBe(false);
    expect(activityRefreshesDetail('checks_failed')).toBe(true);
    expect(activityRefreshesDetail('paused')).toBe(false);
  });

  it('task.deleted drops the card from every list and refetches an open detail', () => {
    const queryClient = cache();
    removeTask(queryClient, { taskId: A, projectId: P });
    expect(queryClient.getQueryData<Task[]>(taskKeys.list(P))).toEqual([]);
    expect(queryClient.getQueryData<Task[]>(taskKeys.list(P, { label: 'ui' }))).toEqual([]);
    expect(stale(queryClient, taskKeys.detail(A))).toBe(true);

    const own = cache();
    removeTask(own, { taskId: A, projectId: P }, { refetchDetail: false });
    expect(stale(own, taskKeys.detail(A))).toBe(false);
  });
});
