import { derivePorts, type Edge, type Node, type Part } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createEventBus, type EventBus } from '../events/index.js';
import { newId } from '../ids.js';
import {
  createMergeArrivalLog,
  executeMergeNode,
  isMergeReady,
  mergeInputEdges,
  mergeInputs,
  mergeOutput,
  type MergeArrival,
  type MergeNode,
  type MergeOutputValue,
} from '../merge/index.js';
import { LOCAL_SCOPE, type EngineEvent } from '../ports/index.js';
import { FakeRepository } from './fake-repository.js';
import { InProcessPubSubStub } from './pubsub-stub.js';

/**
 * Merge nodes (FR-PAR-001, FR-PAR-002, TC-PAR-001, TC-PAR-002, round 3 §2.4).
 */

const WORKFLOW = newId();

function mergeNode(mode: 'all' | 'any'): MergeNode {
  const id = newId();
  const ports = derivePorts({ id, kind: 'merge', config: { mode } });
  return {
    id,
    workflowId: WORKFLOW,
    kind: 'merge',
    name: 'Merge',
    position: { x: 0, y: 0 },
    inputs: ports.inputs,
    outputs: ports.outputs,
    config: { mode },
  };
}

const source = (name: string): Node => {
  const id = newId();
  return {
    id,
    workflowId: WORKFLOW,
    kind: 'input',
    name,
    position: { x: 0, y: 0 },
    inputs: [],
    outputs: derivePorts({ id, kind: 'input', config: { text: name, artifactIds: [], outputTypes: ['text'] } }).outputs,
    config: { text: name, artifactIds: [], outputTypes: ['text'] },
  };
};

function into(from: Node, merge: MergeNode, portName: 'in' | 'in_json'): Edge {
  const to = merge.inputs.find((port) => port.name === portName)!;
  return {
    id: newId(),
    workflowId: WORKFLOW,
    kind: 'data',
    from: { nodeId: from.id, portId: from.outputs[0]!.id },
    to: { nodeId: merge.id, portId: to.id },
  };
}

const text = (value: string): Part[] => [{ type: 'text', text: value }];

const arrival = (edge: Edge, parts: Part[]): MergeArrival => ({
  edgeId: edge.id,
  portId: edge.to.portId,
  fromNodeId: edge.from.nodeId,
  parts,
});

const inputsOf = (parts: Part[]): MergeOutputValue['inputs'] =>
  (parts[0] as { type: 'json'; value: MergeOutputValue }).value.inputs;

/* -------------------------------------------------------------------------- */

describe('TC-PAR-002 Merge node — all', () => {
  const merge = mergeNode('all');
  const left = source('Left');
  const right = source('Right');
  const a = into(left, merge, 'in');
  const b = into(right, merge, 'in');
  const edges = [a, b];

  it('counts only the edges actually wired into it', () => {
    expect(mergeInputEdges(merge, edges).map((edge) => edge.id)).toEqual([a.id, b.id]);
  });

  it('waits for every connected input', () => {
    expect(isMergeReady(merge, edges, new Set([a.id]))).toBe(false);
    expect(isMergeReady(merge, edges, new Set([a.id, b.id]))).toBe(true);
  });

  it('a port with nothing wired into it is not waited for', () => {
    const one = [a];
    expect(isMergeReady(merge, one, new Set([a.id]))).toBe(true);
  });

  it('a merge with no inputs at all is ready and merges nothing', () => {
    expect(isMergeReady(merge, [], new Set())).toBe(true);
    expect(inputsOf(mergeOutput(merge, [], []))).toEqual([]);
  });

  it('outputs one json part holding every input', () => {
    const output = mergeOutput(merge, edges, [arrival(a, text('left')), arrival(b, text('right'))]);

    expect(output).toHaveLength(1);
    expect(output[0]?.type).toBe('json');
    expect(inputsOf(output)).toEqual([
      { port: 'in', nodeId: left.id, parts: text('left') },
      { port: 'in', nodeId: right.id, parts: text('right') },
    ]);
  });
});

describe('TC-PAR-002 Merge node — output order is the input port order', () => {
  const merge = mergeNode('all');
  const onText = source('Text branch');
  const onJson = source('Json branch');
  const textEdge = into(onText, merge, 'in');
  const jsonEdge = into(onJson, merge, 'in_json');
  const edges = [textEdge, jsonEdge];

  it('orders by port, not by arrival, so the json is stable whichever branch won', () => {
    const jsonFirst = mergeInputs(merge, edges, [
      arrival(jsonEdge, text('from json')),
      arrival(textEdge, text('from text')),
    ]);

    expect(jsonFirst.map((input) => input.port)).toEqual(['in', 'in_json']);
    expect(jsonFirst.map((input) => input.nodeId)).toEqual([onText.id, onJson.id]);
  });

  it('two edges on one port keep the snapshot edge order', () => {
    const second = source('Second text branch');
    const secondEdge = into(second, merge, 'in');
    const all = [textEdge, secondEdge, jsonEdge];

    const ordered = mergeInputs(merge, all, [
      arrival(secondEdge, text('second')),
      arrival(jsonEdge, text('json')),
      arrival(textEdge, text('first')),
    ]);

    expect(ordered.map((input) => input.nodeId)).toEqual([onText.id, second.id, onJson.id]);
  });
});

