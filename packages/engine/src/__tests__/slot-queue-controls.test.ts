import type { Node } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  createRunDriverHarness,
  deferred,
  PROVIDER_ID,
  type Deferred,
  type RunDriverHarness,
} from './run-driver-harness.js';

/**
 * FR-CTL-001 / FR-CTL-003 / D66 / D111: a node queued for its provider's concurrency slot.
 *
 * D66 made READY mean "dispatched, waiting for its provider slot", and D111 has a pause move exactly
 * those rows to PAUSED and a stop move them to STOPPED. So the moment the slot comes free must not
 * start a node the run has paused or stopped: it would spend tokens on a paused run, or call a model
 * with a signal that is already aborted.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Brief → A → ResultA and Brief → B → ResultB, on a provider that takes one call at a time. */
async function twoAgentsOneSlot(): Promise<{
  h: RunDriverHarness;
  runId: string;
  done: Promise<unknown>;
  first: Node;
  queued: Node;
  holds: Map<string, Deferred>;
}> {
  const h = await createRunDriverHarness({ providerConcurrency: 1 });
  const brief = h.inputNode();
  const a = h.agentNode('A');
  const b = h.agentNode('B');
  const resultA = h.outputNode('ResultA');
  const resultB = h.outputNode('ResultB');
  const holds = new Map<string, Deferred>([
    [a.id, deferred()],
    [b.id, deferred()],
  ]);
  h.scripts.set('A', [{ hold: holds.get(a.id)?.promise, text: 'a' }]);
  h.scripts.set('B', [{ hold: holds.get(b.id)?.promise, text: 'b' }]);
  await h.seed(
    [brief, a, b, resultA, resultB],
    [h.edge(brief, a), h.edge(brief, b), h.edge(a, resultA), h.edge(b, resultB)],
  );

  const { run, done } = await h.service.beginRun(h.workflowId, {});
  // One of the two holds the slot and streams; the other is dispatched and queued behind it.
  await h.waitFor(
    () =>
      [a, b].some((node) => h.framesOf(node.id).includes('1:RUNNING')) &&
      [a, b].every((node) => h.framesOf(node.id).includes('1:READY')),
    'one agent RUNNING and the other queued READY',
  );
  const first = h.framesOf(a.id).includes('1:RUNNING') ? a : b;
  const queued = first === a ? b : a;
  expect(h.framesOf(queued.id)).toEqual(['1:READY']);

  return { h, runId: run.id, done, first, queued, holds };
}

describe('FR-CTL-001 FR-CTL-002 D66 a node queued for its provider slot does not start while paused', () => {
  it('gives the slot back and stays PAUSED, then starts once the run is resumed', async () => {
    const { h, runId, done, first, queued, holds } = await twoAgentsOneSlot();

    await h.controls.pause(runId);
    expect(h.framesOf(queued.id)).toEqual(['1:READY', '1:PAUSED']);

    // FR-CTL-001: the running one finishes, and its slot comes free — under the pause.
    holds.get(first.id)?.resolve();
    await h.waitForState(first.id, 'COMPLETED');
    await sleep(100);

    expect(h.calls(queued.name)).toBe(0);
    expect(h.framesOf(queued.id)).toEqual(['1:READY', '1:PAUSED']);
    const [held] = await h.nodeRunsOf(runId, queued.id);
    expect(held).toMatchObject({ status: 'PAUSED' });
    expect(held?.startedAt).toBeUndefined();
    // The slot was handed straight back rather than held by a node that is not running.
    expect((await h.providers.semaphoreFor(PROVIDER_ID)).inFlight()).toBe(0);

    holds.get(queued.id)?.resolve();
    await h.controls.resume(runId);
    await done;

    expect((await h.runRow(runId)).status).toBe('COMPLETE');
    expect(h.calls(queued.name)).toBe(1);
    expect(h.framesOf(queued.id)).toEqual([
      '1:READY',
      '1:PAUSED',
      '1:READY',
      '1:RUNNING',
      '1:COMPLETED',
    ]);
  });
});

describe('FR-CTL-003 D111 a node queued for its provider slot is stopped without being called', () => {
  it('goes READY → STOPPED only, and generate() is never called for it', async () => {
    const { h, runId, done, first, queued } = await twoAgentsOneSlot();

    await h.controls.stop(runId);
    await done;

    expect(h.framesOf(queued.id)).toEqual(['1:READY', '1:STOPPED']);
    expect(h.calls(queued.name)).toBe(0);
    expect(h.abortedAtCall(queued.name)).toEqual([]);
    const [stopped] = await h.nodeRunsOf(runId, queued.id);
    expect(stopped).toMatchObject({ status: 'STOPPED', error: { kind: 'user_cancelled' } });
    expect(stopped?.startedAt).toBeUndefined();

    // The one that was streaming is cut short and announced once.
    expect(h.framesOf(first.id)).toEqual(['1:READY', '1:RUNNING', '1:STOPPED']);
    expect(await h.runRow(runId)).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
  });
});
