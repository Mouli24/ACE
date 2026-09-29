import { describe, expect, it } from 'vitest';

import { createRunDriverHarness, deferred, httpError } from './run-driver-harness.js';

/**
 * FR-CTL-001 / FR-CTL-002 / FR-ERR-005: a Pause that lands while a node waits to retry.
 *
 * "No new nodes start while paused" covers a retry as much as a first attempt: the next attempt is a
 * node run that has not started, so it is held PAUSED (D111) and calls nothing until the resume —
 * however long the backoff was.
 */

/** Longer than the first backoff (500 ms, D105), so a retry that ignored the pause would have run. */
const PAST_THE_BACKOFF_MS = 750;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('FR-CTL-001 FR-CTL-002 a pause during a retry backoff holds the retry until the resume', () => {
  it('holds the pending attempt PAUSED past its backoff, then runs it once resumed', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer', { retries: 1 });
    const result = h.outputNode();
    h.scripts.set('Writer', [{ throws: httpError(503, 'overloaded') }, { text: 'second time' }]);
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    // Attempt 1 failed and attempt 2 is waiting out its backoff.
    await h.waitForState(writer.id, 'READY', 2);
    await h.controls.pause(run.id);
    await sleep(PAST_THE_BACKOFF_MS);

    expect(h.calls('Writer')).toBe(1);
    const held = await h.nodeRunsOf(run.id, writer.id);
    expect(held.map((row) => `${row.attempt}:${row.status}`)).toEqual(['1:FAILED', '2:PAUSED']);
    expect(held[1]?.startedAt).toBeUndefined();
    expect((await h.runRow(run.id)).status).toBe('PAUSED');

    await h.controls.resume(run.id);
    await done;

    expect((await h.runRow(run.id)).status).toBe('COMPLETE');
    expect(h.calls('Writer')).toBe(2);
    expect(h.framesOf(writer.id).filter((frame) => frame.startsWith('2:'))).toEqual([
      '2:READY',
      '2:PAUSED',
      '2:READY',
      '2:RUNNING',
      '2:COMPLETED',
    ]);
  });

  it('a retry that falls due while the run is paused is PAUSED from the start (D111)', async () => {
    const h = await createRunDriverHarness();
    const brief = h.inputNode();
    const writer = h.agentNode('Writer', { retries: 1 });
    const result = h.outputNode();
    const firstCall = deferred();
    h.scripts.set('Writer', [
      { hold: firstCall.promise, throws: httpError(503, 'overloaded') },
      { text: 'second time' },
    ]);
    await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitForState(writer.id, 'RUNNING', 1);
    // FR-CTL-001: the running attempt is left to finish — and it fails, under the pause.
    await h.controls.pause(run.id);
    firstCall.resolve();
    await h.waitForState(writer.id, 'FAILED', 1);
    await sleep(PAST_THE_BACKOFF_MS);

    expect(h.calls('Writer')).toBe(1);
    expect((await h.nodeRunsOf(run.id, writer.id)).map((row) => row.status)).toEqual([
      'FAILED',
      'PAUSED',
    ]);

    await h.controls.resume(run.id);
    await done;

    expect((await h.runRow(run.id)).status).toBe('COMPLETE');
    expect(h.calls('Writer')).toBe(2);
    expect(h.framesOf(writer.id).filter((frame) => frame.startsWith('2:'))).toEqual([
      '2:PAUSED',
      '2:READY',
      '2:RUNNING',
      '2:COMPLETED',
    ]);
  });
});
