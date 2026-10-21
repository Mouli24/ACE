import { derivePorts, type Node } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { newId } from '../ids.js';
import {
  createRunDriverHarness,
  deferred,
  httpError,
  type RunDriverHarness,
} from './run-driver-harness.js';

/**
 * When a node with many inputs may run (FR-PAR-001, FR-PAR-002, FR-NODE-013, FR-ERR-006).
 *
 * [audit E-1] A Join's one input port is `multi`, and the generic port rule read "one arrival on a
 * multi port is enough" — so a Join fed by three branches ran on whichever finished first and the
 * run ended COMPLETE with one of the three texts. Only a Merge in `any` mode means "the first
 * arrival"; every other multi port waits for every edge wired into it.
 *
 * [audit E-2] A failed branch BLOCKED every IDLE node downstream that was not ready *yet* — so a
 * Merge in `any` mode whose healthy branch had not finished was blocked by its failed one, and the
 * run's outcome depended on which branch finished first. A node is now blocked only once it can no
 * longer become ready.
 */

function joinNode(h: RunDriverHarness, name = 'Join'): Node {
  const id = newId();
  return {
    id,
    workflowId: h.workflowId,
    kind: 'transform',
    name,
    position: { x: 0, y: 0 },
    inputs: [{ id: `${id}:in:in`, name: 'in', dataType: 'text', multi: true }],
    outputs: [{ id: `${id}:out:out`, name: 'out', dataType: 'text', multi: true }],
    config: { op: 'join', separator: ' | ' },
  } as Node;
}

function mergeNode(h: RunDriverHarness, mode: 'all' | 'any'): Node {
  const id = newId();
  const ports = derivePorts({ id, kind: 'merge', config: { mode } });
  return {
    id,
    workflowId: h.workflowId,
    kind: 'merge',
    name: 'Merge',
    position: { x: 0, y: 0 },
    inputs: ports.inputs,
    outputs: ports.outputs,
    config: { mode },
  };
}

/** An Output node with its real ports, so a Merge's json output lands on the json one. */
function resultNode(h: RunDriverHarness): Node {
  const id = newId();
  const ports = derivePorts({ id, kind: 'output', config: {} });
  return {
    id,
    workflowId: h.workflowId,
    kind: 'output',
    name: 'Result',
    position: { x: 0, y: 0 },
    inputs: ports.inputs,
    outputs: ports.outputs,
    config: {},
  };
}

const into = (h: RunDriverHarness, from: Node, to: Node, portName: string) => ({
  ...h.edge(from, to),
  to: { nodeId: to.id, portId: to.inputs.find((port) => port.name === portName)!.id },
});

/** Brief → Left, Right → Merge(mode) → Result; Left fails, Right answers "right". */
async function seedMerge(h: RunDriverHarness, mode: 'all' | 'any') {
  const brief = h.inputNode();
  const left = h.agentNode('Left');
  const right = h.agentNode('Right');
  const merge = mergeNode(h, mode);
  const result = resultNode(h);
  await h.seed(
    [brief, left, right, merge, result],
    [
      h.edge(brief, left),
      h.edge(brief, right),
      into(h, left, merge, 'in'),
      into(h, right, merge, 'in'),
      into(h, merge, result, 'json'),
    ],
  );
  return { left, right, merge, result };
}

const textOf = (parts: readonly { type: string; text?: string }[] | undefined): string =>
  (parts ?? []).map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('');

describe('[audit E-1] a Join waits for every input', () => {
  it('Input → A, B, C → Join → Output carries all three texts, however the branches finish', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const a = h.agentNode('Alpha');
    const b = h.agentNode('Beta');
    const c = h.agentNode('Gamma');
    const join = joinNode(h);
    const result = h.outputNode();
    // Alpha answers at once; Beta and Gamma are held until Alpha has delivered, so a Join that ran
    // on its first arrival would already have run on "alpha" alone.
    const late = deferred();
    h.scripts.set('Alpha', [{ text: 'alpha' }]);
    h.scripts.set('Beta', [{ text: 'beta', hold: late.promise }]);
    h.scripts.set('Gamma', [{ text: 'gamma', hold: late.promise }]);
    await h.seed(
      [brief, a, b, c, join, result],
      [
        h.edge(brief, a),
        h.edge(brief, b),
        h.edge(brief, c),
        h.edge(a, join),
        h.edge(b, join),
        h.edge(c, join),
        h.edge(join, result),
      ],
    );

    const { run, done } = await h.start();
    await h.waitForState(a.id, 'COMPLETED');
    await h.waitFor(
      () =>
        h.events.some(
          (event) =>
            event.type === 'edge.transfer' &&
            (event.payload as { fromNodeId: string }).fromNodeId === a.id,
        ),
      'Alpha to deliver into the Join',
    );
    expect(h.framesOf(join.id)).not.toContain('1:RUNNING');
    late.resolve();
    const ended = await done;

    expect(ended.status).toBe('COMPLETE');
    const [joined] = await h.nodeRunsOf(run.id, join.id);
    expect(joined?.status).toBe('COMPLETED');
    const text = textOf(joined?.output as { type: string; text?: string }[] | undefined);
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
    expect(text).toContain('gamma');
    const [out] = await h.nodeRunsOf(run.id, result.id);
    expect(textOf(out?.output as { type: string; text?: string }[] | undefined)).toBe(text);
  });
});

