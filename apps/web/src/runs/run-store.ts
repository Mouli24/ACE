import type { Id, NodeState, Part, RunState, ServerFrame, Usage } from '@ace/contracts';
import { RunEventBuffer, type EdgeTransferView, type NodeRunView } from '@ace/sdk';
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
  haltReason: string | undefined;
  totals: Usage | undefined;
  finalOutput: Record<Id, Part[]> | undefined;
  /** Bumped on every applied frame; the cheap way to invalidate the derived selectors. */
  revision: number;
  /** True from `POST /runs` until `run.completed`; the UI allows one active run per workflow. */
  active: boolean;
  /** The workflow whose run this is, so another workflow's Canvas stays clean. */
  workflowId: Id | undefined;

  begin(workflowId: Id, runId: Id, status: RunState): void;
  apply(frame: ServerFrame): void;
  reset(): void;

  nodeState(nodeId: Id): NodeState;
  nodeRun(nodeId: Id): NodeRunView | undefined;
  nodeRunById(nodeRunId: Id): NodeRunView | undefined;
  nodeRuns(): NodeRunView[];
  streamedText(nodeRunId: Id): string;
  lastTransfer(edgeId: Id): EdgeTransferView | undefined;
  /** What a reconnect must ask the engine to replay (FR-EXE-014). */
  lastSeq(): number;
}

/** One buffer per store; `reset()` clears it rather than replacing it, so selectors stay valid. */
const buffer = new RunEventBuffer();

const IDLE: NodeState = 'IDLE';

export const useRunStore = create<RunOverlayState>((set) => ({
  runId: undefined,
  status: undefined,
  haltReason: undefined,
  totals: undefined,
  finalOutput: undefined,
  revision: 0,
  active: false,
  workflowId: undefined,

  /**
   * A run was accepted. `run.started` carries the same facts, but the button must go busy before
   * the first frame arrives, and a BLOCKED run never sends one at all (FR-EXE-003).
   */
  begin: (workflowId, runId, status) => {
    buffer.reset();
    set({
      workflowId,
      runId,
      status,
      haltReason: undefined,
      totals: undefined,
      finalOutput: undefined,
      revision: 0,
      active: status === 'RUNNING' || status === 'PREFLIGHT' || status === 'PAUSED',
    });
  },

  apply: (frame) => {
    buffer.apply(frame);
    const view = buffer.view;
    set((state) => ({
      runId: view.runId ?? state.runId,
      status: view.status ?? state.status,
      haltReason: view.haltReason,
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
      totals: undefined,
      finalOutput: undefined,
      revision: 0,
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
