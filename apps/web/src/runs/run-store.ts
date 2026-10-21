import type {
  ApprovalRequest,
  BlockedReason,
  BudgetHalt,
  Envelope,
  FailureReason,
  HaltReason,
  Id,
  NodeError,
  NodeState,
  Part,
  RunAction,
  RunDomainConfig,
  RunState,
  ServerFrame,
  ToolCall,
  Usage,
  Verdict,
} from '@ace/contracts';
import {
  EDGE_TRANSFER_SUMMARY_MAX,
  allowedRunActions,
  estimatePartsTokens,
  isPersistedFrame,
} from '@ace/contracts';
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
  /** [audit W-5] D305: why the run is BLOCKED mid-run; absent for a pre-flight block. */
  blockedReason: BlockedReason | undefined;
  /** [audit W-5] The engine's words for that block, when a `run.blocked` frame carried them. */
  blockedDetail: string | undefined;
  /** When the pause landed, so the run bar can say how long it has been held (FR-CTL-002). */
  pausedAt: string | undefined;
  totals: Usage | undefined;
  finalOutput: Record<Id, Part[]> | undefined;
  /** Bumped on every applied frame; the cheap way to invalidate the derived selectors. */
  revision: number;
  /**
   * [audit W-3] Moves only on an approval frame (`node.approval_*`) or a run frame (`run.*`) — what
   * can change the approvals still waiting — so they are not refetched once per streamed token.
   */
  approvalRevision: number;
  /**
   * [audit W-4] Moves only on the frames that change how an edge is drawn: `node.state` (a loop's
   * iteration, D390's flow states), `loop.iteration` and `edge.transfer`. The Canvas keys its edges
   * on this rather than on `revision`, so a token does not rebuild every edge.
   */
  edgeRevision: number;
  /** [audit W-4] Moves only on a persisted frame — what the Events tab lists. */
  eventRevision: number;
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
  /**
   * D390: what crossed this edge in the run on show, if anything — the live `edge.transfer`
   * (FR-EXE-015), else, for an adopted run, an envelope its records say went from `fromNodeId` to
   * `toNodeId`. `at` is set only on a live transfer: a delivery read back from the records never
   * counts as just crossed.
   */
  delivery(edgeId: Id, fromNodeId: Id, toNodeId: Id): EdgeDelivery | undefined;
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
  /** [audit W-5] D305: a run blocked mid-run waits for Resume; the frames carry it on from here. */
  blockedReason?: BlockedReason;
  /** [audit W-5] D312: its Domain settings — whether it stays open (D323), so End stays offered. */
  domain?: RunDomainConfig;
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
  /**
   * D388: why it ended, rebuilt as a `node.error` frame — an interrupted node (BLOCKED
   * `engine_restarted` / `approval_lost`) is only told apart from an upstream block by its code.
   */
  error?: NodeError;
  /** D390: the envelopes it was delivered, so an adopted run's edges can say what crossed them. */
  inputEnvelopes?: readonly Pick<Envelope, 'fromNodeId' | 'toNodeId' | 'reads'>[];
}

/** D390: what crossed an edge — the engine's ≤120-character summary, and when, if seen live. */
export interface EdgeDelivery {
  summary: string;
  /** Epoch ms the live `edge.transfer` arrived; absent for a delivery read back from records. */
  at?: number;
}

/** One buffer per store; `reset()` clears it rather than replacing it, so selectors stay valid. */
const buffer = new RunEventBuffer();

/**
 * D390: an adopted run's deliveries, `from→to` → summary, from its node runs' `inputEnvelopes`.
 * `edge.transfer` frames are not persisted per edge in a node-run record and `resume` replays
 * nothing from before a reload, so this is how a finished run's Canvas still knows which edges
 * carried data. Envelopes name nodes, not edges: two data edges between the same pair of nodes
 * (different ports) read as delivered together — the engine delivers one envelope per target node.
 */
const adoptedDeliveries = new Map<string, string>();
const pairKey = (fromNodeId: Id, toNodeId: Id): string => `${fromNodeId}→${toNodeId}`;

/**
 * The summary the engine's `transferSummary` writes on a live `edge.transfer` — the part kinds and
 * a token estimate — rebuilt from a recorded envelope's reads, so an adopted run says the same.
 */
function deliverySummary(reads: readonly Part[]): string {
  const kinds = [...new Set(reads.map((part) => part.type))].join(', ');
  return `${kinds || 'nothing'} · ~${estimatePartsTokens(reads)} tokens`.slice(
    0,
    EDGE_TRANSFER_SUMMARY_MAX,
  );
}

const IDLE: NodeState = 'IDLE';

/**
 * [audit W-3/W-4] Where the narrow revisions come from: one rising number, so every arm, adopt and
 * reset moves them too (a new fold is always a change) and no two folds ever share a value.
 */
let revisions = 0;
const nextRevision = (): number => ++revisions;

/** Frames that change how an edge is drawn (FR-PAR-005 loop chips, D390 flow states). */
const EDGE_FRAMES: ReadonlySet<string> = new Set(['node.state', 'loop.iteration', 'edge.transfer']);

/** A run that still takes controls: going, paused, or blocked mid-run with a reason (D305). */
const isLive = (status: RunState, blockedReason: BlockedReason | undefined): boolean =>
  status === 'RUNNING' ||
  status === 'PAUSED' ||
  status === 'PREFLIGHT' ||
  (status === 'BLOCKED' && blockedReason !== undefined);

