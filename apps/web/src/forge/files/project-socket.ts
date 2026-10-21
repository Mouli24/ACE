import type { FilesChangedPayload } from '@ace/contracts';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { getSocket } from '../../app/socket';
import { useProjectScope } from '../project-scope';
import { fileKeys } from './keys';
import { isWithin, parentOf } from './paths';

/** `/files/status` is refetched at most once a second, however fast the disk churns (design §6.1). */
const STATUS_THROTTLE_MS = 1_000;
/** Per query client, so one client's pending refresh never swallows another's. */
const statusTimers = new WeakMap<QueryClient, Map<string, ReturnType<typeof setTimeout>>>();

function refreshStatusSoon(queryClient: QueryClient, projectId: string): void {
  const timers = statusTimers.get(queryClient) ?? new Map<string, ReturnType<typeof setTimeout>>();
  statusTimers.set(queryClient, timers);
  if (timers.has(projectId)) return;
  timers.set(
    projectId,
    setTimeout(() => {
      timers.delete(projectId);
      void queryClient.invalidateQueries({ queryKey: fileKeys.status(projectId) });
    }, STATUS_THROTTLE_MS),
  );
}

/** A `.gitignore` anywhere: what it ignores decides the file list and the folders' dimming. */
const isGitignore = (path: string): boolean =>
  path === '.gitignore' || path.endsWith('/.gitignore');

/**
 * [audit F-8] The file list — a walk of up to 50,000 files — is refreshed at most once every 2 s
 * while files keep coming and going (an install, a build): the first burst at once, the rest of
 * the churn once, when the window closes.
 */
const LIST_THROTTLE_MS = 2_000;
/** Per query client and project, the window open now, and whether a burst came during it. */
const listWindows = new WeakMap<QueryClient, Map<string, { again: boolean }>>();

function refreshListSoon(queryClient: QueryClient, projectId: string): void {
  const windows = listWindows.get(queryClient) ?? new Map<string, { again: boolean }>();
  listWindows.set(queryClient, windows);
  const open = windows.get(projectId);
  if (open !== undefined) {
    open.again = true;
    return;
  }
  void queryClient.invalidateQueries({ queryKey: fileKeys.list(projectId) });
  const window = { again: false };
  windows.set(projectId, window);
  setTimeout(() => {
    windows.delete(projectId);
    if (window.again) refreshListSoon(queryClient, projectId);
  }, LIST_THROTTLE_MS);
}

/**
 * One `files.changed` burst into the query cache: the folder showing each path, the content of a
 * changed file, everything inside a created or deleted folder, and quick open's list — and, when a
 * `.gitignore` changed, the list and every folder, as the list never goes stale by time ([audit
 * F-6]).
 */
export function applyFilesChanged(queryClient: QueryClient, payload: FilesChangedPayload): void {
  const { projectId } = payload;
  refreshStatusSoon(queryClient, projectId);
  if (payload.resync) {
    void queryClient.invalidateQueries({ queryKey: fileKeys.all(projectId) });
    return;
  }
  let listChanged = false;
  if (payload.changes.some((change) => isGitignore(change.path))) {
    listChanged = true;
    void queryClient.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === 'files' && queryKey[1] === projectId && queryKey[2] === 'folder',
    });
  }
  for (const change of payload.changes) {
    void queryClient.invalidateQueries({
      queryKey: fileKeys.folder(projectId, parentOf(change.path)),
    });
    if (change.kind === 'changed') {
      void queryClient.invalidateQueries({ queryKey: fileKeys.content(projectId, change.path) });
      continue;
    }
    listChanged = true;
    void queryClient.invalidateQueries({
      predicate: ({ queryKey }) => {
        const [scope, owner, kind, path] = queryKey;
        return (
          scope === 'files' &&
          owner === projectId &&
          (kind === 'content' || kind === 'folder') &&
          typeof path === 'string' &&
          path !== '' &&
          isWithin(path, change.path)
        );
      },
    });
  }
  if (listChanged) refreshListSoon(queryClient, projectId);
}

/**
 * While mounted: hold the project's scope — the engine watches its folder meanwhile — and fold
 * each `files.changed` into the cache. Mounting also refreshes every file query of the project,
 * and so does a reconnect (`hello`): frames missed while away are never replayed, because they
 * are transient. The subscription is shared with the terminal (`useProjectScope`, D301). The
 * workflow layout holds it in every mode ([audit F-6]), so this runs once per project visit, and
 * its refresh joins a fetch a query that just mounted has started rather than walking again.
 */
export function useProjectFiles(projectId: string | undefined): void {
  const queryClient = useQueryClient();
  useProjectScope(projectId);
  useEffect(() => {
    if (!projectId) return;
    void queryClient.invalidateQueries(
      { queryKey: fileKeys.all(projectId) },
      { cancelRefetch: false },
    );
    const socket = getSocket();
    if (!socket) return;
    const offChanged = socket.on('files.changed', (frame) => {
      if (frame.projectId === projectId) applyFilesChanged(queryClient, frame);
    });
    const offHello = socket.on('hello', () => {
      void queryClient.invalidateQueries({ queryKey: fileKeys.all(projectId) });
    });
    return () => {
      offChanged();
      offHello();
    };
  }, [projectId, queryClient]);
}
