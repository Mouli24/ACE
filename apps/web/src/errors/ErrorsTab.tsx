import type {
  BudgetHalt,
  FailureReason,
  HaltReason,
  Id,
  NodeError,
  NodeState,
} from '@ace/contracts';

import { findBlockingNodeId, type UpstreamEdge } from './blocked';
import { ErrorCard } from './ErrorCard';
import { BlockedNote, StoppedNote } from './NodeOutcome';
import { RunSummary } from './RunSummary';

/**
 * The bottom pane's "Errors" tab (round 3 §5 item 3): every failure of the run in one place, with
 * the nodes the run stopped or never reached listed apart from them (FR-ERR-002, FR-ERR-006,
 * FR-ERR-007, TC-ERR-002, TC-ERR-007, TC-ERR-008, NFR-USE-03).
 *
 * Pure view. The engine owns the run, so the tab is handed what it renders and a retry callback —
 * which is also what lets a component test drive every ending without an engine.
 */

/** What the tab needs of a node run; both a `NodeRun` record and the live overlay's view fit. */
export interface ErrorsTabNodeRun {
  nodeRunId: Id;
  nodeId: Id;
  status: NodeState;
  attempt?: number;
  failureReason?: FailureReason;
  error?: NodeError;
}

export interface ErrorsTabProps {
  /** The run snapshot's nodes: their names, and what "blocked by <node>" resolves against. */
  nodes: readonly { id: Id; name: string }[];
  /** The run snapshot's edges, so a BLOCKED node can name the failure upstream of it. */
  edges?: readonly UpstreamEdge[];
  nodeRuns: readonly ErrorsTabNodeRun[];
  haltReason?: HaltReason;
  budgetHalt?: BudgetHalt;
  /** Provider id → name, so a card can say "provider Anthropic" rather than an id. */
  providerNames?: Readonly<Record<Id, string>>;
  /** `POST /node-runs/:id/retry { withDownstream: false }` (FR-ERR-003). */
  onRetry?: (nodeRunId: Id, nodeId: Id) => void;
  retryingNodeRunId?: Id;
  onShowNode?: (nodeId: Id) => void;
}

export function ErrorsTab({
  nodes,
  edges = [],
  nodeRuns,
  haltReason,
  budgetHalt,
  providerNames,
  onRetry,
  retryingNodeRunId,
  onShowNode,
}: ErrorsTabProps) {
  const nameOf = (nodeId: Id): string =>
    nodes.find((node) => node.id === nodeId)?.name ?? 'unknown node';

  const failed = nodeRuns.filter((nodeRun) => nodeRun.status === 'FAILED');
  const stopped = nodeRuns.filter((nodeRun) => nodeRun.status === 'STOPPED');
  const blocked = nodeRuns.filter((nodeRun) => nodeRun.status === 'BLOCKED');

  /*
   * What a BLOCKED node is blocked by: the nearest node upstream of it that failed or was stopped
   * (FR-ERR-006). The engine reports the state, not the cause, so it is resolved from the snapshot.
   */
  const stoppers = new Set<Id>(
    nodeRuns
      .filter((nodeRun) => nodeRun.status === 'FAILED' || nodeRun.status === 'STOPPED')
      .map((nodeRun) => nodeRun.nodeId),
  );

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="errors-tab">
      <RunSummary
        nodeRuns={nodeRuns}
        {...(haltReason === undefined ? {} : { haltReason })}
        {...(budgetHalt === undefined ? {} : { budgetHalt })}
      />

      {nodeRuns.length === 0 && (
        <p className="font-human text-sm text-fg-muted">
          No node has run yet. Start a run and anything that goes wrong appears here.
        </p>
      )}

      {nodeRuns.length > 0 && failed.length === 0 && (
        <p className="font-human text-sm text-fg-muted" data-testid="errors-tab-no-failures">
          No failures in this run.
        </p>
      )}

      {failed.length > 0 && (
        <ul className="flex flex-col gap-2">
          {failed.map((nodeRun) => {
            const providerId = nodeRun.error?.providerId;
            const providerName = providerId === undefined ? undefined : providerNames?.[providerId];
            return (
              <li key={nodeRun.nodeRunId}>
                {nodeRun.error === undefined ? (
                  /*
                   * A node can be FAILED for a moment before its `node.error` frame arrives, and an
                   * old record may carry no error object at all. The reason is still shown; nothing
                   * is guessed about a kind that was never sent.
                   */
                  <p
                    data-testid={`error-without-detail-${nodeRun.nodeId}`}
                    className="rounded-card border border-danger/60 bg-card p-3 font-human text-sm"
                  >
                    {nameOf(nodeRun.nodeId)} failed
                    {nodeRun.failureReason ? ` — ${nodeRun.failureReason}` : ''}. Waiting for the
                    engine to report what went wrong.
                  </p>
                ) : (
                  <ErrorCard
                    nodeId={nodeRun.nodeId}
                    nodeName={nameOf(nodeRun.nodeId)}
                    state={nodeRun.status}
                    error={nodeRun.error}
                    {...(nodeRun.failureReason === undefined
                      ? {}
                      : { failureReason: nodeRun.failureReason })}
                    {...(nodeRun.attempt === undefined ? {} : { attempt: nodeRun.attempt })}
                    {...(providerName === undefined ? {} : { providerName })}
                    {...(onRetry === undefined
                      ? {}
                      : { onRetry: () => onRetry(nodeRun.nodeRunId, nodeRun.nodeId) })}
                    {...(retryingNodeRunId === nodeRun.nodeRunId ? { retrying: true } : {})}
                    {...(onShowNode === undefined
                      ? {}
                      : { onShowNode: () => onShowNode(nodeRun.nodeId) })}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {stopped.length > 0 && (
        <section className="flex flex-col gap-2" data-testid="errors-tab-stopped">
          <h3 className="font-machine text-[10px] uppercase tracking-wide text-fg-muted">
            stopped · not failures
          </h3>
          {stopped.map((nodeRun) => (
            <StoppedNote
              key={nodeRun.nodeRunId}
              nodeId={nodeRun.nodeId}
              nodeName={nameOf(nodeRun.nodeId)}
            />
          ))}
        </section>
      )}

      {blocked.length > 0 && (
        <section className="flex flex-col gap-2" data-testid="errors-tab-blocked">
          <h3 className="font-machine text-[10px] uppercase tracking-wide text-fg-muted">
            blocked · never reached
          </h3>
          {blocked.map((nodeRun) => {
            const blocker = findBlockingNodeId(nodeRun.nodeId, edges, stoppers);
            return (
              <BlockedNote
                key={nodeRun.nodeRunId}
                nodeId={nodeRun.nodeId}
                nodeName={nameOf(nodeRun.nodeId)}
                {...(blocker === undefined ? {} : { blockedByName: nameOf(blocker) })}
              />
            );
          })}
        </section>
      )}
    </div>
  );
}
