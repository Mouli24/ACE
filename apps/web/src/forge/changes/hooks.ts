import {
  CheckpointConflictDetailsSchema,
  type Checkpoint,
  type CheckpointAction,
  type CheckpointStatus,
  type CheckpointUpdatedPayload,
} from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { api } from '../../app/api';
import { getSocket } from '../../app/socket';
import { useProjectScope } from '../project-scope';
import { useChangesStore } from './changes-store';

/** Query keys for checkpoints, under `['checkpoints', projectId]`. */
export const checkpointKeys = {
  all: (projectId: string) => ['checkpoints', projectId] as const,
  list: (projectId: string) => ['checkpoints', projectId, 'list'] as const,
  one: (projectId: string, id: string) => ['checkpoints', projectId, 'one', id] as const,
  diff: (projectId: string, id: string, path: string) =>
    ['checkpoints', projectId, 'diff', id, path] as const,
};

const OPEN: ReadonlySet<CheckpointStatus> = new Set(['recording', 'pending']);

/** The engine's order: open ones (recording, pending) first, then the rest; newest first in each. */
export function sortCheckpoints(list: readonly Checkpoint[]): Checkpoint[] {
  const newest = [...list].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  return [
    ...newest.filter((checkpoint) => OPEN.has(checkpoint.status)),
    ...newest.filter((checkpoint) => !OPEN.has(checkpoint.status)),
  ];
}

/** One `checkpoint.updated` (or an action's answer) into the cache: the list and the checkpoint. */
export function applyCheckpoint(
  queryClient: QueryClient,
  projectId: string,
  checkpoint: Checkpoint,
  removed = false,
): void {
  const listKey = checkpointKeys.list(projectId);
  if (queryClient.getQueryData(listKey) === undefined) {
    void queryClient.invalidateQueries({ queryKey: listKey });
  } else {
    queryClient.setQueryData<Checkpoint[]>(listKey, (list = []) => {
      const others = list.filter((each) => each.id !== checkpoint.id);
      return removed ? others : sortCheckpoints([...others, checkpoint]);
    });
  }
  const oneKey = checkpointKeys.one(projectId, checkpoint.id);
  if (removed) queryClient.removeQueries({ queryKey: oneKey });
  else queryClient.setQueryData(oneKey, checkpoint);
}

export function applyCheckpointFrame(
  queryClient: QueryClient,
  payload: CheckpointUpdatedPayload,
): void {
  applyCheckpoint(queryClient, payload.projectId, payload.checkpoint, payload.removed === true);
}

/**
 * While mounted: hold the project's scope and fold each `checkpoint.updated` into the cache. Frames
 * are transient, so a reconnect (`hello`) refetches what may have been missed.
 */
export function useCheckpointEvents(projectId: string): void {
  const queryClient = useQueryClient();
  useProjectScope(projectId);
  useEffect(() => {
    if (projectId === '') return;
    const socket = getSocket();
    if (!socket) return;
    const offs = [
      socket.on('checkpoint.updated', (payload) => {
        if (payload.projectId === projectId) applyCheckpointFrame(queryClient, payload);
      }),
      socket.on(
        'hello',
        () => void queryClient.invalidateQueries({ queryKey: checkpointKeys.all(projectId) }),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [projectId, queryClient]);
}

/** The project's checkpoints, open ones first; frames keep it fresh. */
export function useCheckpoints(projectId: string) {
  return useQuery({
    queryKey: checkpointKeys.list(projectId),
    queryFn: () => api().listCheckpoints(projectId),
    enabled: projectId !== '',
    staleTime: 30_000,
  });
}

export function useCheckpoint(projectId: string, checkpointId: string) {
  return useQuery({
    queryKey: checkpointKeys.one(projectId, checkpointId),
    queryFn: () => api().getCheckpoint(projectId, checkpointId),
    enabled: projectId !== '' && checkpointId !== '',
    staleTime: 30_000,
  });
}

/** One file before and after: fixed once recorded, so it never goes stale. */
export function useCheckpointFileDiff(projectId: string, checkpointId: string, path: string) {
  return useQuery({
    queryKey: checkpointKeys.diff(projectId, checkpointId, path),
    queryFn: () => api().checkpointFileDiff(projectId, checkpointId, path),
    staleTime: Infinity,
  });
}

/**
 * Keep or revert. A 409 `checkpoint_conflict` leaves its files pending: each refusal is kept by
 * path, to show on that file, and the checkpoint is refetched — the other files went through.
 */
export function useCheckpointAction(projectId: string, checkpointId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: CheckpointAction) =>
      api().checkpointAction(projectId, checkpointId, action),
    onSuccess: (checkpoint, action) => {
      applyCheckpoint(queryClient, projectId, checkpoint);
      const decided = checkpoint.files
        .filter((file) => file.state !== 'pending')
        .map((file) => file.path);
      useChangesStore.getState().clearConflicts(checkpointId, action.paths ?? decided);
    },
    onError: (error) => {
      if (AceApiError.is(error) && error.code === 'checkpoint_conflict') {
        const details = CheckpointConflictDetailsSchema.safeParse(error.details);
        if (details.success) {
          useChangesStore.getState().setConflicts(checkpointId, details.data.conflicts);
        }
      }
      void queryClient.invalidateQueries({ queryKey: checkpointKeys.all(projectId) });
    },
  });
}

/**
 * Path → the newest pending checkpoint that changed it, for the Explorer's agent-change markers
 * (D300). Holds the project's checkpoint frames while mounted, so the markers follow live.
 */
export function usePendingChanges(projectId: string): ReadonlyMap<string, string> {
  useCheckpointEvents(projectId);
  const list = useCheckpoints(projectId).data;
  return useMemo(() => {
    const pending = new Map<string, string>();
    for (const checkpoint of list ?? []) {
      if (checkpoint.status !== 'pending') continue;
      for (const file of checkpoint.files) {
        if (file.state === 'pending' && !pending.has(file.path))
          pending.set(file.path, checkpoint.id);
      }
    }
    return pending;
  }, [list]);
}
