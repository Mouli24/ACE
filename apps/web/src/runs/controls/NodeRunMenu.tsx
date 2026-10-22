import { isInterruptedNodeRun, type Id, type NodeError, type NodeState } from '@ace/contracts';
import { RUN_GOING_TITLE } from '../hooks';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icons,
} from '@ace/ui';

/**
 * The node-level controls (round 3 §5 item 2): Retry · Retry with downstream · Re-run this node ·
 * Start from this node (FR-ERR-003, FR-ERR-004, FR-CTL-005, FR-EXE-013).
 *
 * Each item is one engine call, and the caller makes it — the menu takes callbacks, so the same
 * component serves the Canvas context menu and the inspector's button row:
 *
 *   Retry                 `POST /node-runs/:nodeRunId/retry  { withDownstream: false }`
 *   Retry with downstream `POST /node-runs/:nodeRunId/retry  { withDownstream: true }`
 *   Re-run this node      `POST /runs/:runId/nodes/:nodeId/rerun`
 *   Start from this node  `POST /workflows/:workflowId/runs  { startFromNodeId: nodeId }`
 *
 * Unlike the run controls, these are *node* actions and the contract carries no `allowedActions` for
 * them, so what is enabled follows the FRS: a retry needs a node run that failed (FR-ERR-003/004)
 * or, D388, one that was cut off before it finished — STOPPED, or BLOCKED by an engine restart
 * under it (`isInterruptedNodeRun`; a node BLOCKED by a failed upstream never started, and is
 * retried with that upstream) — a re-run needs a node run to take the latest upstream outputs from
 * (FR-CTL-005), and starting from a node needs neither — it starts a new run (FR-EXE-013).
 *
 * The trigger is the theme's "…" pill (24px, hairline, soft, 11px) and the items are its menu (D328).
 */
export interface NodeRunMenuProps {
  nodeId: Id;
  nodeName: string;
  /** The node's state in the run being looked at. */
  state: NodeState;
  /** The node's latest node run, if the run has reached it. */
  nodeRunId?: Id;
  /** D388: that node run's error, whose code tells an interrupted BLOCKED row from a blocked one. */
  error?: NodeError | undefined;
  onRetry: () => void;
  onRetryWithDownstream: () => void;
  onRerunNode: () => void;
  onStartFromNode: () => void;
  busy?: boolean;
  /** [audit W-8] A run of the workflow is going: Start from this node would start a second. */
  runGoing?: boolean;
}

export function NodeRunMenu({
  nodeId,
  nodeName,
  state,
  nodeRunId,
  error,
  onRetry,
  onRetryWithDownstream,
  onRerunNode,
  onStartFromNode,
  busy,
  runGoing = false,
}: NodeRunMenuProps) {
  const hasNodeRun = nodeRunId !== undefined;
  const retryable = state === 'FAILED' || isInterruptedNodeRun({ status: state, error });
  const canRetry = hasNodeRun && retryable && !busy;
  const canRerun = hasNodeRun && !busy;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={`node-actions-${nodeId}`}
          aria-label={`Run actions for ${nodeName}`}
          className="inline-flex h-[24px] cursor-pointer items-center rounded-full border border-[var(--line)] bg-[var(--soft)] px-[9px] text-[11px] text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
        >
          <Icons.MoreHorizontal aria-hidden size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem
          data-testid={`node-action-retry-${nodeId}`}
          disabled={!canRetry}
          onSelect={onRetry}
        >
          Retry
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid={`node-action-retry-downstream-${nodeId}`}
          disabled={!canRetry}
          onSelect={onRetryWithDownstream}
        >
          Retry with downstream
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid={`node-action-rerun-${nodeId}`}
          disabled={!canRerun}
          onSelect={onRerunNode}
        >
          Re-run this node
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid={`node-action-start-from-${nodeId}`}
          disabled={busy === true || runGoing}
          {...(runGoing ? { title: RUN_GOING_TITLE } : {})}
          onSelect={onStartFromNode}
        >
          Start from this node
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
