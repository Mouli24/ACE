import type { Id, NodeState } from '@ace/contracts';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useRunStore } from '../runs/run-store';

/*
 * D390 (W1-6): a data edge says what the run on show did with it. Before this every edge drew the
 * same flowing dashed line whatever happened; now the line is read from the live overlay
 * (`run-store`: the source node's state and what crossed the edge) and drawn as one of:
 *
 *   none       no run of this workflow on show   today's look exactly (animated dashes)
 *   delivered  an envelope crossed the edge      solid line
 *   flowing    the source is RUNNING, or the     animated dashes
 *              transfer landed under 2 s ago
 *   waiting    the source has not finished       dim, static dashes
 *              (or finished and its target has not taken the output yet — a Merge that waits
 *              for every branch; or finished and sent nothing — a branch it did not take)
 *   cut        the source ended FAILED, STOPPED  static dashes in the failed red
 *              or BLOCKED without delivering
 *
 * Loop and "run after" edges keep their own look: only data edges are read this way.
 */
export const EDGE_FLOWS = ['none', 'delivered', 'flowing', 'waiting', 'cut'] as const;
export type EdgeFlow = (typeof EDGE_FLOWS)[number];

/** How long a transfer keeps its edge flowing after it lands — TypedEdge's highlight (FR-EXE-015). */
export const FLOW_RECENT_MS = 2_000;

/** What the run on show says about one data edge. */
export interface EdgeRunFacts {
  /** The source node's state in the run (IDLE until the run reaches it). */
  sourceState: NodeState;
  /** The target node's state in the run; undefined until the run reaches it. */
  targetState?: NodeState | undefined;
  /** What crossed the edge, if anything: the engine's summary of the envelope. */
  summary?: string | undefined;
}

/** A source that ended without finishing: what it did not send never will be (Arch §19.1). */
const CUT_STATES: ReadonlySet<NodeState> = new Set<NodeState>(['FAILED', 'STOPPED', 'BLOCKED']);

/** A target that has not started: a finished source's output is still on its way to it. */
const NOT_STARTED: ReadonlySet<NodeState> = new Set<NodeState>(['IDLE', 'READY', 'PAUSED']);

/**
 * The flow state of a data edge. `facts` undefined: no run of this workflow is on show. `recent`:
 * the edge's transfer landed under {@link FLOW_RECENT_MS} ago. A running source wins over an earlier
 * delivery — a loop's next iteration is on its way over the same edge.
 */
export function edgeFlowState(facts: EdgeRunFacts | undefined, recent: boolean): EdgeFlow {
  if (facts === undefined) return 'none';
  if (facts.sourceState === 'RUNNING' || recent) return 'flowing';
  if (facts.summary !== undefined) return 'delivered';
  if (CUT_STATES.has(facts.sourceState)) return 'cut';
  return 'waiting';
}

/**
 * What the edge says it did, for its `<title>` and the tests ("delivered: <summary>", "cut off:
 * <source> failed"). `none` says nothing: the interactive edge underneath keeps its own title.
 */
export function edgeFlowTitle(
  flow: EdgeFlow,
  facts: EdgeRunFacts | undefined,
  sourceName: string,
  targetName = 'the next node',
): string | undefined {
  if (facts === undefined || flow === 'none') return undefined;
  const state = facts.sourceState.toLowerCase();
  switch (flow) {
    case 'delivered':
      return `delivered: ${facts.summary ?? ''}`;
    case 'flowing':
      return facts.sourceState === 'RUNNING' || facts.summary === undefined
        ? `flowing: ${sourceName} is running`
        : `delivered just now: ${facts.summary}`;
    case 'cut':
      return `cut off: ${sourceName} ${state}`;
    case 'waiting':
      if (facts.sourceState !== 'COMPLETED') return `waiting: ${sourceName} is ${state}`;
      // The output is there; whether it is still to be taken depends on the target. A Merge that
      // waits for every branch (or a run stopped before the target started) has not taken it yet.
      return facts.targetState === undefined || NOT_STARTED.has(facts.targetState)
        ? `ready: ${sourceName} finished; ${targetName} has not taken it yet`
        : `nothing sent: ${sourceName} finished without sending on this edge`;
  }
}

/** The facts' "nothing on show" value: one constant, so `useShallow` never sees a change. */
const NO_RUN = { on: false } as const;

/**
 * One data edge's flow state and title, from the overlay (D390). The selector picks primitives
 * through `useShallow`, so a token for another node — or one that changes nothing about this edge's
 * source or delivery — never re-renders this edge (NFR-PERF-04). The overlay counts as on show once
 * it holds a run of this workflow: named by the engine, or already folding frames.
 */
export function useEdgeFlow(
  workflowId: Id | undefined,
  edgeId: Id,
  sourceNodeId: Id,
  targetNodeId: Id,
  sourceName: string,
  targetName?: string,
): { flow: EdgeFlow; title: string | undefined } {
  const seen = useRunStore(
    useShallow((store) => {
      void store.revision;
      if (workflowId === undefined || store.workflowId !== workflowId) return NO_RUN;
      if (store.runId === undefined && store.revision === 0) return NO_RUN;
      const delivery = store.delivery(edgeId, sourceNodeId, targetNodeId);
      return {
        on: true as const,
        sourceState: store.nodeRun(sourceNodeId)?.status ?? ('IDLE' as NodeState),
        targetState: store.nodeRun(targetNodeId)?.status,
        summary: delivery?.summary,
        at: delivery?.at,
      };
    }),
  );
  const at = seen.on ? seen.at : undefined;

  /*
   * "Just crossed" has to switch itself off: comparing `Date.now()` during render never re-runs,
   * because nothing about this edge changes once the transfer has been folded (as TypedEdge does).
   */
  const [recent, setRecent] = useState(false);
  useEffect(() => {
    const left = at === undefined ? 0 : FLOW_RECENT_MS - (Date.now() - at);
    if (left <= 0) {
      setRecent(false);
      return;
    }
    setRecent(true);
    const timer = setTimeout(() => setRecent(false), left);
    return () => clearTimeout(timer);
  }, [at]);

  const facts: EdgeRunFacts | undefined = seen.on
    ? { sourceState: seen.sourceState, targetState: seen.targetState, summary: seen.summary }
    : undefined;
  const flow = edgeFlowState(facts, recent);
  return { flow, title: edgeFlowTitle(flow, facts, sourceName, targetName) };
}
