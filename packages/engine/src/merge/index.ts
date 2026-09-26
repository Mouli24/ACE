import type { Edge, Id, Node, Part, Usage } from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import type { NodeExecutionOutcome } from '../runs/executor.js';

/**
 * The Merge node (FR-PAR-001, FR-PAR-002, round 3 §2.4).
 *
 * A merge is the one node whose readiness is not a property of its ports: both of its input ports
 * are `multi`, so the generic port rule ("one arrival on a multi port is enough") is exactly the
 * `any` behaviour and can never express `all`. Everything here is therefore written against the
 * **arrival log** — which edge delivered what, in the order it happened — rather than against the
 * port model, and the mode decides both when the node may run and which arrivals feed it.
 *
 * Nothing in this module is stateful except `createMergeArrivalLog`, and nothing in it writes: the
 * scheduler owns the node run row, as it does for every other kind (see `runs/executor.ts`).
 */

export type MergeNode = Extract<Node, { kind: 'merge' }>;

/** One delivery into a merge node: the edge it came down, and what crossed it. */
export interface MergeArrival {
  edgeId: Id;
  /** The merge node's input port the edge lands on. */
  portId: string;
  /** The node the parts came from. */
  fromNodeId: Id;
  parts: Part[];
}

/**
 * One entry of the merge's json output. `port` is the input **port id**, not the port's name: §2.4
 * only calls the field `port`, and D78 settled which of the two it holds. An id is what a client
 * already has — the merge node's `inputs[]` and every edge endpoint are keyed by it — so a
 * consumer can put an arrival back against the port that received it without a second lookup,
 * which is exactly what "ordered by input port order" has to be checkable against.
 */
export interface MergeInput {
  port: string;
  nodeId: Id;
  parts: Part[];
}

/** The value of the single json part a merge node outputs (§2.4). */
export interface MergeOutputValue {
  inputs: MergeInput[];
}

const NO_USAGE: Usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

/** The data edges that actually feed this merge — an unconnected port is nothing to wait for. */
export function mergeInputEdges(node: MergeNode, edges: readonly Edge[]): Edge[] {
  return edges.filter((edge) => edge.kind === 'data' && edge.to.nodeId === node.id);
}

/**
 * Whether a merge node may run (FR-PAR-002).
 *
 * `all` waits for every **connected** input, which is not the same as every port: a merge with one
 * branch wired into `in` and nothing in `in_json` must still run. `any` runs on the first arrival.
 * A merge with nothing wired into it is ready at once and produces an empty input list, because a
 * node that can never receive anything would otherwise hold the run open for ever.
 */
export function isMergeReady(
  node: MergeNode,
  edges: readonly Edge[],
  delivered: ReadonlySet<Id>,
): boolean {
  const incoming = mergeInputEdges(node, edges);
  if (incoming.length === 0) return true;

  return node.config.mode === 'all'
    ? incoming.every((edge) => delivered.has(edge.id))
    : incoming.some((edge) => delivered.has(edge.id));
}

/**
 * Which arrivals feed the merge, in the order §2.4 asks for: by the merge's own input port order,
 * and within one port by the order the edges sit in the snapshot — so the same graph and the same
 * branch outputs produce byte-identical json however the branches happened to interleave.
 *
 * In `any` mode only the first arrival feeds it. The later branches are still in the log (they ran
 * and their node runs are recorded) and are deliberately dropped here — that is the whole
 * difference between the two modes, and it is decided by the log's order, not by a timer.
 */
