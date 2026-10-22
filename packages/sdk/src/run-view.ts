import {
  PERSISTED_RUN_EVENT_TYPES,
  allowedRunActions,
  isPersistedFrame,
  zeroUsage,
  type ApprovalRequest,
  type BlockedReason,
  type BudgetHalt,
  type FailureReason,
  type HaltReason,
  type Id,
  type ModelUsed,
  type NodeError,
  type NodeState,
  type Part,
  type RunAction,
  type RunEvent,
  type RunState,
  type ServerFrame,
  type Usage,
  type Verdict,
} from '@ace/contracts';

/**
 * What the UI knows about one node in the run in flight. It is a projection of the §2.4 events,
 * not a `NodeRun` from the API: the engine owns that record, this is what has arrived so far.
 */
export interface NodeRunView {
  nodeRunId: Id;
  nodeId: Id;
  iteration: number;
  attempt: number;
  status: NodeState;
  /** The contract's own reason, never a string: CONTRACT_VIOLATION and RUN_FAILED stay apart (BR-03). */
  failureReason?: FailureReason;
  error?: NodeError;
  modelUsed?: ModelUsed;
  output?: Part[];
  usage: Usage;
  /** D381: the tool call in flight, from its `tool.started` to the `tool.call` that ends it. */
  activeTool?: ActiveToolView;
}

/** A tool call an agentic node has started and not yet finished (D381). */
export interface ActiveToolView {
  callId: string;
  name: string;
  /** The path or command it works on, when the frame named one. */
  target?: string;
  /** When the frame arrived, epoch ms. */
  startedAt: number;
}

export interface EdgeTransferView {
  edgeId: Id;
  fromNodeId: Id;
  toNodeId: Id;
  iteration: number;
  summary: string;
  /** When it arrived, so the Canvas can animate the most recent transfer (FR-EXE-015). */
  at: number;
}

export interface RunView {
  runId: Id | undefined;
  status: RunState | undefined;
  haltReason: HaltReason | undefined;
  /** Set only when `haltReason` is `budget_exceeded`, so a run view can say which cap tripped. */
  budgetHalt: BudgetHalt | undefined;
  totals: Usage;
  /** The highest persisted seq folded in; what `resume { afterSeq }` should ask from. */
  lastSeq: number;
  finalOutput: Record<Id, Part[]> | undefined;
  /**
   * When the run paused (FR-CTL-001), cleared by `run.resumed` (FR-CTL-002). `run.paused` carries
   * nothing but the run id, so this is when the frame arrived; `Run.pausedAt` from
   * `GET /runs/:id` is the engine's own value.
   */
  pausedAt: string | undefined;
  /**
   * The controls this run state accepts, undefined before the first frame names a status. No run
   * event carries `allowedActions`, so this is `allowedRunActions(status, context)` — the same table
   * the engine writes into `Run.allowedActions` and the web mocks call (FR-CTL-006, D71, D76) — with
   * the block's reason (D305) and whether the run stays open (D323) as its context.
   */
  allowedActions: RunAction[] | undefined;
  /**
   * D305: why the run is BLOCKED mid-run, from `run.blocked` until `run.resumed` or its end. Absent
   * for a run blocked at pre-flight, which has no reason and can only restart.
   */
  blockedReason: BlockedReason | undefined;
  /** D305: the engine's words for the block, from the same frame. */
  blockedDetail: string | undefined;
  /**
   * D323: a run started from Domain whose graph has nothing left to do — open, idle, costing
   * nothing. Set by `run.parked`, cleared when a node starts working again or the run ends.
   */
  parked: boolean;
  /** The approval requests still waiting for a decision, oldest first (FR-GRD-013). */
  approvals(): ApprovalRequest[];
  /** Every guardrail verdict seen for one node run, in arrival order (FR-GRD-015). */
  verdicts(nodeRunId: Id): Verdict[];
  /** The highest iteration this node has reached; `0` before it has run (FR-PAR-005). */
  iterations(nodeId: Id): number;
  /** Every persisted frame in arrival order — what the Events tab lists (§5 item 7). */
  events(): PersistedRunEvent[];
  nodeState(nodeId: Id): NodeState;
  nodeRun(nodeId: Id): NodeRunView | undefined;
  nodeRunById(nodeRunId: Id): NodeRunView | undefined;
  /** Text streamed so far for a node run (`node.token` deltas, in arrival order). */
  streamedText(nodeRunId: Id): string;
  lastTransfer(edgeId: Id): EdgeTransferView | undefined;
  nodeRuns(): NodeRunView[];
}

