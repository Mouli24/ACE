import {
  RUN_EVENT_TYPES,
  type ApprovalDecisionRequest,
  type Id,
  type Run,
  type RunState,
  type StartRunRequest,
} from '@ace/contracts';
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
export function useRunEvents(workflowId?: Id): void {
  const apply = useRunStore((store) => store.apply);
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const offs = RUN_EVENT_TYPES.map((type) => socket.on(type, (_payload, frame) => apply(frame)));

    /**
     * When the run ends, the records the engine kept are the ones the inspector and the history
     * read, and they are only complete now — so this is where they are refetched. The live overlay
     * needs no refetch at all; it is the frames.
     */
    offs.push(
      socket.on('run.completed', ({ runId }) => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.nodeRuns(runId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) });
        if (workflowId !== undefined) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.runs(workflowId) });
        }
      }),
    );
    /*
     * Pause, resume and a halt each change `status`, `allowedActions` and `pausedAt` on the run row
     * (FR-CTL-006). The overlay already has them from the frame — this is for everything reading the
     * record: the history row, and any screen opened after the fact (BR-01).
     */
    // PG-3.3: a block mid-run (D305) and a Domain run parking (D323) change the record too.
    for (const type of [
      'run.started',
      'run.paused',
      'run.resumed',
      'run.blocked',
      'run.parked',
    ] as const) {
      offs.push(
        socket.on(type, (_payload, frame) => {
          const runId = frame.type === 'run.started' ? frame.payload.run.id : frame.payload.runId;
          void queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) });
          if (workflowId !== undefined) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.runs(workflowId) });
          }
        }),
      );
    }

    return () => offs.forEach((off) => off());
  }, [apply, queryClient, workflowId]);
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
  const arm = useRunStore((store) => store.arm);
  const begin = useRunStore((store) => store.begin);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: StartRunRequest) => api().startRun(workflowId, body),
    // Armed before the request goes out, so a frame that beats the 201 is still folded (§2.4).
    onMutate: () => arm(workflowId),
    onSuccess: (run: Run) => {
      begin(workflowId, run.id, run.status);
      queryClient.setQueryData(queryKeys.run(run.id), run);
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs(workflowId) });
    },
    onError: () => useRunStore.getState().reset(),
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
  /**
   * A node that finished mid-run has a record before the run does, and the inspector may already be
   * open on it, so the list is refetched on a settled node as well as on `run.completed` (which
   * `useRunEvents` invalidates). `completedNodeRuns` only changes when a node reaches a terminal
   * state, which is a handful of times per run rather than once per token.
   */
  const settled = useRunStore((store) => store.settledCount);
  return useQuery({
    queryKey: [...queryKeys.nodeRuns(runId ?? ''), settled],
    queryFn: () => api().listNodeRuns(runId ?? ''),
    enabled: Boolean(runId),
  });
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

/* -------------------------------------------------------------------------- */
/* Run controls (round 3 §2.1, FR-CTL-001..006)                                */
/* -------------------------------------------------------------------------- */

/**
 * The four run controls. Each is a POST that answers the updated `Run`, which is written straight
 * into the cache: the engine decided the new status and the new `allowedActions`, so the toolbar
 * re-renders from its answer and never from a local guess (BR-01, FR-CTL-006).
 *
 * Nothing here is optimistic. A control outside the allowed set is a 409 `invalid_run_state`, and
 * the toolbar only offers what `allowedActions` lists, so an optimistic flip would be a lie in the
 * one case it mattered.
 */
function useRunControl(action: (runId: Id) => Promise<Run>) {
  const queryClient = useQueryClient();
  const begin = useRunStore((store) => store.begin);
  const arm = useRunStore((store) => store.arm);
  return useMutation({
    mutationFn: (runId: Id) => action(runId),
    onSuccess: (run: Run) => {
      queryClient.setQueryData(queryKeys.run(run.id), run);
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs(run.workflowId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodeRuns(run.id) });
      /*
       * A restart is a *new* run on the same snapshot (FR-CTL-004), so the overlay is cleared and
       * re-armed on it; pause, resume and stop keep folding the run already on screen.
       */
      // PG-5.4: a replay is a new run too.
      if (run.restartedFromRunId !== undefined || run.replayOf !== undefined) {
        arm(run.workflowId);
        begin(run.workflowId, run.id, run.status);
      }
    },
  });
}