/** [audit W-4] Whether two action lists say the same, so a frame keeps the array it had. */
const sameActions = (a: RunAction[] | undefined, b: RunAction[] | undefined): boolean =>
  a === b ||
  (a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => x === b[i]));

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
  blockedReason: undefined,
  blockedDetail: undefined,
  pausedAt: undefined,
  totals: undefined,
  finalOutput: undefined,
  revision: 0,
  approvalRevision: 0,
  edgeRevision: 0,
  eventRevision: 0,
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
    adoptedDeliveries.clear();
    set({
      workflowId,
      runId: undefined,
      status: undefined,
      haltReason: undefined,
      budgetHalt: undefined,
      allowedActions: undefined,
      blockedReason: undefined,
      blockedDetail: undefined,
      pausedAt: undefined,
      totals: undefined,
      finalOutput: undefined,
      revision: 0,
      approvalRevision: nextRevision(),
      edgeRevision: nextRevision(),
      eventRevision: nextRevision(),
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
    adoptedDeliveries.clear();
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
      // D388: the error is the record's too — Retry and Continue tell an interrupted node by it.
      if (nodeRun.error !== undefined) {
        buffer.apply({
          seq: syntheticSeq--,
          type: 'node.error',
          payload: {
            runId: run.id,
            nodeRunId: nodeRun.id,
            nodeId: nodeRun.nodeId,
            error: nodeRun.error,
            failureReason: nodeRun.failureReason,
          },
        } as unknown as ServerFrame);
      }
      for (const envelope of nodeRun.inputEnvelopes ?? []) {
        adoptedDeliveries.set(
          pairKey(envelope.fromNodeId, envelope.toNodeId),
          deliverySummary(envelope.reads),
        );
      }
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
    /*
     * [audit W-5] The run's own D305/D323 facts, as the frames that announced them, so the frames
     * that follow (a resume, a block) are folded with them: an open Domain run keeps its End, and a
     * run adopted while blocked reads blocked. The block's words are not on the record.
     */
    if (run.domain !== undefined) {
      buffer.apply({
        seq: syntheticSeq--,
        type: 'run.config',
        payload: { runId: run.id, config: run.domain },
      } as unknown as ServerFrame);
    }
    if (run.status === 'BLOCKED' && run.blockedReason !== undefined) {
      buffer.apply({
        seq: syntheticSeq--,
        type: 'run.blocked',
        payload: { runId: run.id, reason: run.blockedReason, detail: '' },
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
      allowedActions:
        run.allowedActions ??
        allowedRunActions(run.status, {
          blockedReason: run.blockedReason,
          stayOpen: run.domain?.stayOpen,
        }),
      blockedReason: run.status === 'BLOCKED' ? run.blockedReason : undefined,
      blockedDetail: undefined,
      pausedAt: run.pausedAt,
      totals: run.totals,
      finalOutput: run.finalOutput,
      revision: 1,
      approvalRevision: nextRevision(),
      edgeRevision: nextRevision(),
      eventRevision: nextRevision(),
      settledCount: view.nodeRuns().filter((nodeRun) => TERMINAL.has(nodeRun.status)).length,
      active: isLive(run.status, run.blockedReason),
    });
  },

  apply: (frame) => {
    buffer.apply(frame);
    const view = buffer.view;
    const settled = view.nodeRuns().filter((run) => TERMINAL.has(run.status)).length;
    set((state) => {
      const allowedActions = view.allowedActions ?? state.allowedActions;
      return {
        settledCount: settled,
        runId: view.runId ?? state.runId,
        status: view.status ?? state.status,
        haltReason: view.haltReason,
        budgetHalt: view.budgetHalt,
        // [audit W-4] the same actions keep the same array, so a token re-renders no control
        allowedActions: sameActions(allowedActions, state.allowedActions)
          ? state.allowedActions
          : allowedActions,
        blockedReason: view.blockedReason,
        blockedDetail: view.blockedDetail === '' ? undefined : view.blockedDetail,
        pausedAt: view.pausedAt,
        totals: view.totals,
        finalOutput: view.finalOutput,
        revision: state.revision + 1,
        approvalRevision:
          frame.type.startsWith('node.approval_') || frame.type.startsWith('run.')
            ? nextRevision()
            : state.approvalRevision,
        edgeRevision: EDGE_FRAMES.has(frame.type) ? nextRevision() : state.edgeRevision,
        eventRevision: isPersistedFrame(frame) ? nextRevision() : state.eventRevision,
        // [audit W-5] a run blocked mid-run is still live (D305): it waits for Resume or Stop
        active: view.status === undefined ? state.active : isLive(view.status, view.blockedReason),
      };
    });
  },

  reset: () => {
    buffer.reset();
    adoptedDeliveries.clear();
    set({
      runId: undefined,
      status: undefined,
      haltReason: undefined,
      budgetHalt: undefined,
      allowedActions: undefined,
      blockedReason: undefined,
      blockedDetail: undefined,
      pausedAt: undefined,
      totals: undefined,
      finalOutput: undefined,
      revision: 0,
      approvalRevision: nextRevision(),
      edgeRevision: nextRevision(),
      eventRevision: nextRevision(),
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
  delivery: (edgeId, fromNodeId, toNodeId) => {
    const live = buffer.view.lastTransfer(edgeId);
    if (live !== undefined) return { summary: live.summary, at: live.at };
    const recorded = adoptedDeliveries.get(pairKey(fromNodeId, toNodeId));
    return recorded === undefined ? undefined : { summary: recorded };
  },
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
  /** D381: the tool call in flight on an agentic node, until the matching `tool.call`. */
  activeTool: { name: string; target?: string; startedAt: number } | undefined;
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
        activeTool: run?.activeTool,
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
