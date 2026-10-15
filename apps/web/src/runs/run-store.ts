import type {
  ApprovalRequest,
  BudgetHalt,
  FailureReason,
  HaltReason,
  Id,
  NodeState,
  Part,
  RunAction,
  RunState,
  ServerFrame,
  ToolCall,
  Usage,
  Verdict,
} from '@ace/contracts';
import { allowedRunActions } from '@ace/contracts';
import {
  RunEventBuffer,
  type EdgeTransferView,
  type NodeRunView,
  type PersistedRunEvent,
} from '@ace/sdk';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

/**
 * The live run overlay (Arch §10.1: Zustand for the live overlay). The engine owns the truth, so
 * this store holds no decisions of its own — it is the folded `§2.4` event stream and nothing else.
 *
 * The fold itself lives in `@ace/sdk`'s `RunEventBuffer`, which is what the acceptance tests use
 * against the real engine; the store only republishes its view so React can subscribe. A monotonic
 * `revision` is what changes on every frame: the view object is stable, so components select the
 * one field they render and a token for node A never re-renders node B.
 */
interface RunOverlayState {
  /** The run the overlay is showing, if any. */
  runId: Id | undefined;
  status: RunState | undefined;
  haltReason: HaltReason | undefined;
  /** Set only alongside `haltReason: 'budget_exceeded'` — which cap tripped (FR-GRD-008, D80). */
  budgetHalt: BudgetHalt | undefined;
  /** What the run in this state accepts, from the contract's one table (FR-CTL-006, D76). */
  allowedActions: RunAction[] | undefined;
  /** When the pause landed, so the run bar can say how long it has been held (FR-CTL-002). */
  pausedAt: string | undefined;
  totals: Usage | undefined;
  finalOutput: Record<Id, Part[]> | undefined;
  /** Bumped on every applied frame; the cheap way to invalidate the derived selectors. */
  revision: number;
  /**
   * How many node runs have reached a terminal state (Arch §19.1). It moves a handful of times per
   * run rather than once per token, which makes it the right thing to key a refetch on.
   */
  settledCount: number;
  /** True from `POST /runs` until `run.completed`; the UI allows one active run per workflow. */
  active: boolean;
  /** The workflow whose run this is, so another workflow's Canvas stays clean. */
  workflowId: Id | undefined;

  /** Clear the fold and claim the workflow, before the start request is sent. */
  arm(workflowId: Id): void;
  /**
   * Rebuild the overlay from what the engine has recorded, for a run this client did not start —
   * after a reload, or when a Canvas is opened while a run is already going (FR-EXE-014).
   */
  adopt(
    workflowId: Id,
    run: AdoptableRun,
    nodeRuns: readonly AdoptableNodeRun[],
    /** The run's approvals still waiting on a person, from `GET /runs/:id/approvals` (D-074). */
    approvals?: readonly ApprovalRequest[],
  ): void;
  begin(workflowId: Id, runId: Id, status: RunState): void;
  apply(frame: ServerFrame): void;
  reset(): void;

  nodeState(nodeId: Id): NodeState;
  nodeRun(nodeId: Id): NodeRunView | undefined;
  nodeRunById(nodeRunId: Id): NodeRunView | undefined;
  nodeRuns(): NodeRunView[];
  streamedText(nodeRunId: Id): string;
  lastTransfer(edgeId: Id): EdgeTransferView | undefined;
  /** Approvals still waiting on a person, newest last (FR-GRD-013). */
  approvals(): ApprovalRequest[];
  /** Every guardrail verdict recorded against this node run (FR-GRD-015). */
  verdicts(nodeRunId: Id): Verdict[];
  /** How many iterations this node has run, for the loop selector (FR-CON-007). */
  iterations(nodeId: Id): number;
  /** The persisted frames in order, for the events tab (FR-OBS-002). */
  events(): PersistedRunEvent[];
  /** What a reconnect must ask the engine to replay (FR-EXE-014). */
  lastSeq(): number;
}

/** The parts of a `Run` the overlay needs to adopt one; a `Run` itself carries far more. */
export interface AdoptableRun {
  id: Id;
  status: RunState;
  haltReason?: HaltReason;
  budgetHalt?: BudgetHalt;
  allowedActions?: RunAction[];
  pausedAt?: string;
  totals: Usage;
  finalOutput?: Record<Id, Part[]>;
}

/** The parts of a `NodeRun` the overlay can rebuild a card from. */
export interface AdoptableNodeRun {
  id: Id;
  nodeId: Id;
  iteration: number;
  attempt: number;
  status: NodeState;
  failureReason?: FailureReason;
  modelUsed?: NodeRunView['modelUsed'];
  output?: Part[];
  usage: Usage;
  /** The calls it made (round 4 §2.1); rebuilt as `tool.call` frames for Forge (PG-3.2). */
  toolCalls?: readonly ToolCall[];
}

