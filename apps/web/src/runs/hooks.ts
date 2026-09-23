import { RUN_EVENT_TYPES, type Id, type Run, type StartRunRequest } from '@ace/contracts';
import type { AceSocketStatus } from '@ace/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api } from '../app/api';
import { getSocket } from '../app/socket';
import { queryKeys } from '../workflows/query-keys';
import { useRunStore } from './run-store';

/**
 * Feed every run frame of §2.4 into the overlay store, for as long as a Canvas is mounted.
 *
 * The socket resubscribes and replays `resume { afterSeq }` by itself on a reconnect, and the
 * buffer drops any frame it has already folded, so a drop mid-run costs nothing but the gap
 * (FR-EXE-014, TC-EXE-013).
 */
export function useRunEvents(): void {
  const apply = useRunStore((store) => store.apply);
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const offs = RUN_EVENT_TYPES.map((type) => socket.on(type, (_payload, frame) => apply(frame)));
    return () => offs.forEach((off) => off());
  }, [apply]);
}

/** The connection state behind the top bar's "reconnecting" notice (FR-EXE-014). */
export function useSocketStatus(): AceSocketStatus {
  const [status, setStatus] = useState<AceSocketStatus>(() => getSocket()?.status ?? 'idle');
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    setStatus(socket.status);
    return socket.onStatus(setStatus);
  }, []);
  return status;
}

/**
 * `POST /workflows/:id/runs` (FR-EXE-001). A BLOCKED run is a normal 201 with pre-flight issues
 * (FR-EXE-003), so it is a success here and the screen renders the issues.
 */
export function useStartRun(workflowId: Id) {
  const begin = useRunStore((store) => store.begin);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: StartRunRequest) => api().startRun(workflowId, body),
    onSuccess: (run: Run) => {
      begin(workflowId, run.id, run.status);
      queryClient.setQueryData(queryKeys.run(run.id), run);
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs(workflowId) });
    },
  });
}

/** `GET /workflows/:id/runs`, newest first as the engine returns them (FR-EXE-012). */
export function useRuns(workflowId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.runs(workflowId ?? ''),
    queryFn: async () => (await api().listRuns(workflowId ?? '')).items,
    enabled: Boolean(workflowId),
  });
}

export function useRun(runId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.run(runId ?? ''),
    queryFn: () => api().getRun(runId ?? ''),
    enabled: Boolean(runId),
  });
}

/**
 * `GET /runs/:id/node-runs` — what the inspector reads (FR-EXE-010). While the run is in flight the
 * overlay is ahead of this query, so it is refetched when the run ends and whenever the inspector
 * opens a node.
 */
export function useNodeRuns(runId: Id | undefined) {
  const revision = useRunStore((store) => store.revision);
  const query = useQuery({
    queryKey: queryKeys.nodeRuns(runId ?? ''),
    queryFn: () => api().listNodeRuns(runId ?? ''),
    enabled: Boolean(runId),
  });
  const active = useRunStore((store) => store.active);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!runId || !active) return;
    // One refetch per frame batch would be wasteful; the overlay covers the live view, so this
    // only needs to catch up when the run settles.
    const timer = setTimeout(
      () => void queryClient.invalidateQueries({ queryKey: queryKeys.nodeRuns(runId) }),
      300,
    );
    return () => clearTimeout(timer);
  }, [runId, active, revision, queryClient]);
  return query;
}

/** A finished run's node runs — no live refresh, because the record cannot change (BR-04). */
export function useNodeRunsOnce(runId: Id | undefined) {
  return useQuery({
    queryKey: queryKeys.nodeRuns(runId ?? ''),
    queryFn: () => api().listNodeRuns(runId ?? ''),
    enabled: Boolean(runId),
  });
}

/** Which Input nodes still have nothing to send — what the input dialog asks for (FR-NODE-011). */
export function inputNodesNeedingText(
  nodes: Array<{ id: string; kind: string; name: string; config: unknown }>,
): Array<{ id: string; name: string }> {
  return nodes
    .filter((node) => node.kind === 'input')
    .filter((node) => {
      const config = node.config as { text?: string; artifactIds?: string[] };
      return !config.text?.trim() && (config.artifactIds?.length ?? 0) === 0;
    })
    .map((node) => ({ id: node.id, name: node.name }));
}