describe('TC-PAR-002 Merge node — any', () => {
  const merge = mergeNode('any');
  const fast = source('Fast');
  const slow = source('Slow');
  const fastEdge = into(fast, merge, 'in');
  const slowEdge = into(slow, merge, 'in');
  const edges = [fastEdge, slowEdge];

  it('is ready on the first arrival', () => {
    expect(isMergeReady(merge, edges, new Set([slowEdge.id]))).toBe(true);
  });

  it('feeds only the first arrival, whichever port it landed on', () => {
    const ordered = mergeInputs(merge, edges, [
      arrival(slowEdge, text('slow')),
      arrival(fastEdge, text('fast')),
    ]);

    expect(ordered).toEqual([{ port: 'in', nodeId: slow.id, parts: text('slow') }]);
  });

  it('a later branch is in the log — it ran and was recorded — but does not feed the merge', () => {
    const log = createMergeArrivalLog();
    log.record(merge.id, arrival(fastEdge, text('fast')));
    log.record(merge.id, arrival(slowEdge, text('slow')));

    expect(log.arrivals(merge.id)).toHaveLength(2);
    expect(mergeInputs(merge, edges, log.arrivals(merge.id))).toEqual([
      { port: 'in', nodeId: fast.id, parts: text('fast') },
    ]);
  });
});

describe('FR-PAR-002 an arrival the graph does not explain', () => {
  it('sorts last and keeps its port id, rather than losing the branch', () => {
    const merge = mergeNode('all');
    const known = source('Known');
    const stranger = source('Stranger');
    const knownEdge = into(known, merge, 'in_json');
    const strayEdge = into(stranger, merge, 'in');

    // `strayEdge` is deliberately not in the snapshot: a node run from a graph that has since been
    // edited must still appear in the merge's json, at the end, named by what it does know.
    const ordered = mergeInputs(merge, [knownEdge], [
      arrival(strayEdge, text('stray')),
      arrival(knownEdge, text('known')),
    ]);

    expect(ordered.map((input) => input.nodeId)).toEqual([stranger.id, known.id]);
    expect(ordered[0]?.port).toBe('in');
  });

  it('two unexplained arrivals keep the order they arrived in', () => {
    const merge = mergeNode('all');
    const first = source('First');
    const second = source('Second');
    const firstEdge = into(first, merge, 'in');
    const secondEdge = into(second, merge, 'in');

    const ordered = mergeInputs(merge, [], [
      arrival(secondEdge, text('second')),
      arrival(firstEdge, text('first')),
    ]);

    expect(ordered.map((input) => input.nodeId)).toEqual([second.id, first.id]);
  });

  it('an arrival on a port the node does not have keeps the raw port id', () => {
    const merge = mergeNode('all');
    const from = source('From');
    const stray: MergeArrival = {
      edgeId: newId(),
      portId: `${merge.id}:in:gone`,
      fromNodeId: from.id,
      parts: text('stray'),
    };

    expect(mergeInputs(merge, [], [stray])[0]?.port).toBe(`${merge.id}:in:gone`);
  });
});

describe('FR-PAR-002 the arrival log', () => {
  it('keeps arrivals per node and clears them for a new loop iteration', () => {
    const first = mergeNode('all');
    const second = mergeNode('all');
    const from = source('From');
    const edgeOne = into(from, first, 'in');
    const edgeTwo = into(from, second, 'in');

    const log = createMergeArrivalLog();
    log.record(first.id, arrival(edgeOne, text('one')));
    log.record(second.id, arrival(edgeTwo, text('two')));

    expect(log.arrivals(first.id)).toHaveLength(1);
    expect(log.arrivals(second.id)).toHaveLength(1);

    log.clear(first.id);
    expect(log.arrivals(first.id)).toEqual([]);
    expect(log.arrivals(second.id)).toHaveLength(1);
  });
});

describe('FR-PAR-002 executing a merge node', () => {
  async function bus(): Promise<{ bus: EventBus; events: EngineEvent[] }> {
    const repository = new FakeRepository();
    const pubsub = new InProcessPubSubStub<EngineEvent>();
    const eventBus = createEventBus({ repository, scope: LOCAL_SCOPE, pubsub });
    const events: EngineEvent[] = [];
    await eventBus.subscribe((event) => events.push(event));
    return { bus: eventBus, events };
  }

  it('completes with the merged json, costs nothing and emits node.output', async () => {
    const merge = mergeNode('all');
    const left = source('Left');
    const right = source('Right');
    const a = into(left, merge, 'in');
    const b = into(right, merge, 'in');
    const { bus: eventBus, events } = await bus();

    const outcome = await executeMergeNode(
      {
        runId: newId(),
        workflowId: WORKFLOW,
        nodeRunId: newId(),
        node: merge,
        edges: [a, b],
        arrivals: [arrival(a, text('left')), arrival(b, text('right'))],
      },
      { bus: eventBus },
    );

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.usage).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
    expect(inputsOf(outcome.output)).toHaveLength(2);

    const emitted = events.filter((event) => event.type === 'node.output');
    expect(emitted).toHaveLength(1);
    expect((emitted[0]?.payload as { nodeId: string }).nodeId).toBe(merge.id);
  });
});
