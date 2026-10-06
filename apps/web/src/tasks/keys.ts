import type { Id } from '@ace/contracts';
import type { TaskListFilter } from '@ace/sdk';

/**
 * The filter as a query key: blank and unset fields dropped, so `{}` and `{ q: '' }` are the same
 * list — the unfiltered one a `task.updated` frame patches in place (every filtered list is
 * invalidated instead, because only the engine knows whether the task still matches it).
 */
export function normalizeTaskFilter(filter: TaskListFilter = {}): TaskListFilter {
  const out: TaskListFilter = {};
  if (filter.stage !== undefined) out.stage = filter.stage;
  const q = filter.q?.trim();
  if (q !== undefined && q !== '') out.q = q;
  if (filter.label !== undefined && filter.label !== '') out.label = filter.label;
  if (filter.attention === true) out.attention = true;
  return out;
}

export const isUnfilteredTaskList = (filter: TaskListFilter): boolean =>
  Object.keys(normalizeTaskFilter(filter)).length === 0;

/**
 * TanStack Query keys for the task screens (ACE parity P0). Everything about one task hangs under
 * `taskKeys.detail(id)`, so invalidating it refreshes the detail, its activity, changes and diffs at
 * once; `exact` narrows that when only the detail is stale.
 */
export const taskKeys = {
  /** Every list of one project's tasks, whatever its filter. */
  lists: (projectId: Id) => ['tasks', projectId] as const,
  list: (projectId: Id, filter: TaskListFilter = {}) =>
    ['tasks', projectId, normalizeTaskFilter(filter)] as const,
  detail: (id: Id) => ['task', id] as const,
  activity: (id: Id) => ['task', id, 'activity'] as const,
  /** The changes and every file diff under them. */
  changes: (id: Id) => ['task', id, 'changes'] as const,
  fileDiff: (id: Id, path: string) => ['task', id, 'changes', 'diff', path] as const,
  repository: (projectId: Id) => ['repository', projectId] as const,
};
