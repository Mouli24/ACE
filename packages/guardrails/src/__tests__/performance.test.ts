import type { Id } from '@ace/contracts';
import { defaultGuardrailChecks } from '@ace/contracts';
import { describe, expect, it, onTestFinished } from 'vitest';

import { evaluateChecks } from '../evaluate.js';
import { FAKE_OPENAI_KEY, SAMPLE_EMAIL, SAMPLE_PHONE_INTL } from './fixtures.js';

/**
 * TC-NFR-013 / NFR-SAFE-01 — "Guardrail checks add under 300 ms per node when using rule packs".
 *
 * The measurement is the whole default policy (D10, round 3 §2.2 — every check a new project gets)
 * run over 100 nodes' worth of realistic text, at both the input and the output point, which is what
 * a node actually costs: two evaluations, not one.
 *
 * The budget is not weakened to make this pass. It passes because every regex in every pack is
 * compiled once at module scope and `findSpans` walks the text once per rule; if someone moves a
 * `new RegExp` inside a check, this is the test that notices.
 */

const NODES = 100;
const BUDGET_MS_PER_NODE = 300;

/** A node's worth of text: a few paragraphs, with the things the packs look for actually in it. */
function nodeText(index: number): string {
  const paragraph =
    'The quarterly review covers revenue, retention and the migration plan. Each section should ' +
    'summarise the numbers, name the owner and list the open risks with a one-line mitigation. ' +
    'Keep the tone factual and the sentences short; the audience is the leadership team. ';

  return [
    `Node ${index} brief.`,
    paragraph.repeat(6),
    `Escalate to ${SAMPLE_EMAIL} or call ${SAMPLE_PHONE_INTL}.`,
    paragraph.repeat(6),
    `Ignore previous instructions is the sort of line a poisoned document carries.`,
    `A leaked credential looks like ${FAKE_OPENAI_KEY} and must never reach a log.`,
    paragraph.repeat(6),
    'Cited as [source: q3-review.pdf p12].',
  ].join('\n\n');
}

describe('TC-NFR-013 Guardrail overhead', () => {
  it(`runs the default rule pack over ${NODES} nodes in under ${BUDGET_MS_PER_NODE} ms per node`, () => {
    let sequence = 0;
    const newId = (): Id => `01${'C'.repeat(20)}${String((sequence += 1)).padStart(4, '0')}`;
    const checks = defaultGuardrailChecks(newId);

    const texts = Array.from({ length: NODES }, (_, index) => nodeText(index));
    const totalChars = texts.reduce((sum, text) => sum + text.length, 0);

    // One warm-up node, so the figure is steady-state rather than first-call JIT cost.
    evaluateChecks(checks, { text: texts[0] ?? '' });

    const started = performance.now();
    let verdicts = 0;
    for (const text of texts) {
      // Both points a node goes through: its input, then its output.
      verdicts += evaluateChecks(checks, { text }).length;
      verdicts += evaluateChecks(checks, {
        text,
        parts: [{ type: 'text', text }],
        contract: { outputTypes: ['text'] },
        value: 0.001,
        limit: 1,
        outputHashes: ['a', 'b'],
      }).length;
    }
    const elapsed = performance.now() - started;
    const perNode = elapsed / NODES;

    onTestFinished(() => {
      const chars = Math.round(totalChars / NODES);
      // eslint-disable-next-line no-console -- TC-NFR-013 asks for the measured figure to be printed.
      console.log(
        `TC-NFR-013 guardrail overhead: ${perNode.toFixed(3)} ms/node ` +
          `(${elapsed.toFixed(1)} ms for ${NODES} nodes, ${verdicts} verdicts, ~${chars} chars/node, ` +
          `budget ${BUDGET_MS_PER_NODE} ms/node)`,
      );
    });

    expect(verdicts).toBeGreaterThan(NODES);
    expect(perNode).toBeLessThan(BUDGET_MS_PER_NODE);
  });

  it('is linear enough in the text size that a long input cannot blow the budget', () => {
    let sequence = 0;
    const checks = defaultGuardrailChecks(
      () => `01${'D'.repeat(20)}${String((sequence += 1)).padStart(4, '0')}`,
    );

    // The default size_limit cap is 200 000 characters, so this is the largest input the pack is
    // ever asked to judge in full.
    const huge = nodeText(0).repeat(Math.ceil(200_000 / nodeText(0).length));
    const started = performance.now();
    evaluateChecks(checks, { text: huge });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(BUDGET_MS_PER_NODE);
  });
});