/** One buffer per store; `reset()` clears it rather than replacing it, so selectors stay valid. */
const buffer = new RunEventBuffer();

const IDLE: NodeState = 'IDLE';

/** Terminal node states (Arch §19.1): once a node is here its record on the engine is complete. */
const TERMINAL: ReadonlySet<NodeState> = new Set<NodeState>([
  'COMPLETED',
  'FAILED',
  'STOPPED',
  'BLOCKED',
]);

export const useRunStore = create<RunOverlayState>((set) => ({
  runId: undefined,
  status: undefined,
  haltReason: undefined,
  budgetHalt: undefined,
  allowedActions: undefined,
  pausedAt: undefined,
  totals: undefined,
  finalOutput: undefined,
  revision: 0,
  settledCount: 0,
  active: false,
  workflowId: undefined,

  /**
   * Called before `POST /runs`. The engine may emit frames before its 201 reaches us — with an
   * instant provider the whole run can be over by then — so the fold is cleared *here*. Clearing it
   * on the response instead erased those frames for good: `node.token` is transient and `resume`
   * would not replay them, because the socket's `lastSeq` has already passed them (§2.4).
   */
  arm: (workflowId) => {
    buffer.reset();
    set({
      workflowId,
      runId: undefined,
      status: undefined,
      haltReason: undefined,
      budgetHalt: undefined,
      allowedActions: undefined,
      pausedAt: undefined,
      totals: undefined,
      finalOutput: undefined,
      revision: 0,
      settledCount: 0,
      active: true,
    });
  },

  /**
   * The run was accepted. `run.started` carries the same facts, but a BLOCKED run never sends one
   * (FR-EXE-003), and frames already folded by `arm` are kept: this only names the run and, when
   * the engine answers with a finished or blocked run, settles the status.
   */
  begin: (workflowId, runId, status) => {
    set((state) => ({
      workflowId,
      runId,
      // A frame that arrived first is ahead of this response; it decides the status.
      status: state.revision > 0 && state.status !== undefined ? state.status : status,
      active:
        state.revision > 0 && state.status !== undefined
          ? state.active
          : status === 'RUNNING' || status === 'PREFLIGHT' || status === 'PAUSED',
    }));
  },

  /**
   * A fresh page seeds the socket's `lastSeq` from `hello`, which is the *current* seq, so `resume`
   * replays nothing from before the load — by design, or every reload would replay all of history.
   * The overlay therefore rebuilds itself from the records instead, and live frames carry on from
   * there. What cannot come back is the text streamed before the reload: `node.token` is transient
   * and never persisted (§2.4), so a reloaded card shows its state and output but not the typing.
   */
  adopt: (workflowId, run, nodeRuns, approvals = []) => {
    buffer.reset();
    /*
     * Each synthetic frame needs its own seq: the buffer drops a persisted frame whose seq it has
     * already folded, so reusing one number would silently discard every frame after the first.
     * They go negative on purpose — a real seq is ≥ 0, so these never collide with one and never
     * advance the `lastSeq` a reconnect would resume from.
     */
    let syntheticSeq = -1;
    for (const nodeRun of nodeRuns) {
      buffer.apply({
        seq: syntheticSeq--,
        type: 'node.state',
        payload: {
          runId: run.id,
          nodeRunId: nodeRun.id,
          nodeId: nodeRun.nodeId,
          iteration: nodeRun.iteration,
          attempt: nodeRun.attempt,
          status: nodeRun.status,
          ...(nodeRun.failureReason === undefined ? {} : { failureReason: nodeRun.failureReason }),
        },
      } as unknown as ServerFrame);
      if (nodeRun.output !== undefined) {
        buffer.apply({
          seq: syntheticSeq--,
          type: 'node.output',
          payload: {
            runId: run.id,
            nodeRunId: nodeRun.id,
            nodeId: nodeRun.nodeId,
            output: nodeRun.output,
            usage: nodeRun.usage,
            ...(nodeRun.modelUsed === undefined ? {} : { modelUsed: nodeRun.modelUsed }),
          },
        } as unknown as ServerFrame);
      }
    }
    /*
     * PG-3.2: every tool call the records hold, as the `tool.call` frames that carried them, in
     * the order they were made — Forge's attribution (who wrote which file, D334) is folded from
     * these, so it survives a reload and a finished run.
     */
    const calls = nodeRuns
      .flatMap((nodeRun) =>
        (nodeRun.toolCalls ?? []).map((toolCall) => ({ nodeRunId: nodeRun.id, toolCall })),
      )
      .sort((a, b) => a.toolCall.at.localeCompare(b.toolCall.at));
    for (const { nodeRunId, toolCall } of calls) {
      buffer.apply({
        seq: syntheticSeq--,
        type: 'tool.call',
        payload: { runId: run.id, nodeRunId, toolCall },
      } as unknown as ServerFrame);
    }
    // a WAITING node's card is anchored to its pending approval, which no node-run record carries
    for (const request of approvals) {
      buffer.apply({
        seq: syntheticSeq--,
        type: 'node.approval_required',
        payload: { runId: run.id, request },
      } as unknown as ServerFrame);
    }
    const view = buffer.view;
    set({
      workflowId,
      runId: run.id,
      status: run.status,
      haltReason: run.haltReason,
      budgetHalt: run.budgetHalt,
      // The engine writes `allowedActions`; where an older engine omits it, the contract's table
      // answers the same thing from the status (D71/D76) rather than the UI guessing.
      allowedActions: run.allowedActions ?? allowedRunActions(run.status),
      pausedAt: run.pausedAt,
      totals: run.totals,
      finalOutput: run.finalOutput,
      revision: 1,
      settledCount: view.nodeRuns().filter((nodeRun) => TERMINAL.has(nodeRun.status)).length,
      active: run.status === 'RUNNING' || run.status === 'PAUSED' || run.status === 'PREFLIGHT',
    });
  },

  apply: (frame) => {
    buffer.apply(frame);
    const view = buffer.view;
    const settled = view.nodeRuns().filter((run) => TERMINAL.has(run.status)).length;
    set((state) => ({
      settledCount: settled,
      runId: view.runId ?? state.runId,
      status: view.status ?? state.status,
      haltReason: view.haltReason,
      budgetHalt: view.budgetHalt,
      allowedActions: view.allowedActions ?? state.allowedActions,
      pausedAt: view.pausedAt,
      totals: view.totals,
      finalOutput: view.finalOutput,
      revision: state.revision + 1,
      active:
        view.status === undefined
          ? state.active
          : view.status === 'RUNNING' || view.status === 'PAUSED' || view.status === 'PREFLIGHT',
    }));
  },

  reset: () => {
    buffer.reset();
    set({
      runId: undefined,
      status: undefined,
      haltReason: undefined,
      budgetHalt: undefined,
      allowedActions: undefined,
      pausedAt: undefined,
      totals: undefined,
      finalOutput: undefined,
      revision: 0,
      settledCount: 0,
      active: false,
      workflowId: undefined,
    });
  },

  nodeState: (nodeId) => buffer.view.nodeState(nodeId) ?? IDLE,
  nodeRun: (nodeId) => buffer.view.nodeRun(nodeId),
  nodeRunById: (nodeRunId) => buffer.view.nodeRunById(nodeRunId),
  nodeRuns: () => buffer.view.nodeRuns(),
  streamedText: (nodeRunId) => buffer.view.streamedText(nodeRunId),
  lastTransfer: (edgeId) => buffer.view.lastTransfer(edgeId),
  approvals: () => buffer.view.approvals(),
  verdicts: (nodeRunId) => buffer.view.verdicts(nodeRunId),
  iterations: (nodeId) => buffer.view.iterations(nodeId),
  events: () => buffer.view.events(),
  lastSeq: () => buffer.view.lastSeq,
}));

/**
 * What one node card renders (FR-EXE-008/009, FR-RTR-006, FR-NODE-012). Selecting through
 * `revision` keeps the subscription cheap: the fields are primitives, so a frame that changes
 * nothing about this node does not re-render it.
 */
export function useNodeOverlay(nodeId: Id): {
  state: NodeState;
  streamedText: string;
  modelUsed: NodeRunView['modelUsed'];
  finalOutput: Part[] | undefined;
  failureReason: FailureReason | undefined;
} {
  return useRunStore(
    useShallow((store) => {
      void store.revision;
      const run = store.nodeRun(nodeId);
      return {
        state: run?.status ?? IDLE,
        streamedText: run === undefined ? '' : store.streamedText(run.nodeRunId),
        modelUsed: run?.modelUsed,
        finalOutput: store.finalOutput?.[nodeId],
        failureReason: run?.failureReason,
      };
    }),
  );
}

/** FR-EXE-015: the most recent transfer on this edge, for the animation. */
export function useEdgeTransfer(edgeId: Id): EdgeTransferView | undefined {
  return useRunStore((store) => {
    void store.revision;
    return store.lastTransfer(edgeId);
  });
}
