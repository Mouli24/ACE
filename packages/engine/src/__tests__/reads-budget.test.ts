import { envelopeUsedTokens, readsBudgetFor, type Node } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createRunDriverHarness } from './run-driver-harness.js';

/**
 * [audit E-9] An agent's reads budget is for all its reads together (FR-EXE-007, round 5 §2.2).
 *
 * Each envelope into an agent was built to the agent's whole reads share, so an agent fed by three
 * nodes read three times its budget. The share is now split over the nodes that feed it.
 */

const long = (label: string): string => `${label} `.repeat(4_000);

describe('[audit E-9] the reads budget is split over an agent’s inputs', () => {
  it('three long inputs together fit in one reads budget', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const a = h.agentNode('Alpha');
    const b = h.agentNode('Beta');
    const c = h.agentNode('Gamma');
    const base = h.agentNode('Editor');
    // One text port that takes many edges, so three branches can feed the one agent.
    const editor: Node = {
      ...base,
      inputs: [{ ...base.inputs[0]!, multi: true }],
    } as Node;
    const result = h.outputNode();
    h.scripts.set('Alpha', [{ text: long('alpha') }]);
    h.scripts.set('Beta', [{ text: long('beta') }]);
    h.scripts.set('Gamma', [{ text: long('gamma') }]);
    await h.seed(
      [brief, a, b, c, editor, result],
      [
        h.edge(brief, a),
        h.edge(brief, b),
        h.edge(brief, c),
        h.edge(a, editor),
        h.edge(b, editor),
        h.edge(c, editor),
        h.edge(editor, result),
      ],
    );

    const { run, done } = await h.start();
    expect((await done).status).toBe('COMPLETE');

    const share = readsBudgetFor(editor as Extract<Node, { kind: 'agent' }>);
    const [read] = await h.nodeRunsOf(run.id, editor.id);
    const envelopes = read?.inputEnvelopes ?? [];
    expect(envelopes).toHaveLength(3);
    for (const envelope of envelopes) {
      expect(envelope.context.budgetTokens).toBe(Math.floor(share / 3));
    }
    const used = envelopes.reduce((total, envelope) => total + envelopeUsedTokens(envelope), 0);
    expect(used).toBeLessThanOrEqual(share);
  });

  it('a single input keeps the whole share', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer');
    const result = h.outputNode();
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);

    const { run, done } = await h.start();
    await done;

    const [read] = await h.nodeRunsOf(run.id, writer.id);
    expect(read?.inputEnvelopes[0]?.context.budgetTokens).toBe(
      readsBudgetFor(writer as Extract<Node, { kind: 'agent' }>),
    );
  });
});
