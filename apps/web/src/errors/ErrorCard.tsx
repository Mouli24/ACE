import type { FailureReason, Id, NodeError, NodeState } from '@ace/contracts';
import { Badge, Button, StatusRing } from '@ace/ui';
import { RotateCcw } from 'lucide-react';

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
}: ErrorCardProps) {
  const provider = providerName ?? error.providerId;
  return (
    <article
      data-testid={`error-card-${nodeId}`}
      data-kind={error.kind}
      data-state={state}
      className="flex flex-col gap-2 rounded-[12px] border bg-card px-3 py-2.5"
      style={{ borderColor: 'color-mix(in oklab, var(--color-danger) 35%, var(--color-border))' }}
    >
      <header className="flex flex-wrap items-center gap-2">
        <StatusRing state={state} showLabel />
        <span className="font-human text-[15px] font-semibold">{nodeName}</span>
        <Badge
          data-testid={`error-kind-${nodeId}`}
          className="rounded-chip border-danger/40 px-2 py-[3px] font-machine text-[9px] tracking-[0.08em] text-danger"
        >
          {error.kind}
        </Badge>
        <span className="font-machine text-[10px] text-fg-muted">{error.code}</span>
        {failureReason && (
          <span className="font-machine text-[10px] text-fg-muted">{failureReason}</span>
        )}
        {attempt !== undefined && (
          <span className="font-machine text-[10px] text-fg-muted">attempt {attempt}</span>
        )}
        {provider !== undefined && (
          <span
            data-testid={`error-provider-${nodeId}`}
            className="font-machine text-[10px] text-fg-muted"
          >
            provider {provider}
          </span>
        )}
      </header>

      <p className="font-human text-sm">
        <span className="text-fg-muted">{ERROR_KIND_LABEL[error.kind]}: </span>
        {error.message}
      </p>

      {/* NFR-USE-03: what happened, then what to do about it. */}
      <p
        data-testid={`error-next-step-${nodeId}`}
        className="font-human text-[13px] leading-[1.45] text-fg-soft"
      >
        {NEXT_STEP_BY_ERROR_KIND[error.kind]}
      </p>

      <footer className="flex items-center gap-2">
        {onRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry} disabled={retrying}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry
          </Button>
        )}
        {onShowNode && (
          <button
            type="button"
            onClick={onShowNode}
            className="font-machine text-xs text-accent underline-offset-2 hover:underline"
          >
            show node
          </button>
        )}
        {/* `retryable` is about the engine's own retries (FR-ERR-005); a person may always retry. */}
        {!error.retryable && (
          <span className="font-machine text-[10px] text-fg-muted">not retried automatically</span>
        )}
      </footer>
    </article>
  );
}