/**
 * A run event that carries a `seq`: everything in §2.4 except `node.token`, which is transient and
 * never persisted. Narrowing by the field rather than by a type list means a frame added to the
 * contract later is included without a second list to remember.
 */
export type PersistedRunEvent = Extract<RunEvent, { seq: number }>;

/**
 * Whether a frame is a persisted event of the *run* family. `isPersistedFrame` answers only whether
 * a frame has a `seq`, and since round 4 that is true of the thread family too, so it no longer
 * narrows to a run event on its own.
 */
function isPersistedRunEvent(frame: ServerFrame): frame is PersistedRunEvent {
  return (
    isPersistedFrame(frame) && (PERSISTED_RUN_EVENT_TYPES as readonly string[]).includes(frame.type)
  );
}

/** A node the run has not touched yet is IDLE (Arch §19.1), so the Canvas can render immediately. */
const DEFAULT_STATE: NodeState = 'IDLE';
/** States a node run does not leave (Arch §19.1); a tool call cannot still be in flight there. */const TERMINAL_STATES: ReadonlySet<NodeState> = new Set<NodeState>([  'COMPLETED',  'FAILED',  'STOPPED',  'BLOCKED',]);

/**
 * Folds the run events of §2.4 into something a screen can render, and does it idempotently: the
 * engine replays every persisted event after `afterSeq` on a resume, so the same frame can arrive
 * twice and must not count twice. `node.token` is the exception — it carries no seq and is never
 * replayed, so its deltas are appended as they arrive and are never re-applied.
 */
export class RunEventBuffer {
  private runId: Id | undefined;
  private status: RunState | undefined;
  private haltReason: HaltReason | undefined;
  private budgetHalt: BudgetHalt | undefined;
  /**
   * Every persisted frame, in arrival order, for the Events tab. Pushed inside the `seq` guard
   * below, so a `resume` replay appends nothing twice; `node.token` never reaches here because it
   * carries no seq (§2.4).
   */
  private readonly log: PersistedRunEvent[] = [];
  private totals: Usage = zeroUsage();
  private finalOutput: Record<Id, Part[]> | undefined;
  private pausedAt: string | undefined;
  /** [audit W-5] D305's mid-run block, and D323's stay-open run — the context of `allowedActions`. */
  private blockedReason: BlockedReason | undefined;
  private blockedDetail: string | undefined;
  private stayOpen = false;
  private parked = false;
  private lastSeq = -1;
  private readonly seen = new Set<number>();
  private readonly byNodeRunId = new Map<Id, NodeRunView>();
  private readonly nodeRunIdByNodeId = new Map<Id, Id>();
  private readonly text = new Map<Id, string>();
  private readonly transfers = new Map<Id, EdgeTransferView>();
  /** Keyed by request id, which is what a decision names, so a decision removes exactly one. */
  private readonly pendingApprovals = new Map<Id, ApprovalRequest>();
  private readonly verdictsByNodeRunId = new Map<Id, Verdict[]>();
  private readonly iterationByNodeId = new Map<Id, number>();
  /**
   * FR-BEN-008: runs ACE Bench queued, learned from their `run.started`. A buffer not already
   * following one never adopts it — a bench run is shown only where the bench opens it.
   */
  private readonly benchRunIds = new Set<Id>();

