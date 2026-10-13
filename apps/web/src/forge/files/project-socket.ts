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

/**
 * One `files.changed` burst into the query cache: the folder showing each path, the content of a
 * changed file, everything inside a created or deleted folder, and quick open's list.
 */
export function applyFilesChanged(queryClient: QueryClient, payload: FilesChangedPayload): void {
  const { projectId } = payload;
  refreshStatusSoon(queryClient, projectId);
  // Search's results follow the disk, as VS Code's do (D299 Phase 4).
  void queryClient.invalidateQueries({ queryKey: fileKeys.searches(projectId) });
  if (payload.resync) {
    void queryClient.invalidateQueries({ queryKey: fileKeys.all(projectId) });
    return;
  }
  let listChanged = false;
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
  if (listChanged) void queryClient.invalidateQueries({ queryKey: fileKeys.list(projectId) });
}

/**
 * While mounted: hold the project's scope — the engine watches its folder meanwhile — and fold
 * each `files.changed` into the cache. Mounting also refreshes every file query of the project,
 * and so does a reconnect (`hello`): frames missed while away are never replayed, because they
 * are transient. The subscription is shared with the terminal (`useProjectScope`, D301).
 */
export function useProjectFiles(projectId: string | undefined): void {
  const queryClient = useQueryClient();
  useProjectScope(projectId);
  useEffect(() => {
    if (!projectId) return;
    void queryClient.invalidateQueries({ queryKey: fileKeys.all(projectId) });
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
