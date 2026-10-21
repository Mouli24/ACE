import type { Node } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { newId } from '../ids.js';
import { createRunDriverHarness, deferred, type RunDriverHarness } from './run-driver-harness.js';

/**
 * When a node with many inputs may run (FR-PAR-001, FR-PAR-002, FR-NODE-013, FR-ERR-006).
 *
 * [audit E-1] A Join's one input port is `multi`, and the generic port rule read "one arrival on a
 * multi port is enough" — so a Join fed by three branches ran on whichever finished first and the
 * run ended COMPLETE with one of the three texts. Only a Merge in `any` mode means "the first
 * arrival"; every other multi port waits for every edge wired into it.
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
      () => h.events.some((event) => event.type === 'edge.transfer' && (event.payload as { fromNodeId: string }).fromNodeId === a.id),
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
