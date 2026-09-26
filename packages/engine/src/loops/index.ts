import { createHash } from 'node:crypto';

import {
  loopBody,
  type Edge,
  type Envelope,
  type Id,
  type LoopConfig,
  type LoopStopReason,
  type Node,
  type NodeError,
  type Part,
} from '@ace/contracts';

import { readPath } from '../runs/transform.js';

/**
 * Loop edges (FR-CON-007, FR-PAR-003..007, FR-GRD-009, Arch §12.3, round 3 §2.4).
 *
 * A loop edge is the only legal cycle (D3): when its source completes, its exit condition is read
 * out of that node's json output, and either the whole loop **body** runs again one iteration
 * higher or the loop stops and says why. `loopBody` and `validateLoopConfig` live in
 * `@ace/contracts` so the Canvas and the scheduler cannot disagree about what an iteration
 * re-runs (D84) — nothing here re-implements either.
 *
 * Everything in this module is a decision or a plan. It reads no rows and writes none: the
 * scheduler applies what it returns, which is what lets a loop be unit-tested without a run.
 */

/** An edge that has been checked to be a loop edge with its config present. */
export type LoopEdge = Edge & { kind: 'loop'; loop: LoopConfig };

export function isLoopEdge(edge: Edge): edge is LoopEdge {
  return edge.kind === 'loop' && edge.loop !== undefined;
}

/** `repeated_output`'s default `times` (§2.2's default policy). */
export const DEFAULT_REPEATED_OUTPUT_TIMES = 3;

/* -------------------------------------------------------------------------- */
/* Reading the source's output                                                 */
/* -------------------------------------------------------------------------- */

/** The value of a node's first json part — what a loop's exit condition is read out of. */
export function jsonValueOf(parts: readonly Part[]): unknown {
  return parts.find((part) => part.type === 'json')?.value;
}

/**
 * Whether the loop may stop because it got what it was waiting for (FR-PAR-004).
 *
 * The path is read by the transform node's `readPath`, deliberately and not by a second reader:
 * `{{a.b}}` in a template, `extract_json_field`'s path and a loop's exit path are the same dotted
 * grammar, and it is the grammar `DOTTED_PATH_REGEX` lets the loop edge editor save (D73). A path
 * that resolves to nothing reads as `undefined`, so a reviewer that answered without the field has
 * simply not met the condition — which is a loop decision, not a crash.
 *
 * Strict equality, with no coercion: `"8"` is not `8`, and a reviewer that answered
 * `verdict: "Approved"` has not met `equals: "approved"`. A loop that silently accepted a near
 * miss would end a Review→Fix cycle on an unreviewed draft, which is the one outcome the cycle
 * exists to prevent.
 */
export function exitConditionMet(loop: LoopConfig, output: readonly Part[]): boolean {
  return readPath(jsonValueOf(output), loop.exitCondition.path) === loop.exitCondition.equals;
}

/**
 * A stable fingerprint of a node's output, for `repeated_output` (FR-GRD-009).
 *
 * Hashed rather than compared: the counter keeps one string per node for the whole run instead of
 * every previous output, and object keys are sorted so two identical json answers hash alike
 * whatever order the provider serialised them in.
 */
export function hashParts(parts: readonly Part[]): string {
  return createHash('sha256').update(stableStringify(parts)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableStringify(inner)}`).join(',')}}`;
}

/** How many times in a row each node has produced the same output (FR-GRD-009). */
export interface RepeatCounter {
  /** Record an output and return how many identical ones this node has now produced in a row. */
  record(nodeId: Id, parts: readonly Part[]): number;
  count(nodeId: Id): number;
}

