import {
  orderEdgeEnds,
  runPlan,
  validateOrderEdge,
  type Edge,
  type GraphOp,
  type Node,
  type NodeState,
  type RunPlanStep,
} from '@ace/contracts';

import { newId } from '../lib/ulid';

/*
 * D373: "who runs when". The plan is the contract's `runPlan` (data and order edges, loop edges
 * ignored); everything here turns a person's wish — "run X after Y", "move X to step 3" — into the
 * graph-ops that make the plan say so, or into the reason it cannot. Only order edges are ever
 * added or removed: a data edge carries work and is never touched to reorder a run.
 */

/** A plan edit: the ops and their undo label, or why it cannot be done. */
export type RunOrderEdit =
  { ok: true; ops: GraphOp[]; label: string } | { ok: false; reason: string };

const nameOf = (nodes: readonly Node[], id: string): string =>
  nodes.find((node) => node.id === id)?.name || 'Untitled';

/** The workflow's order edges ("run after" links). */
export function orderEdges(edges: readonly Edge[]): Edge[] {
  return edges.filter((edge) => edge.kind === 'order');
}

/** The nodes `nodeId` runs after through an order edge, with the edge that says so. */
export function runsAfter(edges: readonly Edge[], nodeId: string): Edge[] {
  return orderEdges(edges).filter((edge) => edge.to.nodeId === nodeId);
}

/** The order edge "`nodeId` runs after `afterId`", as `add_edge` takes it. */
export function newOrderEdge(workflowId: string, afterId: string, nodeId: string): Edge {
  return { id: newId(), workflowId, kind: 'order', ...orderEdgeEnds(afterId, nodeId) };
}

/** "Run `nodeId` after `afterId`": one `add_edge`, or the contract's reason it would be refused. */
export function addRunAfter(
  workflowId: string,
  nodes: readonly Node[],
  edges: readonly Edge[],
  nodeId: string,
  afterId: string,
): RunOrderEdit {
  const edge = newOrderEdge(workflowId, afterId, nodeId);
  const check = validateOrderEdge(edge, { nodes, edges });
  if (!check.ok) return { ok: false, reason: check.reason };
  return {
    ok: true,
    ops: [{ op: 'add_edge', edge }],
    label: `Run ${nameOf(nodes, nodeId)} after ${nameOf(nodes, afterId)}`,
  };
}

/** Whether "run `nodeId` after `afterId`" would be accepted, and if not why. */
export function runAfterCheck(
  nodes: readonly Node[],
  edges: readonly Edge[],
  nodeId: string,
  afterId: string,
): { ok: true } | { ok: false; reason: string } {
  const outcome = addRunAfter('', nodes, edges, nodeId, afterId);
  return outcome.ok ? { ok: true } : outcome;
}

/** Each node's 1-based step in the plan. */
export function stepOf(plan: readonly RunPlanStep[]): Map<string, number> {
  const steps = new Map<string, number>();
  for (const step of plan) for (const id of step.nodeIds) steps.set(id, step.step);
  return steps;
}

/**
 * Move a node to another step of the plan (D373). Later: an order edge from a node of the step
 * before the target (one the node does not already feed, which would be a cycle). Earlier: the
 * order edges from nodes at the target step or after are removed, and when that leaves the node
 * earlier than asked, an order edge from the step before the target holds it there. A data edge
 * from a node at the target step or after holds it where it is — that is said, never changed.
 */
export function moveToStep(
  workflowId: string,
  nodes: readonly Node[],
  edges: readonly Edge[],
  nodeId: string,
  target: number,
): RunOrderEdit {
  const plan = runPlan(nodes, edges);
  const steps = stepOf(plan);
  const current = steps.get(nodeId);
  if (current === undefined) return { ok: false, reason: 'That node is not in this workflow.' };
  const step = Math.max(1, Math.min(target, plan.length + 1));
  const name = nameOf(nodes, nodeId);
  if (step === current) return { ok: true, ops: [], label: `Run ${name} in step ${step}` };

  const before = plan.find((each) => each.step === step - 1)?.nodeIds ?? [];
  /** An order edge from a node of step `step - 1` that the contract accepts, if there is one. */
  const holdAt = (graphEdges: readonly Edge[]): RunOrderEdit | undefined => {
    let refusal: string | undefined;
    for (const afterId of before) {
      if (afterId === nodeId) continue;
      const outcome = addRunAfter(workflowId, nodes, graphEdges, nodeId, afterId);
      if (outcome.ok) return outcome;
      refusal ??= outcome.reason;
    }
    return refusal === undefined ? undefined : { ok: false, reason: refusal };
  };

  if (step > current) {
    const held = holdAt(edges);
    if (held === undefined) {
      return { ok: false, reason: `There is nothing in step ${step - 1} for ${name} to wait on.` };
    }
    return held.ok ? { ...held, label: `Run ${name} in step ${step}` } : held;
  }

  // Earlier: what holds it at `step` or later has to go — order edges only.
  const holding = edges.filter(
    (edge) =>
      (edge.kind === 'data' || edge.kind === 'order') &&
      edge.to.nodeId === nodeId &&
      (steps.get(edge.from.nodeId) ?? 0) >= step,
  );
  const data = holding.find((edge) => edge.kind === 'data');
  if (data !== undefined) {
    const from = data.from.nodeId;
    return {
      ok: false,
      reason:
        `${name} takes data from ${nameOf(nodes, from)} (step ${steps.get(from) ?? '?'}), so it ` +
        `cannot run before step ${(steps.get(from) ?? 0) + 1}. Remove that connection first.`,
    };
  }
  const ops: GraphOp[] = holding.map((edge) => ({ op: 'delete_edge', edgeId: edge.id }));
  const gone = new Set(holding.map((edge) => edge.id));
  const left = edges.filter((edge) => !gone.has(edge.id));
  const stillAt = Math.max(
    0,
    ...left
      .filter(
        (edge) => (edge.kind === 'data' || edge.kind === 'order') && edge.to.nodeId === nodeId,
      )
      .map((edge) => steps.get(edge.from.nodeId) ?? 0),
  );
  if (step > 1 && stillAt < step - 1) {
    const held = holdAt(left);
    if (held?.ok) ops.push(...held.ops);
  }
  return { ok: true, ops, label: `Run ${name} in step ${step}` };
}

/** How a step of the plan stands during a run of the workflow. */
export type StepLook = 'idle' | 'active' | 'done' | 'failed';

/** A step is active while any of its nodes is RUNNING or WAITING, done once all have COMPLETED. */
export function stepLook(nodeIds: readonly string[], state: (id: string) => NodeState): StepLook {
  const states = nodeIds.map(state);
  if (states.some((each) => each === 'RUNNING' || each === 'WAITING')) return 'active';
  if (states.length > 0 && states.every((each) => each === 'COMPLETED')) return 'done';
  if (states.some((each) => each === 'FAILED' || each === 'BLOCKED')) return 'failed';
  return 'idle';
}