  /** Fold one frame in. Frames for another run, and repeats of a persisted frame, are ignored. */
  apply(frame: ServerFrame): void {
    if (frame.type === 'hello' || frame.type === 'workflow.updated') return;

    // `run.started` nests the id at `payload.run.id`; every other run frame carries `payload.runId`.
    // Reading only the flat field let another run's `run.started` past the guard and retarget the
    // buffer, leaving the previous run's node views in place beside it.
    const incoming =
      frame.type === 'run.started' ? frame.payload.run.id : (frame.payload as { runId?: Id }).runId;
    if (
      frame.type === 'run.started' &&
      frame.payload.run.benchExperimentId !== undefined &&
      this.runId !== frame.payload.run.id
    ) {
      this.benchRunIds.add(frame.payload.run.id);
      return;
    }
    if (incoming !== undefined && incoming !== this.runId && this.benchRunIds.has(incoming)) return;
    if (this.runId !== undefined && incoming !== undefined && incoming !== this.runId) return;

    if (isPersistedFrame(frame)) {
      if (this.seen.has(frame.seq)) return;
      this.seen.add(frame.seq);
      if (frame.seq > this.lastSeq) this.lastSeq = frame.seq;
      // `hello` and `workflow.updated` are already gone by here. What is left may still not belong
      // to this run: `provider.status` and `mcp.status` are engine scope and belong to the providers
      // screen, `chat.message` is thread scope (round 4 §2.5). The log keeps the run family only,
      // and asks the contract which types those are rather than naming them here a second time.
      if (isPersistedRunEvent(frame)) this.log.push(frame);
    }

    switch (frame.type) {
      case 'run.started': {
        this.runId = frame.payload.run.id;
        this.status = frame.payload.run.status;
        this.totals = frame.payload.run.totals;
        return;
      }

      case 'run.completed': {
        this.runId ??= frame.payload.runId;
        this.status = frame.payload.status;
        this.haltReason = frame.payload.haltReason;
        this.budgetHalt = frame.payload.budgetHalt;
        this.totals = frame.payload.totals;
        this.finalOutput = frame.payload.finalOutput;
        // A run that ended is no longer paused, including one stopped while PAUSED (D76).
        this.pausedAt = undefined;
        // …nor blocked mid-run or parked (D305, D323): an ended run's BLOCKED is pre-flight's.
        this.blockedReason = undefined;
        this.blockedDetail = undefined;
        this.parked = false;
        return;
      }

      case 'node.state': {
        this.runId ??= frame.payload.runId;
        const view = this.upsert(frame.payload.nodeRunId, frame.payload.nodeId);
        view.iteration = frame.payload.iteration;
        view.attempt = frame.payload.attempt;
        view.status = frame.payload.status;
        if (TERMINAL_STATES.has(frame.payload.status)) delete view.activeTool;
        // D323: a node starting work in a parked run un-parks it; `run.parked` says when it parks again.
        if (!TERMINAL_STATES.has(frame.payload.status)) this.parked = false;
        if (frame.payload.failureReason !== undefined)
          view.failureReason = frame.payload.failureReason;
        this.noteIteration(frame.payload.nodeId, frame.payload.iteration);
        return;
      }

      case 'node.token': {
        this.text.set(
          frame.payload.nodeRunId,
          (this.text.get(frame.payload.nodeRunId) ?? '') + frame.payload.delta,
        );
        return;
      }

      case 'tool.started': {
        const view = this.upsert(frame.payload.nodeRunId, frame.payload.nodeId);
        view.activeTool = {
          callId: frame.payload.callId,
          name: frame.payload.name,
          ...(frame.payload.target === undefined ? {} : { target: frame.payload.target }),
          startedAt: Date.now(),
        };
        return;
      }

      case 'tool.call': {
        const view = this.byNodeRunId.get(frame.payload.nodeRunId);
        if (view?.activeTool !== undefined && view.activeTool.callId === frame.payload.callId) {
          delete view.activeTool;
        }
        return;
      }

      case 'node.output': {
        const view = this.upsert(frame.payload.nodeRunId, frame.payload.nodeId);
        view.output = frame.payload.output;
        view.usage = frame.payload.usage;
        if (frame.payload.modelUsed !== undefined) view.modelUsed = frame.payload.modelUsed;
        return;
      }

      case 'node.error': {
        const view = this.upsert(frame.payload.nodeRunId, frame.payload.nodeId);
        view.error = frame.payload.error;
        view.failureReason = frame.payload.failureReason;
        return;
      }

      case 'edge.transfer': {
        this.transfers.set(frame.payload.edgeId, {
          edgeId: frame.payload.edgeId,
          fromNodeId: frame.payload.fromNodeId,
          toNodeId: frame.payload.toNodeId,
          iteration: frame.payload.iteration,
          summary: frame.payload.summary,
          at: Date.now(),
        });
        return;
      }

      case 'usage.updated': {
        this.totals = frame.payload.totals;
        return;
      }

      /* Round 3 §2.6 */

      case 'run.paused': {
        this.runId ??= frame.payload.runId;
        // The frame says the run paused but not what its status became; Arch §19.2 draws only
        // RUNNING ⇄ PAUSED, so PAUSED is the state the pause left it in — and it is what
        // `allowedActions` has to read to offer Resume rather than Pause (FR-CTL-002, D76).
        this.status = 'PAUSED';
        this.pausedAt = new Date().toISOString();
        return;
      }

      case 'run.resumed': {
        this.runId ??= frame.payload.runId;
        this.status = 'RUNNING';
        this.pausedAt = undefined;
        // D305: `run.resumed` is also how a run leaves a mid-run BLOCKED.
        this.blockedReason = undefined;
        this.blockedDetail = undefined;
        return;
      }

      /* Domain (D303, D305, D323) — [audit W-5] */

      case 'run.blocked': {
        this.runId ??= frame.payload.runId;
        // RUNNING → BLOCKED with a reason: the drive waits, Resume and Stop apply (D305).
        this.status = 'BLOCKED';
        this.blockedReason = frame.payload.reason;
        this.blockedDetail = frame.payload.detail;
        return;
      }

      case 'run.parked': {
        this.runId ??= frame.payload.runId;
        // Only a run that stays open parks (D323), so this says so even without its `run.config`.
        this.stayOpen = true;
        this.parked = true;
        return;
      }

      case 'run.config': {
        this.runId ??= frame.payload.runId;
        this.stayOpen = frame.payload.config.stayOpen;
        return;
      }

      case 'node.approval_required': {
        this.runId ??= frame.payload.runId;
        this.pendingApprovals.set(frame.payload.request.id, frame.payload.request);
        return;
      }

      case 'node.approval_decided': {
        this.runId ??= frame.payload.runId;
        this.pendingApprovals.delete(frame.payload.decision.requestId);
        return;
      }

      case 'guardrail.verdict': {
        this.runId ??= frame.payload.runId;
        const list = this.verdictsByNodeRunId.get(frame.payload.nodeRunId);
        if (list) list.push(frame.payload.verdict);
        else this.verdictsByNodeRunId.set(frame.payload.nodeRunId, [frame.payload.verdict]);
        return;
      }

      case 'loop.iteration': {
        this.runId ??= frame.payload.runId;
        // With `stop` the iteration named is the last one that ran, without it the one now
        // starting (§2.6) — either way it is an iteration the target reached.
        this.noteIteration(frame.payload.targetNodeId, frame.payload.iteration);
        return;
      }

      default:
        return;
    }
  }

