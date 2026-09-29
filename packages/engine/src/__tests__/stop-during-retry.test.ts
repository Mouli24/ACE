import { describe, expect, it } from 'vitest';

import { countNodeOutcomes, hasFailures } from '../errors/index.js';
import { createRunDriverHarness, httpError } from './run-driver-harness.js';

/**
 * TC-ERR-008 / FR-ERR-007 / FR-CTL-003: a Stop that lands while a node waits out its retry backoff.
 *
 * The attempt that failed is a recorded, FAILED attempt — but it is not the node's last word: the
 * engine had already decided to try again. So the node's latest attempt must say what actually
 * ended it, which is the user's Stop, and a stopped run must count no failure.
 */
describe('TC-ERR-008 FR-ERR-007 a stop during a retry backoff ends the node STOPPED, not FAILED', () => {
  it('stops the pending attempt, calls the model no more, and counts no failed node', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer', { retries: 2 });
    const result = h.outputNode();
    h.scripts.set('Writer', [{ throws: httpError(503, 'overloaded') }]);
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    // Attempt 1 has failed; the engine is now inside its 500 ms wait (D105).
    await h.waitForState(writer.id, 'FAILED', 1);
    await h.controls.stop(run.id);
    await done;

    const attempts = await h.nodeRunsOf(run.id, writer.id);
    expect(attempts.map((row) => `${row.attempt}:${row.status}`)).toEqual(['1:FAILED', '2:STOPPED']);
    expect(attempts[1]?.error?.kind).toBe('user_cancelled');
    expect(attempts[1]?.failureReason).toBeUndefined();

    // Nothing was called after the stop: the retry never ran, and never showed as RUNNING.
    expect(h.calls('Writer')).toBe(1);
    expect(h.framesOf(writer.id)).toEqual([
      '1:READY',
      '1:RUNNING',
      '1:FAILED',
      '2:READY',
      '2:STOPPED',
    ]);

    const all = await h.nodeRunsOf(run.id);
    expect(countNodeOutcomes(all).failed).toBe(0);
    expect(countNodeOutcomes(all).stopped).toBe(1);
    expect(hasFailures(all)).toBe(false);

    expect(await h.runRow(run.id)).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
  });
});