export function mergeInputs(
  node: MergeNode,
  edges: readonly Edge[],
  arrivals: readonly MergeArrival[],
): MergeInput[] {
  const incoming = mergeInputEdges(node, edges);
  const fed = node.config.mode === 'any' ? arrivals.slice(0, 1) : arrivals;

  const portOrder = new Map(node.inputs.map((port, index) => [port.id, index]));
  const edgeOrder = new Map(incoming.map((edge, index) => [edge.id, index]));
  const last = node.inputs.length;

  return [...fed]
    .map((arrival, index) => ({ arrival, index }))
    .sort((a, b) => {
      const portDelta =
        (portOrder.get(a.arrival.portId) ?? last) - (portOrder.get(b.arrival.portId) ?? last);
      if (portDelta !== 0) return portDelta;

      const edgeDelta =
        (edgeOrder.get(a.arrival.edgeId) ?? incoming.length) -
        (edgeOrder.get(b.arrival.edgeId) ?? incoming.length);
      return edgeDelta !== 0 ? edgeDelta : a.index - b.index;
    })
    .map(({ arrival }) => ({
      port: arrival.portId,
      nodeId: arrival.fromNodeId,
      parts: arrival.parts,
    }));
}

/** A merge node's output: one json part, whatever the branches produced (§2.4). */
export function mergeOutput(
  node: MergeNode,
  edges: readonly Edge[],
  arrivals: readonly MergeArrival[],
): Part[] {
  const value: MergeOutputValue = { inputs: mergeInputs(node, edges, arrivals) };
  return [{ type: 'json', value }];
}

export interface MergeExecutionInput {
  runId: Id;
  workflowId: Id;
  nodeRunId: Id;
  node: MergeNode;
  edges: readonly Edge[];
  arrivals: readonly MergeArrival[];
}

/**
 * Run a merge node, in the shape the scheduler already handles for every other kind.
 *
 * A merge calls no provider and costs nothing, so it cannot fail: its output is a function of what
 * arrived. It still emits `node.output`, because a client that renders outputs from the event
 * stream must see a merge's json the same way it sees an agent's text (FR-EXE-014).
 */
export async function executeMergeNode(
  input: MergeExecutionInput,
  deps: { bus: EventBus },
): Promise<NodeExecutionOutcome> {
  const output = mergeOutput(input.node, input.edges, input.arrivals);

  await deps.bus.emit({
    type: 'node.output',
    workflowId: input.workflowId,
    runId: input.runId,
    payload: {
      runId: input.runId,
      nodeRunId: input.nodeRunId,
      nodeId: input.node.id,
      output,
      usage: NO_USAGE,
    },
  });

  return { status: 'COMPLETED', output, usage: NO_USAGE };
}

/* -------------------------------------------------------------------------- */
/* The arrival log                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What arrived at each merge node, in order.
 *
 * The scheduler's `envelopesFor` cannot stand in for this: it holds one envelope per *target
 * node*, so it loses which port an arrival landed on and cannot tell two edges from the same
 * upstream apart.
 *
 * `clear` is for a merge inside a loop body, and it takes the body: only the arrivals that came
 * from *inside* the loop are forgotten. A branch feeding the merge from outside the body does
 * not run again — `loopBody` does not include it — so dropping its arrival would leave an `all`
 * merge waiting for something that will never come a second time. Same rule as
 * `retainedEnvelopes`: forget what the iteration produced, keep what was handed in from outside.
 */
export interface MergeArrivalLog {
  record(targetNodeId: Id, arrival: MergeArrival): void;
  arrivals(targetNodeId: Id): readonly MergeArrival[];
  /** Drop this node's arrivals; with `fromNodeIds`, only the ones that came from those nodes. */
  clear(targetNodeId: Id, fromNodeIds?: ReadonlySet<Id>): void;
}

export function createMergeArrivalLog(): MergeArrivalLog {
  const byNode = new Map<Id, MergeArrival[]>();

  return {
    record(targetNodeId, arrival) {
      byNode.set(targetNodeId, [...(byNode.get(targetNodeId) ?? []), arrival]);
    },
    arrivals: (targetNodeId) => byNode.get(targetNodeId) ?? [],
    clear(targetNodeId, fromNodeIds) {
      if (fromNodeIds === undefined) {
        byNode.delete(targetNodeId);
        return;
      }
      byNode.set(
        targetNodeId,
        (byNode.get(targetNodeId) ?? []).filter((arrival) => !fromNodeIds.has(arrival.fromNodeId)),
      );
    },
  };
}
