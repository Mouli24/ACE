import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';

import { createRunDriverHarness, deferred, httpError } from './run-driver-harness.js';

/**
 * [audit E-12] A retry's backoff waits on the run's signal so a Stop can cut it short (FR-CTL-003).
 * Once the wait ran its course its listener stayed on that signal, one per retry, for as long as
 * the run lived — which for a Domain run that stays open is for ever.
 */

async function listenersAfterFlaky(retried: boolean): Promise<number> {
  const h = await createRunDriverHarness();
  const brief = h.inputNode();
  const flaky = h.agentNode('Flaky', { retries: 1 });
  const holder = h.agentNode('Holder');
  const flakyResult = h.outputNode('FlakyResult');
  const holderResult = h.outputNode('HolderResult');
  const release = deferred();
  h.scripts.set(
    'Flaky',
    retried ? [{ throws: httpError(503) }, { text: 'second go' }] : [{ text: 'first go' }],
  );
  h.scripts.set('Holder', [{ text: 'held', hold: release.promise }]);
  await h.seed(
    [brief, flaky, holder, flakyResult, holderResult],
    [
      h.edge(brief, flaky),
      h.edge(brief, holder),
      h.edge(flaky, flakyResult),
      h.edge(holder, holderResult),
    ],
  );

  const { run, done } = await h.start();
  await h.waitForState(flakyResult.id, 'COMPLETED');
  // The run is still going — Holder holds it open — so its signal is still the one listened on.
  const gate = h.gates.get(run.id);
  expect(gate).toBeDefined();
  const count = getEventListeners(gate!.signal, 'abort').length;
  release.resolve();
  await done;
  return count;
}

describe('[audit E-12] a retry leaves no listener on the run’s signal', () => {
  it('a node that was retried after a backoff leaves as many listeners as one that was not', async () => {
    const plain = await listenersAfterFlaky(false);
    const retried = await listenersAfterFlaky(true);

    expect(retried).toBe(plain);
  });
});
