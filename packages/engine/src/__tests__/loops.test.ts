import {
  REVIEW_CONTRACT_SCHEMA,
  derivePorts,
  loopBody,
  type Edge,
  type Id,
  type LoopConfig,
  type LoopStopReason,
  type Node,
  type Part,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { newId } from '../ids.js';
import {
  createLoopCoordinator,
  createRepeatCounter,
  decideLoop,
  exitConditionMet,
  hashParts,
  isLoopEdge,
  jsonValueOf,
  loopFailure,
  planNextIteration,
  retainedEnvelopes,
  splitOutgoing,
  type LoopContinue,
  type LoopEdge,
  type LoopStop,
} from '../loops/index.js';
import { createMergeArrivalLog, isMergeReady, mergeOutput, type MergeNode } from '../merge/index.js';
import { readPath } from '../runs/transform.js';

/**
 * Loop scheduling (FR-PAR-003..007, FR-GRD-009, TC-PAR-004..007, TC-GRD-013, Arch §12.3, §2.4).
 */

const WORKFLOW = newId();

function node(kind: 'input' | 'agent' | 'output' | 'merge', name: string, outputType = 'text'): Node {
  const id = newId();
  if (kind === 'input') {
    const config = { text: 'the brief', artifactIds: [], outputTypes: ['text' as const] };
    return {
      id,
      workflowId: WORKFLOW,
      kind,
      name,
      position: { x: 0, y: 0 },
      ...derivePorts({ id, kind, config }),
      config,
    };
  }
  if (kind === 'output') {
    const config = {};
    return {
      id,
      workflowId: WORKFLOW,
      kind,
      name,
      position: { x: 0, y: 0 },
      ...derivePorts({ id, kind, config }),
      config,
    };
  }
  if (kind === 'merge') {
    const config = { mode: 'all' as const };
    return {
      id,
      workflowId: WORKFLOW,
      kind,
      name,
      position: { x: 0, y: 0 },
      ...derivePorts({ id, kind, config }),
      config,
    };
  }

  const config = {
    instructions: `Act as ${name}.`,
    inputTypes: ['text' as const],
    outputTypes: [outputType as 'text'],
    routing: { policy: 'fixed' as const, fallbackModelIds: [] },
    execution: { temperature: 0.7, maxTokens: 4096, timeoutMs: 120_000, retries: 2 },
    contextPolicy: { budgetTokens: 4000 },
    tools: { enabled: [], maxToolCalls: 10, allowedDomains: [] },
    knowledgeBaseIds: [],
    memory: { enabled: false },
    skillIds: [],
  };
  return {
    id,
    workflowId: WORKFLOW,
    kind: 'agent',
    name,
    position: { x: 0, y: 0 },
    ...derivePorts({ id, kind: 'agent', config }),
    config,
  };
}

const dataEdge = (from: Node, fromPort: string, to: Node, toPort: string): Edge => ({
  id: newId(),
  workflowId: WORKFLOW,
  kind: 'data',
  from: { nodeId: from.id, portId: `${from.id}:out:${fromPort}` },
  to: { nodeId: to.id, portId: `${to.id}:in:${toPort}` },
});

const LOOP: LoopConfig = {
  maxIterations: 3,
  exitCondition: { path: 'verdict', equals: 'approved' },
  onMax: 'continue',
};

const loopBack = (from: Node, to: Node, loop: LoopConfig = LOOP): LoopEdge => ({
  id: newId(),
  workflowId: WORKFLOW,
  kind: 'loop',
  from: { nodeId: from.id, portId: `${from.id}:out:json` },
  to: { nodeId: to.id, portId: `${to.id}:in:text` },
  loop,
});

const review = (verdict: string, issues: string[] = []): Part[] => [
  { type: 'json', value: { score: verdict === 'approved' ? 9 : 4, verdict, issues } },
];

/* -------------------------------------------------------------------------- */
/* Reading the exit path                                                      */
/* -------------------------------------------------------------------------- */

describe('FR-PAR-004 reading the exit condition out of a json output', () => {
  it.each([
    ['verdict', 'approved'],
    ['review.verdict', 'approved'],
    ['issues.0', 'first'],
    ['issues[0]', 'first'],
  ])('resolves %s', (path, expected) => {
    const value = { verdict: 'approved', review: { verdict: 'approved' }, issues: ['first'] };
    expect(readPath(value, path)).toBe(expected);
  });

  it.each(['missing', 'review.missing', 'issues.9', 'verdict.deeper'])(
    'reads %s as undefined rather than throwing',
    (path) => {
      expect(readPath({ verdict: 'approved', review: {}, issues: [] }, path)).toBeUndefined();
    },
  );

  it('the loop reads its path with the transform node’s reader, not a second grammar', () => {
    // `exitConditionMet` is `readPath` over the first json part; if the two ever diverged, a path
    // the loop editor accepted could mean one thing in a template and another in a loop.
    expect(exitConditionMet(LOOP, review('approved'))).toBe(
      readPath(jsonValueOf(review('approved')), 'verdict') === 'approved',
    );
  });

  it('takes the exit value from the first json part and ignores text', () => {
    expect(jsonValueOf([{ type: 'text', text: 'hello' }, ...review('approved')])).toEqual({
      score: 9,
      verdict: 'approved',
      issues: [],
    });
  });

  it('does not coerce: "8" is not 8 and "Approved" is not "approved"', () => {
    const numeric: LoopConfig = { ...LOOP, exitCondition: { path: 'score', equals: 8 } };
    expect(exitConditionMet(numeric, [{ type: 'json', value: { score: '8' } }])).toBe(false);
    expect(exitConditionMet(numeric, [{ type: 'json', value: { score: 8 } }])).toBe(true);
    expect(exitConditionMet(LOOP, review('Approved'))).toBe(false);
  });

  it('an output with no json part never meets the condition', () => {
    expect(exitConditionMet(LOOP, [{ type: 'text', text: 'approved' }])).toBe(false);
    expect(exitConditionMet(LOOP, [])).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

describe('TC-PAR-004 Loop exits on approval', () => {
  const writer = node('agent', 'Writer');
  const reviewer = node('agent', 'Reviewer', 'json');
  const edges = [dataEdge(writer, 'text', reviewer, 'text'), loopBack(reviewer, writer)];
  const loop = edges[1] as LoopEdge;

  const decide = (iteration: number, verdict: string) =>
    decideLoop({ edge: loop, edges, iteration, output: review(verdict) });

  it('goes round again while the reviewer asks for changes', () => {
    const decision = decide(1, 'changes_requested');
    expect(decision.kind).toBe('continue');
    expect((decision as LoopContinue).iteration).toBe(2);
    expect((decision as LoopContinue).targetNodeId).toBe(writer.id);
  });

  it('stops at the iteration that approved, with reason exit_condition', () => {
    const decision = decide(2, 'approved');
    expect(decision).toMatchObject({ kind: 'stop', reason: 'exit_condition', iteration: 2 });
  });

  it('an approval on the last allowed iteration is exit_condition, not max_iterations', () => {
    expect(decide(3, 'approved')).toMatchObject({ reason: 'exit_condition' });
  });

  it('an exit always passes the output on, whatever onMax says', () => {
    const failing = loopBack(reviewer, writer, { ...LOOP, onMax: 'fail' });
    const decision = decideLoop({
      edge: failing,
      edges: [edges[0]!, failing],
      iteration: 1,
      output: review('approved'),
    });

    expect(decision).toMatchObject({ kind: 'stop', reason: 'exit_condition', after: 'deliver' });
  });
});

describe('TC-PAR-005 Loop hits its maximum', () => {
  const writer = node('agent', 'Writer');
  const reviewer = node('agent', 'Reviewer', 'json');
  const dataEdges = [dataEdge(writer, 'text', reviewer, 'text')];

  function decide(iteration: number, loop: LoopConfig, policyMaxIterations?: number) {
    const edge = loopBack(reviewer, writer, loop);
    return decideLoop({
      edge,
      edges: [...dataEdges, edge],
      iteration,
      output: review('changes_requested'),
      ...(policyMaxIterations === undefined ? {} : { policyMaxIterations }),
      nameOf: (id) => (id === writer.id ? 'Writer' : 'Reviewer'),
    });
  }

  it('runs exactly maxIterations iterations and no more', () => {
    expect(decide(1, LOOP).kind).toBe('continue');
    expect(decide(2, LOOP).kind).toBe('continue');
    expect(decide(3, LOOP)).toMatchObject({ kind: 'stop', reason: 'max_iterations', iteration: 3 });
  });

  it('a maximum of 1 never goes round', () => {
    expect(decide(1, { ...LOOP, maxIterations: 1 })).toMatchObject({ reason: 'max_iterations' });
  });

  it('the cap is the lower of the edge and the policy, whichever way round they are', () => {
    expect(decide(2, { ...LOOP, maxIterations: 10 }, 2)).toMatchObject({
      reason: 'max_iterations',
      boundBy: 'policy',
    });
    expect(decide(3, LOOP, 50)).toMatchObject({ reason: 'max_iterations', boundBy: 'config' });
    expect(decide(2, { ...LOOP, maxIterations: 10 }, 50).kind).toBe('continue');
  });

  it('names both nodes, the maximum and the condition that never came true', () => {
    const stop = decide(3, LOOP) as LoopStop;
    expect(stop.message).toContain('"Reviewer"');
    expect(stop.message).toContain('"Writer"');
    expect(stop.message).toContain('3 iterations');
    expect(stop.message).toContain('verdict');
    expect(stop.message).toContain('Raise the maximum');
  });
});

describe('TC-PAR-007 Max behaviour', () => {
  const writer = node('agent', 'Writer');
  const reviewer = node('agent', 'Reviewer', 'json');
  const data = dataEdge(writer, 'text', reviewer, 'text');

  function atMax(onMax: 'continue' | 'fail'): LoopStop {
    const edge = loopBack(reviewer, writer, { ...LOOP, onMax });
    return decideLoop({
      edge,
      edges: [data, edge],
      iteration: 3,
      output: review('changes_requested'),
    }) as LoopStop;
  }

  it('continue passes the last output downstream', () => {
    expect(atMax('continue').after).toBe('deliver');
  });

  it('fail ends the node RUN_FAILED with a reason a person can act on', () => {
    const stop = atMax('fail');
    expect(stop.after).toBe('fail');

    const failure = loopFailure(stop);
    expect(failure.failureReason).toBe('RUN_FAILED');
    expect(failure.error.code).toBe('loop_max_iterations');
    expect(failure.error.retryable).toBe(false);
    expect(failure.error.message).toBe(stop.message);
  });
});

/* -------------------------------------------------------------------------- */
/* Repeated output                                                            */
/* -------------------------------------------------------------------------- */

describe('TC-GRD-013 Repeated output stops the loop', () => {
  const writer = node('agent', 'Writer');
  const reviewer = node('agent', 'Reviewer', 'json');
  const data = dataEdge(writer, 'text', reviewer, 'text');
  const edge = loopBack(reviewer, writer, { ...LOOP, maxIterations: 10 });
  const edges = [data, edge];

  it('hashes equal outputs alike whatever order the json keys came in', () => {
    expect(hashParts([{ type: 'json', value: { a: 1, b: [2, { c: 3 }] } }])).toBe(
      hashParts([{ type: 'json', value: { b: [2, { c: 3 }], a: 1 } }]),
    );
    expect(hashParts([{ type: 'text', text: 'one' }])).not.toBe(
      hashParts([{ type: 'text', text: 'two' }]),
    );
  });

  it('counts identical outputs in a row per node, and a change resets the count', () => {
    const counter = createRepeatCounter();
    const same: Part[] = [{ type: 'text', text: 'same' }];

    expect(counter.record(writer.id, same)).toBe(1);
    expect(counter.record(writer.id, same)).toBe(2);
    expect(counter.record(reviewer.id, same)).toBe(1);
    expect(counter.record(writer.id, [{ type: 'text', text: 'different' }])).toBe(1);
    expect(counter.record(writer.id, [{ type: 'text', text: 'different' }])).toBe(2);
  });

  it('stops with repeated_output when a body node has answered the same thing 3 times', () => {
    const decision = decideLoop({
      edge,
      edges,
      iteration: 3,
      output: review('changes_requested'),
      repeatedOutputTimes: 3,
      repeats: new Map([[writer.id, 3]]),
      nameOf: (id) => (id === writer.id ? 'Writer' : 'Reviewer'),
    }) as LoopStop;

    expect(decision.reason).toBe('repeated_output');
    expect(decision.repeatedOn).toBe(writer.id);
    expect(decision.message).toContain('"Writer" produced the same output 3 times in a row');
  });

  it('then applies the onMax behaviour — continue delivers, fail is RUN_FAILED', () => {
    const repeats = new Map([[writer.id, 3]]);
    const failing = loopBack(reviewer, writer, { ...LOOP, onMax: 'fail' });

    const continued = decideLoop({
      edge,
      edges,
      iteration: 3,
      output: review('changes_requested'),
      repeatedOutputTimes: 3,
      repeats,
    }) as LoopStop;
    const failed = decideLoop({
      edge: failing,
      edges: [data, failing],
      iteration: 3,
      output: review('changes_requested'),
      repeatedOutputTimes: 3,
      repeats,
    }) as LoopStop;

    expect(continued.after).toBe('deliver');
    expect(failed.after).toBe('fail');
    expect(loopFailure(failed).error.code).toBe('loop_repeated_output');
  });

  it('two in a row is not three, and a node outside the body does not count', () => {
    const outsider = node('agent', 'Elsewhere');

    expect(
      decideLoop({
        edge,
        edges,
        iteration: 1,
        output: review('changes_requested'),
        repeatedOutputTimes: 3,
        repeats: new Map([[writer.id, 2]]),
      }).kind,
    ).toBe('continue');

    expect(
      decideLoop({
        edge,
        edges,
        iteration: 1,
        output: review('changes_requested'),
        repeatedOutputTimes: 3,
        repeats: new Map([[outsider.id, 9]]),
      }).kind,
    ).toBe('continue');
  });

  it('an unconfigured check never stops a loop, however stuck it looks', () => {
    expect(
      decideLoop({
        edge,
        edges,
        iteration: 1,
        output: review('changes_requested'),
        repeats: new Map([[writer.id, 99]]),
      }).kind,
    ).toBe('continue');
  });

  it('an approval wins over a repeat: the loop got what it was waiting for', () => {
    expect(
      decideLoop({
        edge,
        edges,
        iteration: 3,
        output: review('approved'),
        repeatedOutputTimes: 3,
        repeats: new Map([[writer.id, 5]]),
      }),
    ).toMatchObject({ reason: 'exit_condition' });
  });
});

/* -------------------------------------------------------------------------- */
/* What the next iteration re-runs                                            */
/* -------------------------------------------------------------------------- */

describe('FR-PAR-003 what an iteration re-runs (D84)', () => {
  const input = node('input', 'Brief');
  const writer = node('agent', 'Writer');
  const reviewer = node('agent', 'Reviewer', 'json');
  const output = node('output', 'Result');
  const brief = dataEdge(input, 'text', writer, 'text');
  const draft = dataEdge(writer, 'text', reviewer, 'text');
  const result = dataEdge(writer, 'text', output, 'text');
  const edge = loopBack(reviewer, writer);
  const edges = [brief, draft, result, edge];

  it('the body is the loop, and nothing outside it', () => {
    expect([...loopBody(edge, edges)].sort()).toEqual([writer.id, reviewer.id].sort());
  });

  it('clears the edges inside the body and keeps the brief delivered', () => {
    const decision = decideLoop({
      edge,
      edges,
      iteration: 1,
      output: review('changes_requested'),
    }) as LoopContinue;
    const plan = planNextIteration(decision, edges, [input, writer, reviewer, output]);

    expect(plan.iteration).toBe(2);
    expect(plan.clearEdgeIds).toEqual([draft.id]);
    expect(plan.clearEdgeIds).not.toContain(brief.id);
    expect(plan.clearEdgeIds).not.toContain(result.id);
    expect(plan.mergeNodeIds).toEqual([]);
  });

  it('a body node keeps the envelopes from outside and drops this iteration’s own', () => {
    const body = loopBody(edge, edges);
    const envelope = (fromNodeId: Id) => ({
      id: newId(),
      runId: 'run',
      fromNodeId,
      toNodeId: writer.id,
      iteration: 1,
      reads: [],
      context: { budgetTokens: 10, trust: 'untrusted' as const },
      contract: { outputTypes: ['text' as const] },
      createdAt: '2026-09-26T00:00:00.000Z',
    });

    const kept = retainedEnvelopes([envelope(input.id), envelope(reviewer.id)], body);
    expect(kept.map((each) => each.fromNodeId)).toEqual([input.id]);
  });

  it('while the loop runs, a body node delivers inward only', () => {
    const body = loopBody(edge, edges);

    expect(splitOutgoing(writer.id, edges, body).inside.map((e) => e.id)).toEqual([draft.id]);
    expect(splitOutgoing(writer.id, edges, body).outside.map((e) => e.id)).toEqual([result.id]);
    // A node in no loop delivers everything at once, as it always did.
    expect(splitOutgoing(input.id, edges, undefined).outside).toEqual([]);
  });

  it('the coordinator holds the outward delivery back until the loop stops', () => {
    const coordinator = createLoopCoordinator(edges);

    expect(coordinator.loopEdgesFrom(reviewer.id).map((e) => e.id)).toEqual([edge.id]);
    expect(coordinator.loopEdgesFrom(writer.id)).toEqual([]);
    expect(coordinator.loopFor(writer.id)?.id).toBe(edge.id);
    expect(coordinator.loopFor(output.id)).toBeUndefined();

    coordinator.remember(writer.id, [{ type: 'text', text: 'draft 1' }]);
    coordinator.remember(reviewer.id, review('changes_requested'));
    coordinator.remember(writer.id, [{ type: 'text', text: 'draft 2' }]);

    const held = coordinator.held(edge.id, edges);
    expect(held).toHaveLength(1);
    expect(held[0]?.nodeId).toBe(writer.id);
    expect(held[0]?.parts).toEqual([{ type: 'text', text: 'draft 2' }]);
    expect(held[0]?.edges.map((e) => e.id)).toEqual([result.id]);
  });

  it('isLoopEdge only accepts a loop edge that carries its config', () => {
    expect(isLoopEdge(edge)).toBe(true);
    expect(isLoopEdge(brief)).toBe(false);
    expect(isLoopEdge({ ...edge, loop: undefined })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The whole loop, driven the way the wiring list says to drive it             */
/* -------------------------------------------------------------------------- */

interface Record_ {
  nodeId: Id;
  iteration: number;
  output: Part[];
  loopStop?: LoopStopReason;
  failureReason?: string;
}

interface DriveResult {
  records: Record_[];
  events: { iteration: number; stop?: LoopStopReason }[];
  deliveredOutward: { nodeId: Id; parts: Part[] }[];
}

/**
 * A Review→Fix loop, driven by the modules exactly as the wiring list drives them from the
 * scheduler: run the body, remember each output, decide on the source, and either plan the next
 * iteration or record `loopStop` on the last one. It stands in for the scheduler, which this agent
 * may not edit — the real thing has to be verified by the wiring, not by this.
 */
function driveReviewFix(options: {
  loop: LoopConfig;
  verdictAt: (iteration: number) => string;
  draftAt?: (iteration: number) => string;
  repeatedOutputTimes?: number;
  policyMaxIterations?: number;
}): DriveResult {
  const input = node('input', 'Brief');
  const writer = node('agent', 'Writer');
  const reviewer = node('agent', 'Reviewer', 'json');
  const output = node('output', 'Result');
  const edges = [
    dataEdge(input, 'text', writer, 'text'),
    dataEdge(writer, 'text', reviewer, 'text'),
    dataEdge(writer, 'text', output, 'text'),
    loopBack(reviewer, writer, options.loop),
  ];
  const edge = edges[3] as LoopEdge;

  const coordinator = createLoopCoordinator(edges);
  const records: Record_[] = [];
  const events: { iteration: number; stop?: LoopStopReason }[] = [];
  const deliveredOutward: { nodeId: Id; parts: Part[] }[] = [];

  const draftAt = options.draftAt ?? ((iteration: number) => `draft ${iteration}`);

  let iteration = 1;
  for (;;) {
    for (const [target, parts] of [
      [writer, [{ type: 'text' as const, text: draftAt(iteration) }]],
      [reviewer, review(options.verdictAt(iteration))],
    ] as const) {
      records.push({ nodeId: (target as Node).id, iteration, output: [...parts] });
      coordinator.remember((target as Node).id, parts);
    }

    const decision = decideLoop({
      edge,
      edges,
      iteration,
      output: records[records.length - 1]!.output,
      repeats: coordinator.repeats(),
      ...(options.repeatedOutputTimes === undefined
        ? {}
        : { repeatedOutputTimes: options.repeatedOutputTimes }),
      ...(options.policyMaxIterations === undefined
        ? {}
        : { policyMaxIterations: options.policyMaxIterations }),
    });

    if (decision.kind === 'continue') {
      events.push({ iteration: decision.iteration });
      iteration = planNextIteration(decision, edges, [input, writer, reviewer, output]).iteration;
      continue;
    }

    events.push({ iteration: decision.iteration, stop: decision.reason });

    // §2.4: `loopStop` goes on the *last* iteration's node run of the loop source.
    const last = [...records].reverse().find((record) => record.nodeId === reviewer.id)!;
    last.loopStop = decision.reason;

    if (decision.after === 'fail') {
      last.failureReason = loopFailure(decision).failureReason;
    } else {
      for (const held of coordinator.held(edge.id, edges)) {
        deliveredOutward.push({ nodeId: held.nodeId, parts: held.parts });
      }
    }
    break;
  }

  return { records, events, deliveredOutward };
}

describe('TC-PAR-005 / TC-PAR-006 three iterations, each one recorded', () => {
  it('records a node run per body node per iteration, numbered from 1', () => {
    const { records } = driveReviewFix({ loop: LOOP, verdictAt: () => 'changes_requested' });

    expect(records.map((record) => record.iteration)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(new Set(records.map((record) => record.nodeId)).size).toBe(2);
  });

  it('each iteration keeps its own output, so the inspector has three to choose from', () => {
    const { records } = driveReviewFix({ loop: LOOP, verdictAt: () => 'changes_requested' });
    const drafts = records.filter((record) => record.output[0]?.type === 'text');

    expect(drafts.map((record) => (record.output[0] as { text: string }).text)).toEqual([
      'draft 1',
      'draft 2',
      'draft 3',
    ]);
  });

  it('emits loop.iteration for every re-queue and once more for the stop', () => {
    const { events } = driveReviewFix({ loop: LOOP, verdictAt: () => 'changes_requested' });

    expect(events).toEqual([
      { iteration: 2 },
      { iteration: 3 },
      { iteration: 3, stop: 'max_iterations' },
    ]);
  });

  it('records loopStop on the last iteration only', () => {
    const { records } = driveReviewFix({ loop: LOOP, verdictAt: () => 'changes_requested' });
    const stops = records.filter((record) => record.loopStop !== undefined);

    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ iteration: 3, loopStop: 'max_iterations' });
  });

  it('TC-PAR-004 stops at 2 when the reviewer approves on 2', () => {
    const { records, events } = driveReviewFix({
      loop: LOOP,
      verdictAt: (iteration) => (iteration >= 2 ? 'approved' : 'changes_requested'),
    });

    expect(records.map((record) => record.iteration)).toEqual([1, 1, 2, 2]);
    expect(events.at(-1)).toEqual({ iteration: 2, stop: 'exit_condition' });
  });

  it('onMax continue hands the last draft to the Output node; fail does not', () => {
    const continued = driveReviewFix({ loop: LOOP, verdictAt: () => 'changes_requested' });
    expect(continued.deliveredOutward).toEqual([
      { nodeId: continued.records[4]!.nodeId, parts: [{ type: 'text', text: 'draft 3' }] },
    ]);

    const failed = driveReviewFix({
      loop: { ...LOOP, onMax: 'fail' },
      verdictAt: () => 'changes_requested',
    });
    expect(failed.deliveredOutward).toEqual([]);
    expect(failed.records.at(-1)).toMatchObject({ failureReason: 'RUN_FAILED' });
  });

  it('TC-GRD-013 a Writer that never changes its answer stops the loop at 3', () => {
    const { records, events } = driveReviewFix({
      loop: { ...LOOP, maxIterations: 50 },
      verdictAt: () => 'changes_requested',
      draftAt: () => 'the same draft',
      repeatedOutputTimes: 3,
    });

    expect(events.at(-1)).toEqual({ iteration: 3, stop: 'repeated_output' });
    expect(records.filter((record) => record.loopStop === 'repeated_output')).toHaveLength(1);
    expect(records).toHaveLength(6);
  });

  it('the policy cap stops a loop whose own maximum is higher', () => {
    const { events } = driveReviewFix({
      loop: { ...LOOP, maxIterations: 50 },
      verdictAt: () => 'changes_requested',
      policyMaxIterations: 2,
    });

    expect(events.at(-1)).toEqual({ iteration: 2, stop: 'max_iterations' });
  });
});

/* -------------------------------------------------------------------------- */
/* A merge inside a loop body                                                  */
/* -------------------------------------------------------------------------- */

describe('FR-PAR-002 / FR-PAR-003 a merge inside a loop body', () => {
  const input = node('input', 'Brief');
  const left = node('agent', 'Left');
  const right = node('agent', 'Right');
  const merge = node('merge', 'Merge') as MergeNode;
  const reviewer = node('agent', 'Reviewer', 'json');
  const edges: Edge[] = [
    dataEdge(input, 'text', left, 'text'),
    dataEdge(input, 'text', right, 'text'),
    dataEdge(left, 'text', merge, 'in'),
    dataEdge(right, 'text', merge, 'in'),
    dataEdge(merge, 'out', reviewer, 'text'),
    loopBack(reviewer, left),
  ];
  const edge = edges[5] as LoopEdge;

  it('the body is the merge, the reviewer and the branch the loop leads back to — not the other', () => {
    // `loopBody` is the intersection of "reachable forward from the target" and "reachable back
    // from the source" (D84). The Right branch is fed from the Input, not from the Writer, so it is
    // not part of what an iteration re-runs — which is why its arrival must survive the clearing.
    const body = loopBody(edge, edges);
    expect([...body].sort()).toEqual([left.id, merge.id, reviewer.id].sort());
    expect(body.has(right.id)).toBe(false);
  });

  it('the plan names the merge, so its arrivals are trimmed before the next iteration', () => {
    const decision = decideLoop({
      edge,
      edges,
      iteration: 1,
      output: review('changes_requested'),
    }) as LoopContinue;
    const plan = planNextIteration(decision, edges, [input, left, right, merge, reviewer]);

    expect(plan.mergeNodeIds).toEqual([merge.id]);
    // Left → Merge and Merge → Reviewer are inside; Input → Right and Right → Merge are not.
    expect(plan.clearEdgeIds).toHaveLength(2);
    expect(plan.clearEdgeIds).not.toContain(edges[3]!.id);
  });

  it('trimming keeps the branch from outside, so an all-merge still gets both inputs', () => {
    const log = createMergeArrivalLog();
    const incoming = edges.filter((each) => each.to.nodeId === merge.id);
    for (const each of incoming) {
      log.record(merge.id, {
        edgeId: each.id,
        portId: each.to.portId,
        fromNodeId: each.from.nodeId,
        parts: [{ type: 'text', text: 'iteration 1' }],
      });
    }

    const delivered = new Set(incoming.map((each) => each.id));
    expect(isMergeReady(merge, edges, delivered)).toBe(true);
    expect(mergeOutput(merge, edges, log.arrivals(merge.id))).toHaveLength(1);

    // What the wiring does at the start of an iteration: forget the body's own traffic only.
    const body = loopBody(edge, edges);
    log.clear(merge.id, body);
    for (const id of planNextIteration(
      decideLoop({
        edge,
        edges,
        iteration: 1,
        output: review('changes_requested'),
      }) as LoopContinue,
      edges,
    ).clearEdgeIds) {
      delivered.delete(id);
    }

    expect(isMergeReady(merge, edges, delivered)).toBe(false);
    expect(log.arrivals(merge.id).map((arrival) => arrival.fromNodeId)).toEqual([right.id]);
  });
});

/* -------------------------------------------------------------------------- */
/* The review contract                                                         */
/* -------------------------------------------------------------------------- */

describe('FR-PAR-007 the standard review contract', () => {
  it('is usable as an agent outputContract and is frozen against edits', () => {
    expect(REVIEW_CONTRACT_SCHEMA.required).toEqual(['score', 'verdict', 'issues']);
    expect(Object.isFrozen(REVIEW_CONTRACT_SCHEMA)).toBe(true);
    expect(Object.isFrozen(REVIEW_CONTRACT_SCHEMA.properties)).toBe(true);
  });

  it('a loop exits on the verdict field the contract guarantees', () => {
    expect(exitConditionMet(LOOP, review('approved'))).toBe(true);
    expect(exitConditionMet(LOOP, review('changes_requested'))).toBe(false);
  });
});
