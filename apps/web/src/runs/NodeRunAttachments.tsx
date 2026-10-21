import type { Node } from '@ace/contracts';
import type { ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { ErrorCard } from '../errors/ErrorCard';
import { useProviders } from '../providers/hooks';
import { ApprovalStack } from './approvals/ApprovalStack';
import { NodeRunMenu } from './controls/NodeRunMenu';
import { useRerunNode, useRetryNodeRun, useStartRun } from './hooks';
import { useRunStore } from './run-store';

/**
 * What a node carries on the Canvas once a run has reached it (round 3 §5 items 2, 3, 4).
 *
 * These live beside the node rather than in a panel because each is about *that* node: the actions
 * that apply to it, the failure that happened in it, and the question it is waiting on. The node card
 * itself stays a pure view — it is handed a state and renders it — and everything here reads the run
 * from the overlay, so one node's frame never re-renders another's attachments.
 */

/**
 * The column under a node card (D332): absolute, 8px below the card and the card's width, so what
 * hangs off a node never moves the node or changes its measured size. `nodrag nopan`: a press on an
 * approval or a Retry is a click, never the start of a node drag or a pan.
 */
export function UnderCard({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div
      data-under-card
      className="nodrag nopan absolute left-0 top-[calc(100%+8px)] flex flex-col gap-[8px]"
      style={{ width }}
    >
      {children}
    </div>
  );
}

/**
 * Retry · Retry with downstream · Re-run · Start from this node, for the node's latest node run.
 * The node card has no room for it (D332); the Inspector's button row carries the same menu.
 */
export function NodeRunActions({ node }: { node: Node }) {
  const run = useRunStore(
    useShallow((store) => {
      void store.revision;
      const nodeRun = store.nodeRun(node.id);
      return {
        runId: store.runId,
        nodeRunId: nodeRun?.nodeRunId,
        status: nodeRun?.status,
        // D388: an interrupted BLOCKED row is told apart by its code; the object is the view's own.
        error: nodeRun?.error,
      };
    }),
  );
  const retry = useRetryNodeRun();
  const rerun = useRerunNode();
  const start = useStartRun(node.workflowId);
  const busy = retry.isPending || rerun.isPending || start.isPending;

  // Nothing to act on until the run has reached this node; Start from here needs a run to copy from.
  if (run.nodeRunId === undefined || run.status === undefined) return null;

  return (
    <NodeRunMenu
      nodeId={node.id}
      nodeName={node.name}
      state={run.status}
      nodeRunId={run.nodeRunId}
      error={run.error}
      busy={busy}
      onRetry={() => retry.mutate({ nodeRunId: run.nodeRunId!, withDownstream: false })}
      onRetryWithDownstream={() =>
        retry.mutate({ nodeRunId: run.nodeRunId!, withDownstream: true })
      }
      onRerunNode={() => {
        if (run.runId !== undefined) rerun.mutate({ runId: run.runId, nodeId: node.id });
      }}
      onStartFromNode={() => start.mutate({ startFromNodeId: node.id })}
    />
  );
}

/**
 * The failure, on the node it happened in (FR-ERR-002, NFR-USE-03): kind, message, provider, state,
 * a Retry button and what to do next. The same card the Errors tab shows, so the two cannot disagree.
 */
export function NodeErrorCard({ node }: { node: Node }) {
  const nodeRun = useRunStore(
    useShallow((store) => {
      void store.revision;
      const run = store.nodeRun(node.id);
      return run === undefined
        ? undefined
        : {
            nodeRunId: run.nodeRunId,
            status: run.status,
            attempt: run.attempt,
            error: run.error,
            failureReason: run.failureReason,
          };
    }),
  );
  const providers = useProviders();
  const retry = useRetryNodeRun();

  if (nodeRun?.error === undefined || nodeRun.status !== 'FAILED') return null;
  const providerName = providers.data?.find(
    (provider) => provider.id === nodeRun.error?.providerId,
  )?.name;

  return (
    <div className="w-full">
      <ErrorCard
        nodeId={node.id}
        nodeName={node.name}
        state={nodeRun.status}
        error={nodeRun.error}
        attempt={nodeRun.attempt}
        {...(nodeRun.failureReason === undefined ? {} : { failureReason: nodeRun.failureReason })}
        {...(providerName === undefined ? {} : { providerName })}
        retrying={retry.isPending}
        onRetry={() => retry.mutate({ nodeRunId: nodeRun.nodeRunId, withDownstream: false })}
      />
    </div>
  );
}

/**
 * The approval this node is waiting on, anchored to it (FR-GRD-013, TC-GRD-008/009). `A` and `R` act
 * on it only while it is the one question open, so a second waiting node never has its answer typed
 * for it; the top bar's badge is the way through several.
 */
export function NodeApproval({ node }: { node: Node }) {
  const requests = useRunStore(
    useShallow((store) => {
      void store.revision;
      return store.approvals().filter((request) => request.nodeId === node.id);
    }),
  );
  const total = useRunStore((store) => {
    void store.revision;
    return store.approvals().length;
  });

  if (requests.length === 0) return null;
  return (
    <div className="w-full" data-testid={`node-approval-${node.id}`}>
      <ApprovalStack requests={requests} keyboard={total === 1} />
    </div>
  );
}
