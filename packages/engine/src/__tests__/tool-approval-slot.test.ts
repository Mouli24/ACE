import { describe, expect, it } from 'vitest';

import { deferred } from './run-driver-harness.js';
import {
  createApprovalRunHarness,
  SETTLE_MS,
  within,
  type ApprovalRunHarness,
} from './approval-run-harness.js';

/**
 * D-062 — a node WAITING on a destructive tool's approval must not hold its provider's slot
 * (R3 §4 item 4 "release the provider concurrency slot", FR-GRD-013, FR-PRV-009, D66).
 *
 * The tool loop ran whole inside `runGated`, so the approval wait at the tool point held the slot
 * for as long as a person took to decide: with a limit of 1, every other node on that provider sat
 * READY behind a card. The slot is for provider calls — FR-PRV-009 counts calls — so each model
 * turn now takes it and gives it back, and the guardrails and the tool run without it. The turn
 * after an approval queues for the slot like any READY node: behind whoever holds it, held by a
 * pause until the resume, ended by a stop (D110, D111).
 */

async function startCleanerWaiting(h: ApprovalRunHarness, names: readonly string[]) {
  const [cleaner, other] = await h.seed(names);
  if (cleaner === undefined) throw new Error('no Cleaner');
  const { run, done } = await h.service.beginRun(h.workflowId, {});
  const request = await h.waitForApproval(run.id);
  expect(request).toMatchObject({ nodeId: cleaner.id, point: 'tool' });
  return { run, done, request, cleaner, other };
}

/** Whether a node has emitted this state yet. */
const reached = (h: ApprovalRunHarness, nodeId: string, status: string) => () =>
  h.framesOf(nodeId).includes(status);

describe('FR-GRD-013 FR-PRV-009 D-062 a tool approval gives the provider slot back while WAITING', () => {
  it('with a limit of 1, another node on that provider runs while the first waits for its approval', async () => {
    const h = await createApprovalRunHarness({ providerConcurrency: 1 });
    const { run, done, request, cleaner, other } = await startCleanerWaiting(h, [
      'Cleaner',
      'Helper',
    ]);
    if (other === undefined) throw new Error('no Helper');

    // Cleaner was dispatched first and took the slot first — otherwise this proves nothing.
    const firstRunning = (nodeId: string) =>
      h.events.findIndex(
        (event) =>
          event.type === 'node.state' &&
          (event.payload as { nodeId: string; status: string }).nodeId === nodeId &&
          (event.payload as { status: string }).status === 'RUNNING',
      );
    await h.waitFor(reached(h, other.id, 'COMPLETED'), 'Helper to finish while Cleaner waits');
    expect(firstRunning(cleaner.id)).toBeLessThan(firstRunning(other.id));
    expect((await h.nodeRun(request.nodeRunId)).status).toBe('WAITING');

    expect((await h.decide(request.nodeRunId, 'approve')).status).toBe(200);
    const final = await within(done, SETTLE_MS, "the run's drive");

    expect(final.status).toBe('COMPLETE');
    expect(h.deleted).toEqual(['notes.txt']);
    expect(h.calls('Cleaner')).toBe(2);
    expect(h.maxConcurrentCalls()).toBe(1);
    expect(h.framesOf(cleaner.id)).toEqual(['READY', 'RUNNING', 'WAITING', 'RUNNING', 'COMPLETED']);
    expect((await h.runRow(run.id)).status).toBe('COMPLETE');
  });

  it('the approved node queues for the slot again, behind the node that holds it', async () => {
    const h = await createApprovalRunHarness({ providerConcurrency: 1 });
    const hold = deferred();
    h.holds.set('Helper', hold.promise);
    const { done, request, other } = await startCleanerWaiting(h, ['Cleaner', 'Helper']);
    if (other === undefined) throw new Error('no Helper');

    await h.waitFor(reached(h, other.id, 'RUNNING'), 'Helper to take the slot');
    expect((await h.decide(request.nodeRunId, 'approve')).status).toBe(200);
    await h.waitFor(() => h.deleted.length === 1, 'the approved tool to run');

    // The approved tool ran; its next model call waits for the slot Helper holds.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.calls('Cleaner')).toBe(1);

    hold.resolve();
    const final = await within(done, SETTLE_MS, "the run's drive");
    expect(final.status).toBe('COMPLETE');
    expect(h.calls('Cleaner')).toBe(2);
    expect(h.maxConcurrentCalls()).toBe(1);
  });

  it('a pause while the approved node is re-queued holds its next call until the resume (D110, D111)', async () => {
    const h = await createApprovalRunHarness({ providerConcurrency: 1 });
    const { run, done, request, cleaner } = await startCleanerWaiting(h, ['Cleaner']);

    await h.controls.pause(run.id);
    expect((await h.decide(request.nodeRunId, 'approve')).status).toBe(200);
    await h.waitFor(() => h.deleted.length === 1, 'the approved tool to run');

    // Paused: the slot is free, but a pause dispatches nothing new — no second model call.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.calls('Cleaner')).toBe(1);
    expect((await h.runRow(run.id)).status).toBe('PAUSED');

    await h.controls.resume(run.id);
    const final = await within(done, SETTLE_MS, "the run's drive");
    expect(final.status).toBe('COMPLETE');
    expect(h.calls('Cleaner')).toBe(2);
    expect(h.framesOf(cleaner.id)).toEqual(['READY', 'RUNNING', 'WAITING', 'RUNNING', 'COMPLETED']);
  });

  it('a stop while the approved node is re-queued ends it STOPPED, with no further call and what it spent', async () => {
    const h = await createApprovalRunHarness({ providerConcurrency: 1 });
    const hold = deferred();
    h.holds.set('Helper', hold.promise);
    const { run, done, request, other } = await startCleanerWaiting(h, ['Cleaner', 'Helper']);
    if (other === undefined) throw new Error('no Helper');

    await h.waitFor(reached(h, other.id, 'RUNNING'), 'Helper to take the slot');
    expect((await h.decide(request.nodeRunId, 'approve')).status).toBe(200);
    await h.waitFor(() => h.deleted.length === 1, 'the approved tool to run');

    await within(h.controls.stop(run.id), SETTLE_MS, 'POST /runs/:id/stop');
    const final = await within(done, SETTLE_MS, "the run's drive");

    expect(final).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    const row = await h.nodeRun(request.nodeRunId);
    expect(row.status).toBe('STOPPED');
    expect(row.failureReason).toBeUndefined();
    // Its first turn was a real, billed call: a stop does not make it free (FR-ERR-007, TC-OBS-002).
    expect(row.usage).toMatchObject({ tokensIn: 5, tokensOut: 1 });
    expect(final.totals.tokensIn).toBe(5);
    expect(h.calls('Cleaner')).toBe(1);
    expect(h.callsAfterAbort('Cleaner')).toBe(0);
  });

  it("a person slower than the node's timeout does not time the next turn out: each turn has its own clock", async () => {
    const h = await createApprovalRunHarness({ providerConcurrency: 1 });
    await h.seed(['Cleaner'], undefined, 1_000);
    const { run, done } = await h.service.beginRun(h.workflowId, {});
    const request = await h.waitForApproval(run.id);

    // `execution.timeoutMs` bounds a provider turn (D97), not a person deciding.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await h.decide(request.nodeRunId, 'approve')).status).toBe(200);
    const final = await within(done, SETTLE_MS, "the run's drive");

    expect(final.status).toBe('COMPLETE');
    expect(h.calls('Cleaner')).toBe(2);
    expect(h.callsAfterAbort('Cleaner')).toBe(0);
  });
});