export const usePauseRun = () => useRunControl((runId) => api().pauseRun(runId));
export const useResumeRun = () => useRunControl((runId) => api().resumeRun(runId));
export const useStopRun = () => useRunControl((runId) => api().stopRun(runId));
export const useRestartRun = () => useRunControl((runId) => api().restartRun(runId));
/**
 * D388: carry on a run that was cut off (HALTED crash, shutdown or stopped) — every interrupted node
 * runs again with its downstream, in one drive of the *same* run, and what finished is kept. Not a
 * `RUN_ACTIONS` value: whether it applies is the contract's `canContinueRun`, which the engine
 * enforces too (409 otherwise).
 */
export const useContinueRun = () => useRunControl((runId) => api().continueRun(runId));
/**
 * PG-5.4: replay a finished run — a new run answered from this one's recording, zero provider
 * calls. Only COMPLETE and HALTED runs can be replayed ({@link canReplay}).
 */
export const useReplayRun = () => useRunControl((runId) => api().replayRun(runId));

/** PG-5.4: whether a run in this state has a whole recording to replay. */
export const canReplay = (status: RunState | undefined): boolean =>
  status === 'COMPLETE' || status === 'HALTED';

/** D323: a run started from Domain stays open until it is ended. */
export const useEndRun = () => useRunControl((runId) => api().endRun(runId));

/** `POST /node-runs/:id/retry` — attempt + 1, optionally with everything downstream (FR-ERR-003/004). */
export function useRetryNodeRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeRunId, withDownstream }: { nodeRunId: Id; withDownstream: boolean }) =>
      api().retryNodeRun(nodeRunId, { withDownstream }),
    onSuccess: (nodeRun) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodeRuns(nodeRun.runId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(nodeRun.runId) });
    },
  });
}

/** `POST /runs/:id/nodes/:nodeId/rerun` — that node alone, on the latest upstream output (FR-CTL-005). */
export function useRerunNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, nodeId }: { runId: Id; nodeId: Id }) => api().rerunNode(runId, nodeId),
    onSuccess: (nodeRun) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodeRuns(nodeRun.runId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(nodeRun.runId) });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Approvals (round 3 §2.3, FR-GRD-013)                                        */
/* -------------------------------------------------------------------------- */

/**
 * `GET /runs/:id/approvals` — what is still waiting on a person (FR-GRD-013). Refetched whenever an
 * approval frame lands, which is what `approvalRevision` tracks: the socket says when to ask, the
 * engine says what is pending (BR-01).
 */
export function useApprovals(runId: Id | undefined, extraRevision?: number) {
  const revision = useRunStore((store) => store.revision);
  return useQuery({
    queryKey: [
      ...queryKeys.approvals(runId ?? ''),
      revision,
      // PG-3.5: a screen with a stream of its own (Domain) says when to ask again too.
      ...(extraRevision === undefined ? [] : [extraRevision]),
    ],
    // A new revision keeps showing the cards it had until the engine answers again.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey.includes(runId ?? '') === true ? previous : undefined,
    queryFn: () => api().listApprovals(runId ?? ''),
    enabled: Boolean(runId),
  });
}

export interface ApprovalDecisionVariables extends ApprovalDecisionRequest {
  nodeRunId: Id;
}

function useApprovalDecision(
  decide: (nodeRunId: Id, body: ApprovalDecisionRequest) => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeRunId, ...body }: ApprovalDecisionVariables) => decide(nodeRunId, body),
    /*
     * Nothing is removed from the overlay here: `node.approval_decided` is what takes a card down,
     * and the engine sends it either way (BR-01). The *queries* do need telling, though — the run
     * page reads `GET /runs/:id/approvals` and has no socket of its own, so without this the answered
     * card stayed on screen and pressing Approve again earned a 409.
     */
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodeRunsRoot() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.approvalsRoot() });
    },
  });
}

export const useApproveNodeRun = () =>
  useApprovalDecision((nodeRunId, body) => api().approveNodeRun(nodeRunId, body));
export const useRejectNodeRun = () =>
  useApprovalDecision((nodeRunId, body) => api().rejectNodeRun(nodeRunId, body));
