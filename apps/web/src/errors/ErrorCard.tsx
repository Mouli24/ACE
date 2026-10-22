import type { FailureReason, Id, NodeError, NodeState } from '@ace/contracts';
import { Badge, Button, Icons, StatusRing } from '@ace/ui';
import type { ReactNode } from 'react';

import { ERROR_KIND_LABEL, NEXT_STEP_BY_ERROR_KIND } from './next-steps';

/**
 * One failure, as the operator meets it (FR-ERR-002, TC-ERR-002, NFR-USE-03).
 *
 * FR-ERR-002 lists what has to be on it: the failed node, the kind, the message, the provider, the
 * state and a Retry button. NFR-USE-03 adds the line that makes it useful — what to do next, which
 * comes from `NEXT_STEP_BY_ERROR_KIND` and exists for every one of the eight kinds.
 *
 * Pure view: the engine owns the retry (`POST /node-runs/:id/retry`), so this component is handed a
 * callback rather than a mutation, and renders identically on the Canvas, in the inspector and in
 * the Errors tab.
 *
 * In the theme (D328): a surface card, radius 12, bordered in `#c94c27` at 35%; the state and the
 * kind as mono chips, the facts in mono 10.5px, the next step as the 11px help line, and Retry as the
 * Close pill.
 */
export interface ErrorCardProps {
  nodeId: Id;
  nodeName: string;
  /** The node's state — FAILED for a failure; a card is never invented for a node that is fine. */
  state: NodeState;
  error: NodeError;
  /** Which distinct failure it is: RUN_FAILED, CONTRACT_VIOLATION, GUARDRAIL_VIOLATION (BR-03). */
  failureReason?: FailureReason;
  /** The provider's name when the app knows it; `error.providerId` is the fallback. */
  providerName?: string;
  attempt?: number;
  /** `POST /node-runs/:id/retry { withDownstream: false }` — the same inputs, attempt + 1. */
  onRetry?: () => void;
  retrying?: boolean;
  /** Select the node on the Canvas, so "open the node settings" has a where. */
  onShowNode?: () => void;
  /**
   * [audit L-13] A line under the next step about the node as it is now — on the Canvas, that it
   * changed since the run started, so Retry (which re-runs the run's snapshot, BR-04) would not
   * pick the change up.
   */
  notice?: ReactNode;
  /** [audit L-13] More actions beside Retry, such as "Run again with changes". */
  actions?: ReactNode;
}

export function ErrorCard({
  nodeId,
  nodeName,
  state,
  error,
  failureReason,
  providerName,
  attempt,
  onRetry,
  retrying,
  onShowNode,
  notice,
  actions,
}: ErrorCardProps) {
  const provider = providerName ?? error.providerId;
  return (
    <article
      data-testid={`error-card-${nodeId}`}
      data-kind={error.kind}
      data-state={state}
      className="flex flex-col gap-[10px] rounded-[12px] border border-[rgba(201,76,39,0.35)] bg-[var(--surface)] p-[14px] text-[var(--ink)]"
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-[13.5px] font-bold">{nodeName}</span>
        <StatusRing state={state} showLabel />
        <Badge variant="danger" data-testid={`error-kind-${nodeId}`}>
          {error.kind}
        </Badge>
      </header>

      <p className="m-0 flex flex-wrap gap-x-2 font-machine text-[10.5px] text-[var(--muted)]">
        <span>{error.code}</span>
        {failureReason && <span>{failureReason}</span>}
        {attempt !== undefined && <span>attempt {attempt}</span>}
        {provider !== undefined && (
          <span data-testid={`error-provider-${nodeId}`}>provider {provider}</span>
        )}
      </p>

      <p className="m-0 text-[13px] leading-[1.5]">
        <span className="text-[var(--muted)]">{ERROR_KIND_LABEL[error.kind]}: </span>
        {error.message}
      </p>

      {/* NFR-USE-03: what happened, then what to do about it. */}
      <p
        data-testid={`error-next-step-${nodeId}`}
        className="m-0 text-[11px] leading-[1.45] text-[var(--muted)]"
      >
        {NEXT_STEP_BY_ERROR_KIND[error.kind]}
      </p>

      {notice}

      <footer className="flex flex-wrap items-center gap-3">
        {onRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry} disabled={retrying}>
            <Icons.RotateCw aria-hidden size={12} /> Retry
          </Button>
        )}
        {actions}
        {onShowNode && (
          <button
            type="button"
            onClick={onShowNode}
            className="cursor-pointer border-none bg-transparent p-0 text-[11.5px] font-semibold text-[#e8623a] outline-none hover:text-danger focus-visible:shadow-[0_0_0_2px_var(--focus)]"
          >
            show node
          </button>
        )}
        {/* `retryable` is about the engine's own retries (FR-ERR-005); a person may always retry. */}
        {!error.retryable && (
          <span className="font-machine text-[10.5px] text-[var(--muted)]">
            not retried automatically
          </span>
        )}
      </footer>
    </article>
  );
}