  private noteIteration(nodeId: Id, iteration: number): void {
    const highest = this.iterationByNodeId.get(nodeId);
    if (highest === undefined || iteration > highest) this.iterationByNodeId.set(nodeId, iteration);
  }

  private upsert(nodeRunId: Id, nodeId: Id): NodeRunView {
    const existing = this.byNodeRunId.get(nodeRunId);
    if (existing) return existing;
    const created: NodeRunView = {
      nodeRunId,
      nodeId,
      iteration: 1,
      attempt: 1,
      status: DEFAULT_STATE,
      usage: zeroUsage(),
    };
    this.byNodeRunId.set(nodeRunId, created);
    this.nodeRunIdByNodeId.set(nodeId, nodeRunId);
    return created;
  }

  /** Forget everything; the next run starts from nothing. */
  reset(): void {
    this.runId = undefined;
    this.status = undefined;
    this.haltReason = undefined;
    this.budgetHalt = undefined;
    this.log.length = 0;
    this.totals = zeroUsage();
    this.finalOutput = undefined;
    this.pausedAt = undefined;
    this.blockedReason = undefined;
    this.blockedDetail = undefined;
    this.stayOpen = false;
    this.parked = false;
    this.lastSeq = -1;
    this.seen.clear();
    this.byNodeRunId.clear();
    this.nodeRunIdByNodeId.clear();
    this.text.clear();
    this.transfers.clear();
    this.pendingApprovals.clear();
    this.verdictsByNodeRunId.clear();
    this.iterationByNodeId.clear();
  }

  get view(): RunView {
    const status = this.status;
    return {
      runId: this.runId,
      status,
      haltReason: this.haltReason,
      totals: this.totals,
      lastSeq: this.lastSeq,
      finalOutput: this.finalOutput,
      pausedAt: this.pausedAt,
      budgetHalt: this.budgetHalt,
      allowedActions:
        status === undefined
          ? undefined
          : allowedRunActions(status, {
              blockedReason: this.blockedReason,
              stayOpen: this.stayOpen,
            }),
      blockedReason: this.blockedReason,
      blockedDetail: this.blockedDetail,
      parked: this.parked,
      approvals: () => [...this.pendingApprovals.values()],
      verdicts: (nodeRunId) => [...(this.verdictsByNodeRunId.get(nodeRunId) ?? [])],
      iterations: (nodeId) => this.iterationByNodeId.get(nodeId) ?? 0,
      events: () => [...this.log],
      nodeState: (nodeId) => this.nodeRun(nodeId)?.status ?? DEFAULT_STATE,
      nodeRun: (nodeId) => this.nodeRun(nodeId),
      nodeRunById: (nodeRunId) => this.byNodeRunId.get(nodeRunId),
      streamedText: (nodeRunId) => this.text.get(nodeRunId) ?? '',
      lastTransfer: (edgeId) => this.transfers.get(edgeId),
      nodeRuns: () => [...this.byNodeRunId.values()],
    };
  }

  private nodeRun(nodeId: Id): NodeRunView | undefined {
    const nodeRunId = this.nodeRunIdByNodeId.get(nodeId);
    return nodeRunId === undefined ? undefined : this.byNodeRunId.get(nodeRunId);
  }
}