export function createRepeatCounter(): RepeatCounter {
  const seen = new Map<Id, { hash: string; times: number }>();

  return {
    record(nodeId, parts) {
      const hash = hashParts(parts);
      const previous = seen.get(nodeId);
      const times = previous !== undefined && previous.hash === hash ? previous.times + 1 : 1;
      seen.set(nodeId, { hash, times });
      return times;
    },
    count: (nodeId) => seen.get(nodeId)?.times ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

export interface LoopContinue {
  kind: 'continue';
  edgeId: Id;
  sourceNodeId: Id;
  targetNodeId: Id;
  /** The iteration the body is about to start: 2, 3, … — what `loop.iteration` carries (§2.6). */
  iteration: number;
  /** Every node that runs again, `loopBody` of the edge (D84). */
  body: ReadonlySet<Id>;
}

export interface LoopStop {
  kind: 'stop';
  edgeId: Id;
  sourceNodeId: Id;
  targetNodeId: Id;
  /** The last iteration that ran — the node run that records `loopStop` (§2.4). */
  iteration: number;
  reason: LoopStopReason;
  /** `deliver`: pass the last output on (onMax `continue`). `fail`: onMax `fail` (FR-PAR-006). */
  after: 'deliver' | 'fail';
  body: ReadonlySet<Id>;
  /** Which maximum bound, the edge's own or the policy's `max_iterations` (§2.2, §2.4). */
  boundBy?: 'config' | 'policy';
  /** For `repeated_output`: the body node that kept answering the same thing. */
  repeatedOn?: Id;
  /** Why the loop stopped, in words a person can act on (NFR-USE-03). */
  message: string;
}

export type LoopDecision = LoopContinue | LoopStop;

export interface LoopDecisionInput {
  edge: LoopEdge;
  /** The snapshot's edges — `loopBody` needs them all. */
  edges: readonly Edge[];
  /** The iteration the source has just completed. */
  iteration: number;
  /** The source node's output for that iteration. */
  output: readonly Part[];
  /** The resolved policy's loop `max_iterations { max }`, when the check is configured (§2.2). */
  policyMaxIterations?: number;
  /** The policy's `repeated_output { times }`; absent means the check is not configured. */
  repeatedOutputTimes?: number;
  /** Consecutive identical outputs per node, from a `RepeatCounter` fed by every body node. */
  repeats?: ReadonlyMap<Id, number>;
  /** Node names for the message; ids are used when it is not supplied. */
  nameOf?: (nodeId: Id) => string;
}

/**
 * What a completed loop source does next (Arch §12.3, FR-PAR-003, 005, 006, FR-GRD-009).
 *
 * The order the three stop reasons are tested in is the order they matter in:
 *
 * 1. `exit_condition` first, because a loop that got its answer has succeeded — it must not be
 *    reported as having run out of iterations on the very iteration that approved the work, and
 *    `onMax` never applies to it (FR-PAR-006 is about *reaching the maximum*).
 * 2. `repeated_output` next, because "this node has stopped changing its answer" is the more
 *    useful thing to tell the user than "the counter ran out", and it can fire well before the
 *    maximum (FR-GRD-009).
 * 3. `max_iterations` last (FR-PAR-003): the cap is the lower of the edge's own `maxIterations`
 *    and the policy's, so neither can be raised past the other by editing one of them (§2.4).
 */
export function decideLoop(input: LoopDecisionInput): LoopDecision {
  const { edge, iteration } = input;
  const body = loopBody(edge, input.edges);
  const sourceNodeId = edge.from.nodeId;
  const targetNodeId = edge.to.nodeId;
  const name = input.nameOf ?? ((id: Id) => id);
  const after = edge.loop.onMax === 'fail' ? 'fail' : 'deliver';
  const common = { edgeId: edge.id, sourceNodeId, targetNodeId, iteration, body } as const;

  if (exitConditionMet(edge.loop, input.output)) {
    return {
      ...common,
      kind: 'stop',
      reason: 'exit_condition',
      // The loop did what it was for, so the last output goes on whatever `onMax` says.
      after: 'deliver',
      message:
        `The loop ended at iteration ${iteration}: "${name(sourceNodeId)}" returned ` +
        `${edge.loop.exitCondition.path} = ${JSON.stringify(edge.loop.exitCondition.equals)}.`,
    };
  }

  const times = input.repeatedOutputTimes;
  if (times !== undefined && times > 0) {
    const repeats = input.repeats ?? new Map<Id, number>();
    const stuck = [...body].find((nodeId) => (repeats.get(nodeId) ?? 0) >= times);
    if (stuck !== undefined) {
      return {
        ...common,
        kind: 'stop',
        reason: 'repeated_output',
        after,
        repeatedOn: stuck,
        message:
          `"${name(stuck)}" produced the same output ${times} times in a row, so the loop back to ` +
          `"${name(targetNodeId)}" was stopped at iteration ${iteration}. ` +
          'Change the instructions, the model or the temperature so the next iteration can differ.',
      };
    }
  }

  const policyMax = input.policyMaxIterations;
  const cap =
    policyMax === undefined ? edge.loop.maxIterations : Math.min(edge.loop.maxIterations, policyMax);

  if (iteration >= cap) {
    return {
      ...common,
      kind: 'stop',
      reason: 'max_iterations',
      after,
      boundBy: policyMax !== undefined && policyMax < edge.loop.maxIterations ? 'policy' : 'config',
      message:
        `The loop from "${name(sourceNodeId)}" back to "${name(targetNodeId)}" reached its maximum ` +
        `of ${cap} iteration${cap === 1 ? '' : 's'} without ${edge.loop.exitCondition.path} ` +
        `becoming ${JSON.stringify(edge.loop.exitCondition.equals)}. ` +
        'Raise the maximum, relax the exit condition, or set the loop to continue with the last output.',
    };
  }

  return { ...common, kind: 'continue', iteration: iteration + 1 };
}

/**
 * The failure a stop with `onMax: 'fail'` ends the source node run with (FR-PAR-006).
 *
 * `RUN_FAILED`, never `BLOCKED`: the node ran and produced an output, and it is the loop's own rule
 * that ended the run — which is a failure the user can retry after changing the loop, not an
 * unreachable node (BR-03, BR-12).
 */
export function loopFailure(stop: LoopStop): { failureReason: 'RUN_FAILED'; error: NodeError } {
  return {
    failureReason: 'RUN_FAILED',
    error: {
      kind: 'workflow',
      code: stop.reason === 'repeated_output' ? 'loop_repeated_output' : 'loop_max_iterations',
      message: stop.message,
      retryable: false,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Running the body again                                                     */
/* -------------------------------------------------------------------------- */

export interface IterationPlan {
  /** The iteration the body now starts. */
  iteration: number;
  targetNodeId: Id;
  /** Every node that gets a fresh node run at this iteration (D84, `loopBody`). */
  body: ReadonlySet<Id>;
  /**
   * Data edges to drop from `deliveredEdges`: the ones *inside* the body. An edge into the body
   * from outside stays delivered — the brief the Writer read on iteration 1 is still the brief.
   */
  clearEdgeIds: Id[];
  /**
   * Merge nodes in the body whose arrival log must be trimmed before the iteration — of the
   * arrivals that came from inside the body only, which is what `body` is passed to `clear` for.
   * A branch feeding the merge from outside the body does not run again.
   */
  mergeNodeIds: Id[];
}

/**
 * What the scheduler must undo before the body runs again (Arch §12.3).
 *
 * The rule is one sentence: everything *inside* the body is forgotten, everything from *outside*
 * it is kept. That is what makes iteration 2 of a Review→Fix loop a Writer that still has the
 * original brief plus the reviewer's critique, rather than a Writer with no brief or a Writer
 * holding three critiques.
 */
export function planNextIteration(
  decision: LoopContinue,
  edges: readonly Edge[],
  nodes: readonly Node[] = [],
): IterationPlan {
  const { body } = decision;

  return {
    iteration: decision.iteration,
    targetNodeId: decision.targetNodeId,
    body,
    clearEdgeIds: edges
      .filter(
        (edge) => edge.kind === 'data' && body.has(edge.from.nodeId) && body.has(edge.to.nodeId),
      )
      .map((edge) => edge.id),
    mergeNodeIds: nodes.filter((node) => node.kind === 'merge' && body.has(node.id)).map((n) => n.id),
  };
}

/**
 * The envelopes a body node keeps into the next iteration: the ones that came from outside the
 * body. The rest are this iteration's own traffic and are rebuilt as the body runs again.
 */
export function retainedEnvelopes(
  envelopes: readonly Envelope[],
  body: ReadonlySet<Id>,
): Envelope[] {
  return envelopes.filter((envelope) => !body.has(envelope.fromNodeId));
}

/**
 * A completed node's outgoing data edges, split by whether the target is in the same loop body.
 *
 * While a loop is still going round, a body node delivers only *inward*. An Output node hanging
 * off the Writer must not be handed iteration 1's draft and be finished with — it is fed once, from
 * the last iteration, when the loop stops. `body` of `undefined` means the node is in no
 * loop, and everything is `inside` — the ordinary case, delivered at once.
 */
export function splitOutgoing(
  nodeId: Id,
  edges: readonly Edge[],
  body: ReadonlySet<Id> | undefined,
): { inside: Edge[]; outside: Edge[] } {
  const outgoing = edges.filter((edge) => edge.kind === 'data' && edge.from.nodeId === nodeId);
  if (body === undefined) return { inside: outgoing, outside: [] };

  return {
    inside: outgoing.filter((edge) => body.has(edge.to.nodeId)),
    outside: outgoing.filter((edge) => !body.has(edge.to.nodeId)),
  };
}

/* -------------------------------------------------------------------------- */
/* The coordinator                                                            */
/* -------------------------------------------------------------------------- */

/** One held-back delivery: a body node's last output, and the edges that leave the body. */
export interface HeldDelivery {
  nodeId: Id;
  parts: Part[];
  edges: Edge[];
}

/**
 * The loop state of one run: which node belongs to which loop, how often each has repeated itself,
 * and what each body node last produced. One object, so the scheduler holds one thing rather than
 * four parallel maps.
 */
export interface LoopCoordinator {
  /** Every loop edge whose source is this node — the ones to decide about when it completes. */
  loopEdgesFrom(nodeId: Id): readonly LoopEdge[];
  /** The loop edge whose body contains this node, if any (a node is in one body only, D84). */
  loopFor(nodeId: Id): LoopEdge | undefined;
  body(loopEdgeId: Id): ReadonlySet<Id>;
  /** Record a completed body node's output: feeds `repeated_output` and the held-back delivery. */
  remember(nodeId: Id, parts: readonly Part[]): void;
  /** Consecutive identical outputs per node, as `decideLoop` wants them. */
  repeats(): ReadonlyMap<Id, number>;
  /** What was held back while the loop ran, ready to deliver now the loop has stopped. */
  held(loopEdgeId: Id, edges: readonly Edge[]): HeldDelivery[];
}

export function createLoopCoordinator(edges: readonly Edge[]): LoopCoordinator {
  const loops = edges.filter(isLoopEdge);
  const bodies = new Map<Id, ReadonlySet<Id>>(
    loops.map((edge) => [edge.id, loopBody(edge, edges)]),
  );

  const loopByNode = new Map<Id, LoopEdge>();
  for (const edge of loops) {
    for (const nodeId of bodies.get(edge.id) ?? []) {
      // D84: bodies never overlap, so the first writer is the only writer.
      if (!loopByNode.has(nodeId)) loopByNode.set(nodeId, edge);
    }
  }

  const counter = createRepeatCounter();
  const lastOutput = new Map<Id, Part[]>();

  return {
    loopEdgesFrom: (nodeId) => loops.filter((edge) => edge.from.nodeId === nodeId),
    loopFor: (nodeId) => loopByNode.get(nodeId),
    body: (loopEdgeId) => bodies.get(loopEdgeId) ?? new Set<Id>(),

    remember(nodeId, parts) {
      counter.record(nodeId, parts);
      lastOutput.set(nodeId, [...parts]);
    },

    repeats() {
      const map = new Map<Id, number>();
      for (const nodeId of lastOutput.keys()) map.set(nodeId, counter.count(nodeId));
      return map;
    },

    held(loopEdgeId, allEdges) {
      const body = bodies.get(loopEdgeId) ?? new Set<Id>();
      const deliveries: HeldDelivery[] = [];

      for (const nodeId of body) {
        const parts = lastOutput.get(nodeId);
        if (parts === undefined) continue;
        const { outside } = splitOutgoing(nodeId, allEdges, body);
        if (outside.length === 0) continue;
        deliveries.push({ nodeId, parts, edges: outside });
      }

      return deliveries;
    },
  };
}
