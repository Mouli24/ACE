import {
  isPersistedFrame,
  zeroUsage,
  type Id,
  type ModelUsed,
  type NodeError,
  type NodeState,
  type Part,
  type RunState,
  type ServerFrame,
  type Usage,
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
  failureReason?: string;
  error?: NodeError;
  modelUsed?: ModelUsed;
  output?: Part[];
  usage: Usage;
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
  haltReason: string | undefined;
  totals: Usage;
  /** The highest persisted seq folded in; what `resume { afterSeq }` should ask from. */
  lastSeq: number;
  finalOutput: Record<Id, Part[]> | undefined;
  nodeState(nodeId: Id): NodeState;
  nodeRun(nodeId: Id): NodeRunView | undefined;
  nodeRunById(nodeRunId: Id): NodeRunView | undefined;
  /** Text streamed so far for a node run (`node.token` deltas, in arrival order). */
  streamedText(nodeRunId: Id): string;
  lastTransfer(edgeId: Id): EdgeTransferView | undefined;
  nodeRuns(): NodeRunView[];
}

/** A node the run has not touched yet is IDLE (Arch §19.1), so the Canvas can render immediately. */
const DEFAULT_STATE: NodeState = 'IDLE';

/**
 * Folds the run events of §2.4 into something a screen can render, and does it idempotently: the
 * engine replays every persisted event after `afterSeq` on a resume, so the same frame can arrive
 * twice and must not count twice. `node.token` is the exception — it carries no seq and is never
 * replayed, so its deltas are appended as they arrive and are never re-applied.
 */
export class RunEventBuffer {
  private runId: Id | undefined;
  private status: RunState | undefined;
  private haltReason: string | undefined;
  private totals: Usage = zeroUsage();
  private finalOutput: Record<Id, Part[]> | undefined;
  private lastSeq = -1;
  private readonly seen = new Set<number>();
  private readonly byNodeRunId = new Map<Id, NodeRunView>();
  private readonly nodeRunIdByNodeId = new Map<Id, Id>();
  private readonly text = new Map<Id, string>();
  private readonly transfers = new Map<Id, EdgeTransferView>();

  /** Fold one frame in. Frames for another run, and repeats of a persisted frame, are ignored. */
  apply(frame: ServerFrame): void {
    if (frame.type === 'hello' || frame.type === 'workflow.updated') return;

    const payload = frame.payload as { runId?: Id };
    if (this.runId !== undefined && payload.runId !== undefined && payload.runId !== this.runId) {
      return;
    }

    if (isPersistedFrame(frame)) {
      if (this.seen.has(frame.seq)) return;
      this.seen.add(frame.seq);
      if (frame.seq > this.lastSeq) this.lastSeq = frame.seq;
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
        this.totals = frame.payload.totals;
        this.finalOutput = frame.payload.finalOutput;
        return;
      }

      case 'node.state': {
        this.runId ??= frame.payload.runId;
        const view = this.upsert(frame.payload.nodeRunId, frame.payload.nodeId);
        view.iteration = frame.payload.iteration;
        view.attempt = frame.payload.attempt;
        view.status = frame.payload.status;
        if (frame.payload.failureReason !== undefined)
          view.failureReason = frame.payload.failureReason;
        return;
      }

      case 'node.token': {
        this.text.set(
          frame.payload.nodeRunId,
          (this.text.get(frame.payload.nodeRunId) ?? '') + frame.payload.delta,
        );
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

      default:
        return;
    }
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
    this.totals = zeroUsage();
    this.finalOutput = undefined;
    this.lastSeq = -1;
    this.seen.clear();
    this.byNodeRunId.clear();
    this.nodeRunIdByNodeId.clear();
    this.text.clear();
    this.transfers.clear();
  }

  get view(): RunView {
    return {
      runId: this.runId,
      status: this.status,
      haltReason: this.haltReason,
      totals: this.totals,
      lastSeq: this.lastSeq,
      finalOutput: this.finalOutput,
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