describe('[audit E-2] a failed branch blocks only what can no longer run', () => {
  it('Merge(any): the failed branch finishes first, the healthy one later — the merge runs and the run is COMPLETE', async () => {
    const h = await createRunDriverHarness();
    const late = deferred();
    h.scripts.set('Left', [{ throws: httpError(503) }]);
    h.scripts.set('Right', [{ text: 'right', hold: late.promise }]);
    const { left, merge, result } = await seedMerge(h, 'any');

    const { run, done } = await h.start();
    await h.waitForState(left.id, 'FAILED');
    // Right has not finished: the merge can still run on it, so it is not BLOCKED.
    expect(h.framesOf(merge.id)).not.toContain('1:BLOCKED');
    late.resolve();
    const ended = await done;

    expect(ended.status).toBe('COMPLETE');
    expect((await h.nodeRunsOf(run.id, merge.id)).map((row) => row.status)).toEqual(['COMPLETED']);
    expect((await h.nodeRunsOf(run.id, result.id)).map((row) => row.status)).toEqual(['COMPLETED']);
  });

  it('Merge(any): the healthy branch finishes first, the failed one later — the run is COMPLETE', async () => {
    const h = await createRunDriverHarness();
    const late = deferred();
    h.scripts.set('Left', [{ throws: httpError(503), hold: late.promise }]);
    h.scripts.set('Right', [{ text: 'right' }]);
    const { right, merge } = await seedMerge(h, 'any');

    const { run, done } = await h.start();
    await h.waitForState(right.id, 'COMPLETED');
    await h.waitForState(merge.id, 'COMPLETED');
    late.resolve();
    const ended = await done;

    expect(ended.status).toBe('COMPLETE');
    expect((await h.nodeRunsOf(run.id, merge.id)).map((row) => row.status)).toEqual(['COMPLETED']);
  });

  it('Merge(any): once every branch has failed the merge and what follows are BLOCKED, and the run HALTs', async () => {
    const h = await createRunDriverHarness();
    const late = deferred();
    h.scripts.set('Left', [{ throws: httpError(503) }]);
    h.scripts.set('Right', [{ throws: httpError(503), hold: late.promise }]);
    const { left, merge, result } = await seedMerge(h, 'any');

    const { run, done } = await h.start();
    await h.waitForState(left.id, 'FAILED');
    expect(h.framesOf(merge.id)).not.toContain('1:BLOCKED');
    late.resolve();
    const ended = await done;

    expect(ended).toMatchObject({ status: 'HALTED', haltReason: 'failure' });
    expect((await h.nodeRunsOf(run.id, merge.id)).map((row) => row.status)).toEqual(['BLOCKED']);
    expect((await h.nodeRunsOf(run.id, result.id)).map((row) => row.status)).toEqual(['BLOCKED']);
  });

  it('Merge(all) and a Join are still BLOCKED by one failed input, without waiting for the rest', async () => {
    const h = await createRunDriverHarness();
    const late = deferred();
    h.scripts.set('Left', [{ throws: httpError(503) }]);
    h.scripts.set('Right', [{ text: 'right', hold: late.promise }]);
    const { left, merge } = await seedMerge(h, 'all');

    const { run, done } = await h.start();
    await h.waitForState(left.id, 'FAILED');
    await h.waitForState(merge.id, 'BLOCKED');
    late.resolve();
    expect((await done).status).toBe('HALTED');
    expect((await h.nodeRunsOf(run.id, merge.id)).map((row) => row.status)).toEqual(['BLOCKED']);

    const j = await createRunDriverHarness();
    const brief = j.inputNode();
    const a = j.agentNode('Alpha');
    const b = j.agentNode('Beta');
    const join = joinNode(j);
    const out = j.outputNode();
    const held = deferred();
    j.scripts.set('Alpha', [{ throws: httpError(503) }]);
    j.scripts.set('Beta', [{ text: 'beta', hold: held.promise }]);
    await j.seed(
      [brief, a, b, join, out],
      [j.edge(brief, a), j.edge(brief, b), j.edge(a, join), j.edge(b, join), j.edge(join, out)],
    );
    const started = await j.start();
    await j.waitForState(a.id, 'FAILED');
    await j.waitForState(join.id, 'BLOCKED');
    held.resolve();
    expect((await started.done).status).toBe('HALTED');
  });
});
